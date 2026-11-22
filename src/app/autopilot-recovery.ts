/**
 * Prototype recovery classification. These rules are not yet sufficient to safely restart execution:
 * unknown GitHub/Git state, cross-process locks, and durable side effects need reconciliation.
 */
import type { AutopilotJob, AutopilotState } from '../autopilot.ts'

/** What a restart found for one job, which decides whether it resumes. */
export interface RecoveryFacts {
  /** The job's Ticket still exists. */
  ticket: boolean
  /** The Ticket is still open. */
  open: boolean
  /** The branch exists in the checkout. */
  branch: boolean
  /** The commit the job recorded is still the branch's head. */
  commitLanded: boolean
  /** A pull request for the branch exists, and whether it merged. */
  pull?: { merged: boolean }
}
/** What recovery decided for a job. */
export type Recovery =
  /** The work finished before the stop: record it and stop. */
  | { action: 'settle'; state: AutopilotState; reason: string }
  /** The work is still live: leave it running, and let the Ticket continue. */
  | { action: 'resume'; reason: string }
  /** The work cannot continue safely: record why and stop, keeping the changes. */
  | { action: 'fail'; reason: string }
  /** The job never started its work: queue it again. */
  | { action: 'requeue'; reason: string }
/**
 * Decides what a restart does with a job that was running.
 *
 * The order matters. A merged pull request is finished whatever else is true, so it is never redone. A Ticket that is
 * still open is live work, which the Executor's own recovery resumes. A recorded commit that is still the branch's head
 * means the work landed, so only delivery is left. Anything else is a job whose work cannot be found, which fails with
 * the reason rather than starting over and risking a duplicate commit.
 */
export function recover(job: Pick<AutopilotJob, 'state' | 'commitSha' | 'prNumber'>, facts: RecoveryFacts): Recovery {
  if (facts.pull?.merged) return { action: 'settle', state: 'done', reason: 'the pull request merged before the restart' }
  if (job.state === 'queued') return { action: 'requeue', reason: 'the job had not started' }
  if (facts.open) return { action: 'resume', reason: 'the ticket is still open' }
  if (!facts.ticket) return { action: 'fail', reason: 'the ticket for this issue is gone' }
  if (job.commitSha && facts.commitLanded) return { action: 'resume', reason: 'the commit landed; only delivery is left' }
  if (job.prNumber && facts.pull && !facts.pull.merged) return { action: 'resume', reason: 'the pull request is still open' }
  if (!facts.branch) return { action: 'fail', reason: 'the branch is gone, so the work cannot be delivered' }
  return { action: 'fail', reason: 'the ticket ended without a result and its commit is not on the branch' }
}
/** Whether a job may be started again after a failure, given how many attempts it has made. */
export const retryable = (job: Pick<AutopilotJob, 'attempts'>, maxFixAttempts: number): boolean => job.attempts < Math.max(1, maxFixAttempts)
/** The states a person may pause, resume or skip. */
export const PAUSABLE: readonly AutopilotState[] = ['queued', 'running']
/** Whether a person may pause a job: one that is queued or running. */
export const canPause = (job: Pick<AutopilotJob, 'state'>): boolean => PAUSABLE.includes(job.state)
/** Whether a person may resume a job: one they paused. */
export const canResume = (job: Pick<AutopilotJob, 'state'>): boolean => job.state === 'paused'
/** Whether a person may skip a job: one that is queued, running or paused. */
export const canSkip = (job: Pick<AutopilotJob, 'state'>): boolean => PAUSABLE.includes(job.state) || job.state === 'paused'
