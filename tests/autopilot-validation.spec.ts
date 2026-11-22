// The host's own validation of a job's work: what it observed, never what a worker claimed.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AutopilotConfigSchema } from '../src/policy.ts'
import { validate } from '../src/app/autopilot-validation.ts'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'autopilot-validate-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })
const settings = (patch: Record<string, unknown> = {}) => AutopilotConfigSchema.parse({ enabled: true, ...patch })

describe('host validation', () => {
  it('passes only when the configured command exits zero', async () => {
    const result = await validate(settings({ validationCommand: 'exit 0' }), dir)
    expect(result).toMatchObject({ passed: true, command: 'exit 0' })
  })
  it('fails when the command exits non-zero, and keeps its output', async () => {
    const result = await validate(settings({ validationCommand: 'echo "2 tests failed"; exit 1' }), dir)
    expect(result.passed).toBe(false)
    expect(result.detail).toBe('the validation command exited with code 1')
    expect(result.output).toContain('2 tests failed')
  })
  it('fails when no command is configured, rather than assuming the work passed', async () => {
    expect(await validate(settings(), dir)).toMatchObject({ passed: false,
      detail: 'no validation command is configured, so nothing was verified' })
  })
  it('fails when the job has no checkout to validate', async () => {
    expect(await validate(settings({ validationCommand: 'exit 0' }), '')).toMatchObject({ passed: false,
      detail: 'the job has no checkout to validate' })
  })
  it('runs the command in the job\'s own checkout, so it validates that repository', async () => {
    writeFileSync(join(dir, 'marker.txt'), 'here')
    const result = await validate(settings({ validationCommand: 'test -f marker.txt' }), dir)
    expect(result.passed).toBe(true)
  })
  it('fails when the command cannot run at all', async () => {
    const result = await validate(settings({ validationCommand: 'definitely-not-a-real-command-xyz' }), dir)
    expect(result.passed).toBe(false)
    expect(result.detail).toContain('exited with code')
  })
})
