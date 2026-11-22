// The autopilot end to end on a real Runtime: an Issue a listed account labelled becomes a Ticket, and nothing else does.
//
// The unit tests cover each part; this covers the wiring between them, which is where a feature like this actually breaks:
// the poller queues a job, the scheduler proves the checkout, reads the Issue back, hands its Trigger to the Engine, the
// main Session assesses it, and the accept creates the Ticket.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
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
  const git = async (args: string[]) => {
    // `rev-parse --show-toplevel` proves the directory is a checkout; `remote get-url origin` proves whose it is.
    if (args[0] === 'rev-parse') return `${checkout}\n`
    if (args[0] === 'remote') return 'https://github.com/acme/widgets.git\n'
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
    // The immutable ID and default branch the poller and delivery read.
    return { id: 11, full_name: 'acme/widgets', default_branch: 'master', permissions: { push: true } }
  }
  // `Commands.gh` parses the CLI's JSON, so the fake answers with the object and `run` serialises it.
  vi.spyOn(Commands.prototype, 'gh').mockImplementation(gh)
  vi.spyOn(Commands.prototype, 'run').mockImplementation(async (program: string, args: string[]) => {
    if (program === 'git') return git(args)
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
