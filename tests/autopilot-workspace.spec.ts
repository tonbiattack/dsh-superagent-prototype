// Where an autopilot job's work runs, and the proof that the directory is the repository it claims.
import { describe, expect, it } from 'vitest'
import { AutopilotConfigSchema } from '../src/policy.ts'
import { remoteMatches, repositorySlug, verifyCheckout, workspaceRoot } from '../src/app/autopilot-workspace.ts'
import type { Commands } from '../src/infra/commands.ts'

const settings = (patch: Record<string, unknown> = {}) => AutopilotConfigSchema.parse({ enabled: true,
  repositories: [{ fullName: 'owner/one', checkout: '/srv/one' }, { fullName: 'owner/two', checkout: '' }], ...patch })
/** A Git that answers `rev-parse --show-toplevel` and `remote get-url origin` from `state`. */
const git = (state: { top?: string; remote?: string } = {}) => ({
  git: async (args: string[]) => {
    if (args[0] === 'rev-parse') { if (!state.top) throw new Error('not a repository'); return `${state.top}\n` }
    if (args[0] === 'remote') { if (!state.remote) throw new Error('no such remote'); return `${state.remote}\n` }
    throw new Error(`unexpected ${args.join(' ')}`)
  },
}) as unknown as Commands

describe('workspace root', () => {
  it('gives each repository its own checkout, so two repositories never share a directory', () => {
    expect(workspaceRoot('owner/one', settings(), '/state/work')).toBe('/srv/one')
    expect(workspaceRoot('owner/two', settings(), '/state/work')).toBe('/state/work/owner-two')
  })
  it('names a repository without a checkout after it, so its directory cannot collide with another', () => {
    expect(repositorySlug('Owner/One')).toBe('owner-one')
    expect(repositorySlug('owner/one')).not.toBe(repositorySlug('owner/two'))
  })
  it('compares repository names without regard to case', () => {
    expect(workspaceRoot('OWNER/ONE', settings(), '/state/work')).toBe('/srv/one')
  })
  it('gives no root to a repository the operator no longer watches, so its jobs cannot run elsewhere', () => {
    expect(workspaceRoot('owner/three', settings(), '/state/work')).toBeUndefined()
  })
})

describe('remote identity', () => {
  it('recognizes the URL forms a GitHub checkout uses', () => {
    for (const remote of ['https://github.com/owner/one', 'https://github.com/owner/one.git', 'git@github.com:owner/one.git',
      'ssh://git@github.com/owner/one']) expect(remoteMatches(remote, 'owner/one')).toBe(true)
  })
  it('refuses another repository, a lookalike owner, and an empty remote', () => {
    expect(remoteMatches('https://github.com/owner/two', 'owner/one')).toBe(false)
    expect(remoteMatches('https://github.com/owner/one-other', 'owner/one')).toBe(false)
    expect(remoteMatches('https://github.com/evil/owner/one', 'owner/one')).toBe(false)
    expect(remoteMatches('', 'owner/one')).toBe(false)
  })
})

describe('checkout verification', () => {
  it('accepts a checkout whose origin is the repository', async () => {
    await expect(verifyCheckout(git({ top: '/srv/one', remote: 'https://github.com/owner/one.git' }), '/srv/one', 'owner/one'))
      .resolves.toBeUndefined()
  })
  it('refuses a directory that is not a Git checkout', async () => {
    await expect(verifyCheckout(git({}), '/srv/one', 'owner/one')).rejects.toThrow('not a Git checkout')
  })
  it('refuses a checkout with no origin, which cannot be shown to be the repository', async () => {
    await expect(verifyCheckout(git({ top: '/srv/one' }), '/srv/one', 'owner/one')).rejects.toThrow('no origin remote')
  })
  it('refuses a checkout of another repository, so work never lands in the wrong one', async () => {
    await expect(verifyCheckout(git({ top: '/srv/one', remote: 'https://github.com/owner/two.git' }), '/srv/one', 'owner/one'))
      .rejects.toThrow('another repository')
  })
})
