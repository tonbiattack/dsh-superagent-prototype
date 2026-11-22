// The autopilot's durable queue, its poller, and its scheduler, on a real Store and a fake GitHub CLI.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Store } from '../src/app/store.ts'
import { AutopilotQueue } from '../src/app/autopilot-queue.ts'
import { AutopilotPoller, eligibleIssue, labelNames } from '../src/app/autopilot-poller.ts'
import { AutopilotScheduler } from '../src/app/autopilot-scheduler.ts'
import { JobLocks } from '../src/app/autopilot-locks.ts'
import type { RecoveryFacts } from '../src/app/autopilot-recovery.ts'
import type { DeliveryResult } from '../src/app/autopilot-delivery.ts'
import { AutopilotConfigSchema, SettingsSchema } from '../src/policy.ts'
import type { Commands } from '../src/infra/commands.ts'
import type { Trigger } from '../src/core/index.ts'

let dir: string
let store: Store
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'autopilot-')); store = new Store(join(dir, 'db.sqlite')) })
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })

const settings = (patch: Record<string, unknown> = {}) => AutopilotConfigSchema.parse({ enabled: true,
  repositories: [{ fullName: 'owner/one', checkout: '/srv/one' }, { fullName: 'owner/two', checkout: '/srv/two' }], ...patch })
