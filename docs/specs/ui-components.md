# UI modules and components

This page owns Client decomposition, data/command behavior and functional acceptance. [Web UI](web-ui.md) owns navigation, visual rules, journeys and visual acceptance. Names below are Autopilot responsibilities, not instructions to create new components when DSH already supplies them; see [DSH Web reuse evidence](../research/dsh-web.md).

## Module ownership

| Module | Responsibility | Reads | Mutations |
| --- | --- | --- | --- |
| Operations shell | Selected view/run, integration/recovery visibility, global scheduler controls | Host health and scheduler summary | Scheduler pause/resume/drain, explicit reconcile |
| Runs | Browse waiting/active/history and inspect one execution | Paginated run summaries and selected run snapshot | Stop at checkpoint, resume operational pause, cancel quiescent queued/paused/blocked run |
| Schedule | Explain when admission can happen | Effective timezone/windows/cadence, next reconcile/dispatch, recent reconciliations | None; link to Settings |
| Budget | Explain spend authorization and paused work | Scoped caps, reservations, settled usage, coverage, window reset | None; link to Settings |
| Deliveries | Inspect notification failures without confusing them with execution failure | Paginated event/destination receipts | Retry selected failed delivery |
| Worktrees | Inspect retained Git work and safe removal eligibility | Managed worktrees plus explicit refreshed Git/PR inspection | Request preview, confirm valid cleanup |
| Settings contribution | Configure providers and operational policy | Effective values, revision, provider schemas/metadata/lookups | Validate/save configuration, explicit connection/test delivery actions |

Host state is authoritative. Modules use the existing DSH Remote client with Autopilot's generated query/command contributions; the browser persists only view preferences. Use the supported snapshot/stream facilities described in [plugin engineering](plugin.md#web-and-host-interface) for active views and selected details. Disposal cancels requests/subscriptions. Views neither dispatch workflows nor duplicate provider clients, and do not load full Session transcripts for a table. Query and command transitions are owned by the shared presentation components below.

## Shell and list components

| Component | Content and interaction |
| --- | --- |
| `OperationsShell` | DSH main-slot content only; owns local view and selected-run state. Contains header, conditional attention strip, local tabs and one content region. Does not redraw DSH navigation or model chat. |
| `OperationsHeader` | Title, current project/provider identity, scheduler mode with reason, last refresh/reconcile age. One contextual primary control: Pause when enabled, Resume when paused. Drain/reconcile/settings remain labelled secondary actions. |
| `AttentionStrip` | Only actionable health/recovery/provider failures. A concise reason and one destination action; grouped count opens filtered runs/deliveries. No permanent decorative health banner. |
| `RunsToolbar` | Search issue key/summary, lifecycle filter, priority and age filters, attention-only toggle and visible result count. State persists when opening/closing details. Clear filters is available when results are empty. |
| `RunsTable` | Columns in order: issue key + summary; lifecycle + reason; priority; current phase; elapsed; spend qualification; updated age. Leading identity is flexible; numbers align right. Row activation opens details; explicit links and action buttons do not activate the row twice. Host pagination and stable ids; no drag-to-reprioritize control. |
| `RunDetailPanel` | Header with ticket identity, lifecycle/reason and allowed actions. First show required human action or pause condition; completed runs show PR and verification. Then Brief/dependencies, ordered event timeline, verification, workspace/Session, spend and deliveries as collapsible sections. No second dashboard inside the panel. |

Run detail uses composition: `BlockerCallout` renders numbered questions and the exact tracker action; `VerificationSummary` renders checks/results/skips and verified Git identity; `RunTimeline` renders timestamped normalized events, grouping repeated retries; `ResourceLinks` links to tracker, DSH Session, PR and worktree details. None derives success from prose or infers a next action from status color.

The panel footer uses the operator-command policy below. Preserve scroll/selection if an update arrives; announce significant state changes without moving focus.

## Operator-command policy

| Action | Visible behavior |
| --- | --- |
| Pause scheduler | Explains that active work is pausing; displays unfinished pauses until checkpointed |
| Resume scheduler | Re-evaluates paused/queued work through normal gates |
| Drain | Stops new admission/dequeue while current runs finish |
| Reconcile now | Fetches current tracker state under ordinary admission policy |
| Cancel run | Available for quiescent queued/paused/blocked runs; retains worktree/history and cannot silently requeue on an unchanged tracker poll |
| Stop at checkpoint | Requests an operational pause and durable operator hold for the selected run |
| Resume paused run | Clears that run's operator hold and queues continuation only if all other gates permit; otherwise shows the unmet condition |
| Retry notification | Retries selected delivery without repeating code execution |
| Cleanup worktree | Shows exact removal preview and rejection reasons before confirmation |
| Open ticket / Session / PR | Opens the associated system record |

A blocked run shows `Waiting for a human in {trackerName}`, its questions and `Open in {trackerName}`. Human unblock authorization stays on tracker. Display the reason for unavailable actions; do not silently ignore them. Destructive cleanup requires confirmation of the preview, while ordinary reads do not.

