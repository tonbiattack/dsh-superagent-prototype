/**
 * The autopilot's delivery: push the issue branch, open a pull request, wait for what the repository requires, and merge
 * only when every requirement holds.
 *
 * The rules are pure functions so they can be tested without GitHub, and the calls are thin. Nothing here bypasses branch
 * protection: a missing check, an unmet approval, a conflict or a failed push leaves the pull request open and says why.
 */
import { z } from 'zod'
import { CliError, type Commands } from '../infra/commands.ts'
import { sameName } from '../infra/text.ts'
import { branchAllowed, type AutopilotSettings } from '../autopilot.ts'

/** A pull request as delivery reads it: its state, whether it merged, and what GitHub says about merging it. */
const PullSchema = z.looseObject({
  number: z.number().int().positive(), html_url: z.string(), state: z.string(), title: z.string().nullish(),
  merged: z.boolean().nullish(), mergeable: z.boolean().nullish(), mergeable_state: z.string().nullish(),
  head: z.looseObject({ ref: z.string(), sha: z.string() }), base: z.looseObject({ ref: z.string() }),
})
export type DeliveryPull = z.infer<typeof PullSchema>
/** One check run or commit status, reduced to what decides a merge. */
export interface CheckState { name: string; failed: boolean; running: boolean }
/** What GitHub reports about a pull request's mergeability, as delivery uses it. */
export interface MergeFacts {
  /** The pull request is open and not merged. */
  open: boolean
  /** GitHub reports the branch as conflicting with its base. */
  conflicting: boolean
  /** Checks the repository requires, as GitHub reports them; empty when it requires none. */
  checks: readonly CheckState[]
  /** Whether the repository requires an approving review, and how many approvals it has. */
  requiredApprovals?: number
  approvals?: number
}
/** Why a pull request may not merge, or that it may. */
export type MergeVerdict = { merge: true } | { merge: false; reason: string }
/**
 * Whether delivery may merge a pull request. Every refusal is a reason a person can act on, and none of them is a
 * bypass: a required check that has not passed, an unmet approval, a conflict, or a closed pull request all stop it.
 */
export function mergeVerdict(facts: MergeFacts, settings: AutopilotSettings): MergeVerdict {
  if (!settings.autoMerge) return { merge: false, reason: 'automatic merging is off' }
  if (!facts.open) return { merge: false, reason: 'the pull request is not open' }
  if (facts.conflicting) return { merge: false, reason: 'the pull request conflicts with its base branch' }
  const failed = facts.checks.filter(check => check.failed).map(check => check.name)
  if (failed.length) return { merge: false, reason: `required checks failed: ${failed.join(', ')}` }
  const running = facts.checks.filter(check => check.running).map(check => check.name)
  if (running.length) return { merge: false, reason: `required checks are still running: ${running.join(', ')}` }
  // An approval the repository requires is never assumed: without the count, delivery waits rather than guesses.
  if (settings.respectBranchProtection && facts.requiredApprovals) {
    const have = facts.approvals ?? 0
    if (have < facts.requiredApprovals) return { merge: false, reason: `the repository requires ${facts.requiredApprovals} approving review(s); it has ${have}` }
  }
  return { merge: true }
}
/** The title of the pull request a job opens: the issue's own title, so the link back is obvious. */
export const pullTitle = (issue: number, title: string): string => `${title} (#${issue})`
/** The body of the pull request a job opens: what it closes, and that a person should read the issue for the request. */
export function pullBody(issue: number, repository: string, summary: string): string {
  const closes = `Closes #${issue}`
  const note = summary.trim() ? `\n\n${summary.trim()}` : ''
  return `${closes}\n\nOpened by dsh-superagent for ${repository}. The issue is the request; this is the change.${note}`
}
/** What delivery did, which the job records. */
export interface DeliveryResult {
  pushed: boolean
  /** The commit the branch was at when delivery read it, which the job keeps as its record of the work. */
  commitSha?: string
  prNumber?: number
  prUrl?: string
  mergeSha?: string
  /** Why delivery stopped short of merging, when it did. */
  blocked?: string
}
/** Host dependencies of delivery. */
export interface DeliveryHost {
  readonly commands: Commands
  settings(): AutopilotSettings
  /** The repository's default branch, which delivery never commits to. */
  defaultBranch(): Promise<string>
  /** The commit the work left on its branch, read from the checkout. */
  headSha(directory: string, branch: string): Promise<string | undefined>
}
/** A pull request delivery found for the branch, if any. */
const PullListSchema = z.array(PullSchema)
/**
 * Delivers one job's work: pushes its branch, opens or reuses its pull request, and merges it when the rules allow.
 *
 * Every step is idempotent against GitHub's own state: an existing pull request for the branch is reused rather than
 * duplicated, and a pull request already merged reports its merge commit instead of merging again.
 */
export class Delivery {
  constructor(private readonly host: DeliveryHost) {}

