/** The autopilot's view: each watched repository, each job with its state, and the queue's totals. */
import type { AutopilotJob, AutopilotSettings } from '../../autopilot.ts'
import type { AutopilotQueue } from '../autopilot-queue.ts'
import type { Health } from '../../sources/host.ts'

/** One job as the panel shows it: what it is, where it stands, and what it produced. */
export interface AutopilotJobView {
  repository: string
  issue: number
  state: AutopilotJob['state']
  /** The issue's page, so a person can read the request. */
  url: string
  ticketId?: string
  branch?: string
  commitSha?: string
  prNumber?: number
  prUrl?: string
  mergeSha?: string
  /** Where the job's work runs, and why that place was chosen. */
  route?: { kind: 'workspace' | 'checkout'; path: string; title?: string; reason: string }
  /** The DSH session the job's work runs in. */
  sessionId?: string
  error?: string
  attempts: number
  createdAt: string
  updatedAt: string
}
/** The autopilot page: its settings, its health, its repositories and its jobs. */
export interface AutopilotView {
  enabled: boolean
  settings: AutopilotSettings
  health?: Health
  /** Each configured repository with how many of its jobs are still active. */
  repositories: { fullName: string; checkout: string; queued: number; running: number }[]
  jobs: AutopilotJobView[]
  totals: { queued: number; running: number; done: number; failed: number; skipped: number; paused: number }
}
/** The issue's page on GitHub, which the panel links to. */
const issueUrl = (repository: string, issue: number): string => `https://github.com/${repository}/issues/${issue}`
/** Builds the autopilot page from the queue, the settings and the health entry. */
export function autopilotView(queue: Pick<AutopilotQueue, 'all'>, settings: AutopilotSettings, health: Health | undefined): AutopilotView {
  const jobs = queue.all()
  const count = (state: AutopilotJob['state']) => jobs.filter(job => job.state === state).length
  return {
    enabled: settings.enabled,
    settings,
    ...health ? { health } : {},
    repositories: settings.repositories.map(entry => ({
      ...entry,
      queued: jobs.filter(job => job.repository.toLowerCase() === entry.fullName.toLowerCase() && job.state === 'queued').length,
      running: jobs.filter(job => job.repository.toLowerCase() === entry.fullName.toLowerCase() && job.state === 'running').length,
    })),
    // Newest first, so the work a person just started is at the top.
    jobs: jobs.slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.issue - a.issue).map(job => ({
      repository: job.repository, issue: job.issue, state: job.state, url: issueUrl(job.repository, job.issue), attempts: job.attempts,
      createdAt: job.createdAt, updatedAt: job.updatedAt,
      ...job.ticketId === undefined ? {} : { ticketId: job.ticketId }, ...job.branch === undefined ? {} : { branch: job.branch },
      ...job.commitSha === undefined ? {} : { commitSha: job.commitSha }, ...job.prNumber === undefined ? {} : { prNumber: job.prNumber },
      ...job.prUrl === undefined ? {} : { prUrl: job.prUrl }, ...job.mergeSha === undefined ? {} : { mergeSha: job.mergeSha },
      ...job.route === undefined ? {} : { route: job.route }, ...job.sessionId === undefined ? {} : { sessionId: job.sessionId },
      ...job.error === undefined ? {} : { error: job.error },
    })),
    totals: { queued: count('queued'), running: count('running'), done: count('done'), failed: count('failed'), skipped: count('skipped'),
      paused: count('paused') },
  }
}
