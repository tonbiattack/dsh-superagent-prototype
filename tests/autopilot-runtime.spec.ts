// The autopilot end to end on a real Runtime: an Issue a listed account labelled becomes a Ticket, and nothing else does.
//
// The unit tests cover each part; this covers the wiring between them, which is where a feature like this actually breaks:
// the poller queues a job, the scheduler proves the checkout, reads the Issue back, hands its Trigger to the Engine, the
// main Session assesses it, and the accept creates the Ticket.
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { Commands } from '../src/infra/commands.ts'
import { AutopilotConfigSchema } from '../src/policy.ts'
import { startRuntime, type Host } from './fixtures/host.ts'

let h: Host | undefined
let checkout: string | undefined
afterEach(async () => {
  await h?.stop(); h = undefined
  if (checkout) rmSync(checkout, { recursive: true, force: true })
  checkout = undefined
})

/** An open Issue carrying the eligibility label, as `issues/<n>` returns it. */
const issue = (number: number, login = 'alice', labels = ['autopilot']) => ({ id: 1000 + number, number, title: `Fix ${number}`,
  body: 'Please fix it', state: 'open', html_url: `https://github.com/acme/widgets/issues/${number}`, created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z', user: { login }, labels: labels.map(name => ({ name })) })

/**
 * Turns the autopilot on for a checkout of the fixture's repository, and answers the reads a dispatch makes: the Issue
 * itself, and the Git commands that prove the checkout belongs to that repository.
 */
async function enabled(patch: Record<string, unknown> = {}, listed: ReturnType<typeof issue> | undefined = issue(7)) {
  checkout = mkdtempSync(join(tmpdir(), 'autopilot-checkout-'))
  mkdirSync(join(checkout, '.git'), { recursive: true })
  const host = h = await startRuntime()
  // `startRuntime` installs its own `gh` and `run` spies, so the checkout's answers are installed after it, or they are
  // overwritten and every read falls back to the fixture's repository.
  // `Commands.git` runs `git` through `run`, so the checkout's own commands are answered there.
  const git = async (args: string[], cwd?: string) => {
    // `rev-parse --show-toplevel` proves the directory is a checkout; `remote get-url origin` proves whose it is.
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return `${cwd ?? checkout}\n`
    // A worktree is on the branch it was created for, which is what the job's work commits to.
    if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return 'agent/issue-7\n'
    if (args[0] === 'rev-parse') return ''
    if (args[0] === 'remote') return 'https://github.com/acme/widgets.git\n'
    // A clean checkout, so a worktree may be created from it.
    if (args[0] === 'status') return ''
    return ''
  }
  vi.spyOn(Commands.prototype, 'git').mockImplementation(git)
  // `Commands.gh` runs the CLI through `run`, and `startRuntime` fixes `run` for its own checks, so both are answered here.
  const asked: string[] = []
  const gh = async (args: string[]) => {
    asked.push(args.join(' '))
    // `gh api <path>`: the path follows `api`, and is `repos/<owner>/<name>` for the repository itself.
    const path = args[1] ?? ''
    if (path === 'user') return { login: 'agent-bot' }
    // A paged list is asked for with `--slurp`, so GitHub's answer is an array of pages.
    if (args.includes('--slurp')) {
      // An Issue's events record who applied its label, which the poller requires to be a listed account.
      if (path.includes('/events')) return [[{ event: 'labeled', actor: { login: 'alice' }, label: { name: 'autopilot' } }]]
      // The open-issue list is what the poller reconciles the queue against, so it must agree with the Issue a dispatch reads.
      return [listed && listed.state === 'open' ? [listed] : []]
    }
    // A single Issue, which a dispatch reads back before it starts.
    if (path.includes('/issues/')) return listed ?? { message: 'Not Found' }
    // The immutable ID and default branch the poller and delivery read; each repository has its own.
    const id = path.includes('acme/gadgets') ? 12 : 11
    return { id, full_name: path.includes('acme/gadgets') ? 'acme/gadgets' : 'acme/widgets', default_branch: 'master',
      permissions: { push: true } }
  }
  // `Commands.gh` parses the CLI's JSON, so the fake answers with the object and `run` serialises it.
  vi.spyOn(Commands.prototype, 'gh').mockImplementation(gh)
  vi.spyOn(Commands.prototype, 'run').mockImplementation(async (program: string, args: string[], cwd?: string) => {
    if (program === 'git') return git(args, cwd)
    // The agent's GitHub CLI, which `gh` parses as JSON; the fixture's CLI path is `/bin/false`, so the program is not `gh`.
    if (args[0] === 'api') return JSON.stringify(await gh(args))
    return '{"ok":true,"data":{}}'
  })
  ;(globalThis as { autopilotAsked?: string[] }).autopilotAsked = asked
  const settings = host.runtime.store.settings()
  host.runtime.store.saveSettings({ ...settings, autopilot: AutopilotConfigSchema.parse({ enabled: true,
    repositories: [{ fullName: 'acme/widgets', checkout }], eligibleLabel: 'autopilot', validationCommand: 'true', ...patch }) })
  return { host, queue: host.runtime.autopilotQueue }
}

it('turns an Issue a listed account labelled into a Ticket, without a person routing it', async () => {
  const { host, queue } = await enabled()
  queue.enqueue({ repository: 'acme/widgets', repositoryId: 11, issue: 7, state: 'queued' })
  const result = await host.runtime.autopilot.tick()
  // The dispatch records why it could not start, which is what a person reads when it does not.
  expect({ errors: result.dispatch.errors.map(item => item.error), asked: (globalThis as { autopilotAsked?: string[] }).autopilotAsked })
    .toEqual({ errors: [], asked: expect.arrayContaining([expect.stringContaining('api')]) })
  expect(result.dispatch.started.map(job => job.issue)).toEqual([7])  // The Trigger reached the Engine, which queued it for Eval; the job records the Trigger it created.
  const job = queue.get(11, 7)!
  expect(job).toMatchObject({ state: 'running', triggerId: expect.any(String) })
  expect(host.runtime.store.triggers.get(job.triggerId!)).toMatchObject({ source: 'github', actor: { id: 'alice' } })
})

it('skips a queued job whose Issue closed before it started, rather than starting it', async () => {
  const { host, queue } = await enabled({}, { ...issue(7), state: 'closed' })
  queue.enqueue({ repository: 'acme/widgets', repositoryId: 11, issue: 7, state: 'queued' })
  const result = await host.runtime.autopilot.tick()
  expect(result.dispatch.started).toEqual([])
  expect(queue.get(11, 7)).toMatchObject({ state: 'skipped' })
  expect(host.runtime.store.tickets.open()).toEqual([])
})

it('skips a queued job whose Issue lost the label before it started', async () => {
  const { host, queue } = await enabled({}, issue(7, 'alice', ['bug']))
  queue.enqueue({ repository: 'acme/widgets', repositoryId: 11, issue: 7, state: 'queued' })
  await host.runtime.autopilot.tick()
  expect(queue.get(11, 7)).toMatchObject({ state: 'skipped' })
})

it('starts nothing while the autopilot is off, so a queued job waits', async () => {
  const { host, queue } = await enabled({ enabled: false })
  queue.enqueue({ repository: 'acme/widgets', repositoryId: 11, issue: 7, state: 'queued' })
  const result = await host.runtime.autopilot.tick()
  expect(result.dispatch.started).toEqual([])
  expect(queue.get(11, 7)?.state).toBe('queued')
})

it('does not queue the same Issue twice when the poll runs again', async () => {
  const { queue } = await enabled()
  queue.enqueue({ repository: 'acme/widgets', repositoryId: 11, issue: 7, state: 'queued' })
  const first = queue.all().length
  // A second poll of the same Issue finds the job it already recorded, so no second Ticket can come of it.
  queue.enqueue({ repository: 'acme/widgets', repositoryId: 11, issue: 7, state: 'queued' })
  expect(queue.all()).toHaveLength(first)
})

it('runs two repositories independently, each in its own checkout', async () => {
  // Two repositories with the same issue number: the jobs must not collide, and each must be proven against its own
  // checkout, which is what keeps work from landing in the wrong repository.
  const second = mkdtempSync(join(tmpdir(), 'autopilot-checkout-two-'))
  mkdirSync(join(second, '.git'), { recursive: true })
  // The first checkout is made here, not inside `enabled`, because the settings name it before `enabled` runs.
  const first = mkdtempSync(join(tmpdir(), 'autopilot-checkout-one-'))
  mkdirSync(join(first, '.git'), { recursive: true })
  const { host, queue } = await enabled({ maxConcurrentGlobal: 2, maxConcurrentPerRepo: 1,
    repositories: [{ fullName: 'acme/widgets', checkout: first }, { fullName: 'acme/gadgets', checkout: second }] })
  // Each repository's own remote, so a checkout of one is refused for the other. `git` takes its directory as `cwd`.
  vi.spyOn(Commands.prototype, 'git').mockImplementation(async (args: string[], cwd: string) => {
    const gadgets = cwd === second
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return `${cwd}\n`
    // A worktree is on the branch it was created for, which is what the job's work commits to.
    if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return 'agent/issue-7\n'
    if (args[0] === 'rev-parse') return ''
    if (args[0] === 'remote') return `https://github.com/${gadgets ? 'acme/gadgets' : 'acme/widgets'}.git\n`
    return ''
  })
  // `Commands.git` runs `git` through `run`, so the same answers are installed there, after `enabled` fixed `run`.
  vi.spyOn(Commands.prototype, 'run').mockImplementation(async (program: string, args: string[], cwd?: string) => {
    if (program !== 'git') return '{"ok":true,"data":{}}'
    const gadgets = cwd === second
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return `${cwd}\n`
    if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return 'agent/issue-7\n'
    if (args[0] === 'rev-parse') return ''
    if (args[0] === 'remote') return `https://github.com/${gadgets ? 'acme/gadgets' : 'acme/widgets'}.git\n`
    return ''
  })
  queue.enqueue({ repository: 'acme/widgets', repositoryId: 11, issue: 7, state: 'queued' })
  queue.enqueue({ repository: 'acme/gadgets', repositoryId: 12, issue: 7, state: 'queued' })
  // The scheduling pass alone, because the poller would reconcile the queue against the fake's issue list, which names
  // only one repository; what this covers is that two repositories dispatch independently.
  const result = await (host.runtime.autopilot as unknown as { host: { scheduler: { pass: () => Promise<{ started: { repositoryId: number }[];
    errors: { error: string }[] }> } } }).host.scheduler.pass()
  // The lock lives in each checkout, so both must be able to take theirs.
  const locks = (host.runtime as unknown as { autopilotLocks: { holds: (id: number, issue: number) => boolean } }).autopilotLocks
  const files = [first, second].map(dir => {
    try { return readdirSync(join(dir, '.git', 'dsh-superagent-autopilot')).join(',') } catch { return 'missing' }
  })
  expect({ errors: result.errors.map(item => item.error), started: result.started.map(job => job.repositoryId),
    held: [locks.holds(11, 7), locks.holds(12, 7)], files }).toEqual({ errors: [], started: [11, 12], held: [true, true],
    files: ['11-issue-7.lock.lock', '12-issue-7.lock.lock'] })
  // Both started, and each job kept its own repository: the same issue number is two jobs, not one.
  expect(result.started.map(job => job.repositoryId).sort()).toEqual([11, 12])
  expect(queue.get(11, 7)).toMatchObject({ repository: 'acme/widgets', state: 'running' })
  expect(queue.get(12, 7)).toMatchObject({ repository: 'acme/gadgets', state: 'running' })
  rmSync(second, { recursive: true, force: true }); rmSync(first, { recursive: true, force: true })
})
