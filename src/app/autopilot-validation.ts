/**
 * The host's own validation of a job's work.
 *
 * A worker's `ready` report says what the worker believes, not what the host observed. Delivery therefore runs the
 * operator's configured validation command itself, in the job's own checkout, and reads its exit status. A command that
 * is not configured, cannot run, or times out is a failure: nothing is ever assumed to have passed.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { AutopilotSettings } from '../autopilot.ts'

const exec = promisify(execFile)
/** What the host observed when it ran the validation command. */
export interface ValidationResult {
  /** The command exited zero. */
  passed: boolean
  /** The command that ran, for the job's record. */
  command: string
  /** Why it did not pass, or the command's own output when it did not. */
  detail?: string
  /** The command's combined output, trimmed, for the job's record. */
  output?: string
}
/** How much of the command's output is kept, so a noisy command cannot fill the database. */
const OUTPUT_CHARS = 4000
/**
 * Runs the configured validation command in `directory`.
 * @returns what the host observed; never throws, because a failure to run is itself a failed validation.
 */
export async function validate(settings: AutopilotSettings, directory: string, signal?: AbortSignal): Promise<ValidationResult> {
  const command = settings.validationCommand.trim()
  if (!command) return { passed: false, command, detail: 'no validation command is configured, so nothing was verified' }
  if (!directory) return { passed: false, command, detail: 'the job has no checkout to validate' }
  try {
    const { stdout, stderr } = await exec('/bin/sh', ['-c', command], { cwd: directory, timeout: settings.validationTimeoutSeconds * 1000,
      maxBuffer: 8 * 1024 * 1024, signal, env: { ...process.env, CI: '1' } })
    const output = `${stdout}${stderr}`.trim().slice(-OUTPUT_CHARS)
    return { passed: true, command, ...output ? { output } : {} }
  } catch (error) {
    const failed = error as { stdout?: string; stderr?: string; killed?: boolean; signal?: string; code?: unknown; message?: string }
    const output = `${failed.stdout ?? ''}${failed.stderr ?? ''}`.trim().slice(-OUTPUT_CHARS)
    const detail = failed.killed && failed.signal === 'SIGTERM' ? `the validation command timed out after ${settings.validationTimeoutSeconds} s`
      : typeof failed.code === 'number' ? `the validation command exited with code ${failed.code}`
        : `the validation command could not run: ${failed.message ?? String(error)}`
    return { passed: false, command, detail, ...output ? { output } : {} }
  }
}
