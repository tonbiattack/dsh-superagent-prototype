/**
 * Where an autopilot job's work runs: an open DSH workspace of the same repository when there is one, otherwise the
 * operator's configured checkout.
 *
 * A workspace is only a candidate when its directory is proven to be a checkout of the job's repository, by that
 * checkout's own `origin`. A directory whose name happens to match is not enough: a fork, a second clone, or a renamed
 * directory would otherwise receive another repository's work. The rules here are pure, so the choice can be tested
 * without DSH or Git, and the reason it chose is recorded for the panel.
 */
import { sameRepo, type AutopilotSettings } from '../autopilot.ts'

/** One open DSH workspace, as routing sees it. */
export interface WorkspaceCandidate {
  /** The workspace's canonical directory. */
  path: string
  /** The workspace's display title, for the panel. */
  title: string
  /** The sessions the workspace accounts for, newest first. */
  sessionIds: readonly string[]
  /** The directory is proven to be a checkout of the job's repository. */
  matches: boolean
  /** A session in the workspace is running, so it is not a safe target. */
  busy: boolean
}
/** Where a job's work will run, and why. */
export type RouteDecision =
  /** An open workspace of the same repository. */
  | { kind: 'workspace'; path: string; title: string; reason: string }
  /** The operator's configured checkout, which is the fallback. */
  | { kind: 'checkout'; path: string; reason: string }
  /** Nothing safe to run in yet: the job waits rather than running somewhere else. */
  | { kind: 'wait'; reason: string }
/**
 * Chooses where a job runs.
 *
 * An open workspace of the same repository is preferred, because it is where a person already works and its sessions
 * already hold the repository's context. A busy workspace is not chosen: a person's own turn must not be interrupted.
 * When no safe workspace exists, the configured checkout is used, or the job waits, as the operator chose.
 *
 * @param candidates - every open workspace, each already checked against the repository.
 * @param checkout - the operator's configured checkout for the repository.
 */
export function chooseWorkspace(input: { candidates: readonly WorkspaceCandidate[]; checkout: string
  settings: AutopilotSettings }): RouteDecision {
  const { candidates, checkout, settings } = input
  if (!settings.routeToOpenWorkspace) return { kind: 'checkout', path: checkout, reason: 'routing to open workspaces is off' }
  const matching = candidates.filter(candidate => candidate.matches)
  if (!matching.length) return fallback(checkout, settings, 'no open workspace of this repository')
  const idle = matching.filter(candidate => !candidate.busy)
  if (!idle.length) return fallback(checkout, settings, 'every open workspace of this repository is busy')
  // A person's stated preference decides first, so an operator can pin the workspace they want used.
  const preferred = settings.workspacePriority.map(path => path.trim()).filter(Boolean)
    .flatMap(path => idle.find(candidate => candidate.path === path) ?? [])
  if (preferred.length) {
    const chosen = preferred[0]!
    return { kind: 'workspace', path: chosen.path, title: chosen.title, reason: 'the operator listed this workspace first' }
  }
  // Otherwise the choice is deterministic: the same set of workspaces always picks the same one, so a retry does not
  // wander between them.
  const chosen = idle.slice().sort((a, b) => a.path.localeCompare(b.path))[0]!
  return { kind: 'workspace', path: chosen.path, title: chosen.title,
    reason: idle.length === 1 ? 'the only open workspace of this repository' : 'the first open workspace of this repository by path' }
}
/** What to do when no safe workspace exists, as the operator chose. */
function fallback(checkout: string, settings: AutopilotSettings, why: string): RouteDecision {
  if (settings.workspaceFallback === 'wait') return { kind: 'wait', reason: `${why}, and the autopilot waits for one` }
  return { kind: 'checkout', path: checkout, reason: `${why}, so the configured checkout is used` }
}
/** Whether a job's recorded workspace still belongs to a repository the operator watches. */
export const workspaceWatched = (path: string, repository: string, settings: AutopilotSettings): boolean =>
  settings.repositories.some(entry => sameRepo(entry.fullName, repository) && entry.checkout === path)
