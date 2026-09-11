# Operations

## Scheduling and configuration

Run one orchestrator in a supported DSH profile on one VPS. Persist schedule enabled state and operator changes on the Host. Admission has an explicit timezone, reconciliation cadence and optional allowed time windows. Window closure prevents new dispatch; the scheduler disable command has the pause semantics in [lifecycle](lifecycle.md). Show the next reconciliation and next allowed dispatch separately.

Use startup reconciliation of current tracker state rather than replaying every missed polling tick as fresh work. Manual reconcile respects the same gates. Configure maximum running and queued workflows; these are separate limits.

Own one validated configuration with a persisted revision and immutable per-run snapshots. Web edits and file-based deployment settings must have explicit precedence and show effective values. Operator edits affect future admission immediately; reductions to capacity do not kill existing work, while scheduler disable requests pause. Budget reductions stop additional spending authorization under the budget policy below. Record changes affecting active runs.

Run snapshots preserve execution scope and integration interpretation, not permission to ignore current scheduler/budget restrictions. Reject changes to labels, Brief selection, dependency/review-state mappings or priority mappings while unfinished runs or unresolved intents use those mappings; explain the dependents in Settings. Credential rotation and safe operational limit edits remain available. Future-only execution settings do not silently replace the retained Session's preset/model configuration.

| Configuration group | Required choices |
| --- | --- |
| Tracker | Provider binding, project scope, credential reference, ready/state label mapping, Brief selection, completed/review status mapping |
| Target | Code-host provider binding, explicit repository/workspace routing, base branch; D2 must be resolved |
| Scheduler | Enabled, cadence, timezone, allowed windows, running/queue limits |
| Execution | Supported DSH version, preset, model route where needed, timeouts and delegation policy |
| Budget | Enforcement mode, scope limits, warning threshold, accounting currency/units, pricing source/version, unknown-usage policy |
| Notifications | Channels, event subscriptions, secret references, disclosure, retries/timeouts |
| Storage | Runtime data/worktree roots, cleanup retention, history retention and backup location |

Provider bindings and extension rules are owned by [provider architecture](provider-architecture.md). Provider-specific fields use their registered schemas; credentials remain references. Resolve priority ordering explicitly rather than comparing provider-native numbers.

These are semantic configuration groups, not a final YAML schema. Validate references as soon as resolvable and reject invalid writes without replacing valid configuration. Store credentials through supported Host credential facilities, not in model-visible run snapshots.

Default semantic label names (resolve to provider-specific IDs where required): `ready-for-agent`, `agent-queued`, `agent-implementing`, `agent-paused`, `agent-blocked`, `agent-failed`, `agent-completed`. Keep internal pausing/publishing/cancelled details in the run record unless an operator configures additional mappings. Operational pause reasons share `agent-paused`; they do not require a new label per reason. Label mutations preserve unrelated tracker labels.

**Proposed readiness projection:** retain the ready label during queue/execution/operational pause, alongside one current agent-state label. Remove it on human blocker and terminal outcomes. A new human ready transition authorizes blocker continuation or a new execution after a terminal run; repeating the current state does not. Persist the consumed readiness generation so failed tracker label delivery cannot cause re-admission.

## Credit and spending

Autopilot enforces its own execution budget. Display provider account balance separately when a supported API exists. Account balance can change due to work outside Autopilot; it is not a per-run accounting ledger.

Support deployment and per-run caps, with daily/monthly windows where configured. One tracker project does not require another project-budget hierarchy. Values and currency are operator configuration; no monetary defaults are approved.

Reserve budget atomically before concurrent work can spend it. Count settled usage plus outstanding reservations against a cap. Charge all observable request usage for the run, including retries and enabled child agents; avoid double-counting reservation and settlement. Reset windows in the configured timezone without releasing obligations for requests still in flight.

Enforcement must happen before model requests, not solely after expensive responses. A monetary hard-cap claim requires a conservative pre-request cost bound, including output limit and pricing, plus complete metering coverage. Otherwise expose the supported token/request cap or explicitly label the money limit as approximate. An unknown response cost is not zero; retain an appropriate reservation and stop new authorization until reconciled under policy.

When budget becomes unavailable, request an operational pause, retain continuation state, and report the limiting scope. Automatic resumption requires restored budget and all normal dispatch gates. Raising a local limit does not top up the provider account. Warnings and pauses produce durable events, with unchanged notifications deduplicated.

Use provider-reported token usage and a recorded pricing version for estimates. Preserve input/cache/output categories supported by the provider. Credential, provider and model changes cannot silently mix currencies or invent conversions.

