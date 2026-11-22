// Which DSH session a job's work runs in: its own, or one reused for the repository.
import { describe, expect, it } from 'vitest'
import { AutopilotConfigSchema } from '../src/policy.ts'
import { chooseSession, repositorySessionId, type SessionCandidate } from '../src/app/autopilot-session.ts'

const settings = (patch: Record<string, unknown> = {}) => AutopilotConfigSchema.parse({ enabled: true, ...patch })
const session = (id: string, patch: Partial<SessionCandidate> = {}): SessionCandidate =>
  ({ id, cwd: '/home/me/one', busy: false, owned: true, ...patch })
const own = 'worker-t1'

describe('session choice', () => {
  it('reuses the session dsh-superagent keeps for the repository, so its understanding carries over', () => {
    expect(chooseSession({ candidates: [session('autopilot-repo-11')], own, settings: settings() }))
      .toEqual({ kind: 'reuse', id: 'autopilot-repo-11', reason: 'reusing the session dsh-superagent keeps for this repository' })
  })
  it('creates a session per job when reuse is off, which is the behaviour every ticket had before', () => {
    expect(chooseSession({ candidates: [session('autopilot-repo-11')], own, settings: settings({ sessionReuse: 'off' }) }))
      .toEqual({ kind: 'create', id: own, reason: 'session reuse is off, so this job gets its own session' })
  })
  it('never reuses a session that is running, so a person\'s own turn is not interrupted', () => {
    expect(chooseSession({ candidates: [session('autopilot-repo-11', { busy: true })], own, settings: settings() }))
      .toEqual({ kind: 'create', id: own, reason: 'every reusable session is running, so this job gets its own' })
  })
  it('does not reuse a person\'s session unless the operator allowed it', () => {
    const person = session('my-own-chat', { owned: false })
    expect(chooseSession({ candidates: [person], own, settings: settings() }))
      .toEqual({ kind: 'create', id: own, reason: 'no reusable session exists for this repository, so this job gets its own' })
    expect(chooseSession({ candidates: [person], own, settings: settings({ sessionReuse: 'any' }) }))
      .toEqual({ kind: 'reuse', id: 'my-own-chat', reason: 'reusing an idle session of this repository, which the operator allowed' })
  })
  it('still refuses a person\'s session that is running, even when reuse of any session is allowed', () => {
    const person = session('my-own-chat', { owned: false, busy: true })
    expect(chooseSession({ candidates: [person], own, settings: settings({ sessionReuse: 'any' }) }))
      .toMatchObject({ kind: 'create', id: own })
  })
  it('picks the same session every time when several are idle, so a retry keeps the history it built', () => {
    const candidates = [session('autopilot-repo-11'), session('autopilot-repo-11-b')]
    const first = chooseSession({ candidates, own, settings: settings() })
    const again = chooseSession({ candidates: candidates.slice().reverse(), own, settings: settings() })
    expect(first).toMatchObject({ kind: 'reuse', id: 'autopilot-repo-11' })
    expect(again).toEqual(first)
  })
  it('creates a session when the repository has none, rather than failing', () => {
    expect(chooseSession({ candidates: [], own, settings: settings() }))
      .toEqual({ kind: 'create', id: own, reason: 'no reusable session exists for this repository, so this job gets its own' })
  })
  it('names the repository session after its immutable id, so a rename keeps it', () => {
    expect(repositorySessionId(11)).toBe('autopilot-repo-11')
    expect(repositorySessionId(11)).not.toBe(repositorySessionId(12))
  })
})
