// The autopilot's delivery: the merge rules, and the calls that push, open, reuse and merge a pull request.
import { describe, expect, it, vi } from 'vitest'
import { AutopilotConfigSchema } from '../src/policy.ts'
import { Delivery, mergeVerdict, pullBody, pullTitle, type DeliveryHost, type MergeFacts } from '../src/app/autopilot-delivery.ts'
import { CliError } from '../src/infra/commands.ts'
import type { Commands } from '../src/infra/commands.ts'

const settings = (patch: Record<string, unknown> = {}) => AutopilotConfigSchema.parse({ enabled: true, ...patch })
const facts = (patch: Partial<MergeFacts> = {}): MergeFacts => ({ open: true, conflicting: false, checks: [], ...patch })
const check = (name: string, patch: Partial<{ failed: boolean; running: boolean }> = {}) => ({ name, failed: false, running: false, ...patch })

describe('merge verdict', () => {
  it('merges a pull request whose checks passed and whose branch does not conflict', () => {
    expect(mergeVerdict(facts({ checks: [check('build'), check('test')] }), settings())).toEqual({ merge: true })
  })
  it('refuses while automatic merging is off', () => {
    expect(mergeVerdict(facts(), settings({ autoMerge: false }))).toEqual({ merge: false, reason: 'automatic merging is off' })
  })
  it('refuses a pull request that is closed or already merged', () => {
    expect(mergeVerdict(facts({ open: false }), settings())).toEqual({ merge: false, reason: 'the pull request is not open' })
  })
  it('refuses a conflicting pull request, and says so', () => {
    expect(mergeVerdict(facts({ conflicting: true }), settings())).toEqual({ merge: false, reason: 'the pull request conflicts with its base branch' })
  })
  it('refuses while a required check failed, naming it', () => {
    expect(mergeVerdict(facts({ checks: [check('build', { failed: true }), check('lint')] }), settings()))
      .toEqual({ merge: false, reason: 'required checks failed: build' })
  })
  it('refuses while a required check still runs, naming it', () => {
    expect(mergeVerdict(facts({ checks: [check('build', { running: true })] }), settings()))
      .toEqual({ merge: false, reason: 'required checks are still running: build' })
  })
  it('refuses while the repository requires more approvals than it has', () => {
    expect(mergeVerdict(facts({ requiredApprovals: 2, approvals: 1 }), settings()))
      .toEqual({ merge: false, reason: 'the repository requires 2 approving review(s); it has 1' })
    expect(mergeVerdict(facts({ requiredApprovals: 1, approvals: 1 }), settings())).toEqual({ merge: true })
  })
  it('assumes no approval when the count is unknown, rather than guessing', () => {
    expect(mergeVerdict(facts({ requiredApprovals: 1 }), settings())).toEqual({ merge: false, reason: 'the repository requires 1 approving review(s); it has 0' })
  })
  it('ignores the approval requirement when the operator turns branch protection off', () => {
    expect(mergeVerdict(facts({ requiredApprovals: 2, approvals: 0 }), settings({ respectBranchProtection: false }))).toEqual({ merge: true })
  })
})

describe('pull request text', () => {
  it('names the issue in the title, so the two read as one piece of work', () => {
    expect(pullTitle(12, 'Fix the parser')).toBe('Fix the parser (#12)')
  })
  it('closes the issue from the body, and says who opened it', () => {
    const body = pullBody(12, 'owner/one', 'Reworked the parser.')
    expect(body).toContain('Closes #12')
    expect(body).toContain('owner/one')
    expect(body).toContain('Reworked the parser.')
  })
  it('leaves the summary out when there is none', () => {
    expect(pullBody(12, 'owner/one', '  ')).not.toMatch(/\n\n\n/)
  })
})