/** A GitHub CLI that answers the repository read and the issue list from `issues`, and records what it was asked. */
function cli(issues: Record<string, unknown[]>, repository = { id: 11, full_name: 'owner/one', default_branch: 'main' },
  override: { pages?: (path: string) => unknown[] } = {}) {
  const asked: string[] = []
  const commands: Record<string, unknown> = {
    api: async (_schema: unknown, path: string) => { asked.push(path); return path === '' ? repository : {} },
    pages: async (_schema: unknown, path: string) => {
      asked.push(path)
      return override.pages ? override.pages(path) : issues[repository.full_name] ?? []
    },
  }
  // `withSignal` returns the same fake, so an override of `api` or `pages` is what the poller actually calls.
  commands.withSignal = () => commands
  return { commands: commands as unknown as Commands, asked }
}
const listed = (number: number, patch: Record<string, unknown> = {}) => ({ number, title: `Issue ${number}`, state: 'open',
  html_url: `https://github.com/owner/one/issues/${number}`, user: { login: 'alice' }, created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z', labels: [{ name: 'autopilot' }], ...patch })

describe('autopilot queue', () => {
  it('records one job per repository and issue, and keeps the first record', () => {
    const queue = new AutopilotQueue(store)
    const first = queue.enqueue({ repository: 'owner/one', repositoryId: 11, issue: 7, state: 'queued' })
    expect(first.created).toBe(true)
    const again = queue.enqueue({ repository: 'owner/one', repositoryId: 11, issue: 7, state: 'queued' })
    expect(again.created).toBe(false)
    expect(again.job.createdAt).toBe(first.job.createdAt)
    expect(queue.all()).toHaveLength(1)
  })
  it('keeps a job across a repository rename, because its key is the immutable ID', () => {
    const queue = new AutopilotQueue(store)
    queue.enqueue({ repository: 'owner/one', repositoryId: 11, issue: 7, state: 'queued' })
    // The same repository, renamed: the ID is unchanged, so the job is the same job and only its name follows.
    const renamed = queue.enqueue({ repository: 'owner/renamed', repositoryId: 11, issue: 7, state: 'queued' })
    expect(renamed.created).toBe(false)
    expect(renamed.job.repository).toBe('owner/renamed')
    expect(queue.all()).toHaveLength(1)
  })
  it('keeps the same issue number in two repositories as two jobs', () => {
    const queue = new AutopilotQueue(store)
    queue.enqueue({ repository: 'owner/one', repositoryId: 11, issue: 7, state: 'queued' })
    queue.enqueue({ repository: 'owner/two', repositoryId: 12, issue: 7, state: 'queued' })
    expect(queue.all().map(job => job.repository)).toEqual(['owner/one', 'owner/two'])
  })
  it('survives a restart, so a repeated poll finds the job it already queued', () => {
    new AutopilotQueue(store).enqueue({ repository: 'owner/one', repositoryId: 11, issue: 7, state: 'queued' })
    store.close()
    store = new Store(join(dir, 'db.sqlite'))
    const queue = new AutopilotQueue(store)
    expect(queue.get(11, 7)?.state).toBe('queued')
    expect(queue.enqueue({ repository: 'owner/one', repositoryId: 11, issue: 7, state: 'queued' }).created).toBe(false)
  })
  it('updates a job in one transaction and stamps when it changed', () => {
    const queue = new AutopilotQueue(store)
    const { job } = queue.enqueue({ repository: 'owner/one', repositoryId: 11, issue: 7, state: 'queued' })
    const updated = queue.update(11, 7, { state: 'running', ticketId: 't1' })!
    expect(updated).toMatchObject({ state: 'running', ticketId: 't1', createdAt: job.createdAt })
    expect(queue.update(11, 99, { state: 'running' })).toBeUndefined()
  })
  it('counts attempts and forgets a job a person retries', () => {
    const queue = new AutopilotQueue(store)
    queue.enqueue({ repository: 'owner/one', repositoryId: 11, issue: 7, state: 'queued' })
    expect(queue.attempted(11, 7)?.attempts).toBe(1)
    expect(queue.attempted(11, 7)?.attempts).toBe(2)
    queue.forget(11, 7)
    expect(queue.get(11, 7)).toBeUndefined()
    expect(queue.enqueue({ repository: 'owner/one', repositoryId: 11, issue: 7, state: 'queued' }).created).toBe(true)
  })
  it('lists jobs by state, oldest first', () => {
    const queue = new AutopilotQueue(store)
    queue.enqueue({ repository: 'owner/one', repositoryId: 11, issue: 2, state: 'queued' })
    queue.enqueue({ repository: 'owner/one', repositoryId: 11, issue: 1, state: 'queued' })
    queue.update(11, 1, { state: 'done' })
    expect(queue.inStates('queued').map(job => job.issue)).toEqual([2])
    expect(queue.inStates('done').map(job => job.issue)).toEqual([1])
  })
})

describe('autopilot poller', () => {
  const poller = (issues: Record<string, unknown[]>, patch: Record<string, unknown> = {}, allowed = ['alice']) => {
    const queue = new AutopilotQueue(store)
    const { commands, asked } = cli(issues)
    const poll = new AutopilotPoller({ store, queue, commands: () => commands, allowed: () => allowed, settings: () => settings(patch) })
    return { queue, poll, asked }
  }
  it('queues an issue that carries the label and was written by an allowed account', async () => {
    const { queue, poll } = poller({ 'owner/one': [listed(7)] })
    const result = await poll.poll('owner/one')
    expect(result).toMatchObject({ repository: 'owner/one', read: 1, queued: 1 })
    expect(queue.get(11, 7)).toMatchObject({ state: 'queued', repositoryId: 11 })
  })
  it('queues nothing for an issue without the label, or from an account that may not originate work', async () => {
    const { queue, poll } = poller({ 'owner/one': [listed(7, { labels: [{ name: 'bug' }] }), listed(8, { user: { login: 'stranger' } })] })
    expect((await poll.poll('owner/one')).queued).toBe(0)
    expect(queue.all()).toEqual([])
  })
  it('skips a pull request, which the autopilot does not take up', async () => {
    const { queue, poll } = poller({ 'owner/one': [listed(7, { pull_request: { url: 'x' } })] })
    expect((await poll.poll('owner/one')).queued).toBe(0)
    expect(queue.all()).toEqual([])
  })
  it('does not queue an issue twice when the poll runs again', async () => {
    const { queue, poll } = poller({ 'owner/one': [listed(7)] })
    await poll.poll('owner/one')
    const second = await poll.poll('owner/one')
    expect(second.queued).toBe(0)
    expect(queue.all()).toHaveLength(1)
  })
  it('skips a queued job whose issue lost the label before it started', async () => {
    const { queue, poll } = poller({ 'owner/one': [listed(7)] })
    await poll.poll('owner/one')
    const relabelled = poller({ 'owner/one': [listed(7, { labels: [{ name: 'bug' }] })] })
    await relabelled.poll.poll('owner/one')
    expect(queue.get(11, 7)).toMatchObject({ state: 'skipped', error: 'no autopilot label' })
  })
  it('skips a queued job whose issue closed before it started', async () => {
    const { queue, poll } = poller({ 'owner/one': [listed(7)] })
    await poll.poll('owner/one')
    const closed = poller({ 'owner/one': [] })
    const result = await closed.poll.poll('owner/one')
    expect(result.closed).toBe(1)
    expect(queue.get(11, 7)).toMatchObject({ state: 'skipped' })
  })
  it('leaves a job that already ran alone, so its outcome is the record', async () => {
    const { queue, poll } = poller({ 'owner/one': [listed(7)] })
    await poll.poll('owner/one')
    queue.update(11, 7, { state: 'done' })
    await poll.poll('owner/one')
    expect(queue.get(11, 7)?.state).toBe('done')
  })
  it('refuses malformed issue pages without marking unseen jobs closed', async () => {
    const queue = new AutopilotQueue(store)
    queue.enqueue({ repository: 'owner/one', repositoryId: 11, issue: 7, state: 'queued' })
    const { commands } = cli({})
    commands.pages = (async (_schema: unknown, _path: string, tally?: { skipped: number }) => {
      if (tally) tally.skipped++
      return []
    }) as typeof commands.pages
    const poll = new AutopilotPoller({ store, queue, commands: () => commands, allowed: () => ['alice'], settings: () => settings() })
    await expect(poll.poll('owner/one')).rejects.toThrow('unreadable issue')
    expect(queue.get(11, 7)?.state).toBe('queued')
  })
  it('refuses an interrupted poll without marking unseen jobs closed', async () => {
    const { queue, poll } = poller({ 'owner/one': [listed(7)] })
    await poll.poll('owner/one')
    const controller = new AbortController()
    controller.abort()
    await expect(poll.poll('owner/one', controller.signal)).rejects.toThrow('interrupted')
    expect(queue.get(11, 7)?.state).toBe('queued')
  })
  it('reads each repository on its own, so one failure leaves the other\'s jobs alone', async () => {
    const queue = new AutopilotQueue(store)
    const { commands } = cli({}, undefined, { pages: () => { throw new Error('HTTP 502') } })
    const poll = new AutopilotPoller({ store, queue, commands: () => commands, allowed: () => ['alice'], settings: () => settings() })
    const { failures } = await poll.pollAll()
    expect(failures).toHaveLength(2)
    expect(queue.all()).toEqual([])
  })
  it('refuses a changed repository identity rather than reusing old jobs', async () => {
    const { poll, queue } = poller({ 'owner/one': [listed(7)] })
    await poll.poll('owner/one')
    const { commands } = cli({}, { id: 12, full_name: 'owner/one', default_branch: 'main' })
    const renamed = new AutopilotPoller({ store, queue, commands: () => commands, allowed: () => ['alice'], settings: () => settings() })
    await expect(renamed.poll('owner/one')).rejects.toThrow('Repository identity changed')
    expect(queue.get(11, 7)?.state).toBe('queued')
  })
  it('keeps polling the other repositories when one fails', async () => {
    const queue = new AutopilotQueue(store)
    let current = ''
    const { commands } = cli({}, undefined, { pages: path => {
      if (path.startsWith('issues') && current === 'owner/one') throw new Error('HTTP 502')
      return path.startsWith('issues') ? [listed(9)] : []
    } })
    const poll = new AutopilotPoller({ store, queue, commands: repository => {
      current = repository
      if (repository === 'owner/two') return cli({ 'owner/two': [listed(9)] }, { id: 12, full_name: 'owner/two', default_branch: 'main' }).commands
      return commands
    }, allowed: () => ['alice'], settings: () => settings() })
    const { results, failures } = await poll.pollAll()
    expect(failures.map(item => item.repository)).toEqual(['owner/one'])
    expect(results.map(item => item.repository)).toEqual(['owner/two'])
    expect(queue.all().map(job => job.repository)).toEqual(['owner/two'])
  })
  it('rechecks repository identity each time before reconciling its jobs', async () => {
    const { poll, asked } = poller({ 'owner/one': [listed(7)] })
    await poll.poll('owner/one')
    await poll.poll('owner/one')
    expect(asked.filter(path => path === '')).toHaveLength(2)
  })
  it('reads the labels whether GitHub returns names or objects', () => {
    expect(labelNames({ labels: ['autopilot', { name: 'bug' }] })).toEqual(['autopilot', 'bug'])
    expect(labelNames({ labels: null })).toEqual([])
  })
  it('turns a listed issue into an eligible one, and a pull request into nothing', () => {
    expect(eligibleIssue(listed(7), 'owner/one', 11)).toMatchObject({ issue: 7, author: 'alice', labels: ['autopilot'], repositoryId: 11 })
    expect(eligibleIssue(listed(7, { pull_request: {} }), 'owner/one')).toBeUndefined()
    expect(eligibleIssue(listed(7, { state: 'closed' }), 'owner/one')).toBeUndefined()
  })
})

describe('autopilot scheduler safety guard', () => {
  it('refuses to dispatch a job whose checkout is not its own repository, and records why', async () => {
    const queue = new AutopilotQueue(store)
    queue.enqueue({ repository: 'owner/one', repositoryId: 11, issue: 7, state: 'queued' })
    const receive = vi.fn()
    const trigger = vi.fn()
    const checkout = join(dir, 'checkout')
    mkdirSync(join(checkout, '.git'), { recursive: true })
    store.saveSettings(SettingsSchema.parse({ autopilot: settings() }))
    const pass = new AutopilotScheduler({ store, queue, receive, trigger, deliver: vi.fn(), facts: vi.fn(),
      verify: async () => { throw new Error('another repository') }, checkout: () => checkout,
      locks: new JobLocks(), paused: () => false, closing: () => false })
    const result = await pass.pass()
    expect(result.started).toEqual([])
    expect(result.errors.map(item => item.error)).toEqual(['another repository'])
    // Nothing was handed to the Engine, and the job records why it could not start.
    expect(receive).not.toHaveBeenCalled()
    expect(trigger).not.toHaveBeenCalled()
    expect(queue.get(11, 7)).toMatchObject({ state: 'failed', error: 'another repository' })
  })
  it('starts nothing while the autopilot is off, so a queued job waits rather than running', async () => {
    const queue = new AutopilotQueue(store)
    queue.enqueue({ repository: 'owner/one', repositoryId: 11, issue: 7, state: 'queued' })
    const receive = vi.fn()
    store.saveSettings(SettingsSchema.parse({ autopilot: settings({ enabled: false }) }))
    const pass = new AutopilotScheduler({ store, queue, receive, trigger: vi.fn(), deliver: vi.fn(), facts: vi.fn(), verify: vi.fn(),
      checkout: () => join(dir, 'checkout'), locks: new JobLocks(), paused: () => false, closing: () => false })
    expect((await pass.pass()).started).toEqual([])
    expect(receive).not.toHaveBeenCalled()
    expect(queue.get(11, 7)?.state).toBe('queued')
  })
})

describe('autopilot scheduler', () => {
  /** Records the accept Decision and the Ticket it created, as the Engine does when the main Session accepts. */
  const acceptTicket = (ticketId: string, triggerId: string) => {
    store.decisions.save({ id: `d-${ticketId}`, evalId: `e-${ticketId}`, threadKey: 'github:7', triggerIds: [triggerId], policyVersion: 'v',
      at: '2026-01-01T00:00:00Z', kind: 'accept', reason: [], strength: 'explicit', ticketId })
    store.tickets.save({ id: ticketId, title: 'Issue 7', decisionId: `d-${ticketId}`, mandate: { strength: 'explicit', policyVersion: 'v',
      basis: { via: 'autopilot', label: 'autopilot', issue: 7 }, actor: { source: 'github', id: 'alice' }, scope: 'fix' },
      channels: [], assignments: [], inputs: [], undelivered: [], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
      origin: { triggerId, triggerIds: [triggerId] } })
  }
  /** Records a ready report on a Ticket's running Assignment, which is when delivery may run. */
  const reportReady = (ticketId: string) => {
    const ticket = store.tickets.get(ticketId)!
    store.tickets.save({ ...ticket, assignments: [{ id: `a-${ticketId}`, state: 'running', createdAt: '2026-01-01T00:00:00Z',
      report: { state: 'ready', summary: 'Reworked the parser.', at: '2026-01-01T00:30:00Z' } }] })
  }
  const scheduler = (patch: Record<string, unknown> = {}, trigger: (job: { issue: number }) => Promise<Trigger | undefined> = async job => ({
    id: `trigger-${job.issue}`, source: 'github', threads: [{ source: 'github', id: String(job.issue) }], actor: { source: 'github', id: 'alice' },
    human: true, at: '2026-01-01T00:00:00Z', text: 'Fix it', meta: { number: job.issue, autopilot: 'autopilot' } }),
    deliver: (job: { issue: number }) => Promise<DeliveryResult> = async () => ({ pushed: true, commitSha: 'sha', prNumber: 5,
      prUrl: 'https://github.com/owner/one/pull/5', mergeSha: 'merge-sha' }),
    facts: (job: { issue: number }, ticket: { ended?: unknown } | undefined) => Promise<RecoveryFacts> = async (_job, ticket) =>
      ({ ticket: !!ticket, open: !!ticket && !ticket.ended, branch: true, commitLanded: false })) => {
    const queue = new AutopilotQueue(store)
    // The Engine stores a Trigger as it receives it, which is what the scheduler reads back.
    const receive = vi.fn((value: Trigger) => { store.triggers.save(value); return 'stored' })
    // The locks are real files inside a checkout, so a second holder is refused as it is in production.
    const checkout = join(dir, 'checkout')
    mkdirSync(join(checkout, '.git'), { recursive: true })
    const locks = new JobLocks()
    const pass = new AutopilotScheduler({ store, queue, receive, trigger, deliver, facts, verify: async () => {}, checkout: () => checkout, locks,
      paused: () => false, closing: () => false })
    store.saveSettings(SettingsSchema.parse({ autopilot: settings(patch) }))
    return { queue, pass, receive, locks }
  }
  it('starts a queued job by handing its Trigger to the Engine, and records it running', async () => {
    const { queue, pass, receive } = scheduler()
    queue.enqueue({ repository: 'owner/one', repositoryId: 11, issue: 7, state: 'queued' })
    const result = await pass.pass()
    expect(result.started.map(job => job.issue)).toEqual([7])
    expect(receive).toHaveBeenCalledOnce()
    expect(queue.get(11, 7)).toMatchObject({ state: 'running', triggerId: 'trigger-7', attempts: 1 })
  })
  it('starts nothing while processing is paused', async () => {
    const queue = new AutopilotQueue(store)
    const receive = vi.fn()
    store.saveSettings(SettingsSchema.parse({ autopilot: settings() }))
    const pass = new AutopilotScheduler({ store, queue, receive, trigger: async () => undefined, deliver: async () => ({ pushed: false }),
      facts: async () => ({ ticket: false, open: false, branch: false, commitLanded: false }), verify: async () => {}, checkout: () => '/srv/one',
      locks: new JobLocks(), paused: () => true, closing: () => false })
    queue.enqueue({ repository: 'owner/one', repositoryId: 11, issue: 7, state: 'queued' })
    expect((await pass.pass()).started).toEqual([])
    expect(receive).not.toHaveBeenCalled()
  })
  it('starts nothing while the autopilot is off', async () => {
    const { queue, pass, receive } = scheduler({ enabled: false })
    queue.enqueue({ repository: 'owner/one', repositoryId: 11, issue: 7, state: 'queued' })
    expect((await pass.pass()).started).toEqual([])
    expect(receive).not.toHaveBeenCalled()
  })
  it('skips a job whose issue no longer yields a Trigger', async () => {
    const { queue, pass, receive } = scheduler({}, async () => undefined)
    queue.enqueue({ repository: 'owner/one', repositoryId: 11, issue: 7, state: 'queued' })
    await pass.pass()
    expect(receive).not.toHaveBeenCalled()
    expect(queue.get(11, 7)).toMatchObject({ state: 'skipped' })
  })
  it('records a job failed when its Trigger cannot be built, so it does not hold the queue', async () => {
    const { queue, pass } = scheduler({}, async () => { throw new Error('HTTP 502') })
    queue.enqueue({ repository: 'owner/one', repositoryId: 11, issue: 7, state: 'queued' })
    const result = await pass.pass()
    expect(result.errors).toHaveLength(1)
    expect(queue.get(11, 7)).toMatchObject({ state: 'failed', error: 'HTTP 502' })
  })
  it('starts no more than the global limit in one pass', async () => {
    const { queue, pass } = scheduler({ maxConcurrentGlobal: 1, maxConcurrentPerRepo: 4 })
    queue.enqueue({ repository: 'owner/one', repositoryId: 11, issue: 7, state: 'queued' })
    queue.enqueue({ repository: 'owner/one', repositoryId: 11, issue: 8, state: 'queued' })
    expect((await pass.pass()).started).toHaveLength(1)
    expect(queue.get(11, 8)?.state).toBe('queued')
  })
  it('records the Ticket an accept created, and the outcome once it ended', async () => {
    const { queue, pass } = scheduler()
    queue.enqueue({ repository: 'owner/one', repositoryId: 11, issue: 7, state: 'queued' })
    await pass.pass()
    // The accept records a Decision naming the Ticket it created, which the scheduler reads back.
    store.decisions.save({ id: 'd1', evalId: 'e1', threadKey: 'github:7', triggerIds: ['trigger-7'], policyVersion: 'v', at: '2026-01-01T00:00:00Z',
      kind: 'accept', reason: [], strength: 'explicit', ticketId: 't1' })
    store.tickets.save({ id: 't1', title: 'Issue 7', decisionId: 'd1', mandate: { strength: 'explicit', policyVersion: 'v',
      basis: { via: 'autopilot', label: 'autopilot', issue: 7 }, actor: { source: 'github', id: 'alice' }, scope: 'fix' },
      channels: [], assignments: [], inputs: [], undelivered: [], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
      origin: { triggerId: 'trigger-7', triggerIds: ['trigger-7'] } })
    await pass.pass()
    expect(queue.get(11, 7)?.ticketId).toBe('t1')
    const ticket = store.tickets.get('t1')!
    store.tickets.save({ ...ticket, ended: { at: '2026-01-01T01:00:00Z', by: 'executor', outcome: 'merged' } })
    await pass.pass()
    expect(queue.get(11, 7)?.state).toBe('done')
  })
  it('records a job failed when its Ticket ended without a result', async () => {
    const { queue, pass } = scheduler()
    queue.enqueue({ repository: 'owner/one', repositoryId: 11, issue: 7, state: 'queued' })
    await pass.pass()
    store.decisions.save({ id: 'd1', evalId: 'e1', threadKey: 'github:7', triggerIds: ['trigger-7'], policyVersion: 'v', at: '2026-01-01T00:00:00Z',
      kind: 'accept', reason: [], strength: 'explicit', ticketId: 't1' })
    store.tickets.save({ id: 't1', title: 'Issue 7', decisionId: 'd1', mandate: { strength: 'explicit', policyVersion: 'v',
      basis: { via: 'autopilot', label: 'autopilot', issue: 7 }, actor: { source: 'github', id: 'alice' }, scope: 'fix' },
      channels: [], assignments: [], inputs: [], undelivered: [], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
      origin: { triggerId: 'trigger-7', triggerIds: ['trigger-7'] },
      ended: { at: '2026-01-01T01:00:00Z', by: 'executor', outcome: 'closed', reason: 'the pull request was closed unmerged' } })
    await pass.pass()
    expect(queue.get(11, 7)).toMatchObject({ state: 'failed', error: 'the pull request was closed unmerged' })
  })
  it('records a dropped Ticket as skipped, which needs no person', async () => {
    const { queue, pass } = scheduler()
    queue.enqueue({ repository: 'owner/one', repositoryId: 11, issue: 7, state: 'queued' })
    await pass.pass()
    store.decisions.save({ id: 'd1', evalId: 'e1', threadKey: 'github:7', triggerIds: ['trigger-7'], policyVersion: 'v', at: '2026-01-01T00:00:00Z',
      kind: 'accept', reason: [], strength: 'explicit', ticketId: 't1' })
    store.tickets.save({ id: 't1', title: 'Issue 7', decisionId: 'd1', mandate: { strength: 'explicit', policyVersion: 'v',
      basis: { via: 'autopilot', label: 'autopilot', issue: 7 }, actor: { source: 'github', id: 'alice' }, scope: 'fix' },
      channels: [], assignments: [], inputs: [], undelivered: [], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
      origin: { triggerId: 'trigger-7', triggerIds: ['trigger-7'] },
      ended: { at: '2026-01-01T01:00:00Z', by: 'executor', outcome: 'dropped' } })
    await pass.pass()
    expect(queue.get(11, 7)?.state).toBe('skipped')
  })
  it('leaves a running job alone while its Ticket is open, so a repeated pass changes nothing', async () => {
    const { queue, pass } = scheduler()
    queue.enqueue({ repository: 'owner/one', repositoryId: 11, issue: 7, state: 'queued' })
    await pass.pass()
    const before = queue.get(11, 7)!
    await pass.pass()
    expect(queue.get(11, 7)).toMatchObject({ state: 'running', attempts: before.attempts })
  })
  it('delivers a ready Ticket\'s work once, and records the pull request and merge commit', async () => {
    const { queue, pass } = scheduler()
    queue.enqueue({ repository: 'owner/one', repositoryId: 11, issue: 7, state: 'queued' })
    await pass.pass()
    acceptTicket('t1', 'trigger-7')
    reportReady('t1')
    await pass.pass()
    expect(queue.get(11, 7)).toMatchObject({ state: 'running', ticketId: 't1', branch: 'agent/issue-7', commitSha: 'sha',
      prNumber: 5, prUrl: 'https://github.com/owner/one/pull/5', mergeSha: 'merge-sha' })
  })
  it('delivers only once, so a repeated pass opens no second pull request', async () => {
    const deliver = vi.fn(async () => ({ pushed: true, prNumber: 5, mergeSha: 'merge-sha' }))
    const { queue, pass } = scheduler({}, undefined, deliver)
    queue.enqueue({ repository: 'owner/one', repositoryId: 11, issue: 7, state: 'queued' })
    await pass.pass()
    acceptTicket('t1', 'trigger-7')
    reportReady('t1')
    await pass.pass()
    await pass.pass()
    expect(deliver).toHaveBeenCalledOnce()
  })
  it('records why delivery stopped short of merging, and keeps the job running so a later pass retries', async () => {
    const { queue, pass } = scheduler({}, undefined, async () => ({ pushed: true, prNumber: 5, blocked: 'required checks are still running: build' }))
    queue.enqueue({ repository: 'owner/one', repositoryId: 11, issue: 7, state: 'queued' })
    await pass.pass()
    acceptTicket('t1', 'trigger-7')
    reportReady('t1')
    await pass.pass()
    expect(queue.get(11, 7)).toMatchObject({ state: 'running', prNumber: 5, error: 'required checks are still running: build' })
  })
  it('records a delivery failure on the job without losing the Ticket', async () => {
    const { queue, pass } = scheduler({}, undefined, async () => { throw new Error('the push was rejected') })
    queue.enqueue({ repository: 'owner/one', repositoryId: 11, issue: 7, state: 'queued' })
    await pass.pass()
    acceptTicket('t1', 'trigger-7')
    reportReady('t1')
    const result = await pass.pass()
    expect(result.errors.map(item => item.error)).toEqual(['the push was rejected'])
    expect(queue.get(11, 7)).toMatchObject({ state: 'running', ticketId: 't1', error: 'the push was rejected' })
  })
  it('settles a job whose pull request merged before the restart, without delivering again', async () => {
    const deliver = vi.fn(async () => ({ pushed: true }))
    const { queue, pass } = scheduler({}, undefined, deliver, async () => ({ ticket: true, open: false, branch: true, commitLanded: true,
      pull: { merged: true } }))
    queue.enqueue({ repository: 'owner/one', repositoryId: 11, issue: 7, state: 'queued' })
    await pass.pass()
    acceptTicket('t1', 'trigger-7')
    const decisions = await pass.recover()
    expect(decisions).toEqual([{ job: expect.objectContaining({ issue: 7 }), action: 'settle', reason: 'the pull request merged before the restart' }])
    expect(queue.get(11, 7)?.state).toBe('done')
    expect(deliver).not.toHaveBeenCalled()
  })
  it('fails a job whose Ticket is gone, rather than starting it over', async () => {
    const { queue, pass } = scheduler({}, undefined, undefined, async () => ({ ticket: false, open: false, branch: false, commitLanded: false }))
    queue.enqueue({ repository: 'owner/one', repositoryId: 11, issue: 7, state: 'queued' })
    await pass.pass()
    await pass.recover()
    expect(queue.get(11, 7)).toMatchObject({ state: 'failed', error: 'the ticket for this issue is gone' })
  })
  it('leaves a job whose Ticket is still open running, for the Executor to continue', async () => {
    const { queue, pass } = scheduler({}, undefined, undefined, async () => ({ ticket: true, open: true, branch: true, commitLanded: false }))
    queue.enqueue({ repository: 'owner/one', repositoryId: 11, issue: 7, state: 'queued' })
    await pass.pass()
    acceptTicket('t1', 'trigger-7')
    await pass.recover()
    expect(queue.get(11, 7)?.state).toBe('running')
  })
  it('requeues a job that had not started when the host stopped', async () => {
    const { queue, pass } = scheduler({}, undefined, undefined, async () => ({ ticket: false, open: false, branch: false, commitLanded: false }))
    queue.enqueue({ repository: 'owner/one', repositoryId: 11, issue: 7, state: 'queued' })
    await pass.recover()
    expect(queue.get(11, 7)?.state).toBe('queued')
  })
  it('starts no job whose lock another holder keeps', async () => {
    const { queue, pass, receive } = scheduler()
    queue.enqueue({ repository: 'owner/one', repositoryId: 11, issue: 7, state: 'queued' })
    // Another process holds the job's lock in the same checkout, so this pass leaves it for a later one.
    const other = new JobLocks()
    expect(other.tryAcquire(11, 7, join(dir, 'checkout'))).toBeDefined()
    expect((await pass.pass()).started).toEqual([])
    expect(receive).not.toHaveBeenCalled()
    expect(queue.get(11, 7)?.state).toBe('queued')
    await other.releaseAll()
  })
  it('starts nothing while a person has paused the job', async () => {
    const { queue, pass, receive } = scheduler()
    queue.enqueue({ repository: 'owner/one', repositoryId: 11, issue: 7, state: 'queued' })
    queue.pause(11, 7)
    expect((await pass.pass()).started).toEqual([])
    expect(receive).not.toHaveBeenCalled()
  })
})
