/**
 * The autopilot's durable job queue: one record per repository and issue, written only here.
 * Jobs survive a restart, so a poll that runs again finds the work it already queued instead of duplicating it.
 */
import { KV } from '../kv.ts'
import type { Store } from './store.ts'
import { canPause, canResume, canSkip } from './autopilot-recovery.ts'
import { jobKey, type AutopilotJob, type AutopilotState } from '../autopilot.ts'

/** What a caller may change about a job; the key and creation time stay as first recorded. */
export type JobPatch = Partial<Omit<AutopilotJob, 'repository' | 'issue' | 'createdAt'>>

/**
 * Reads and writes autopilot jobs. Every write is one transaction, so a job's state and the facts that explain it
 * change together, and a restart never sees half an update.
 */
export class AutopilotQueue {
  constructor(private readonly store: Pick<Store, 'get' | 'set' | 'delete' | 'keys' | 'atomic'>) {}

  /** Every job, oldest first, which is the order the scheduler starts them in. */
  all(): AutopilotJob[] {
    return this.store.keys(KV.autopilot.job).flatMap(name => {
      const job = this.store.get(name as ReturnType<typeof KV.autopilot.job>)
      return job ? [job] : []
    }).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.issue - b.issue)
  }
  /** The job for one repository and issue, if it was ever queued. */
  get(repository: string, issue: number): AutopilotJob | undefined {
    return this.store.get(KV.autopilot.job(jobKey(repository, issue)))
  }
  /** Jobs in the given states, oldest first. */
  inStates(...states: AutopilotState[]): AutopilotJob[] {
    return this.all().filter(job => states.includes(job.state))
  }
  /**
   * Records a job for an issue, or returns the one already recorded for it.
   * A job that exists is never replaced, so a repeated poll cannot reset work in progress or a recorded failure.
   */
  enqueue(job: Omit<AutopilotJob, 'attempts' | 'createdAt' | 'updatedAt'> & { attempts?: number }): { job: AutopilotJob; created: boolean } {
    return this.store.atomic(() => {
      const existing = this.get(job.repository, job.issue)
      if (existing) return { job: existing, created: false }
      const at = new Date().toISOString()
      const created: AutopilotJob = { ...job, attempts: job.attempts ?? 0, createdAt: at, updatedAt: at }
      this.store.set(KV.autopilot.job(jobKey(job.repository, job.issue)), created)
      return { job: created, created: true }
    })
  }
  /**
   * Applies `patch` to a job in one transaction.
   * @returns the updated job, or undefined when no job exists for that repository and issue.
   */
  update(repository: string, issue: number, patch: JobPatch): AutopilotJob | undefined {
    return this.store.atomic(() => {
      const current = this.get(repository, issue)
      if (!current) return undefined
      const updated: AutopilotJob = { ...current, ...patch, updatedAt: new Date().toISOString() }
      this.store.set(KV.autopilot.job(jobKey(repository, issue)), updated)
      return updated
    })
  }
  /**
   * Moves a job to a state, recording why when it failed or was skipped.
   * @returns the updated job, or undefined when no job exists.
   */
  setState(repository: string, issue: number, state: AutopilotState, error?: string): AutopilotJob | undefined {
    return this.update(repository, issue, { state, ...error === undefined ? {} : { error } })
  }
  /**
   * Counts one dispatch attempt, which bounds automatic retries.
   * @returns the updated job, or undefined when no job exists.
   */
  attempted(repository: string, issue: number): AutopilotJob | undefined {
    const current = this.get(repository, issue)
    return current && this.update(repository, issue, { attempts: current.attempts + 1 })
  }
  /** Removes a job, so a later poll may queue the issue again; a person's explicit retry uses this. */
  forget(repository: string, issue: number): void {
    this.store.delete(KV.autopilot.job(jobKey(repository, issue)))
  }
  /**
   * Pause a queued job. Running jobs are refused because their worker cannot yet be paused safely here.
   * @returns the updated job, or undefined when no job exists.
   * @throws when the job is not in a state a person may pause.
   */
  pause(repository: string, issue: number): AutopilotJob | undefined {
    const current = this.get(repository, issue)
    if (!current) return undefined
    if (!canPause(current)) throw new Error(`A ${current.state} job cannot be paused`)
    if (current.state === 'running') throw new Error('A running worker cannot be safely paused from the queue; use the ticket controls')
    return this.update(repository, issue, { state: 'paused' })
  }
  /**
   * A person resumes a job they paused, which queues it again.
   * @returns the updated job, or undefined when no job exists.
   * @throws when the job is not paused.
   */
  resume(repository: string, issue: number): AutopilotJob | undefined {
    const current = this.get(repository, issue)
    if (!current) return undefined
    if (!canResume(current)) throw new Error(`A ${current.state} job cannot be resumed`)
    if (current.triggerId || current.ticketId || current.commitSha || current.prNumber) {
      throw new Error('Cannot requeue a paused job with prior execution; reconcile its ticket and Git state first')
    }
    return this.update(repository, issue, { state: 'queued', error: undefined })
  }
  /**
   * Skip a queued or paused job. Running jobs are refused until worker cancellation is coordinated.
   * @returns the updated job, or undefined when no job exists.
   * @throws when the job is already finished.
   */
  skip(repository: string, issue: number, reason = 'skipped by a person'): AutopilotJob | undefined {
    const current = this.get(repository, issue)
    if (!current) return undefined
    if (!canSkip(current)) throw new Error(`A ${current.state} job cannot be skipped`)
    if (current.state === 'running') throw new Error('A running worker cannot be safely skipped from the queue; stop the ticket first')
    return this.update(repository, issue, { state: 'skipped', error: reason })
  }
  /**
   * A person retries a failed or skipped job: its attempts start again, so the automatic bound does not refuse it.
   * @returns the updated job, or undefined when no job exists.
   */
  retry(repository: string, issue: number): AutopilotJob | undefined {
    const current = this.get(repository, issue)
    if (!current) return undefined
    if (current.state !== 'failed' && current.state !== 'skipped') throw new Error(`A ${current.state} job cannot be retried`)
    if (current.triggerId || current.ticketId || current.commitSha || current.prNumber) {
      throw new Error('Cannot requeue a job with prior execution; reconcile its ticket and Git state first')
    }
    return this.update(repository, issue, { state: 'queued', attempts: 0, error: undefined })
  }
}