/** A GitHub CLI and git that answer from `state`, recording every call. */
function fake(state: {
  pulls?: Record<string, unknown>[]; checks?: Record<string, unknown>[]; statuses?: Record<string, unknown>[]
  reviews?: Record<string, unknown>[]; protection?: unknown; merge?: Record<string, unknown>; issue?: { title: string }
  pull?: Record<string, unknown>; fail?: (path: string) => Error | undefined
} = {}) {
  const calls: { program: string; args: string[] }[] = []
  const commands = {
    withSignal: () => commands,
    git: async (args: string[]) => { calls.push({ program: 'git', args }); return '' },
    api: async (_schema: unknown, path: string, ...flags: string[]) => {
      calls.push({ program: 'gh', args: [path, ...flags] })
      const failure = state.fail?.(path)
      if (failure) throw failure
      if (path === '') return { default_branch: 'main' }
      if (path.startsWith('pulls?')) return state.pulls ?? []
      if (path === 'pulls') return { number: 5, html_url: 'https://github.com/owner/one/pull/5', state: 'open', head: { ref: 'agent/issue-12', sha: 'abc' },
        base: { ref: 'main' }, merged: false }
      if (path.startsWith('issues/')) return state.issue ?? { title: 'Fix the parser' }
      if (path.startsWith('commits/') && path.includes('check-runs')) return { check_runs: state.checks ?? [] }
      if (path.startsWith('pulls/') && path.endsWith('/reviews?per_page=100')) return state.reviews ?? []
      if (path.includes('/protection')) return state.protection ?? {}
      if (path.endsWith('/merge')) return state.merge ?? { merged: true, sha: 'merge-sha' }
      if (/^pulls\/\d+$/.test(path)) return state.pull ?? { merge_commit_sha: 'merge-sha' }
      return {}
    },
    pages: async (_schema: unknown, path: string) => { calls.push({ program: 'gh', args: [path] }); return state.statuses ?? [] },
  } as unknown as Commands
  return { commands, calls }
}
const delivery = (state: Parameters<typeof fake>[0] = {}, patch: Record<string, unknown> = {}) => {
  const { commands, calls } = fake(state)
  const host: DeliveryHost = { commands, settings: () => settings(patch), defaultBranch: async () => 'main',
    headSha: async () => 'abc' }
  return { deliver: new Delivery(host), calls }
}
const input = { repository: 'owner/one', issue: 12, branch: 'agent/issue-12', directory: '/srv/one', summary: 'Reworked the parser.' }

