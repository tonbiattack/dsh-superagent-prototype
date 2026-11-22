/**
 * Which DSH session a job's work runs in, and whether that session is reused or created.
 *
 * A worker session is normally created per Ticket, so every Issue starts from an empty history. Reusing one session for a
 * repository keeps the repository's understanding and the prompt's common prefix, which is what makes a cache hit
 * possible. It is never assumed: the session must exist, belong to the job's repository, and be idle, and a person's own
 * session is only used when the operator explicitly allows it.
 *
 * The rules are pure, so the choice can be tested without DSH.
 */
import type { AutopilotSettings } from '../autopilot.ts'

/** One session a job could run in, as the choice sees it. */
export interface SessionCandidate {
  id: string
  /** The directory the session runs in, which is how it is tied to a repository. */
  cwd: string
  /** The session is running a turn, so it is not a safe target. */
  busy: boolean
  /** The session was created by dsh-superagent for this repository, rather than by a person. */
  owned: boolean
}
/** Which session a job runs in, and why. */
export type SessionChoice =
  /** Reuse this session, keeping its history. */
  | { kind: 'reuse'; id: string; reason: string }
  /** Create a session for this job alone. */
  | { kind: 'create'; id: string; reason: string }
/**
 * Chooses the session a job runs in.
 *
 * The operator's mode decides what may be reused at all: `off` always creates a session per job, `repository` reuses only
 * a session dsh-superagent itself created for the repository, and `any` may also reuse a person's idle session. A busy
 * session is never reused, because a person's own turn must not be interrupted.
 *
 * @param candidates - the sessions that run in the job's own directory.
 * @param own - the session id this job would create for itself.
 */
export function chooseSession(input: { candidates: readonly SessionCandidate[]; own: string; settings: AutopilotSettings }): SessionChoice {
  const { candidates, own, settings } = input
  const mode = settings.sessionReuse
  if (mode === 'off') return { kind: 'create', id: own, reason: 'session reuse is off, so this job gets its own session' }
  const usable = candidates.filter(candidate => !candidate.busy && (mode === 'any' || candidate.owned))
  if (!usable.length) {
    const busy = candidates.some(candidate => candidate.busy)
    return { kind: 'create', id: own, reason: busy ? 'every reusable session is running, so this job gets its own'
      : 'no reusable session exists for this repository, so this job gets its own' }
  }
  // The same session every time, so a retry keeps the history it built rather than starting over elsewhere.
  const chosen = usable.slice().sort((a, b) => a.id.localeCompare(b.id))[0]!
  return { kind: 'reuse', id: chosen.id, reason: chosen.owned
    ? 'reusing the session dsh-superagent keeps for this repository'
    : 'reusing an idle session of this repository, which the operator allowed' }
}
/** The session id dsh-superagent keeps for a repository's jobs, which is what makes reuse possible. */
export const repositorySessionId = (repositoryId: number): string => `autopilot-repo-${repositoryId}`
