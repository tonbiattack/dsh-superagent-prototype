/** The autopilot page: its repositories, its jobs with their state and result, and the commands a person may run. */
import type { ReactNode } from 'react'
import type { AutopilotJobView } from '../app/views/autopilot.ts'
import { usePoll } from './api.ts'
import { Button, Dot, Icon } from './controls.tsx'
import { useAction, usePanel } from './provider.tsx'
import { healthText } from './text.ts'
import { ConfirmButton, Hint, LoadState, Section, When } from './widgets.tsx'

/** The dot a job's state shows, matching the panel's legend. */
const tone = (state: AutopilotJobView['state']): 'done' | 'ongoing' | 'warning' | 'error' | 'idle' => state === 'done' ? 'done'
  : state === 'running' ? 'ongoing' : state === 'failed' ? 'error' : state === 'paused' ? 'warning' : 'idle'

/** One job: what it is, where it stands, what it produced, and the commands that apply to its state. */
function JobLine({ job, onChanged }: { job: AutopilotJobView; onChanged: () => Promise<void> }) {
  const { t, call } = usePanel()
  const act = useAction((request: () => Promise<unknown>) => request(), { reload: onChanged })
  const command = (name: 'pause' | 'resume' | 'skip' | 'retry') => async () => {
    await act.run(() => call(`POST autopilot/:repository/:issue/${name}`, { repository: job.repository, issue: String(job.issue) }))
  }
  const link = (href: string, label: string) => <a className="dt-textlink" href={href} target="_blank" rel="noreferrer">{label}</a>
  return <li className="dt-row">
    <div className="dt-row-main">
      <div className="dt-row-title">
        <Dot state={tone(job.state)} />
        {link(job.url, `${job.repository}#${job.issue}`)}
        <span className="dt-row-meta">{t(`autopilotState.${job.state}`)}</span>
      </div>
      <div className="dt-row-meta">
        {job.branch && <span className="dt-mono">{job.branch}</span>}
        {job.commitSha && <span className="dt-mono">{job.commitSha.slice(0, 7)}</span>}
        {job.prUrl && job.prNumber !== undefined && link(job.prUrl, `PR #${job.prNumber}`)}
        {job.mergeSha && <span className="dt-mono">{t('autopilotMerged', { sha: job.mergeSha.slice(0, 7) })}</span>}
        <When at={job.updatedAt} />
      </div>
      {job.route && <div className="dt-row-meta">
        <span className="dt-mono">{job.route.path}</span>
        <span>{t(job.route.kind === 'workspace' ? 'autopilotRoutedWorkspace' : 'autopilotRoutedCheckout')}</span>
        <span className="dt-hint">{job.route.reason}</span>
      </div>}
      {job.sessionId && <div className="dt-row-meta"><span className="dt-mono">{job.sessionId}</span></div>}
      {job.error && <p className="dt-error">{job.error}</p>}
      <div className="dt-row-meta dt-row-buttons">
        {job.state === 'queued' && <Button variant="outline" size="sm" icon={<Icon name="pause" size={14} />}
          disabled={act.busy} onClick={command('pause')}>{t('autopilotPause')}</Button>}
        {job.state === 'paused' && <Button variant="outline" size="sm" icon={<Icon name="play" size={14} />} disabled={act.busy}
          onClick={command('resume')}>{t('autopilotResume')}</Button>}
        {(job.state === 'queued' || job.state === 'paused') && <ConfirmButton variant="outline"
          icon="dismiss" label={t('autopilotSkip')} title={t('autopilotSkip')} message={t('autopilotSkipConfirm')}
          onConfirm={command('skip')} />}
        {(job.state === 'failed' || job.state === 'skipped') && <Button variant="outline" size="sm" icon={<Icon name="refresh" size={14} />}
          disabled={act.busy} onClick={command('retry')}>{t('autopilotRetry')}</Button>}
      </div>
    </div>
  </li>
}

export function AutopilotPage() {
  const { t, call } = usePanel()
  const { data, error, reload } = usePoll(() => call('GET autopilot'), [])
  const poll = useAction(() => call('POST autopilot/poll'), { reload })
  if (!data) return <LoadState error={error} loading />
  const stat = (label: string, value: ReactNode) => <span className="dt-stat">
    <span className="dt-stat-label">{label}</span><span className="dt-stat-value">{value}</span>
  </span>
  return <>
    {error && <LoadState error={error} loading={false} />}
    <Section title={t('autopilotTitle')} action={<Button variant="outline" size="sm" icon={<Icon name="refresh" size={14} />}
      disabled={poll.busy} onClick={() => { void poll.run() }}>{t('autopilotPollNow')}</Button>}>
      <p className="dt-error" role="alert">{t('autopilotUnavailable')}</p>
      {!data.enabled ? <Hint>{t('autopilotOff')}</Hint> : <>
        {data.health && <p className={data.health.state === 'error' ? 'dt-error' : 'dt-hint'}>{data.health.code
          ? healthText(t, data.health) : data.health.detail}</p>}
        <div className="dt-stats">
          {stat(t('autopilotQueued'), data.totals.queued)}
          {stat(t('autopilotRunning'), data.totals.running)}
          {stat(t('autopilotDone'), data.totals.done)}
          {stat(t('autopilotFailed'), data.totals.failed)}
          {stat(t('autopilotSkipped'), data.totals.skipped)}
          {stat(t('autopilotPausedCount'), data.totals.paused)}
        </div>
        {data.repositories.length ? <ul className="dt-list">{data.repositories.map(repository => <li key={repository.fullName}
          className="dt-row"><div className="dt-row-main">
          <div className="dt-row-title">{repository.fullName}</div>
          <div className="dt-row-meta"><span className="dt-mono">{repository.checkout || t('autopilotDefaultCheckout')}</span>
            <span>{t('autopilotRepoCounts', { queued: repository.queued, running: repository.running })}</span></div>
        </div></li>)}</ul> : <Hint>{t('autopilotNoRepositories')}</Hint>}
      </>}
    </Section>
    {data.jobs.length > 0 && <Section title={t('autopilotJobs')} count={data.jobs.length}>
      <ul className="dt-list dt-cards">{data.jobs.map(job => <JobLine key={`${job.repository}#${job.issue}`} job={job}
        onChanged={reload} />)}</ul>
    </Section>}
  </>
}
