/**
 * The autopilot's durable job queue: one record per repository and issue, written only here.
 * Jobs survive a restart, so a poll that runs again finds the work it already queued instead of duplicating it.
 *
 * A job is keyed by GitHub's immutable repository ID and the issue number, so renaming a repository keeps its jobs and
 * cannot make the same issue look like a new one. The repository's name is a field a poll refreshes.
 */
import { KV } from '../kv.ts'
import type { Store } from './store.ts'
import { canPause, canResume, canSkip } from './autopilot-recovery.ts'
import { jobKey, sameRepo, type AutopilotJob, type AutopilotState } from '../autopilot.ts'

/** What a caller may change about a job; the key and creation time stay as first recorded. */
export type JobPatch = Partial<Omit<AutopilotJob, 'repositoryId' | 'issue' | 'createdAt'>>

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
  get(repositoryId: number, issue: number): AutopilotJob | undefined {
    return this.store.get(KV.autopilot.job(jobKey(repositoryId, issue)))
  }
  /**
   * The job for a repository the operator names, which the panel and a person's commands use.
   * A name is not the key, so this resolves it to the job's immutable ID first.
   */
  named(repository: string, issue: number): AutopilotJob | undefined {
    return this.all().find(job => job.issue === issue && sameRepo(job.repository, repository))
  }
  /** Jobs in the given states, oldest first. */
  inStates(...states: AutopilotState[]): AutopilotJob[] {
    return this.all().filter(job => states.includes(job.state))
  }
  /**
   * Records a job for an issue, or returns the one already recorded for it.
   * A job that exists is never replaced, so a repeated poll cannot reset work in progress or a recorded failure; only
   * the repository's name is refreshed, because a rename must not lose the job.
   */
  enqueue(job: Omit<AutopilotJob, 'attempts' | 'createdAt' | 'updatedAt'> & { attempts?: number }): { job: AutopilotJob; created: boolean } {
    return this.store.atomic(() => {
      const existing = this.get(job.repositoryId, job.issue)
      if (existing) {
        if (existing.repository === job.repository) return { job: existing, created: false }
        return { job: this.update(job.repositoryId, job.issue, { repository: job.repository })!, created: false }
      }
      const at = new Date().toISOString()
      const created: AutopilotJob = { ...job, attempts: job.attempts ?? 0, createdAt: at, updatedAt: at }
      this.store.set(KV.autopilot.job(jobKey(job.repositoryId, job.issue)), created)
      return { job: created, created: true }
    })
  }
  /**
   * Applies `patch` to a job in one transaction.
   * @returns the updated job, or undefined when no job exists for that repository and issue.
   */
  update(repositoryId: number, issue: number, patch: JobPatch): AutopilotJob | undefined {
    return this.store.atomic(() => {
      const current = this.get(repositoryId, issue)
      if (!current) return undefined
      const updated: AutopilotJob = { ...current, ...patch, updatedAt: new Date().toISOString() }
      this.store.set(KV.autopilot.job(jobKey(repositoryId, issue)), updated)
      return updated
    })
  }
  /**
   * Moves a job to a state, recording why when it failed or was skipped.
   * @returns the updated job, or undefined when no job exists.
   */
  setState(repositoryId: number, issue: number, state: AutopilotState, error?: string): AutopilotJob | undefined {
    return this.update(repositoryId, issue, { state, ...error === undefined ? {} : { error } })
  }
  /**
   * Counts one dispatch attempt, which bounds automatic retries.
   * @returns the updated job, or undefined when no job exists.
   */
  attempted(repositoryId: number, issue: number): AutopilotJob | undefined {
    const current = this.get(repositoryId, issue)
    return current && this.update(repositoryId, issue, { attempts: current.attempts + 1 })
  }
  /** Removes a job, so a later poll may queue the issue again; a person's explicit retry uses this. */
  forget(repositoryId: number, issue: number): void {
    this.store.delete(KV.autopilot.job(jobKey(repositoryId, issue)))
  }
  /**
   * Pause a queued job. Running jobs are refused because their worker cannot yet be paused safely here.
   * @returns the updated job, or undefined when no job exists.
   * @throws when the job is not in a state a person may pause.
   */
  pause(repositoryId: number, issue: number): AutopilotJob | undefined {
    const current = this.get(repositoryId, issue)
    if (!current) return undefined
    if (!canPause(current)) throw new Error(`A ${current.state} job cannot be paused`)
    if (current.state === 'running') throw new Error('A running worker cannot be safely paused from the queue; use the ticket controls')
    return this.update(repositoryId, issue, { state: 'paused' })
  }
  /**
   * A person resumes a job they paused, which queues it again.
   * @returns the updated job, or undefined when no job exists.
   * @throws when the job is not paused.
   */
  resume(repositoryId: number, issue: number): AutopilotJob | undefined {
    const current = this.get(repositoryId, issue)
    if (!current) return undefined
    if (!canResume(current)) throw new Error(`A ${current.state} job cannot be resumed`)
    if (current.triggerId || current.ticketId || current.commitSha || current.prNumber) {
      throw new Error('Cannot requeue a paused job with prior execution; reconcile its ticket and Git state first')
    }
    return this.update(repositoryId, issue, { state: 'queued', error: undefined })
  }
  /**
   * Skip a queued or paused job. Running jobs are refused until worker cancellation is coordinated.
   * @returns the updated job, or undefined when no job exists.
   * @throws when the job is already finished.
   */
  skip(repositoryId: number, issue: number, reason = 'skipped by a person'): AutopilotJob | undefined {
    const current = this.get(repositoryId, issue)
    if (!current) return undefined
    if (!canSkip(current)) throw new Error(`A ${current.state} job cannot be skipped`)
    if (current.state === 'running') throw new Error('A running worker cannot be safely skipped from the queue; stop the ticket first')
    return this.update(repositoryId, issue, { state: 'skipped', error: reason })
  }
  /**
   * A person retries a failed or skipped job: its attempts start again, so the automatic bound does not refuse it.
   * @returns the updated job, or undefined when no job exists.
   */
  retry(repositoryId: number, issue: number): AutopilotJob | undefined {
    const current = this.get(repositoryId, issue)
    if (!current) return undefined
    if (current.state !== 'failed' && current.state !== 'skipped') throw new Error(`A ${current.state} job cannot be retried`)
    if (current.triggerId || current.ticketId || current.commitSha || current.prNumber) {
      throw new Error('Cannot requeue a job with prior execution; reconcile its ticket and Git state first')
    }
    return this.update(repositoryId, issue, { state: 'queued', attempts: 0, error: undefined })
  }
}