  /**
   * Delivers `branch` from `directory` for `issue`.
   * @param summary - what the work did, for the pull request body.
   * @throws when the branch is the default branch, or a push or read fails; the caller records the reason on the job.
   */
  async deliver(input: { repository: string; issue: number; branch: string; directory: string; summary: string }): Promise<DeliveryResult> {
    const settings = this.host.settings()
    const defaultBranch = await this.host.defaultBranch()
    if (settings.disallowDefaultBranchCommit && !branchAllowed(input.branch, defaultBranch)) {
      throw new Error(`Refusing to deliver to ${input.branch}: it is the default branch`)
    }
    const commands = this.host.commands
    const result: DeliveryResult = { pushed: false }
    // The commit the branch is at is the record of the work, whether or not it is pushed.
    result.commitSha = await this.host.headSha(input.directory, input.branch)
    if (settings.autoPush) {
      // A plain push, never a force push: a rejected push means the branch moved, which a person must look at.
      await commands.git(['push', '--set-upstream', 'origin', input.branch], input.directory)
      result.pushed = true
    }
    if (!settings.createPullRequest) return result
    const pull = await this.pullFor(input.repository, input.branch, defaultBranch)
    const opened = pull ?? await this.open(input, defaultBranch)
    result.prNumber = opened.number
    result.prUrl = opened.html_url
    if (opened.merged) {
      result.mergeSha = await this.mergeSha(opened.number)
      return result
    }
    const verdict = mergeVerdict(await this.facts(opened), settings)
    if (!verdict.merge) { result.blocked = verdict.reason; return result }
    result.mergeSha = await this.merge(opened.number, settings.mergeMethod)
    return result
  }
  /** The open pull request whose head is `branch`, so a retry reuses it instead of opening a second one. */
  private async pullFor(repository: string, branch: string, defaultBranch: string): Promise<DeliveryPull | undefined> {
    const owner = repository.split('/')[0] ?? ''
    const pulls = await this.host.commands.api(PullListSchema, `pulls?state=all&head=${encodeURIComponent(`${owner}:${branch}`)}&per_page=100`)
    // A merged pull request for the same branch is the work already delivered; an open one is reused.
    return pulls.find(pull => sameName(pull.head.ref, branch) && sameName(pull.base.ref, defaultBranch))
  }
  /** Opens the pull request for the branch, targeting the repository's default branch. */
  private async open(input: { repository: string; issue: number; branch: string; summary: string }, defaultBranch: string): Promise<DeliveryPull> {
    return this.host.commands.api(PullSchema, 'pulls', '--method', 'POST', '-f', `title=${pullTitle(input.issue, await this.issueTitle(input.issue))}`,
      '-f', `head=${input.branch}`, '-f', `base=${defaultBranch}`, '-f', `body=${pullBody(input.issue, input.repository, input.summary)}`)
  }
  /** The issue's title, which the pull request's title repeats so the two read as one piece of work. */
  private async issueTitle(issue: number): Promise<string> {
    const read = await this.host.commands.api(z.looseObject({ title: z.string() }), `issues/${issue}`)
    return read.title
  }
  /** What GitHub reports about the pull request's mergeability, its required checks and its approvals. */
  private async facts(pull: DeliveryPull): Promise<MergeFacts> {
    const commands = this.host.commands
    const checks = await this.checks(pull.head.sha)
    const reviews = await commands.api(z.array(z.looseObject({ state: z.string() })), `pulls/${pull.number}/reviews?per_page=100`)
    const approvals = new Set(reviews.filter(review => review.state === 'APPROVED').map(review => review.state)).size
    const protection = await this.protection(pull.base.ref)
    return { open: pull.state === 'open' && !pull.merged, conflicting: pull.mergeable === false || pull.mergeable_state === 'dirty',
      checks, ...protection.requiredApprovals ? { requiredApprovals: protection.requiredApprovals } : {}, approvals }
  }
  /** The pull request's checks, reduced to whether each failed or still runs; a check that passed is neither. */
  private async checks(head: string): Promise<CheckState[]> {
    const commands = this.host.commands
    const runs = await commands.api(z.looseObject({ check_runs: z.array(z.looseObject({ name: z.string(), status: z.string(), conclusion: z.string().nullable() })) }),
      `commits/${head}/check-runs?per_page=100`)
    const statuses = await commands.pages(z.looseObject({ context: z.string(), state: z.string() }), `commits/${head}/statuses?per_page=100`)
    const failing = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'error'])
    const latest = new Map<string, string>()
    for (const status of statuses) if (!latest.has(status.context)) latest.set(status.context, status.state)
    return [...runs.check_runs.map(run => ({ name: run.name, failed: failing.has(run.conclusion ?? ''), running: run.status !== 'completed' })),
      ...[...latest].map(([name, state]) => ({ name, failed: failing.has(state), running: state === 'pending' }))]
  }
  /** What the base branch's protection requires; a repository without protection requires nothing. */
  private async protection(branch: string): Promise<{ requiredApprovals?: number }> {
    try {
      const read = await this.host.commands.api(z.looseObject({ required_pull_request_reviews: z.looseObject({
        required_approving_review_count: z.number().int().nullish() }).nullish() }), `branches/${encodeURIComponent(branch)}/protection`)
      const count = read.required_pull_request_reviews?.required_approving_review_count
      return count ? { requiredApprovals: count } : {}
    } catch (error) {
      // 404 means the branch is unprotected, which requires nothing; any other failure must not be read as permission.
      if (error instanceof CliError && error.code === 404) return {}
      throw error
    }
  }
  /** Merges the pull request with the configured method, returning the merge commit GitHub reports. */
  private async merge(number: number, method: AutopilotSettings['mergeMethod']): Promise<string | undefined> {
    const merged = await this.host.commands.api(z.looseObject({ merged: z.boolean().nullish(), sha: z.string().nullish(), message: z.string().nullish() }),
      `pulls/${number}/merge`, '--method', 'PUT', '-f', `merge_method=${method}`)
    if (!merged.merged) throw new Error(`GitHub refused the merge: ${merged.message ?? 'no reason given'}`)
    return merged.sha ?? await this.mergeSha(number)
  }
  /** The merge commit of a merged pull request, read back so the job records it. */
  private async mergeSha(number: number): Promise<string | undefined> {
    const read = await this.host.commands.api(z.looseObject({ merge_commit_sha: z.string().nullish() }), `pulls/${number}`)
    return read.merge_commit_sha ?? undefined
  }
}
