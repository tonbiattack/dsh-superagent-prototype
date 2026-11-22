/**
 * Unfinished autopilot scheduler prototype. Dispatch and delivery are disabled until repository isolation,
 * durable execution reconciliation, trusted admission, and host-verified delivery are implemented.
 */
import { latestReport, liveTicket, threadKey, type Ticket, type Trigger } from '../core/index.ts'
import { jobBranch, jobKey, nextJob, sameRepo, type AutopilotJob, type AutopilotSettings } from '../autopilot.ts'
import type { AutopilotQueue } from './autopilot-queue.ts'
import type { DeliveryResult } from './autopilot-delivery.ts'
import { recover, type RecoveryFacts } from './autopilot-recovery.ts'
import type { JobLocks } from './autopilot-locks.ts'
import type { RouteDecision } from './autopilot-routing.ts'
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
  /** What a restart finds for a job: its Ticket, its branch and its commit, which decide whether it resumes. */
  facts(job: AutopilotJob, ticket: Ticket | undefined): Promise<RecoveryFacts>
  /** Holds one job's lock while its work runs, so two processes never run the same issue. */
  readonly locks: Pick<JobLocks, 'tryAcquire' | 'release'>
  /** The checkout a job's work runs in, which is where its lock lives so every process shares it. */
  checkout(job: AutopilotJob): string
  /**
   * Chooses where the job's work runs, and why: an open workspace of the same repository, the configured checkout, or a
   * wait when nothing safe exists.
   */
  route(job: AutopilotJob): Promise<RouteDecision>
  /**
   * Proves that the job's work will run in its own repository's checkout.
   * @throws when the checkout is missing or belongs to another repository, so work never lands in the wrong one.
   */
  verify(job: AutopilotJob): Promise<void>
  /** Whether processing is paused, which holds dispatch. */
  paused(): boolean
  closing(): boolean
}
/** What one scheduling pass did, for the health detail and the tests. */
export interface DispatchResult { started: AutopilotJob[]; settled: AutopilotJob[]; errors: { job: AutopilotJob; error: string }[] }

/**
 * The autopilot's scheduler: turns queued jobs into Tickets through the existing Trigger → Eval → accept path, and keeps
 * each job's record in step with the Ticket that carries its work.
 *
 * It starts nothing itself. A job becomes a Trigger, the main Session assesses it as any other candidate, and the accept
 * creates the Ticket, its Mandate, its Assignment and its isolated directory. That is what keeps the autopilot inside the
 * Policy, the concurrency limits and the recovery rules the rest of dsh-superagent already enforces.
 */
export class AutopilotScheduler {
  constructor(private readonly host: AutopilotSchedulerHost) {}

