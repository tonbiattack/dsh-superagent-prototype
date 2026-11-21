/**
 * The autopilot's GitHub poller: reads the open issues of each watched repository, queues the eligible ones, and keeps
 * the queue's view of each issue current. It reads through the agent's `gh`, so it needs no webhook and no new credential.
 */
import { z } from 'zod'
import { KV } from '../kv.ts'
import { validItems, type Commands, type Tally } from '../infra/commands.ts'
import { sameName } from '../infra/text.ts'
import { eligible, ineligibleReason, jobKey, sameRepo, type AutopilotJob, type AutopilotSettings, type EligibleIssue } from '../autopilot.ts'
import type { AutopilotQueue } from './autopilot-queue.ts'
import type { Store } from './store.ts'

/** An Issue as the repository list returns it; `labels` are objects, and `pull_request` marks a pull request. */
const IssueListSchema = z.looseObject({
  number: z.number().int().positive(), title: z.string(), state: z.string(), html_url: z.string(),
  user: z.looseObject({ login: z.string() }).nullable(), created_at: z.string(), updated_at: z.string().nullish(),
  labels: z.array(z.union([z.string(), z.looseObject({ name: z.string() })])).nullish(),
  pull_request: z.unknown().nullish(),
})
export type ListedIssue = z.infer<typeof IssueListSchema>
/** The repository facts the poller reads once: its immutable ID and its default branch. */
const RepositorySchema = z.looseObject({ id: z.number().int().positive(), full_name: z.string(), default_branch: z.string() })
/** GitHub's label names, whether the API returned strings or objects. */
export const labelNames = (issue: Pick<ListedIssue, 'labels'>): string[] =>
  (issue.labels ?? []).flatMap(label => typeof label === 'string' ? [label] : label.name ? [label.name] : [])
/** An issue as the queue records it, or undefined for a pull request, which the autopilot does not take up. */
export function eligibleIssue(issue: ListedIssue, repository: string, repositoryId?: number): EligibleIssue | undefined {
  if (issue.pull_request != null || issue.state !== 'open' || !issue.user) return undefined
  return { repository, ...repositoryId === undefined ? {} : { repositoryId }, issue: issue.number, title: issue.title,
    author: issue.user.login, url: issue.html_url, createdAt: issue.created_at, labels: labelNames(issue) }
}
/** What one repository's poll changed, for the health detail and the tests. */
export interface PollResult { repository: string; read: number; queued: number; skipped: number; closed: number }
/** Host dependencies of the poller. */
export interface AutopilotPollerHost {
  readonly store: Pick<Store, 'get' | 'set' | 'atomic'>
  readonly queue: Pick<AutopilotQueue, 'all' | 'enqueue' | 'update' | 'get'>
  /** The agent's GitHub CLI, restricted to the repository each call names. */
  commands(repository: string): Commands  /** The Policy's GitHub allowed list, which an issue's author must be on. */
  allowed(): readonly string[]
  settings(): AutopilotSettings
}

/**
 * Reads and queues issues. Each repository is polled on its own, so one repository's failure leaves the others' jobs
 * and cursors alone; a failure is reported to the caller, which records it on that repository's health entry.
 */
export class AutopilotPoller {
  constructor(private readonly host: AutopilotPollerHost) {}

  /** Polls every configured repository, returning what each poll did and the failures, by repository. */
  async pollAll(signal?: AbortSignal): Promise<{ results: PollResult[]; failures: { repository: string; error: string }[] }> {
    const results: PollResult[] = [], failures: { repository: string; error: string }[] = []
    for (const entry of this.host.settings().repositories) {
      if (signal?.aborted) break
      try { results.push(await this.poll(entry.fullName, signal)) }
      catch (error) { failures.push({ repository: entry.fullName, error: error instanceof Error ? error.message : String(error) }) }
    }
    return { results, failures }
  }
  /**
   * Polls one repository: reads its facts once, then every open issue, and queues the eligible ones.
   * An issue already queued keeps its job, so a repeated poll changes nothing; an issue that lost the label or closed
   * while its job waited is skipped, so the queue never starts work the operator withdrew.
   */
  async poll(repository: string, signal?: AbortSignal): Promise<PollResult> {
    const settings = this.host.settings()
    const commands = this.host.commands(repository).withSignal(signal)
    const facts = await this.facts(commands, repository)
    const issues = await this.openIssues(commands)
    const allowed = this.host.allowed()
    const result: PollResult = { repository, read: issues.length, queued: 0, skipped: 0, closed: 0 }
    for (const listed of issues) {
      if (signal?.aborted) break
      const issue = eligibleIssue(listed, repository, facts.id)
      if (!issue) continue
      const existing = this.host.queue.get(repository, issue.issue)
      // A job that already ran, or is running, is not reconsidered: its outcome is the record.
      if (existing && existing.state !== 'queued') continue
      if (!eligible(issue, settings, allowed)) {
        // A queued job whose issue lost its label or its author's authorization is skipped rather than started.
        if (existing) { this.host.queue.update(repository, issue.issue, { state: 'skipped', error: ineligibleReason(issue, settings, allowed) }); result.skipped += 1 }
        continue
      }
      const { created } = this.host.queue.enqueue({ repository, issue: issue.issue, repositoryId: facts.id, state: 'queued' })
      if (created) result.queued += 1
    }
    // A queued job whose issue closed, or lost the label, before it started is skipped, so the queue holds only live work.
    for (const job of this.host.queue.all()) {
      if (job.state !== 'queued' || !sameRepo(job.repository, repository)) continue
      const listed = issues.find(item => item.number === job.issue)
      if (listed) continue
      this.host.queue.update(job.repository, job.issue, { state: 'skipped', error: 'the issue closed before its work started' })
      result.closed += 1
    }
    this.host.store.set(KV.autopilot.since(repository), new Date().toISOString())
    return result
  }
  /** Reads a repository's immutable ID and default branch, keeping them so a rename does not lose its jobs. */
  private async facts(commands: Commands, repository: string): Promise<{ id?: number; defaultBranch?: string }> {
    const stored = this.host.store.get(KV.autopilot.repository(repository))
    if (stored?.id && stored.defaultBranch) return stored
    const read = await commands.api(RepositorySchema, '')
    const facts = { id: read.id, defaultBranch: read.default_branch }
    this.host.store.set(KV.autopilot.repository(repository), facts)
    return facts
  }
  /** Every open issue of the repository, oldest first, skipping the ones GitHub returns malformed. */
  private async openIssues(commands: Commands): Promise<ListedIssue[]> {
    const tally: Tally = { skipped: 0 }
    const issues = await commands.pages(IssueListSchema, 'issues?state=open&sort=created&direction=asc&per_page=100', tally)
    return issues.filter(issue => issue.pull_request == null)
  }
}
/** The default branch of a repository, which delivery refuses to commit to. */
export async function defaultBranchOf(commands: Commands): Promise<string> {
  return (await commands.api(z.looseObject({ default_branch: z.string() }), '')).default_branch
}
/** Whether a job's repository is still configured; a removed repository's jobs stop rather than run elsewhere. */
export const configured = (job: Pick<AutopilotJob, 'repository'>, settings: AutopilotSettings): boolean =>
  settings.repositories.some(entry => sameName(entry.fullName, job.repository))
export { jobKey }
