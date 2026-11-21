/**
 * The autopilot's scheduler: turns queued jobs into Tickets through the existing Trigger → Eval → accept path, and keeps
 * each job's record in step with the Ticket that carries its work.
 *
 * It starts nothing itself. A job becomes a Trigger, the main Session assesses it as any other candidate, and the accept
 * creates the Ticket, its Mandate, its Assignment and its isolated directory. That is what keeps the autopilot inside the
 * Policy, the concurrency limits and the recovery rules the rest of dsh-superagent already enforces.
 */
import { latestReport, liveTicket, threadKey, type Ticket, type Trigger } from '../core/index.ts'
import { jobBranch, nextJob, sameRepo, type AutopilotJob, type AutopilotSettings } from '../autopilot.ts'
import type { AutopilotQueue } from './autopilot-queue.ts'
import type { DeliveryResult } from './autopilot-delivery.ts'
import type { Store } from './store.ts'

/** Host dependencies of the scheduler. */
export interface AutopilotSchedulerHost {
  readonly store: Pick<Store, 'tickets' | 'triggers' | 'decisions' | 'settings'>
  readonly queue: Pick<AutopilotQueue, 'all' | 'update' | 'get'>
  /** Hands a Trigger to the Engine, which queues it for Eval. */
  receive(trigger: Trigger): unknown
  /** Builds the Trigger for a job's issue, reading the issue as the Source does. */
  trigger(job: AutopilotJob): Promise<Trigger | undefined>
  /** Delivers a finished job's branch: pushes it, opens its pull request and merges it when the rules allow. */
  deliver(job: AutopilotJob, ticket: Ticket): Promise<DeliveryResult>
  /** Whether processing is paused, which holds dispatch. */
  paused(): boolean
  closing(): boolean
}
/** What one scheduling pass did, for the health detail and the tests. */
export interface DispatchResult { started: AutopilotJob[]; settled: AutopilotJob[]; errors: { job: AutopilotJob; error: string }[] }

/**
 * Starts queued jobs within the configured limits and records what became of the running ones.
 * Both steps are idempotent: a job already running is not started again, and a job whose Ticket ended keeps the outcome
 * it recorded, so a restart or a repeated pass changes nothing.
 */
export class AutopilotScheduler {
  constructor(private readonly host: AutopilotSchedulerHost) {}

