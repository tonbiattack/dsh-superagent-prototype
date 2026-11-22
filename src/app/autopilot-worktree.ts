/**
 * The git worktree a job's work runs in, and the session lock that keeps two jobs out of one session.
 *
 * A job must not edit the checkout a person is working in: its changes would mix with theirs, and its branch would be the
 * one they have checked out. Each job therefore gets its own worktree on its own branch, created from the checkout without
 * touching it. The rules here are pure where they can be; the Git calls are thin.
 */
import { join } from 'node:path'
import type { Commands } from '../infra/commands.ts'

/** Where a job's worktree lives, under the state directory rather than inside the checkout. */
export const worktreePath = (root: string, repositoryId: number, issue: number): string =>
  join(root, 'autopilot-worktrees', `${repositoryId}-issue-${issue}`)
/** The branch a job's worktree checks out, which is what its pull request is opened from. */
export const worktreeBranch = (issue: number): string => `agent/issue-${issue}`
/** What creating a worktree found. */
export type WorktreeState =
  /** The worktree exists on the job's branch, ready to work in. */
  | { kind: 'ready'; path: string; branch: string }
  /** The worktree was created. */
  | { kind: 'created'; path: string; branch: string }
  /** The checkout has uncommitted changes, so a worktree is not created from it. */
  | { kind: 'dirty'; reason: string }
/**
 * Ensures the job's worktree exists on its branch, creating it from the checkout when it does not.
 *
 * A checkout with uncommitted changes is refused rather than used: a worktree created from it would carry a person's
 * unfinished work into the job, and the job's commits would then contain changes nobody asked for.
 *
 * @throws when Git fails for a reason other than the worktree being absent.
 */
export async function ensureWorktree(commands: Commands, input: { checkout: string; path: string; branch: string }): Promise<WorktreeState> {
  const { checkout, path, branch } = input
  // An existing worktree is reused, so a retry continues in the directory it already has.
  const existing = await commands.git(['rev-parse', '--show-toplevel'], path).then(text => text.trim(), () => '')
  if (existing) {
    const current = await commands.git(['rev-parse', '--abbrev-ref', 'HEAD'], path).then(text => text.trim(), () => '')
    if (current !== branch) {
      // The worktree is on another branch, which means it belongs to other work; it is not reused.
      throw new Error(`The worktree at ${path} is on ${current || 'no branch'}, not ${branch}`)
    }
    return { kind: 'ready', path, branch }
  }
  // A person's uncommitted work is never carried into a job, and never discarded to make room for one.
  const status = await commands.git(['status', '--porcelain'], checkout).then(text => text.trim(), () => '')
  if (status) return { kind: 'dirty', reason: `${checkout} has uncommitted changes, so a worktree is not created from it` }
  // The branch may already exist from an earlier attempt, so it is reused rather than recreated.
  const hasBranch = await commands.git(['rev-parse', '--verify', `refs/heads/${branch}`], checkout).then(text => text.trim(), () => '')
  const args = hasBranch ? ['worktree', 'add', path, branch] : ['worktree', 'add', '-b', branch, path]
  await commands.git(args, checkout)
  return { kind: 'created', path, branch }
}
/** Removes a job's worktree, keeping its branch so the work it committed is not lost. */
export async function removeWorktree(commands: Commands, input: { checkout: string; path: string }): Promise<void> {
  // `--force` because the worktree may hold the job's own uncommitted work, which its branch already records.
  await commands.git(['worktree', 'remove', '--force', input.path], input.checkout).catch(() => { /* Already gone. */ })
}
