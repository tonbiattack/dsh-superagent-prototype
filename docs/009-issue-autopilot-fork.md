# Fork customization specification — Issue-driven autonomous coding

## Goal
Extend the upstream research prototype to monitor selected GitHub repositories and automatically implement opt-in issues in local DSH sessions. No manual per-issue command and no pull request required.

## Upstream reuse
Keep existing GitHub Source, Policy, Ticket/Executor, isolated sessions/work directories, persistence, panel, and permission boundaries. Before editing, inspect docs/001-domain.md, 002-authorization.md, 003-execution.md, 004-prompts.md, 006-deployment.md, 007-architecture.md and associated tests. Maintain upstream compatibility wherever feasible.

## MVP workflow
1. Operator registers one or more repositories with local checkout paths, allowed owners and credentials.
2. GitHub Source periodically polls open issues or uses existing event ingestion; on startup backfill currently-open issues. Default interval 60 seconds, configurable with rate-limit/backoff.
3. Only issues explicitly labeled `autopilot` and authored/approved by allowed users are eligible. Existing proactive accept/policy flow must be applied; other issues are observed only.
4. Deduplicate by repository immutable ID + issue ID + event/revision as appropriate. Durable queue; at most one running job per repository, initially one global job by default. Prioritize oldest eligible issues.
5. Create Ticket and isolated branch/worktree/session using upstream Executor; read issue text and repository instructions (AGENTS.md, README, related docs). Treat issue body as untrusted input.
6. Implement and run configured validation. Retry corrections at most 3 times. Missing/unverifiable checks must be stated, never silently passed.
7. Commit only related files in issue branch (e.g. `agent/issue-123`). Never directly commit to default branch. By default no PR, no push, no auto-close, no force push. Optional push is explicit opt-in.
8. Persist Ticket, commit SHA, result and error; expose state in existing panel. Optional issue comment is opt-in.
9. On restart, reconcile running Tickets, git status and commit SHA to prevent duplicate execution or commit; resume only safe, known steps. Expose manual pause/resume/skip.

## GitHub labels
- `autopilot`: eligibility only
- `ai:running`, `ai:done`, `ai:failed`: optional mirrored status, not primary source of truth
Never auto-apply the eligibility label. A ticket must not recursively trigger itself.

## Config (illustrative, adapt to upstream schema)
```yaml
github:
  repositories:
    - fullName: owner/repo
      checkout: /absolute/path
  pollIntervalSeconds: 60
  eligibleLabel: autopilot
execution:
  maxConcurrentGlobal: 1
  maxConcurrentPerRepo: 1
  maxFixAttempts: 3
delivery:
  createPullRequest: false
  autoPush: false
  autoCloseIssue: false
  autoComment: false
safety:
  requireAllowedActor: true
  disallowDefaultBranchCommit: true
```

## Non-goals
No new hosted service, webhook requirement, CI requirement, model failover, auto-merge, or direct changes to upstream except necessary extensions.

## Acceptance criteria
- Adding an eligible issue to one monitored repo starts a job without manual prompt.
- An unlabeled or unauthorized issue never starts a job.
- Repeated polling/restart does not duplicate Tickets or commits.
- New eligible issues are queued while the first job runs.
- At least two repositories can be monitored and scheduled independently.
- Success results in tested, isolated local commit and no PR/push/default-branch edit.
- Failure preserves changes and displays actionable explanation.
- `pnpm check` succeeds, with tests added for policy, polling, dedupe, scheduler, delivery and restart.
- Installation steps for Windows + WSL2 are documented.

## Implementation sequence
1. Safety and local baseline/characterization tests.
2. Label-based watch + durable queue.
3. Multi-repository configuration and routing.
4. Commit-only delivery and validation.
5. Recovery, status panel and operator documentation.