  /** One scheduling pass: reconcile running jobs with their Tickets, then start what the limits allow. */
  async pass(): Promise<DispatchResult> {
    const result: DispatchResult = { started: [], settled: [], errors: [] }
    if (this.host.closing()) return result
    if (this.host.paused()) return result
    const settings = this.host.store.settings().autopilot
    if (!settings.enabled) return result
    await this.reconcile(result)
    // Each job is considered once per pass: a job that could not start, because another process holds it or its issue no
    // longer qualifies, must not be chosen again, or the pass would never end. The limits count every job, so the
    // candidates are filtered here rather than before `nextJob` reads them.
    const considered = new Set<string>()
    for (;;) {
      const jobs = this.host.queue.all()
      const job = nextJob(jobs, settings, jobs.filter(item => !considered.has(jobKey(item.repositoryId, item.issue))))
      if (!job) break
      considered.add(jobKey(job.repositoryId, job.issue))
      try {
        const started = await this.start(job)
        if (started) result.started.push(started)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        // A job that cannot be dispatched is recorded failed, so it does not hold the queue behind it.
        this.host.queue.update(job.repositoryId, job.issue, { state: 'failed', error: message })
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
    // Where the work runs is decided first, because the lock lives in that directory and a job that must wait for a safe
    // workspace must not take a lock it will not use.
    const route = await this.host.route(job)
    if (route.kind === 'wait') {
      this.host.queue.update(job.repositoryId, job.issue, { error: route.reason })
      return undefined
    }
    // One process runs a job at a time; a job another process holds, or whose checkout cannot hold a lock, waits.
    if (!this.host.locks.tryAcquire(job.repositoryId, job.issue, route.path)) return undefined
    // The work must run in this repository's own checkout, proven before anything is dispatched.
    await this.host.verify(job)
    const trigger = await this.host.trigger(job)
    if (!trigger) {
      this.host.queue.update(job.repositoryId, job.issue, { state: 'skipped', error: 'the issue is no longer open or no longer carries the label' })
      await this.host.locks.release(job.repositoryId, job.issue)
      return undefined
    }
    // The attempt is counted before the Trigger is handed over, so a crash between the two cannot retry without bound.
    this.host.queue.update(job.repositoryId, job.issue, { state: 'running', triggerId: trigger.id, attempts: job.attempts + 1,
      error: undefined, route: { kind: route.kind, path: route.path, ...route.kind === 'workspace' ? { title: route.title } : {},
        reason: route.reason } })
    this.host.receive(trigger)
    return this.host.queue.get(job.repositoryId, job.issue)
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
          this.host.queue.update(job.repositoryId, job.issue, { state: 'failed', error: 'the ticket for this issue is gone' })
          result.settled.push(this.host.queue.get(job.repositoryId, job.issue)!)
        }
        continue
      }
      if (ticket.id !== job.ticketId) this.host.queue.update(job.repositoryId, job.issue, { ticketId: ticket.id })
      // A ready Ticket has work to deliver. A delivery that stopped short of merging is retried on a later pass, once the
      // blocker it recorded, such as a still-running check, has cleared; a merged one is never delivered again.
      if (liveTicket(ticket) && ready(ticket) && !job.mergeSha) {
        await this.deliver(job, ticket, result)
        continue
      }
      if (liveTicket(ticket)) continue
      const outcome = ticket.ended?.outcome
      const state = outcome === 'completed' || outcome === 'merged' ? 'done' : outcome === 'dropped' ? 'skipped' : 'failed'
      const error = state === 'failed' ? ticket.ended?.reason ?? `the ticket ended ${outcome ?? 'without a result'}` : undefined
      this.host.queue.update(job.repositoryId, job.issue, { state, ...error === undefined ? {} : { error } })
      // A settled job holds no lock: its work is over, and the next issue may start at once.
      await this.host.locks.release(job.repositoryId, job.issue)
      result.settled.push(this.host.queue.get(job.repositoryId, job.issue)!)
    }
  }
  /**
   * Reconciles the jobs a restart found running, before anything new starts: each is checked against its Ticket, its
   * branch and its commit, so work that landed is not repeated and work that cannot be found fails with the reason.
   * @returns what recovery decided for each job, for the health detail and the tests.
   */
  async recover(): Promise<{ job: AutopilotJob; action: string; reason: string }[]> {
    const decisions: { job: AutopilotJob; action: string; reason: string }[] = []
    for (const job of this.host.queue.all()) {
      if (job.state !== 'running') continue
      const ticket = this.ticketOf(job)
      const facts = await this.host.facts(job, ticket)
      const decision = recover(job, facts)
      decisions.push({ job, action: decision.action, reason: decision.reason })
      if (decision.action === 'settle') this.host.queue.update(job.repositoryId, job.issue, { state: decision.state, error: undefined })
      else if (decision.action === 'fail') this.host.queue.update(job.repositoryId, job.issue, { state: 'failed', error: decision.reason })
      else if (decision.action === 'requeue') this.host.queue.update(job.repositoryId, job.issue, { state: 'queued' })
      else if (decision.action === 'wait') this.host.queue.update(job.repositoryId, job.issue, { error: decision.reason })
      // A resume leaves the job running: the Executor's own recovery continues its Ticket.
    }
    return decisions
  }
  /**
   * Delivers a ready Ticket's branch. A delivery that cannot finish leaves the job running with the reason recorded, so a
   * later pass tries again once the blocker, such as a still-running check, has cleared.
   */
  private async deliver(job: AutopilotJob, ticket: Ticket, result: DispatchResult): Promise<void> {
    // Delivery holds the job's lock too, so a second process cannot push or merge the same branch beside it.
    if (!this.host.locks.tryAcquire(job.repositoryId, job.issue, this.host.checkout(job))) return
    try {
      const delivered = await this.host.deliver(job, ticket)
      // A blocked delivery keeps the job running with the reason, so a later pass retries once the blocker clears; a
      // merged one records the merge commit, which is what stops it being delivered again.
      this.host.queue.update(job.repositoryId, job.issue, { branch: job.branch ?? branchOf(job), commitSha: delivered.commitSha,
        ...delivered.prNumber === undefined ? {} : { prNumber: delivered.prNumber }, ...delivered.prUrl === undefined ? {} : { prUrl: delivered.prUrl },
        ...delivered.mergeSha === undefined ? {} : { mergeSha: delivered.mergeSha }, error: delivered.blocked })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.host.queue.update(job.repositoryId, job.issue, { error: message })
      result.errors.push({ job, error: message })
    } finally { await this.host.locks.release(job.repositoryId, job.issue) }
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