  /** One scheduling pass: reconcile running jobs with their Tickets, then start what the limits allow. */
  async pass(): Promise<DispatchResult> {
    const result: DispatchResult = { started: [], settled: [], errors: [] }
    if (this.host.closing()) return result
    await this.reconcile(result)
    if (this.host.paused()) return result
    const settings = this.host.store.settings().autopilot
    if (!settings.enabled) return result
    for (;;) {
      const job = nextJob(this.host.queue.all(), settings)
      if (!job) break
      try {
        const started = await this.start(job)
        if (!started) break
        result.started.push(started)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        // A job that cannot be dispatched is recorded failed, so it does not hold the queue behind it.
        this.host.queue.update(job.repository, job.issue, { state: 'failed', error: message })
        result.errors.push({ job, error: message })
      }
    }
    return result
  }
  /**
   * Starts one job: builds its Trigger, hands it to the Engine, and records the job as running.
   * @returns the updated job, or undefined when the issue no longer yields a Trigger, in which case the job is skipped.
   */
  private async start(job: AutopilotJob): Promise<AutopilotJob | undefined> {
    const trigger = await this.host.trigger(job)
    if (!trigger) {
      this.host.queue.update(job.repository, job.issue, { state: 'skipped', error: 'the issue is no longer open or no longer carries the label' })
      return undefined
    }
    // The attempt is counted before the Trigger is handed over, so a crash between the two cannot retry without bound.
    this.host.queue.update(job.repository, job.issue, { state: 'running', triggerId: trigger.id, attempts: job.attempts + 1, error: undefined })
    this.host.receive(trigger)
    return this.host.queue.get(job.repository, job.issue)
  }
  /**
   * Brings running jobs in step with their Tickets: records the Ticket once the accept created it, delivers the work once
   * the Ticket reported ready, and records the outcome once the Ticket ended. A job whose Ticket is gone is failed rather
   * than left running forever.
   */
  private async reconcile(result: DispatchResult): Promise<void> {
    for (const job of this.host.queue.all()) {
      if (job.state !== 'running') continue
      const ticket = this.ticketOf(job)
      if (!ticket) {
        // The Trigger may still wait for its Eval; only a job whose Trigger is gone is a failure.
        if (job.triggerId && !this.host.store.triggers.get(job.triggerId)) {
          this.host.queue.update(job.repository, job.issue, { state: 'failed', error: 'the ticket for this issue is gone' })
          result.settled.push(this.host.queue.get(job.repository, job.issue)!)
        }
        continue
      }
      if (ticket.id !== job.ticketId) this.host.queue.update(job.repository, job.issue, { ticketId: ticket.id })
      // A ready Ticket has work to deliver; delivery runs once, and its result is what the job records.
      if (liveTicket(ticket) && !job.prNumber && ready(ticket)) {
        await this.deliver(job, ticket, result)
        continue
      }
      if (liveTicket(ticket)) continue
      const outcome = ticket.ended?.outcome
      const state = outcome === 'completed' || outcome === 'merged' ? 'done' : outcome === 'dropped' ? 'skipped' : 'failed'
      const error = state === 'failed' ? ticket.ended?.reason ?? `the ticket ended ${outcome ?? 'without a result'}` : undefined
      this.host.queue.update(job.repository, job.issue, { state, ...error === undefined ? {} : { error } })
      result.settled.push(this.host.queue.get(job.repository, job.issue)!)
    }
  }
  /**
   * Delivers a ready Ticket's branch. A delivery that cannot finish leaves the job running with the reason recorded, so a
   * later pass tries again once the blocker, such as a still-running check, has cleared.
   */
  private async deliver(job: AutopilotJob, ticket: Ticket, result: DispatchResult): Promise<void> {
    try {
      const delivered = await this.host.deliver(job, ticket)
      this.host.queue.update(job.repository, job.issue, { branch: job.branch ?? branchOf(job), commitSha: delivered.commitSha,
        ...delivered.prNumber === undefined ? {} : { prNumber: delivered.prNumber }, ...delivered.prUrl === undefined ? {} : { prUrl: delivered.prUrl },
        ...delivered.mergeSha === undefined ? {} : { mergeSha: delivered.mergeSha }, ...delivered.blocked === undefined ? {} : { error: delivered.blocked } })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.host.queue.update(job.repository, job.issue, { error: message })
      result.errors.push({ job, error: message })
    }
  }
  /** The Ticket a job's Trigger started, open or ended, or undefined while no accept has created one. */
  private ticketOf(job: AutopilotJob): Ticket | undefined {
    if (job.ticketId) {
      const ticket = this.host.store.tickets.get(job.ticketId)
      if (ticket) return ticket
    }
    if (!job.triggerId) return undefined
    const trigger = this.host.store.triggers.get(job.triggerId)
    if (!trigger) return undefined
    // The accept Decision records the Ticket it created; the Thread's Decisions hold it.
    const decision = this.host.store.decisions.byThread(threadKey(trigger.threads[0]!))
      .find(item => item.kind === 'accept' && item.triggerIds.includes(job.triggerId!))
    return decision?.ticketId ? this.host.store.tickets.get(decision.ticketId) : undefined
  }
}
/** Whether a job belongs to a repository the operator still watches. */
export const watched = (job: Pick<AutopilotJob, 'repository'>, settings: AutopilotSettings): boolean =>
  settings.repositories.some(entry => sameRepo(entry.fullName, job.repository))
/**
 * Whether a Ticket reported ready, which is when its work is finished and delivery may run. A ready report that the
 * Ticket has not ended on yet, such as one waiting for a pull request it follows, still has work to deliver.
 */
export const ready = (ticket: Ticket): boolean => latestReport(ticket)?.state === 'ready'
/** The branch a job's work commits to, which the Ticket's short name ends so a pull request binds to it. */
export const branchOf = (job: Pick<AutopilotJob, 'issue'>): string => jobBranch(job.issue)
