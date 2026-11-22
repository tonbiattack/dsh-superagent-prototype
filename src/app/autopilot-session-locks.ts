/**
 * The lock that keeps two autopilot jobs out of one DSH session.
 *
 * A reused session holds one conversation, so two jobs in it would interleave their turns and each would see the other's
 * work. The lock is per session, not per job, because that is the resource being shared. It is a file lock in the state
 * directory, so it also holds across processes, and it is released when the holder stops, so a crash frees it.
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { lockSync } from 'proper-lockfile'

/** A held lock, and the release that frees it. */
export interface Held { release: () => void }
/**
 * How long a lock may go unrefreshed before another process may take it. `proper-lockfile` refreshes the lock's mtime
 * every half of this, so the window only opens when the holder's event loop stalls for longer than that.
 */
const STALE_MS = 600_000
/**
 * Holds one lock per DSH session under `directory`. A lock is taken before a job's work starts in a session and released
 * when it ends, so a second job waits rather than interleaving with the first.
 */
export class SessionLocks {
  private readonly held = new Map<string, Held>()
  constructor(private readonly directory: string) { mkdirSync(directory, { recursive: true, mode: 0o700 }) }
  /** The file a session's lock is kept in, named so a person can see which session is held. */
  path(sessionId: string): string { return join(this.directory, `${sessionId.replace(/[^A-Za-z0-9_.-]/g, '_')}.lock`) }
  /**
   * Takes a session's lock, or returns undefined when another holder has it.
   * @param onCompromised - called when the lock is lost, such as when its file is removed; the holder must then stop
   * working in the session, because another job may have taken it.
   */
  tryAcquire(sessionId: string, onCompromised?: (error: Error) => void): Held | undefined {
    const existing = this.held.get(sessionId)
    if (existing) return existing
    try {
      const release = lockSync(this.path(sessionId), { stale: STALE_MS, realpath: false, onCompromised: error => {
        // A lost lock is never silently ignored: this job no longer owns the session.
        this.held.delete(sessionId)
        onCompromised?.(error)
      } })
      const held = { release }
      this.held.set(sessionId, held)
      return held
    } catch (error) {
      // A lock another holder keeps is not an error: the job simply waits for the next pass. Anything else is a real
      // failure to lock, which must not be mistaken for contention.
      if ((error as { code?: string }).code !== 'ELOCKED') throw error
      return undefined
    }
  }
  /** Whether this process holds a session's lock. */
  holds(sessionId: string): boolean { return this.held.has(sessionId) }
  /** Releases a session's lock, if this process holds it. */
  async release(sessionId: string): Promise<void> {
    const held = this.held.get(sessionId)
    if (!held) return
    this.held.delete(sessionId)
    try { held.release() } catch { /* A lock already gone needs no release. */ }
  }
  /** Releases every lock this process holds, which shutdown does. */
  async releaseAll(): Promise<void> {
    await Promise.all([...this.held.keys()].map(sessionId => this.release(sessionId)))
  }
}
