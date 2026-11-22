// The autopilot's rules: eligibility, the queue's capacity and order, and the branch a job commits to.
import { describe, expect, it } from 'vitest'
import { AutopilotConfigSchema } from '../src/policy.ts'
import { active, branchAllowed, eligible, hasCapacity, ineligibleReason, jobBranch, jobKey, mayRetry, nextJob, repositoryOf, sameRepo,
  terminal, type AutopilotJob } from '../src/autopilot.ts'
import { AUTOPILOT_ID_PREFIX, autopilotTrigger, fromAutopilot, issueTrigger } from '../src/sources/github-trigger.ts'

const settings = (patch: Record<string, unknown> = {}) => AutopilotConfigSchema.parse({ enabled: true, repositories: [{ fullName: 'owner/one', checkout: '/srv/one' }], ...patch })
const job = (issue: number, patch: Partial<AutopilotJob> = {}): AutopilotJob => ({ repository: 'owner/one', repositoryId: 11, issue, state: 'queued',
  attempts: 0, createdAt: `2026-01-01T00:00:${String(issue).padStart(2, '0')}Z`, updatedAt: '2026-01-01T00:00:00Z', ...patch })
const issue = (patch: Record<string, unknown> = {}) => ({ repository: 'owner/one', issue: 7, title: 'Fix it', author: 'alice', url: 'https://github.com/owner/one/issues/7',
  createdAt: '2026-01-01T00:00:00Z', labels: ['autopilot'], ...patch })

describe('autopilot eligibility', () => {
  it('takes up an issue that carries the label and was written by an allowed account', () => {
    expect(eligible(issue(), settings(), ['alice'])).toBe(true)
    expect(ineligibleReason(issue(), settings(), ['alice'])).toBeUndefined()
  })
  it('refuses an issue without the label, and says why', () => {
    expect(eligible(issue({ labels: ['bug'] }), settings(), ['alice'])).toBe(false)
    expect(ineligibleReason(issue({ labels: ['bug'] }), settings(), ['alice'])).toBe('no autopilot label')
  })
  it('refuses an issue whose author may not originate work, and says why', () => {
    expect(eligible(issue(), settings(), ['bob'])).toBe(false)
    expect(ineligibleReason(issue(), settings(), ['bob'])).toBe('alice may not originate work')
  })
  it('matches the label and the author without regard to case, as GitHub does', () => {
    expect(eligible(issue({ labels: ['AutoPilot'], author: 'Alice' }), settings(), ['ALICE'])).toBe(true)
  })
  it('never accepts an unlisted author, even if an old setting disables the check', () => {
    expect(eligible(issue({ author: 'stranger' }), settings({ requireAllowedActor: false }), [])).toBe(false)
  })
  it('honours a configured label rather than the default', () => {
    expect(eligible(issue({ labels: ['ai'] }), settings({ eligibleLabel: 'ai' }), ['alice'])).toBe(true)
    expect(eligible(issue(), settings({ eligibleLabel: 'ai' }), ['alice'])).toBe(false)
  })
})

describe('autopilot trigger identity', () => {
  it('marks a Trigger the autopilot built, so the gate can tell it from one that merely claims the label', () => {
    const issue = { number: 7, title: 'Fix it', body: 'Please fix', user: { login: 'alice' }, created_at: '2026-01-01T00:00:00Z',
      html_url: 'https://github.com/owner/one/issues/7', updated_at: '2026-01-02T00:00:00Z' }
    const trigger = autopilotTrigger(issue, 'autopilot', 'agent-bot')
    expect(fromAutopilot(trigger)).toBe(true)
    expect(trigger.id.startsWith(AUTOPILOT_ID_PREFIX)).toBe(true)
    // The same revision is the same Trigger, so a repeated poll is a duplicate rather than new work.
    expect(autopilotTrigger(issue, 'autopilot', 'agent-bot').id).toBe(trigger.id)
    // An edit is a new Trigger, so a re-labelled or changed issue is taken up again.
    expect(autopilotTrigger({ ...issue, updated_at: '2026-01-03T00:00:00Z' }, 'autopilot', 'agent-bot').id).not.toBe(trigger.id)
    // An ordinary Issue Trigger is not one the autopilot built.
    expect(fromAutopilot(issueTrigger(issue, 'agent-bot'))).toBe(false)
  })
})