The Host rechecks current state for every command. Audit mutations with operator identity when available, timestamp, request id, target and resulting revision.
Mapping repair is available only for failed tracker projections under [delivery repair](operations.md#repairing-a-broken-delivery-mapping). Show the old/new mapping and affected intent, validate and confirm; never expose it as an unblock shortcut.

## Operational components

| Component | Content and interaction |
| --- | --- |
| `ScheduleSummary` | Text/table of effective windows and timezone, next reconciliation versus next admissible dispatch, disabled/draining/window-closed explanations, recent reconciliation outcomes. No cron-expression-only presentation or calendar editor. Edit opens the owning Settings section. |
| `BudgetLedger` | Per configured scope: cap, settled, reserved, remaining, reset time and enforcement mode. Unknown amounts remain unknown. A restrained labelled meter is permitted only with a known denominator; provider balance is separate. Show affected paused runs and coverage explanation; no forecast graph without data. |
| `DeliveryTable` | Event, linked run/ticket, destination label, delivery state, attempts/next retry and sanitized error. Inspect exposes redacted payload/receipt; retry uses the operator-command policy. |
| `WorktreeTable` | Ticket/run, branch, active/retained/missing/orphaned state, last inspection age, dirty/untracked/unpushed indicators, PR disposition, disk usage and cleanup eligibility. Unknown inspection values display explicitly. Select opens an inspector; refreshing inspection is an explicit read. |
| `WorktreeInspector` | Exact managed path and run association, Git findings, PR link/disposition, retention basis and blocking reasons. Preview cleanup is available only for an inspectable managed target; no recursive filesystem-delete button. |
| `CleanupDialog` | Host-issued target/revision, removable path/size, branch/data retained, checked Git/PR conditions and expiry/staleness. Cancel is the safe default; confirm names the worktree. Pending disables repeat submit. Stale preview requires re-inspection, not confirmation of old data. |
| `ProviderBindingFields` | Provider selector from installed registrations; provider-specific project/team/workspace/repository selectors and validated mappings. Keep stable ids internally and friendly names visibly. Show missing capabilities, access, compatibility and binding-switch restrictions before save. |
| `SettingsForm` | Sections: Providers & project; Schedule & capacity; Execution; Budget; Notifications; Retention & storage, using [Host configuration](operations.md#scheduling-and-configuration). Show defaults/effective values. One draft/revision with dirty state, validation, inline errors and save result; a stale edit returns conflict with a reload path, not an overwrite. Loading lookups cannot erase stored values. No silent autosave for operational policy. |

Notifications use a destination list with add/edit/test controls inside Settings. An explicit operator test previews destination, redacted payload and disclosure before sending, and labels the delivery as a test. Credentials use supported Host reference/status controls. Never hydrate existing secret values into the Client; show only configured/missing/source/writable/error metadata and allowed replacement actions.

## Shared primitives and state

Compose the public DSH primitives, Settings services/slots, theme and localization listed in the [reuse map](../research/dsh-web.md#reuse-map). The baseline exports no generic table, accessible tablist, schema form or credential editor; implement only the required domain composition over shared atoms and semantic HTML. Reusing a dialog still requires verifying focus management. Autopilot-specific shared components are limited to repeated domain presentation: `RunStateLabel`, `ProviderResourceLink`, `UsageValue`, `CommandFeedback` and `QueryState`. A domain label carries text/icon/color; unknown remains distinct from zero/success.

`QueryState` distinguishes first load, empty domain, empty filtered result, denied/unavailable, stale cached data and retryable error. Preserve last known data on disconnection and visibly mark its age; disable unsafe mutations. Do not replace a useful table with a full-screen spinner during each refresh.

On reconnect, fetch a current Host snapshot before enabling actions from cached data. `UsageValue` distinguishes provider-reported values, estimates, `Metering` and `Unknown`; absent evidence never renders as zero. Accompany local schedule times with their configured timezone.

`CommandFeedback` distinguishes request pending, Host accepted, action in progress, succeeded and rejected. For example accepted pause remains “Pausing” until the checkpoint is confirmed; accepted cleanup is not “Removed.” Persisted Host command identifiers handle duplicate submission. Errors explain what failed and how to recover, with diagnostic details collapsed.

UI language uses registered provider names on links, historical runs and instructions. Core copy says ticket, tracker, code host or PR as appropriate. Provider metadata/schema contributions own provider fields; optional Client enhancements cannot be required for a usable validated form. Unsupported required capabilities prevent activation with a reason, following [provider policy](providers.md#readiness-and-capabilities).

## Component acceptance

Test components through operator-visible outcomes, not internal state variables. Include long issue titles, missing/renamed provider objects, empty/many runs, pagination, unknown usage, inaccessible PR, stale settings, in-flight command, disconnected Host and failed cleanup. Verify no click initiates model execution outside the Host policy.

- A fixture external provider supplies usable Settings without core UI changes; switching the supported provider pairs changes fields/labels but not run policy.
- Open Operations without selecting a Session; inspect queue and health.
- A pause command remains in progress until the Host confirms a checkpoint.
- Reconnect retrieves the latest completed run without replaying an old command.
- Human blockers have no Web authorization bypass; a completed PR with failed ntfy delivery shows both facts.
- Unknown usage/PR disposition is distinct from zero/closed; cleanup rejection identifies the blocking condition.

Capture integrated screenshots using [visual acceptance](web-ui.md#visual-acceptance). Component fixtures alone cannot prove slot mounting, theme compatibility or remote configuration.
