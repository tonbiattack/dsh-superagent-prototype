// The worktree a job works in, and the lock that keeps two jobs out of one session.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ensureWorktree, removeWorktree, worktreeBranch, worktreePath } from '../src/app/autopilot-worktree.ts'
import { SessionLocks } from '../src/app/autopilot-session-locks.ts'
import type { Commands } from '../src/infra/commands.ts'

/** A Git that answers from `state` and records the commands it ran. */
function git(state: { top?: string; branch?: string; status?: string; hasBranch?: boolean } = {}) {
  const ran: string[][] = []
  const commands = {
    git: async (args: string[]) => {
      ran.push(args)
      if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') { if (!state.top) throw new Error('not a worktree'); return `${state.top}\n` }
      if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return `${state.branch ?? 'main'}\n`
      if (args[0] === 'rev-parse' && args[1] === '--verify') { if (!state.hasBranch) throw new Error('no branch'); return 'abc\n' }
      if (args[0] === 'status') return `${state.status ?? ''}\n`
      return ''
    },
  } as unknown as Commands
  return { commands, ran }
}

describe('worktree', () => {
  it('names the worktree after the repository and issue, outside the checkout', () => {
    expect(worktreePath('/state', 11, 7)).toBe('/state/autopilot-worktrees/11-issue-7')
    expect(worktreeBranch(7)).toBe('agent/issue-7')
  })
  it('creates a worktree on the job\'s own branch, so its changes never mix with the checkout', async () => {
    const { commands, ran } = git()
    const state = await ensureWorktree(commands, { checkout: '/srv/one', path: '/state/wt', branch: 'agent/issue-7' })
    expect(state).toEqual({ kind: 'created', path: '/state/wt', branch: 'agent/issue-7' })
    expect(ran).toContainEqual(['worktree', 'add', '-b', 'agent/issue-7', '/state/wt'])
  })
  it('reuses a worktree that already exists on the job\'s branch, so a retry continues where it was', async () => {
    const { commands, ran } = git({ top: '/state/wt', branch: 'agent/issue-7' })
    expect(await ensureWorktree(commands, { checkout: '/srv/one', path: '/state/wt', branch: 'agent/issue-7' }))
      .toEqual({ kind: 'ready', path: '/state/wt', branch: 'agent/issue-7' })
    expect(ran.some(args => args[0] === 'worktree')).toBe(false)
  })
  it('refuses a worktree that is on another branch, which belongs to other work', async () => {
    const { commands } = git({ top: '/state/wt', branch: 'agent/issue-9' })
    await expect(ensureWorktree(commands, { checkout: '/srv/one', path: '/state/wt', branch: 'agent/issue-7' }))
      .rejects.toThrow('is on agent/issue-9, not agent/issue-7')
  })
  it('refuses to create a worktree from a checkout with uncommitted changes, so a person\'s work is not carried in', async () => {
    const { commands, ran } = git({ status: ' M src/app.ts' })
    expect(await ensureWorktree(commands, { checkout: '/srv/one', path: '/state/wt', branch: 'agent/issue-7' }))
      .toEqual({ kind: 'dirty', reason: '/srv/one has uncommitted changes, so a worktree is not created from it' })
    expect(ran.some(args => args[0] === 'worktree')).toBe(false)
  })
  it('reuses a branch left by an earlier attempt rather than recreating it', async () => {
    const { commands, ran } = git({ hasBranch: true })
    await ensureWorktree(commands, { checkout: '/srv/one', path: '/state/wt', branch: 'agent/issue-7' })
    expect(ran).toContainEqual(['worktree', 'add', '/state/wt', 'agent/issue-7'])
  })
  it('removes a worktree without touching its branch, so the work it committed is kept', async () => {
    const { commands, ran } = git()
    await removeWorktree(commands, { checkout: '/srv/one', path: '/state/wt' })
    expect(ran).toContainEqual(['worktree', 'remove', '--force', '/state/wt'])
    expect(ran.some(args => args.includes('-D'))).toBe(false)
  })
})

describe('session locks', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'autopilot-sessions-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })
  it('holds one lock per session, and refuses a second job in the same session', async () => {
    const locks = new SessionLocks(dir)
    expect(locks.tryAcquire('autopilot-repo-11')).toBeDefined()
    expect(locks.holds('autopilot-repo-11')).toBe(true)
    // A second job in the same session would interleave with the first, so it is refused.
    expect(new SessionLocks(dir).tryAcquire('autopilot-repo-11')).toBeUndefined()
    // Another session is a different lock.
    expect(new SessionLocks(dir).tryAcquire('autopilot-repo-12')).toBeDefined()
    await locks.releaseAll()
  })
  it('frees the lock on release, so the next job takes it', async () => {
    const locks = new SessionLocks(dir)
    locks.tryAcquire('autopilot-repo-11')
    await locks.release('autopilot-repo-11')
    expect(locks.holds('autopilot-repo-11')).toBe(false)
    expect(new SessionLocks(dir).tryAcquire('autopilot-repo-11')).toBeDefined()
  })
  it('names the lock file after the session, so a person can see which session is held', () => {
    expect(new SessionLocks(dir).path('autopilot-repo-11')).toContain('autopilot-repo-11.lock')
  })
  it('releases every lock it holds, which shutdown does', async () => {
    const locks = new SessionLocks(dir)
    locks.tryAcquire('autopilot-repo-11')
    locks.tryAcquire('autopilot-repo-12')
    await locks.releaseAll()
    expect(locks.holds('autopilot-repo-11')).toBe(false)
    expect(locks.holds('autopilot-repo-12')).toBe(false)
  })
})