The source-confirmed request hook is listed in [DSH execution](dsh-execution.md). Cover conversation requests, retries, compaction, title generation and enabled children; map each to a run before authorization. Unowned model requests need an explicit deployment policy. DSH usage reports uncached input separately from cache-read/write; do not count reasoning tokens again when already included in output. Its token-meter is heuristic, not a billing-grade monetary bound.

## Durable state

**Proposed implementation:** one SQLite database for run metadata, admission/queue state, budget entries, operation intents, notification outbox, worktree ownership and audit. DSH continues owning its Session persistence; Git continues owning repository state. A single-process store lock is sufficient for v1; no distributed coordinator.

Persist enough information to reconcile external actions after a crash: issue identity/readiness generation, Brief snapshot, run/attempt ids, state/revision, queue ordering facts, configuration revision, DSH Session reference, worktree/base/head, pause/checkpoint, publication intent/receipt, usage/reservations, delivery records and operator actions. Avoid mirroring complete DSH logs into another database.

Version durable records and schema. Never advance runtime state on a failed durable write. Backup the database together with the associated Session store and retained worktrees; recovery evidence must account for their consistency. Retention of execution history is independent from worktree deletion.

## Worktrees and cleanup

Allocate and register a worktree per run beneath the configured managed root. Persist ownership before dispatch. Preserve local changes across pause/restart, and distinguish managed, missing and orphaned worktrees. An orphan requires reconciliation before it is treated as disposable. Git paths and branch names must be derived from validated inputs, never executed as ticket-supplied shell text.

Provide cleanup preview showing the exact managed worktree, associated run, branch, dirty/untracked files, unpushed commits, current PR disposition, removable disk usage and retained data. Refuse ordinary cleanup for active/queued/paused/blocked work, an open or unknown PR, dirty/untracked data, or commits not safely accounted for remotely. Do not turn a default cleanup button into force deletion.

Auto-cleanup is enabled with configurable retention, initially seven days. **Proposed conservative implementation:** only merged PRs qualify automatically; calculate retention from a provider-proven merge time or the later durable first-observed-merged time when no authoritative timestamp is available. A generic last-updated timestamp is insufficient. Closed-unmerged PRs require manual evaluation of retained work. This narrows automatic deletion until a closed-PR policy is explicitly selected.

Query code host disposition during maintenance to evaluate eligibility, without extending execution until merge. Recheck preview conditions immediately before removal to avoid deleting a worktree that resumed or changed. Use Git worktree operations; retain Session/run/audit data. Branch or remote-branch deletion is a separate policy, not implied by removing a worktree. Record cleanup outcome and notify when cleanup needs attention.

## VPS and access

Provide one tested Linux deployment recipe using a supported DSH profile with process supervision and durable storage. Select a single initial supervisor/container approach during implementation. Restart performs recovery before dispatch. The browser is not a scheduler host.

Expose the Web UI through authenticated access and TLS using the supported DSH deployment model. One operator role has all application capabilities. Authentication can be provided by the deployment; identify the operator in audit when available, without introducing an account-management/RBAC subsystem. Protect state-changing requests through supported origin/authentication controls. Treat webhook ingress authentication independently of browser login.

Resolve D6 using the access constraints in [plugin engineering](plugin-engineering.md). The baseline CLI rejects `--host 0.0.0.0`, and a public-domain browser does not automatically receive durable Settings access. SSH forwarding is a candidate administrative access mode; any remote-access plugin or reverse proxy needs its own actual-host validation. Do not claim a tested VPS recipe until that path works end to end.

Health reports distinguish process alive, store usable, recovery complete, integrations available and admission permitted. A healthy paused scheduler is not a failure. Logs carry run/event identifiers and sanitized errors; avoid ticket transcripts and credential values.

## Acceptance scenarios

- Competing dispatches cannot reserve the same remaining budget twice.
- Missing usage stays unknown and cannot be shown as zero spending.
- Budget reset during an in-flight request preserves its accounting obligation.
- Closing the Web browser does not interrupt scheduled work.
- A second Host using the same store refuses to dispatch.
- Cleanup preview becomes stale after resume; deletion is rejected.
- Completed run with open PR remains retained beyond seven days.
- Merged, clean, remotely accounted work passes retention cleanup while its Session/report remains available.

Community references: [dsh-automation](https://github.com/titanwings/dsh-automation) for schedule/run history, [dsh-budget](https://github.com/PerryLink/dsh-budget) for budget presentation. Verify their internals before considering reuse.