describe('delivery', () => {
  it('pushes the branch, opens a pull request and merges it when every requirement holds', async () => {
    const { deliver, calls } = delivery()
    const result = await deliver.deliver(input)
    expect(result).toMatchObject({ pushed: true, prNumber: 5, prUrl: 'https://github.com/owner/one/pull/5', mergeSha: 'merge-sha' })
    expect(calls.find(call => call.program === 'git')?.args).toEqual(['push', '--set-upstream', 'origin', 'agent/issue-12'])
    expect(calls.some(call => call.args.includes('--method') && call.args.includes('PUT'))).toBe(true)
  })
  it('never force-pushes', async () => {
    const { deliver, calls } = delivery()
    await deliver.deliver(input)
    expect(calls.filter(call => call.program === 'git').flatMap(call => call.args)).not.toContain('--force')
  })
  it('refuses to deliver to the default branch', async () => {
    const { deliver, calls } = delivery()
    await expect(deliver.deliver({ ...input, branch: 'main' })).rejects.toThrow('it is the default branch')
    expect(calls.filter(call => call.program === 'git')).toEqual([])
  })
  it('reuses the pull request already open for the branch instead of opening a second one', async () => {
    const { deliver, calls } = delivery({ pulls: [{ number: 5, html_url: 'https://github.com/owner/one/pull/5', state: 'open', merged: false,
      head: { ref: 'agent/issue-12', sha: 'abc' }, base: { ref: 'main' } }] })
    const result = await deliver.deliver(input)
    expect(result.prNumber).toBe(5)
    expect(calls.some(call => call.args[0] === 'pulls' && call.args.includes('POST'))).toBe(false)
  })
  it('reports the merge commit of a pull request that already merged, without merging again', async () => {
    const { deliver, calls } = delivery({ pulls: [{ number: 5, html_url: 'https://github.com/owner/one/pull/5', state: 'closed', merged: true,
      head: { ref: 'agent/issue-12', sha: 'abc' }, base: { ref: 'main' } }], pull: { merge_commit_sha: 'already-merged' } })
    const result = await deliver.deliver(input)
    expect(result.mergeSha).toBe('already-merged')
    expect(calls.some(call => call.args.some(arg => arg.endsWith('/merge')))).toBe(false)
  })
  it('leaves the pull request open and says why when a required check failed', async () => {
    const { deliver, calls } = delivery({ checks: [{ name: 'build', status: 'completed', conclusion: 'failure' }] })
    const result = await deliver.deliver(input)
    expect(result.blocked).toBe('required checks failed: build')
    expect(result.mergeSha).toBeUndefined()
    expect(calls.some(call => call.args.some(arg => arg.endsWith('/merge')))).toBe(false)
  })
  it('leaves the pull request open while a required check still runs', async () => {
    const { deliver } = delivery({ checks: [{ name: 'build', status: 'in_progress', conclusion: null }] })
    expect((await deliver.deliver(input)).blocked).toBe('required checks are still running: build')
  })
  it('leaves the pull request open when the repository requires an approval it lacks', async () => {
    const { deliver } = delivery({ protection: { required_pull_request_reviews: { required_approving_review_count: 1 } }, reviews: [] })
    expect((await deliver.deliver(input)).blocked).toBe('the repository requires 1 approving review(s); it has 0')
  })
  it('merges once the required approval is present', async () => {
    const { deliver } = delivery({ protection: { required_pull_request_reviews: { required_approving_review_count: 1 } },
      reviews: [{ state: 'APPROVED' }] })
    expect((await deliver.deliver(input)).mergeSha).toBe('merge-sha')
  })
  it('treats an unprotected branch as requiring nothing, and a failed protection read as no permission', async () => {
    const open = delivery({ fail: path => path.includes('/protection') ? new CliError('Not Found', 404) : undefined })
    expect((await open.deliver.deliver(input)).mergeSha).toBe('merge-sha')
    const broken = delivery({ fail: path => path.includes('/protection') ? new CliError('Server Error', 500) : undefined })
    await expect(broken.deliver.deliver(input)).rejects.toThrow('Server Error')
  })
  it('leaves the pull request open when it conflicts with its base', async () => {
    const { deliver } = delivery({ pulls: [{ number: 5, html_url: 'https://github.com/owner/one/pull/5', state: 'open', merged: false,
      mergeable: false, head: { ref: 'agent/issue-12', sha: 'abc' }, base: { ref: 'main' } }] })
    expect((await deliver.deliver(input)).blocked).toBe('the pull request conflicts with its base branch')
  })
  it('opens no pull request and pushes nothing when the operator turns both off', async () => {
    const { deliver, calls } = delivery({}, { createPullRequest: false, autoPush: false })
    const result = await deliver.deliver(input)
    expect(result).toEqual({ pushed: false, commitSha: 'abc' })
    expect(calls.filter(call => call.program === 'git')).toEqual([])
  })
  it('pushes but opens no pull request when only pull requests are off', async () => {
    const { deliver, calls } = delivery({}, { createPullRequest: false })
    expect(await deliver.deliver(input)).toEqual({ pushed: true, commitSha: 'abc' })
    expect(calls.filter(call => call.program === 'git')).toHaveLength(1)
  })
  it('records the merge method the operator chose', async () => {
    const { deliver, calls } = delivery({}, { mergeMethod: 'rebase' })
    await deliver.deliver(input)
    expect(calls.find(call => call.args.some(arg => arg.endsWith('/merge')))?.args).toContain('merge_method=rebase')
  })
  it('fails when GitHub refuses the merge, rather than reporting success', async () => {
    const { deliver } = delivery({ merge: { merged: false, message: 'Pull request is not mergeable' } })
    await expect(deliver.deliver(input)).rejects.toThrow('GitHub refused the merge: Pull request is not mergeable')
  })
})
