/**
 * Issue-driven autopilot: which issues are eligible, the durable job queue, and how jobs are scheduled.
 * This module holds the rules only; it performs no I/O, so the poller, the panel and the tests share one definition.
 */
import type { Settings } from './policy.ts'

/** Where a job stands. `queued` waits for a worker slot, `running` has a Ticket, and the rest are terminal. */
export type AutopilotState = 'queued' | 'running' | 'done' | 'failed' | 'skipped' | 'paused'
/** States a job never leaves on its own; a person may still retry one. */
export const TERMINAL: readonly AutopilotState[] = ['done', 'failed', 'skipped']
/** States that hold a worker slot. */
export const ACTIVE: readonly AutopilotState[] = ['queued', 'running']
/**
 * One issue's work. The key is GitHub's immutable repository ID and the issue number, so renaming a repository keeps its
 * jobs; `repository` is the name to call, which a poll refreshes.
 */
export interface AutopilotJob {
  repository: string
  issue: number
  /** GitHub's immutable repository ID, which survives a rename and is the job's key. */
  repositoryId: number
  state: AutopilotState
  /** The Trigger the job created, once dispatched; its Ticket is the work. */
  triggerId?: string
  ticketId?: string
  /** The branch the work commits to, such as `agent/issue-123`. */
  branch?: string
  commitSha?: string
  prNumber?: number
  prUrl?: string
  /** The merge commit GitHub reported, once the pull request merged. */
  mergeSha?: string
  /** Why the job failed or was skipped, in the words a person reads. */
  error?: string
  /** How many times dispatch was attempted, which bounds automatic retries. */
  attempts: number
  createdAt: string
  updatedAt: string
}
/** The repository a job belongs to, as the operator configured it. */
export interface AutopilotRepository { fullName: string; checkout: string }
/** The autopilot settings a job is scheduled under. */
export type AutopilotSettings = Settings['autopilot']
/**
 * The key of a job: GitHub's immutable repository ID and the issue number. A repository rename changes its name but not
 * its ID, so a job keeps its identity across one; the name is only what the job is called.
 */
export const jobKey = (repositoryId: number, issue: number): string => `${repositoryId}#${issue}`
/** The branch a job commits to; the last path segment is the Ticket's short name, which binds a pull request to it. */
export const jobBranch = (issue: number): string => `agent/issue-${issue}`
/** Whether a job still needs work: queued or running. */
export const active = (job: Pick<AutopilotJob, 'state'>): boolean => ACTIVE.includes(job.state)
/** Whether a job reached a state it does not leave on its own. */
export const terminal = (job: Pick<AutopilotJob, 'state'>): boolean => TERMINAL.includes(job.state)
/**
 * Whether the queue may start another job: the global limit, and the limit for the job's own repository.
 * A running job counts against both, so one repository cannot take every slot.
 */
export function hasCapacity(jobs: readonly AutopilotJob[], repository: string, settings: AutopilotSettings): boolean {
  const running = jobs.filter(job => job.state === 'running')
  if (running.length >= settings.maxConcurrentGlobal) return false
  return running.filter(job => sameRepo(job.repository, repository)).length < settings.maxConcurrentPerRepo
}
/** Repository names compare case-insensitively, as GitHub treats them. */
export const sameRepo = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()
/**
 * The next job to start: the oldest queued job whose repository still has a slot, so a busy repository does not
 * hold back another one. Returns undefined when nothing may start.
 */
export function nextJob(jobs: readonly AutopilotJob[], settings: AutopilotSettings): AutopilotJob | undefined {
  const queued = jobs.filter(job => job.state === 'queued')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.issue - b.issue)
  return queued.find(job => hasCapacity(jobs, job.repository, settings))
}
/**
 * Whether a job may be dispatched again after a failure: automatic retries are bounded, so a permanently broken
 * issue does not spin. A person's retry resets `attempts`.
 */
export const mayRetry = (job: Pick<AutopilotJob, 'attempts'>, settings: AutopilotSettings): boolean =>
  job.attempts < Math.max(1, settings.maxFixAttempts)
/** What a poll found for one issue, before it becomes a job. */
export interface EligibleIssue {
  repository: string
  repositoryId?: number
  issue: number
  title: string
  /** The issue's author, which the Policy's allowed list must name. */
  author: string
  url: string
  createdAt: string
  /** Labels the issue carries, which decide eligibility. */
  labels: readonly string[]
}
/**
 * Whether an issue is eligible: it carries the configured label, and its author may originate work.
 * `allowed` is the Policy's GitHub allowed list, matched case-insensitively as GitHub logins are.
 */
export function eligible(issue: EligibleIssue, settings: AutopilotSettings, allowed: readonly string[]): boolean {
  if (!issue.labels.some(label => label.toLowerCase() === settings.eligibleLabel.toLowerCase())) return false
  return allowed.some(id => id.toLowerCase() === issue.author.toLowerCase())
}
/** Why an issue was not taken up, for the panel and the log; undefined when it is eligible. */
export function ineligibleReason(issue: EligibleIssue, settings: AutopilotSettings, allowed: readonly string[]): string | undefined {
  if (!issue.labels.some(label => label.toLowerCase() === settings.eligibleLabel.toLowerCase())) return `no ${settings.eligibleLabel} label`
  if (!allowed.some(id => id.toLowerCase() === issue.author.toLowerCase())) {
    return `${issue.author} may not originate work`
  }
  return undefined
}
/**
 * The repository a job runs in: the configured entry for its name, which carries the local checkout.
 * Returns undefined when the operator removed the repository, so its jobs stop rather than run elsewhere.
 */
export function repositoryOf(repository: string, settings: AutopilotSettings): AutopilotRepository | undefined {
  return settings.repositories.find(entry => sameRepo(entry.fullName, repository))
}
/**
 * Whether a branch may receive the work: never the repository's default branch, and never a force push.
 * The default branch is read from the repository rather than assumed, so a renamed default is still refused.
 */
export function branchAllowed(branch: string, defaultBranch: string): boolean {
  return !!branch.trim() && branch.toLowerCase() !== defaultBranch.toLowerCase()
}
/** The merge method GitHub accepts, as the settings name it. */
export type MergeMethod = AutopilotSettings['mergeMethod']