describe('autopilot queue', () => {
  it('keys a job by the repository\'s immutable ID and the issue, so a rename keeps it and two repositories differ', () => {
    expect(jobKey(11, 7)).toBe('11#7')
    expect(jobKey(12, 7)).not.toBe(jobKey(11, 7))
  })
  it('compares repository names without regard to case', () => {
    expect(sameRepo('Owner/One', 'owner/one')).toBe(true)
  })
  it('starts the oldest queued job first', () => {
    const jobs = [job(3), job(1), job(2)]
    expect(nextJob(jobs, settings())?.issue).toBe(1)
  })
  it('starts nothing beyond the global limit', () => {
    const jobs = [job(1, { state: 'running' }), job(2)]
    expect(nextJob(jobs, settings({ maxConcurrentGlobal: 1, maxConcurrentPerRepo: 4 }))).toBeUndefined()
    expect(nextJob(jobs, settings({ maxConcurrentGlobal: 2, maxConcurrentPerRepo: 4 }))?.issue).toBe(2)
  })
  it('starts nothing beyond a repository\'s own limit, and lets another repository run meanwhile', () => {
    const jobs = [job(1, { state: 'running' }), job(2), job(3, { repository: 'owner/two' })]
    const limited = settings({ maxConcurrentGlobal: 4, maxConcurrentPerRepo: 1, repositories: [{ fullName: 'owner/one', checkout: '' }, { fullName: 'owner/two', checkout: '' }] })
    // owner/one is full, so the oldest job that may start is owner/two's.
    expect(nextJob(jobs, limited)?.repository).toBe('owner/two')
    expect(hasCapacity(jobs, 'owner/one', limited)).toBe(false)
    expect(hasCapacity(jobs, 'owner/two', limited)).toBe(true)
  })
  it('counts only queued and running jobs as active', () => {
    expect(active(job(1))).toBe(true)
    expect(active(job(1, { state: 'running' }))).toBe(true)
    expect(active(job(1, { state: 'done' }))).toBe(false)
    expect(terminal(job(1, { state: 'failed' }))).toBe(true)
    expect(terminal(job(1, { state: 'queued' }))).toBe(false)
  })
  it('bounds automatic retries by the configured fix attempts', () => {
    expect(mayRetry(job(1, { attempts: 0 }), settings({ maxFixAttempts: 3 }))).toBe(true)
    expect(mayRetry(job(1, { attempts: 2 }), settings({ maxFixAttempts: 3 }))).toBe(true)
    expect(mayRetry(job(1, { attempts: 3 }), settings({ maxFixAttempts: 3 }))).toBe(false)
  })
})

describe('autopilot repository and branch', () => {
  it('finds the configured checkout for a job\'s repository', () => {
    expect(repositoryOf('owner/one', settings())?.checkout).toBe('/srv/one')
    expect(repositoryOf('owner/gone', settings())).toBeUndefined()
  })
  it('names the branch after the issue, with the ticket short name last', () => {
    expect(jobBranch(123)).toBe('agent/issue-123')
    expect(jobBranch(123).split('/').at(-1)).toBe('issue-123')
  })
  it('refuses the default branch, whatever its name, and an empty branch', () => {
    expect(branchAllowed('agent/issue-1', 'main')).toBe(true)
    expect(branchAllowed('main', 'main')).toBe(false)
    expect(branchAllowed('Main', 'main')).toBe(false)
    expect(branchAllowed('trunk', 'trunk')).toBe(false)
    expect(branchAllowed('', 'main')).toBe(false)
  })
})
