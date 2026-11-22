/**
 * The autopilot's per-issue lock: one job per repository and issue runs at a time, across processes.
 *
 * The lock lives inside the repository's own checkout, not in a state directory, because the checkout is what the
 * processes actually share: two dsh-superagent instances with different state directories but the same checkout must
 * still not run the same issue twice. A worktree's `.git` is a file naming the real Git directory, which is read here.
 */
import { mkdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { lockSync } from 'proper-lockfile'
import { jobKey } from '../autopilot.ts'

/** A held lock, and the release that frees it. */
export interface Held { release: () => void }
/**
 * How long a lock may go unrefreshed before another process may take it. `proper-lockfile` refreshes the lock's mtime
 * every half of this, so the window only opens when the holder's event loop stalls for longer than that; a job's work
 * is minutes long, so the window is generous rather than tight.
 */
const STALE_MS = 600_000
/** Where inside a checkout the locks live, so every process working on that checkout shares them. */
const LOCK_DIR = 'dsh-superagent-autopilot'
/**
 * The directory a checkout's locks live in, or undefined when `checkout` is not a Git checkout.
 * A worktree's `.git` is a file holding `gitdir: <path>`, which is followed so its locks are shared with the main one.
 */
export function lockDirectory(checkout: string): string | undefined {
  if (!checkout) return undefined
  const dot = join(checkout, '.git')
  let git = dot
  try {
    if (statSync(dot).isFile()) {
      const target = /^gitdir:\s*(.+)$/m.exec(readFileSync(dot, 'utf8'))?.[1]?.trim()
      if (!target) return undefined
      git = target.startsWith('/') ? target : join(checkout, target)
    }
  } catch { return undefined }
  return join(git, LOCK_DIR)
}
/**
 * Holds one lock per job under the checkout's lock directory. A lock is taken before a job's work starts and released
 * when it ends, so a second process attempting the same issue waits rather than running beside the first.
 */
export class JobLocks {
  private readonly held = new Map<string, Held>()
  /** The checkout each job's lock belongs to, so a release finds the same file it took. */
  private readonly directories = new Map<string, string>()
  /**
   * Takes a job's lock in `checkout`, or returns undefined when another holder has it or the checkout has no lock
   * directory. A job whose checkout cannot hold a lock must not run: without the lock, two processes could run it.
   * @param onCompromised - called when the lock is lost, such as when its file is removed; the holder must then stop
   * working on the job, because another process may have taken it.
   */
  tryAcquire(repository: string, issue: number, checkout: string, onCompromised?: (error: Error) => void): Held | undefined {
    const key = jobKey(repository, issue)
    const existing = this.held.get(key)
    if (existing) return existing
    const directory = lockDirectory(checkout)
    if (!directory) return undefined
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      // The lock file itself is the lock; `realpath: false` lets it be created on first use.
      const release = lockSync(join(directory, `${repository.replace(/[^A-Za-z0-9_.-]/g, '_')}-issue-${issue}.lock`),
        { stale: STALE_MS, realpath: false, onCompromised: error => {
          // A lost lock is never silently ignored: this process no longer owns the job.
          this.held.delete(key)
          this.directories.delete(key)
          onCompromised?.(error)
        } })
      const held = { release }
      this.held.set(key, held)
      this.directories.set(key, directory)
      return held
    } catch {
      // A lock another holder keeps is not an error: the job simply waits for the next pass.
      return undefined
    }
  }
  /** Whether this process holds a job's lock. */
  holds(repository: string, issue: number): boolean { return this.held.has(jobKey(repository, issue)) }
  /** Releases a job's lock, if this process holds it. */
  async release(repository: string, issue: number): Promise<void> {
    const key = jobKey(repository, issue)
    const held = this.held.get(key)
    if (!held) return
    this.held.delete(key)
    this.directories.delete(key)
    try { held.release() } catch { /* A lock already gone needs no release. */ }
  }
  /** Releases every lock this process holds, which shutdown does. */
  async releaseAll(): Promise<void> {
    await Promise.all([...this.held.keys()].map(key => {
      const [repository = '', issue = '0'] = key.split('#')
      return this.release(repository, Number(issue))
    }))
  }
}
