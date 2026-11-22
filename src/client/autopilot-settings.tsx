/** The Autopilot settings group: the repositories it watches, eligibility, concurrency, and what delivery may do. */
import { LIMITS } from '../limits.ts'
import { InfoTip, Input } from './controls.tsx'
import { SaveBar } from './draft.tsx'
import { usePanel } from './provider.tsx'
import { ConfigHistory, Field, Fields, numberOf, useBlockDraft, useSettings } from './settings-kit.tsx'
import { Hint, Section } from './widgets.tsx'

/** A switch with its label and hint, which the settings blocks share. */
function Toggle({ label, hint, checked, disabled, onChange }: { label: string; hint: string; checked: boolean; disabled: boolean
  onChange: (next: boolean) => void }) {
  return <label className="dt-switch-row">
    <input type="checkbox" checked={checked} disabled={disabled} onChange={event => onChange(event.target.checked)} />
    <span><span className="dt-switch-label">{label}</span><span className="dt-hint">{hint}</span></span>
  </label>
}

export function AutopilotSettings() {
  const { t } = usePanel()
  const { blocks } = useSettings().settings
  const autopilot = blocks.autopilot.value
  // Numbers are edited as text and parsed on save, so a half-typed value is not rejected while typing.
  const saved = { ...autopilot, pollSeconds: String(autopilot.pollSeconds), maxConcurrentGlobal: String(autopilot.maxConcurrentGlobal),
    maxConcurrentPerRepo: String(autopilot.maxConcurrentPerRepo), maxFixAttempts: String(autopilot.maxFixAttempts),
    validationTimeoutSeconds: String(autopilot.validationTimeoutSeconds),
    repositories: autopilot.repositories.map(entry => `${entry.fullName} ${entry.checkout}`.trim()).join('\n') }
  const draft = useBlockDraft('autopilot', saved, blocks.autopilot.revision, value => ({ ...value,
    pollSeconds: numberOf(value.pollSeconds), maxConcurrentGlobal: numberOf(value.maxConcurrentGlobal),
    maxConcurrentPerRepo: numberOf(value.maxConcurrentPerRepo), maxFixAttempts: numberOf(value.maxFixAttempts),
    validationTimeoutSeconds: numberOf(value.validationTimeoutSeconds),
    // One repository per line, `owner/name` then an optional absolute checkout path.
    repositories: value.repositories.split('\n').map(line => line.trim()).filter(Boolean).map(line => {
      const [fullName = '', ...rest] = line.split(/\s+/)
      return { fullName, checkout: rest.join(' ') }
    }) }))
  const value = draft.value
  const edit = (next: Partial<typeof value>) => draft.edit({ ...value, ...next })
  return <div className="dt-form">
    <p className="dt-error" role="alert">{t('autopilotUnavailable')}</p>
    <form className="dt-form" onSubmit={event => { void draft.submit(event) }}>
      <Fields disabled={true}>
        <div className="dt-form dt-block">
          <h2 className="dt-block-title">{t('autopilotTitle')}<InfoTip text={t('autopilotIntro')} /></h2>
          <Toggle label={t('autopilotEnabled')} hint={t('autopilotEnabledHint')} checked={value.enabled} disabled={draft.busy}
            onChange={enabled => edit({ enabled })} />
          <Field label={t('autopilotRepositories')} hint={t('autopilotRepositoriesHint')}>
            <textarea className="dt-textarea dt-mono" rows={4} spellCheck={false} value={value.repositories}
              placeholder={t('autopilotRepositoriesEmpty')} onChange={event => edit({ repositories: event.target.value })} />
          </Field>
          <Field label={t('autopilotLabel')} hint={t('autopilotLabelHint')}>
            <Input className="dt-mono" required maxLength={LIMITS.autopilotLabel} value={value.eligibleLabel} spellCheck={false}
              onChange={event => edit({ eligibleLabel: event.target.value })} />
          </Field>
          <Toggle label={t('autopilotRequireAllowed')} hint={t('autopilotRequireAllowedHint')} checked={true}
            disabled={true} onChange={() => {}} />
        </div>
        <div className="dt-form dt-block">
          <h2 className="dt-block-title">{t('autopilotScheduling')}</h2>
          <Field label={t('autopilotPollSeconds')} hint={t('autopilotPollSecondsHint')}>
            <Input type="number" min={LIMITS.autopilotPollSeconds.min} max={LIMITS.autopilotPollSeconds.max} required
              value={value.pollSeconds} onChange={event => edit({ pollSeconds: event.target.value })} />
          </Field>
          <Field label={t('autopilotMaxGlobal')} hint={t('autopilotMaxGlobalHint')}>
            <Input type="number" min={LIMITS.autopilotMaxConcurrentGlobal.min} max={LIMITS.autopilotMaxConcurrentGlobal.max} required
              value={value.maxConcurrentGlobal} onChange={event => edit({ maxConcurrentGlobal: event.target.value })} />
          </Field>
          <Field label={t('autopilotMaxPerRepo')} hint={t('autopilotMaxPerRepoHint')}>
            <Input type="number" min={LIMITS.autopilotMaxConcurrentPerRepo.min} max={LIMITS.autopilotMaxConcurrentPerRepo.max} required
              value={value.maxConcurrentPerRepo} onChange={event => edit({ maxConcurrentPerRepo: event.target.value })} />
          </Field>
          <Field label={t('autopilotMaxFixAttempts')} hint={t('autopilotMaxFixAttemptsHint')}>
            <Input type="number" min={LIMITS.autopilotMaxFixAttempts.min} max={LIMITS.autopilotMaxFixAttempts.max} required
              value={value.maxFixAttempts} onChange={event => edit({ maxFixAttempts: event.target.value })} />
          </Field>
          <Field label={t('autopilotValidationCommand')} hint={t('autopilotValidationCommandHint')}>
            <Input className="dt-mono" maxLength={LIMITS.autopilotValidationCommand} value={value.validationCommand} spellCheck={false}
              placeholder={t('autopilotValidationCommandEmpty')} onChange={event => edit({ validationCommand: event.target.value })} />
          </Field>
          <Field label={t('autopilotValidationTimeout')} hint={t('autopilotValidationTimeoutHint')}>
            <Input type="number" min={LIMITS.autopilotValidationTimeoutSeconds.min} max={LIMITS.autopilotValidationTimeoutSeconds.max}
              required value={value.validationTimeoutSeconds} onChange={event => edit({ validationTimeoutSeconds: event.target.value })} />
          </Field>
        </div>
        <div className="dt-form dt-block">
          <h2 className="dt-block-title">{t('autopilotDelivery')}<InfoTip text={t('autopilotDeliveryIntro')} /></h2>
          <Toggle label={t('autopilotCreatePullRequest')} hint={t('autopilotCreatePullRequestHint')} checked={value.createPullRequest}
            disabled={draft.busy} onChange={createPullRequest => edit({ createPullRequest })} />
          <Toggle label={t('autopilotAutoPush')} hint={t('autopilotAutoPushHint')} checked={value.autoPush} disabled={draft.busy}
            onChange={autoPush => edit({ autoPush })} />
          <Toggle label={t('autopilotAutoMerge')} hint={t('autopilotAutoMergeHint')} checked={value.autoMerge} disabled={draft.busy}
            onChange={autoMerge => edit({ autoMerge })} />
          <Field label={t('autopilotMergeMethod')} hint={t('autopilotMergeMethodHint')}>
            <select className="dt-select" value={value.mergeMethod} disabled={draft.busy}
              onChange={event => edit({ mergeMethod: event.target.value as typeof value.mergeMethod })}>
              {(['squash', 'merge', 'rebase'] as const).map(method => <option key={method} value={method}>{t(`autopilotMerge.${method}`)}</option>)}
            </select>
          </Field>
          <Toggle label={t('autopilotRespectProtection')} hint={t('autopilotRespectProtectionHint')} checked={value.respectBranchProtection}
            disabled={draft.busy} onChange={respectBranchProtection => edit({ respectBranchProtection })} />
          <Toggle label={t('autopilotRequireChecks')} hint={t('autopilotRequireChecksHint')} checked={value.requireRequiredChecks}
            disabled={draft.busy} onChange={requireRequiredChecks => edit({ requireRequiredChecks })} />
          <Toggle label={t('autopilotDisallowDefault')} hint={t('autopilotDisallowDefaultHint')} checked={value.disallowDefaultBranchCommit}
            disabled={draft.busy} onChange={disallowDefaultBranchCommit => edit({ disallowDefaultBranchCommit })} />
          <Toggle label={t('autopilotAutoClose')} hint={t('autopilotAutoCloseHint')} checked={value.autoCloseIssue} disabled={draft.busy}
            onChange={autoCloseIssue => edit({ autoCloseIssue })} />
          <Toggle label={t('autopilotAutoComment')} hint={t('autopilotAutoCommentHint')} checked={value.autoComment} disabled={draft.busy}
            onChange={autoComment => edit({ autoComment })} />
          <Hint>{t('autopilotDeliveryNote')}</Hint>
        </div>
      </Fields>
      <SaveBar {...draft} onDiscard={draft.discard} />
    </form>
    <ConfigHistory blocks={['autopilot']} />
  </div>
}
