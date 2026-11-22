// Where a job's work runs: an open workspace of the same repository when one is safe, otherwise the configured checkout.
import { describe, expect, it } from 'vitest'
import { AutopilotConfigSchema } from '../src/policy.ts'
import { chooseWorkspace, workspaceWatched, type WorkspaceCandidate } from '../src/app/autopilot-routing.ts'

const settings = (patch: Record<string, unknown> = {}) => AutopilotConfigSchema.parse({ enabled: true,
  repositories: [{ fullName: 'owner/one', checkout: '/srv/one' }], ...patch })
const workspace = (path: string, patch: Partial<WorkspaceCandidate> = {}): WorkspaceCandidate =>
  ({ path, title: path.split('/').pop() ?? path, sessionIds: [], matches: true, busy: false, ...patch })

describe('workspace routing', () => {
  it('routes to an open workspace of the same repository, which is where a person already works', () => {
    expect(chooseWorkspace({ candidates: [workspace('/home/me/one')], checkout: '/srv/one', settings: settings() }))
      .toEqual({ kind: 'workspace', path: '/home/me/one', title: 'one', reason: 'the only open workspace of this repository' })
  })
  it('never routes to a workspace of another repository, whatever its directory is called', () => {
    // A fork or a second clone has the same directory name but a different origin, so it is not a candidate.
    const other = workspace('/home/me/one', { matches: false })
    expect(chooseWorkspace({ candidates: [other], checkout: '/srv/one', settings: settings() }))
      .toEqual({ kind: 'checkout', path: '/srv/one', reason: 'no open workspace of this repository, so the configured checkout is used' })
  })
  it('does not route to a workspace whose session is running, so a person\'s turn is not interrupted', () => {
    const busy = workspace('/home/me/one', { busy: true })
    expect(chooseWorkspace({ candidates: [busy], checkout: '/srv/one', settings: settings() }))
      .toEqual({ kind: 'checkout', path: '/srv/one', reason: 'every open workspace of this repository is busy, so the configured checkout is used' })
  })
  it('waits instead of falling back when the operator chose to wait', () => {
    const busy = workspace('/home/me/one', { busy: true })
    expect(chooseWorkspace({ candidates: [busy], checkout: '/srv/one', settings: settings({ workspaceFallback: 'wait' }) }))
      .toEqual({ kind: 'wait', reason: 'every open workspace of this repository is busy, and the autopilot waits for one' })
  })
  it('uses the configured checkout when routing to open workspaces is off', () => {
    expect(chooseWorkspace({ candidates: [workspace('/home/me/one')], checkout: '/srv/one',
      settings: settings({ routeToOpenWorkspace: false }) }))
      .toEqual({ kind: 'checkout', path: '/srv/one', reason: 'routing to open workspaces is off' })
  })
  it('picks the same workspace every time when several are idle, so a retry does not wander', () => {
    const candidates = [workspace('/home/me/b'), workspace('/home/me/a'), workspace('/home/me/c')]
    const first = chooseWorkspace({ candidates, checkout: '/srv/one', settings: settings() })
    const again = chooseWorkspace({ candidates: candidates.slice().reverse(), checkout: '/srv/one', settings: settings() })
    expect(first).toMatchObject({ kind: 'workspace', path: '/home/me/a' })
    expect(again).toEqual(first)
  })
  it('honours the operator\'s stated preference before the deterministic order', () => {
    const candidates = [workspace('/home/me/a'), workspace('/home/me/b')]
    expect(chooseWorkspace({ candidates, checkout: '/srv/one', settings: settings({ workspacePriority: ['/home/me/b'] }) }))
      .toMatchObject({ kind: 'workspace', path: '/home/me/b', reason: 'the operator listed this workspace first' })
  })
  it('ignores a preferred workspace that is busy or not a candidate', () => {
    const candidates = [workspace('/home/me/a'), workspace('/home/me/b', { busy: true })]
    expect(chooseWorkspace({ candidates, checkout: '/srv/one', settings: settings({ workspacePriority: ['/home/me/b'] }) }))
      .toMatchObject({ kind: 'workspace', path: '/home/me/a' })
  })
  it('records whether a job\'s workspace is still one the operator configured', () => {
    expect(workspaceWatched('/srv/one', 'owner/one', settings())).toBe(true)
    expect(workspaceWatched('/home/me/one', 'owner/one', settings())).toBe(false)
    expect(workspaceWatched('/srv/one', 'owner/two', settings())).toBe(false)
  })
})
