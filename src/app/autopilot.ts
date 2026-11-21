/**
 * The autopilot service: the polling loop, the scheduling pass, and the health entry the panel reads.
 *
 * It owns no domain rules. Polling finds eligible issues and records jobs; scheduling hands a job's Trigger to the Engine,
 * which assesses and accepts it as any other candidate; delivery reads the Ticket that resulted. Each part is separately
 * testable, and this class only decides when each runs and what the operator is told.
 */
import { health, type Health } from '../sources/host.ts'
import type { HealthEntry } from '../infra/health.ts'
import type { Trigger } from '../core/index.ts'
import { pause } from '../sources/poll.ts'
import type { AutopilotJob } from '../autopilot.ts'
import type { AutopilotPoller, PollResult } from './autopilot-poller.ts'
import type { AutopilotScheduler, DispatchResult } from './autopilot-scheduler.ts'
import type { AutopilotQueue } from './autopilot-queue.ts'
import type { Store } from './store.ts'

/** Host dependencies of the autopilot service. */
export interface AutopilotHost {
  readonly store: Pick<Store, 'settings'>
  readonly queue: Pick<AutopilotQueue, 'all' | 'inStates'>
  readonly poller: Pick<AutopilotPoller, 'pollAll'>
  readonly scheduler: Pick<AutopilotScheduler, 'pass'>
  /** The `autopilot` health entry, which this service alone writes. */
  readonly health: HealthEntry
  readonly lifetime: AbortSignal
  /** Whether setup resolved the accounts, without which nothing may be read or dispatched. */
  configured(): boolean
  closing(): boolean
  /** Runs a scheduling pass now, such as after a settings save or a person's retry. */
  requestPass(): void
}
/** What one loop iteration did, which the tests drive directly instead of waiting on timers. */
export interface TickResult { polls: PollResult[]; failures: { repository: string; error: string }[]; dispatch: DispatchResult }

/**
 * Runs the autopilot: polls each watched repository on its interval, then schedules what the limits allow.
 * A failure of one repository is recorded and does not stop the others, and a failure of the whole tick is reported on
 * the health entry rather than thrown, so the loop keeps running.
 */
export class Autopilot {
  private running?: Promise<void>
  constructor(private readonly host: AutopilotHost) {}

  /** Starts the loop; it runs until the lifetime aborts. Call once, after setup. */
  start(): void {
    if (this.running) return
    this.running = this.loop().catch((error: unknown) => {
      this.host.health.set({ state: 'error', detail: String(error), at: new Date().toISOString() })
    })
  }
  /** Waits for the loop to stop, which the lifetime's abort causes. */
  async stop(): Promise<void> { await this.running }
  /**
   * One iteration: poll every watched repository, then schedule. Returns what happened so a test or a person's command
   * can run it without waiting for the interval.
   */
  async tick(signal?: AbortSignal): Promise<TickResult> {
    const settings = this.host.store.settings().autopilot
    if (!settings.enabled || !settings.repositories.length) {
      this.host.health.set(health('paused', 'autopilotOff'))
      return { polls: [], failures: [], dispatch: { started: [], settled: [], errors: [] } }
    }
    const { results, failures } = await this.host.poller.pollAll(signal)
    const dispatch = await this.host.scheduler.pass()
    this.report(results, failures, dispatch)
    return { polls: results, failures, dispatch }
  }
  /** Writes the health entry: an error when a repository could not be read, otherwise what the queue holds. */
  private report(polls: PollResult[], failures: { repository: string; error: string }[], dispatch: DispatchResult): void {
    const at = new Date().toISOString()
    const jobs = this.host.queue.all()
    const counts = (state: AutopilotJob['state']) => jobs.filter(job => job.state === state).length
    const queued = counts('queued'), running = counts('running')
    const detail = `${polls.length} repositories; ${queued} queued, ${running} running; started ${dispatch.started.length}`
    if (failures.length) {
      this.host.health.set({ state: 'error', detail: `${failures.length} repositories could not be read: ${failures.map(item => `${item.repository}: ${item.error}`).join('; ')}`, at })
      return
    }
    this.host.health.set({ state: 'ready', detail, at })
  }
  /** The loop: one tick per interval, waiting out the interval or the lifetime's abort. */
  private async loop(): Promise<void> {
    while (!this.host.lifetime.aborted && !this.host.closing()) {
      // Setup resolves the accounts; until then nothing is read, and the health entry says so.
      if (!this.host.configured()) {
        this.host.health.set(health('paused', 'setupPending'))
        await pause(5000, this.host.lifetime)
        continue
      }
      try { await this.tick(this.host.lifetime) }
      catch (error) { if (!this.host.lifetime.aborted) this.host.health.set({ state: 'error', detail: String(error), at: new Date().toISOString() }) }
      const seconds = this.host.store.settings().autopilot.pollSeconds
      await pause(seconds * 1000, this.host.lifetime)
    }
  }
}
/** The health entry a disabled autopilot shows. */
export const offHealth = (): Health => health('paused', 'autopilotOff')
/** The Trigger a job dispatches, as the scheduler asks for it. */
export type JobTrigger = (job: AutopilotJob) => Promise<Trigger | undefined>
