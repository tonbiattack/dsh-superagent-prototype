// The autopilot's recovery rules, its per-issue lock, and the pause, resume, skip and retry a person asks for.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Store } from '../src/app/store.ts'
import { AutopilotQueue } from '../src/app/autopilot-queue.ts'
import { JobLocks } from '../src/app/autopilot-locks.ts'
import { canPause, canResume, canSkip, recover, retryable, type RecoveryFacts } from '../src/app/autopilot-recovery.ts'

const facts = (patch: Partial<RecoveryFacts> = {}): RecoveryFacts => ({ ticket: true, open: false, branch: true, commitLanded: false, ...patch })
const job = (patch: Record<string, unknown> = {}) => ({ state: 'running' as const, ...patch })

describe('recovery', () => {
  it('settles a job whose pull request merged before the restart, whatever else is true', () => {
    expect(recover(job(), facts({ pull: { merged: true }, open: true }))).toEqual({ action: 'settle', state: 'done', reason: 'the pull request merged before the restart' })
  })
  it('requeues a job that had not started', () => {
    expect(recover(job({ state: 'queued' }), facts())).toEqual({ action: 'requeue', reason: 'the job had not started' })
  })
  it('resumes a job whose Ticket is still open, which the Executor continues', () => {
    expect(recover(job(), facts({ open: true }))).toEqual({ action: 'resume', reason: 'the ticket is still open' })
  })
  it('fails a job whose Ticket is gone, rather than starting over', () => {
    expect(recover(job(), facts({ ticket: false }))).toEqual({ action: 'fail', reason: 'the ticket for this issue is gone' })
  })
  it('resumes a job whose recorded commit is still the branch head, so only delivery is left', () => {
    expect(recover(job({ commitSha: 'abc' }), facts({ commitLanded: true }))).toEqual({ action: 'resume', reason: 'the commit landed; only delivery is left' })
  })
  it('resumes a job whose pull request is still open', () => {
    expect(recover(job({ prNumber: 5 }), facts({ pull: { merged: false } }))).toEqual({ action: 'resume', reason: 'the pull request is still open' })
  })
  it('fails a job whose branch is gone, so its work cannot be delivered', () => {
    expect(recover(job(), facts({ branch: false }))).toEqual({ action: 'fail', reason: 'the branch is gone, so the work cannot be delivered' })
  })
  it('fails a job whose Ticket ended without a result and whose commit is not on the branch', () => {
    expect(recover(job({ commitSha: 'abc' }), facts({ commitLanded: false }))).toEqual({ action: 'fail',
      reason: 'the ticket ended without a result and its commit is not on the branch' })
  })
  it('waits rather than failing a job whose branch could not be read', () => {
    expect(recover(job(), facts({ branch: 'unknown' }))).toEqual({ action: 'wait',
      reason: 'could not establish its branch; nothing was changed' })
  })
  it('waits rather than resuming a job whose commit could not be read', () => {
    expect(recover(job({ commitSha: 'abc' }), facts({ commitLanded: 'unknown' }))).toMatchObject({ action: 'wait' })
  })
  it('waits rather than settling a job whose pull request could not be read', () => {
    expect(recover(job({ prNumber: 5 }), facts({ pull: { merged: 'unknown' } }))).toMatchObject({ action: 'wait' })
  })
  it('still settles a job whose pull request is known to have merged, whatever else is unknown', () => {
    expect(recover(job(), facts({ pull: { merged: true }, branch: 'unknown', commitLanded: 'unknown' })))
      .toEqual({ action: 'settle', state: 'done', reason: 'the pull request merged before the restart' })
  })
  it('bounds automatic retries by the configured fix attempts', () => {
    expect(retryable({ attempts: 0 }, 3)).toBe(true)
    expect(retryable({ attempts: 3 }, 3)).toBe(false)
  })
})

describe('job commands', () => {
  it('lets a person pause a queued or running job, and resume only a paused one', () => {
    expect(canPause({ state: 'queued' })).toBe(true)
    expect(canPause({ state: 'running' })).toBe(true)
    expect(canPause({ state: 'paused' })).toBe(false)
    expect(canPause({ state: 'done' })).toBe(false)
    expect(canResume({ state: 'paused' })).toBe(true)
    expect(canResume({ state: 'running' })).toBe(false)
  })
  it('lets a person skip a job that has not finished', () => {
    expect(canSkip({ state: 'queued' })).toBe(true)
    expect(canSkip({ state: 'running' })).toBe(true)
    expect(canSkip({ state: 'paused' })).toBe(true)
    expect(canSkip({ state: 'done' })).toBe(false)
    expect(canSkip({ state: 'failed' })).toBe(false)
  })
})

