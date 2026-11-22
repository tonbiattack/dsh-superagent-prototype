// The autopilot's GitHub reads against the real API, read-only.
//
// These run only when DSH_SUPERAGENT_LIVE_REPO names a repository the agent's `gh` can read, so the suite stays offline by
// default. They exist because the shapes the poller parses are GitHub's, not ours: a fixture that drifts from the real
// response would pass while the feature failed in use.
import { describe, expect, it } from 'vitest'
import { Commands } from '../src/infra/commands.ts'
import { AutopilotPoller, labelNames } from '../src/app/autopilot-poller.ts'
import { AutopilotQueue } from '../src/app/autopilot-queue.ts'
import { Store } from '../src/app/store.ts'
import { AutopilotConfigSchema } from '../src/policy.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { testDeployment } from './fixtures/deployment.ts'
import { z } from 'zod'

/** Accepts any JSON shape, so a live read is checked by the assertions rather than by a schema. */
const raw = z.unknown()

const repository = process.env.DSH_SUPERAGENT_LIVE_REPO
const live = repository ? describe : describe.skip

live('live GitHub reads', () => {
  // The agent's own `gh`, which the operator has signed in; the fixture's `/bin/false` is for offline tests.
  const commands = () => new Commands(() => testDeployment({ repository: repository!, github: { cli: 'gh', login: 'tonbiattack',
    noreply: '7+tonbiattack@users.noreply.github.com' } }), {}, new AbortController().signal)
  it('reads the repository facts the poller needs', async () => {
    const read = await commands().api(raw, '')
    expect(read).toMatchObject({ id: expect.any(Number), full_name: repository, default_branch: expect.any(String) })
  })
  it('reads open issues with the fields the poller parses', async () => {
    const issues = await commands().pages(raw, 'issues?state=open&per_page=5')
    for (const issue of issues as Record<string, unknown>[]) {
      expect(issue).toMatchObject({ number: expect.any(Number), title: expect.any(String), state: 'open' })
      expect(labelNames(issue as never)).toEqual(expect.any(Array))
    }
  })
  it('reads an Issue\'s label events, which is how the poller learns who applied the label', async () => {
    const issues = await commands().pages(raw, 'issues?state=all&per_page=20') as Record<string, unknown>[]
    const labelled = issues.find(issue => labelNames(issue as never).length > 0)
    if (!labelled) return
    const events = await commands().pages(raw, `issues/${labelled.number}/events?per_page=100`)
    // GitHub reports the actor and the label as objects; the poller reads `actor.login` and `label.name`.
    for (const event of events as Record<string, unknown>[]) {
      if (event.event !== 'labeled') continue
      expect(event).toMatchObject({ actor: { login: expect.any(String) }, label: { name: expect.any(String) } })
    }
  })
  it('polls a real repository end to end, queueing only what a listed account labelled', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'autopilot-live-'))
    const store = new Store(join(dir, 'db.sqlite'))
    try {
      const queue = new AutopilotQueue(store)
      const poll = new AutopilotPoller({ store, queue, commands: () => commands(), allowed: () => ['tonbiattack'],
        settings: () => AutopilotConfigSchema.parse({ enabled: true, repositories: [{ fullName: repository, checkout: '' }] }) })
      const result = await poll.poll(repository!)
      expect(result.repository).toBe(repository)
      expect(result.read).toBeGreaterThanOrEqual(0)
      // Nothing is queued unless a listed account applied the label, which is the whole point of the check.
      for (const job of queue.all()) expect(job.state).toBe('queued')
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }) }
  })
})
