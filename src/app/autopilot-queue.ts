/**
 * The autopilot's durable job queue: one record per repository and issue, written only here.
 * Jobs survive a restart, so a poll that runs again finds the work it already queued instead of duplicating it.
 */
import { KV } from '../kv.ts'
import type { Store } from './store.ts'
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
    const existing = this.get(job.repository, job.issue)
    if (existing) return { job: existing, created: false }
    const at = new Date().toISOString()
    const created: AutopilotJob = { ...job, attempts: job.attempts ?? 0, createdAt: at, updatedAt: at }
    this.store.set(KV.autopilot.job(jobKey(job.repository, job.issue)), created)
    return { job: created, created: true }
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
}
