/**
 * The autopilot service: the polling loop, the scheduling pass, and the health entry the panel reads.
 *
 * Polling records eligible issues. The unfinished scheduler intentionally refuses dispatch and delivery
 * until the repository, validation, and recovery safety requirements are implemented.
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
  readonly scheduler: Pick<AutopilotScheduler, 'pass' | 'recover'>
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
 * Polls watched repositories and reports that dispatch is disabled until safety work is complete.
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
   * Reconciles the jobs a restart found running, before anything new starts. Each is checked against its Ticket, its
   * branch and its commit, so work that landed is not repeated and work that cannot be found fails with the reason.
   * A fact the restart could not establish changes nothing and is looked at again on a later pass.
   */
  async recover(): Promise<void> {
    if (!this.host.configured()) return
    try { await this.host.scheduler.recover() }
    catch (error) { this.host.health.set({ state: 'error', detail: `Recovery failed: ${String(error)}`, at: new Date().toISOString() }) }
  }
  /**
   * One iteration: poll every watched repository, then schedule. Returns what happened so a test or a person's command
   * can run it without waiting for the interval.
   */
  async tick(signal?: AbortSignal): Promise<TickResult> {
    if (!this.host.configured() || this.host.closing() || this.host.lifetime.aborted || signal?.aborted) {
      return { polls: [], failures: [], dispatch: { started: [], settled: [], errors: [] } }
    }
    const settings = this.host.store.settings().autopilot
    if (!settings.enabled || !settings.repositories.length) {
      this.host.health.set(health('paused', 'autopilotOff'))
      return { polls: [], failures: [], dispatch: { started: [], settled: [], errors: [] } }
    }
    const { results, failures } = await this.host.poller.pollAll(signal)
    const dispatch = await this.host.scheduler.pass()
    const reason = 'Autopilot dispatch is disabled until repository isolation and host-verified delivery are implemented'
    this.host.health.set({ state: 'error', detail: failures.length ? `${reason}; polling failures: ${failures.map(item => `${item.repository}: ${item.error}`).join('; ')}` : reason,
      at: new Date().toISOString() })
    return { polls: results, failures, dispatch }
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
