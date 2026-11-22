/**
 * Prototype per-issue file locks. Only processes using the same lock directory coordinate; different
 * state directories are not protected. Dispatch must remain disabled until a shared identity-based
 * lock and compromised-lock handling are implemented.
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { lockSync } from 'proper-lockfile'
import { jobKey } from '../autopilot.ts'

/** A held lock, and the release that frees it. */
export interface Held { release: () => void }
/**
 * How long a lock may go unrefreshed before another process may take it. `proper-lockfile` refreshes the lock's mtime
 * every half of this, so the window only opens when the holder's event loop stalls for longer than this; a job's work
 * is minutes long, so the window is generous rather than tight.
 */
const STALE_MS = 600_000
/**
 * Holds one lock per job under `directory`. A lock is taken before a job's work starts and released when it ends, so a
 * second attempt on the same issue waits rather than running beside the first.
 */
export class JobLocks {
  private readonly held = new Map<string, Held>()
  constructor(private readonly directory: string) { mkdirSync(directory, { recursive: true, mode: 0o700 }) }
  /** The file a job's lock is kept in, named so a person can see which issue holds it. */
  path(repository: string, issue: number): string {
    return join(this.directory, `${repository.replace(/[^A-Za-z0-9_.-]/g, '_')}-issue-${issue}.lock`)
  }
  /**
   * Takes a job's lock, or returns undefined when another holder has it.
   * @param onCompromised - called when the lock is lost, such as when its file is removed; the holder must then stop
   * working on the job, because another process may have taken it.
   */
  tryAcquire(repository: string, issue: number, onCompromised?: (error: Error) => void): Held | undefined {
    const key = jobKey(repository, issue)
    const existing = this.held.get(key)
    if (existing) return existing
    const path = this.path(repository, issue)
    try {
      // The lock file itself is the lock; `realpath: false` lets it be created on first use.
      const release = lockSync(path, { stale: STALE_MS, realpath: false, onCompromised: error => {
        // A lost lock is never silently ignored: this process no longer owns the job.
        this.held.delete(key)
        onCompromised?.(error)
      } })
      const held = { release }
      this.held.set(key, held)
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