describe('job locks', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'autopilot-locks-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })
  it('holds one lock per repository and issue, and refuses a second holder', async () => {
    const locks = new JobLocks(dir)
    expect(locks.tryAcquire('owner/one', 7)).toBeDefined()
    expect(locks.holds('owner/one', 7)).toBe(true)
    // A second holder of the same job is refused, which is what keeps two processes off one issue.
    expect(new JobLocks(dir).tryAcquire('owner/one', 7)).toBeUndefined()
    // Another issue is a different lock.
    expect(new JobLocks(dir).tryAcquire('owner/one', 8)).toBeDefined()
    await locks.releaseAll()
  })
  it('frees the lock on release, so the next holder takes it', async () => {
    const locks = new JobLocks(dir)
    locks.tryAcquire('owner/one', 7)
    await locks.release('owner/one', 7)
    expect(locks.holds('owner/one', 7)).toBe(false)
    expect(new JobLocks(dir).tryAcquire('owner/one', 7)).toBeDefined()
  })
  it('names the lock file after the repository and issue, so a person can see which job holds it', () => {
    expect(new JobLocks(dir).path('owner/one', 7)).toContain('owner_one-issue-7.lock')
  })
  it('releases every lock it holds, which shutdown does', async () => {
    const locks = new JobLocks(dir)
    locks.tryAcquire('owner/one', 7)
    locks.tryAcquire('owner/two', 9)
    await locks.releaseAll()
    expect(locks.holds('owner/one', 7)).toBe(false)
    expect(locks.holds('owner/two', 9)).toBe(false)
  })
})

describe('queue commands', () => {
  let dir: string
  let store: Store
  let queue: AutopilotQueue
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'autopilot-cmd-'))
    store = new Store(join(dir, 'db.sqlite'))
    queue = new AutopilotQueue(store)
  })
  afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })
  it('pauses and resumes a queued job without starting another worker', () => {
    queue.enqueue({ repository: 'owner/one', issue: 7, state: 'queued' })
    expect(queue.pause('owner/one', 7)?.state).toBe('paused')
    expect(queue.resume('owner/one', 7)).toMatchObject({ state: 'queued' })
  })
  it('refuses to pretend it stopped a running worker', () => {
    queue.enqueue({ repository: 'owner/one', issue: 7, state: 'running', ticketId: 't1' })
    expect(() => queue.pause('owner/one', 7)).toThrow('running worker')
    expect(() => queue.skip('owner/one', 7)).toThrow('running worker')
    expect(queue.get('owner/one', 7)?.state).toBe('running')
  })
  it('refuses to retry a job that already has execution evidence', () => {
    queue.enqueue({ repository: 'owner/one', issue: 7, state: 'failed', ticketId: 't1' })
    expect(() => queue.retry('owner/one', 7)).toThrow('prior execution')
  })
  it('refuses to pause a job that already finished', () => {
    queue.enqueue({ repository: 'owner/one', issue: 7, state: 'done' })
    expect(() => queue.pause('owner/one', 7)).toThrow('A done job cannot be paused')
  })
  it('refuses to resume a job that is not paused', () => {
    queue.enqueue({ repository: 'owner/one', issue: 7, state: 'running' })
    expect(() => queue.resume('owner/one', 7)).toThrow('A running job cannot be resumed')
  })
  it('skips a job with the reason a person gave', () => {
    queue.enqueue({ repository: 'owner/one', issue: 7, state: 'queued' })
    expect(queue.skip('owner/one', 7, 'not wanted')).toMatchObject({ state: 'skipped', error: 'not wanted' })
  })
  it('retries a failed job, starting its attempts again so the bound does not refuse it', () => {
    queue.enqueue({ repository: 'owner/one', issue: 7, state: 'failed', attempts: 3 })
    expect(queue.retry('owner/one', 7)).toMatchObject({ state: 'queued', attempts: 0 })
  })
  it('answers undefined for a job that does not exist', () => {
    expect(queue.pause('owner/one', 99)).toBeUndefined()
    expect(queue.resume('owner/one', 99)).toBeUndefined()
    expect(queue.skip('owner/one', 99)).toBeUndefined()
    expect(queue.retry('owner/one', 99)).toBeUndefined()
  })
})
