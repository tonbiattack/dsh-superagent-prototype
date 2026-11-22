// Delivery's merge path against real GitHub, on a throwaway repository.
//
// These run only when DSH_SUPERAGENT_LIVE_MERGE_REPO names a repository the agent's `gh` can push to and merge in, and the
// repository is expected to be disposable: the test merges a pull request into its default branch. It covers what a fake
// cannot: that the merge call, its expected-commit guard, and the branch-protection read behave as the code assumes.
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Commands } from '../src/infra/commands.ts'
import { Delivery, mergeVerdict } from '../src/app/autopilot-delivery.ts'
import { AutopilotConfigSchema } from '../src/policy.ts'
import { testDeployment } from './fixtures/deployment.ts'

const repository = process.env.DSH_SUPERAGENT_LIVE_MERGE_REPO
const live = repository ? describe : describe.skip

live('live GitHub merge', () => {
  const commands = () => new Commands(() => testDeployment({ repository: repository!, github: { cli: 'gh', login: 'tonbiattack',
    noreply: '7+tonbiattack@users.noreply.github.com' } }), {}, new AbortController().signal)
  /** A clone with one commit on a branch of its own, which delivery can push and merge. */
  const prepare = (branch: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'autopilot-merge-'))
    execFileSync('git', ['clone', `https://github.com/${repository}.git`, dir], { stdio: 'ignore' })
    execFileSync('git', ['checkout', '-b', branch], { cwd: dir, stdio: 'ignore' })
    writeFileSync(join(dir, `${branch.replace(/\//g, '-')}.txt`), 'merged by the autopilot delivery test\n')
    execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'ignore' })
    execFileSync('git', ['-c', 'user.name=agent-bot', '-c', 'user.email=agent-bot@example.com', 'commit', '-m', `merge check ${branch}`],
      { cwd: dir, stdio: 'ignore' })
    return dir
  }
  const delivery = (dir: string, patch: Record<string, unknown> = {}) => new Delivery({
    commands: commands(),
    settings: () => AutopilotConfigSchema.parse({ enabled: true, repositories: [{ fullName: repository!, checkout: dir }],
      validationCommand: 'true', ...patch }),
    defaultBranch: async () => 'main',
    headSha: async (_directory, ref) => execFileSync('git', ['rev-parse', ref], { cwd: dir }).toString().trim(),
    validate: async () => ({ passed: true, command: 'true' }),
  })

  it('merges a pull request into the default branch and reports the merge commit', async () => {
    const branch = `agent/merge-check-${Date.now()}`
    const dir = prepare(branch)
    try {
      const result = await delivery(dir).deliver({ repository: repository!, issue: 1, branch, directory: dir, summary: 'Merge check.' })
      expect(result.pushed).toBe(true)
      expect(result.prNumber).toBeGreaterThan(0)
      expect(result.mergeSha).toMatch(/^[0-9a-f]{40}$/)
      // The merge really landed: the default branch now carries the file the branch added.
      const merged = execFileSync('gh', ['api', `repos/${repository}/contents/${branch.replace(/\//g, '-')}.txt`,
        '--jq', '.name'], { encoding: 'utf8' }).trim()
      expect(merged).toBe(`${branch.replace(/\//g, '-')}.txt`)
      // A retry after the merge reports the same merge commit instead of merging again.
      const again = await delivery(dir).deliver({ repository: repository!, issue: 1, branch, directory: dir, summary: 'Merge check.' })
      expect(again.mergeSha).toBe(result.mergeSha)
    } finally {
      execFileSync('git', ['push', 'origin', '--delete', branch], { cwd: dir, stdio: 'ignore' })
      rmSync(dir, { recursive: true, force: true })
    }
  }, 180_000)

  it('refuses to merge when the branch moved after the commit it validated', async () => {
    const branch = `agent/moved-check-${Date.now()}`
    const dir = prepare(branch)
    try {
      // The merge names the commit it expects; a branch that moved meanwhile must be refused rather than merged unseen.
      const moved = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).toString().trim()
      writeFileSync(join(dir, 'later.txt'), 'a later commit\n')
      execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'ignore' })
      execFileSync('git', ['-c', 'user.name=agent-bot', '-c', 'user.email=agent-bot@example.com', 'commit', '-m', 'later'],
        { cwd: dir, stdio: 'ignore' })
      const deliveryWithStaleCommit = new Delivery({
        commands: commands(),
        settings: () => AutopilotConfigSchema.parse({ enabled: true, repositories: [{ fullName: repository!, checkout: dir }],
          validationCommand: 'true' }),
        defaultBranch: async () => 'main',
        // The commit delivery validated is the earlier one, which is no longer the branch's head.
        headSha: async () => moved,
        validate: async () => ({ passed: true, command: 'true' }),
      })
      await expect(deliveryWithStaleCommit.deliver({ repository: repository!, issue: 1, branch, directory: dir, summary: 'Moved.' }))
        .rejects.toThrow(/refused the merge|not mergeable|head branch was modified/i)
    } finally {
      const pulls = execFileSync('gh', ['pr', 'list', '--repo', repository!, '--head', branch, '--state', 'open', '--json', 'number'],
        { encoding: 'utf8' })
      for (const pull of JSON.parse(pulls) as { number: number }[]) {
        execFileSync('gh', ['pr', 'close', String(pull.number), '--repo', repository!], { stdio: 'ignore' })
      }
      execFileSync('git', ['push', 'origin', '--delete', branch], { cwd: dir, stdio: 'ignore' })
      rmSync(dir, { recursive: true, force: true })
    }
  }, 180_000)

  it('reads an unprotected default branch as requiring nothing, which is what the merge rules then allow', async () => {
    // The repository this runs against has no branch protection, so the read must say so rather than fail.
    const read = await commands().api({ parse: (value: unknown) => value } as never, 'branches/main/protection')
      .then(() => 'protected', (error: { code?: number }) => error.code === 404 ? 'unprotected' : 'failed')
    expect(read).toBe('unprotected')
    expect(mergeVerdict({ open: true, conflicting: false, checks: [] }, AutopilotConfigSchema.parse({ enabled: true })))
      .toEqual({ merge: true })
  })
})
