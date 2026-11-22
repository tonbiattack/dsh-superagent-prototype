/**
 * Where an autopilot job's work runs, and the proof that the directory is the repository it claims.
 *
 * A job's Ticket must work in its own repository's checkout. Without that, two monitored repositories would share one
 * directory and an issue could be implemented, committed and pushed into the wrong repository. The rules here are pure
 * where they can be, and the one check that needs Git reads the checkout's own remote.
 */
import { join } from 'node:path'
import { sameRepo, type AutopilotSettings } from '../autopilot.ts'
import type { Commands } from '../infra/commands.ts'

/** The directory name a repository's work gets when the operator configured no checkout. */
export const repositorySlug = (repository: string): string => repository.replace(/[^A-Za-z0-9_.-]+/g, '-').toLowerCase()
/**
 * The root a job's Ticket works under: the operator's checkout for that repository, or a directory named after it under
 * the execution root. A repository the operator no longer watches has no root, so its jobs cannot run anywhere.
 */
export function workspaceRoot(repository: string, settings: AutopilotSettings, executionRoot: string): string | undefined {
  const entry = settings.repositories.find(item => sameRepo(item.fullName, repository))
  if (!entry) return undefined
  return entry.checkout || join(executionRoot, repositorySlug(entry.fullName))
}
/** The remote URL forms that name `repository`, so a checkout of another repository is refused. */
export function remoteNames(repository: string): string[] {
  const name = repository.toLowerCase()
  return [`https://github.com/${name}`, `https://github.com/${name}.git`, `git@github.com:${name}`, `git@github.com:${name}.git`,
    `ssh://git@github.com/${name}`, `ssh://git@github.com/${name}.git`]
}
/** Whether a remote URL names `repository`, ignoring a trailing slash and the `.git` suffix. */
export function remoteMatches(remote: string, repository: string): boolean {
  const normalized = remote.trim().replace(/\/+$/, '').toLowerCase()
  return remoteNames(repository).some(candidate => candidate.toLowerCase() === normalized)
}
/**
 * Verifies that `directory` is a Git checkout of `repository`.
 * @throws when the directory is not a repository, or its `origin` names another one.
 */
export async function verifyCheckout(commands: Commands, directory: string, repository: string): Promise<void> {
  const top = await commands.git(['rev-parse', '--show-toplevel'], directory).then(text => text.trim(), () => '')
  if (!top) throw new Error(`${directory} is not a Git checkout, so ${repository} cannot be worked on there`)
  const remote = await commands.git(['remote', 'get-url', 'origin'], directory).then(text => text.trim(), () => '')
  if (!remote) throw new Error(`${directory} has no origin remote, so it cannot be shown to be ${repository}`)
  if (!remoteMatches(remote, repository)) throw new Error(`${directory} is a checkout of another repository, not ${repository}`)
}
