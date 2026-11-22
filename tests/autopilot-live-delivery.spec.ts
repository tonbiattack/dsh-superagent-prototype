// Delivery against the real GitHub API, on a throwaway branch of a real repository.
//
// These run only when DSH_SUPERAGENT_LIVE_REPO names a repository the agent's `gh` can push to, and they never merge: they
// prove the calls delivery makes, which is what a fake cannot. The branch they push is deleted afterwards.
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Commands } from '../src/infra/commands.ts'
import { Delivery, pullBody, pullTitle } from '../src/app/autopilot-delivery.ts'
import { AutopilotConfigSchema } from '../src/policy.ts'
import { testDeployment } from './fixtures/deployment.ts'

const repository = process.env.DSH_SUPERAGENT_LIVE_REPO
const live = repository ? describe : describe.skip

live('live GitHub delivery', () => {
  const commands = () => new Commands(() => testDeployment({ repository: repository!, github: { cli: 'gh', login: 'tonbiattack',
    noreply: '7+tonbiattack@users.noreply.github.com' } }), {}, new AbortController().signal)
  /** A throwaway clone with one commit on a branch of its own, which delivery can push. */
  const branch = `agent/live-check-${Date.now()}`
  const clone = () => {
    const dir = mkdtempSync(join(tmpdir(), 'autopilot-delivery-'))
    execFileSync('git', ['clone', '--depth', '1', `https://github.com/${repository}.git`, dir], { stdio: 'ignore' })
    execFileSync('git', ['checkout', '-b', branch], { cwd: dir, stdio: 'ignore' })
    writeFileSync(join(dir, 'live-check.txt'), 'checked by the autopilot delivery test\n')
    execFileSync('git', ['add', 'live-check.txt'], { cwd: dir, stdio: 'ignore' })
    execFileSync('git', ['-c', 'user.name=agent-bot', '-c', 'user.email=agent-bot@example.com', 'commit', '-m', 'live check'],
      { cwd: dir, stdio: 'ignore' })
    return dir
  }
  it('pushes a branch and opens a pull request, then reuses it instead of opening a second one', async () => {
    const dir = clone()
    try {
      const delivery = new Delivery({ commands: commands(), settings: () => AutopilotConfigSchema.parse({ enabled: true,
        repositories: [{ fullName: repository!, checkout: dir }], validationCommand: 'true', autoMerge: false }),
        defaultBranch: async () => 'main', headSha: async (_directory, ref) =>
          execFileSync('git', ['rev-parse', ref], { cwd: dir }).toString().trim(),
        validate: async () => ({ passed: true, command: 'true' }) })
      const first = await delivery.deliver({ repository: repository!, issue: 1, branch, directory: dir, summary: 'Live check.' })
      expect(first.pushed).toBe(true)
      expect(first.prNumber).toBeGreaterThan(0)
      expect(first.prUrl).toContain('/pull/')
      // A retry must reuse the pull request it opened, not open a second one for the same branch.
      const again = await delivery.deliver({ repository: repository!, issue: 1, branch, directory: dir, summary: 'Live check.' })
      expect(again.prNumber).toBe(first.prNumber)
      // Automatic merging is off here, so nothing merged and the pull request is a person's to close.
      expect(first.mergeSha).toBeUndefined()
    } finally {
      // Leave the repository as it was: the branch and its pull request are a test's, not a person's.
      const pulls = execFileSync('gh', ['pr', 'list', '--repo', repository!, '--head', branch, '--state', 'open', '--json', 'number'],
        { encoding: 'utf8' })
      for (const pull of JSON.parse(pulls) as { number: number }[]) {
        execFileSync('gh', ['pr', 'close', String(pull.number), '--repo', repository!], { stdio: 'ignore' })
      }
      execFileSync('git', ['push', 'origin', '--delete', branch], { cwd: dir, stdio: 'ignore' })
      rmSync(dir, { recursive: true, force: true })
    }
  }, 120_000)
  it('names the issue in the title and closes it only when asked', () => {
    expect(pullTitle(1, 'Live check')).toBe('Live check (#1)')
    expect(pullBody(1, repository!, 'Live check.')).not.toContain('Closes #1')
    expect(pullBody(1, repository!, 'Live check.', true)).toContain('Closes #1')
  })
})
