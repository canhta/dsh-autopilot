# Run lifecycle

## Admission

Webhook events, periodic reconciliation, startup reconciliation, and an operator reconciliation request enter the same admission path. A manual reconciliation does not bypass policy.

An issue is eligible only when it belongs to the configured project, carries the configured ready label, has a valid designated Agent Brief, and all provider-resolved blocking dependencies are completed under the configured status mapping. Snapshot these facts and recheck them before dispatch.

Persist admission and claim together so a ticket has at most one unfinished run. The configured queue capacity limits admitted waiting work. **Proposed implementation:** leave eligible overflow issues in tracker ready state, expose the capacity reason, and reconsider them during reconciliation.

Event delivery identifiers deduplicate ingress retries. Run uniqueness additionally uses provider-qualified issue identity and a persisted readiness generation; unrelated issue edits must not create fresh runs. A blocked run becomes eligible only after a human explicitly returns the ticket to the ready label following the blocker. Bot label writes and comments alone cannot generate that authorization. Providers must supply the readiness evidence required by [provider architecture](provider-architecture.md); current labels alone do not prove a human transition.

## State transitions

| State | Meaning | Permitted next states |
| --- | --- | --- |
| queued | Admitted and waiting for dispatch | implementing, paused, blocked, cancelled |
| implementing | DSH executing; its reported phase is metadata | pausing, blocked, publishing, failed |
| pausing | Pause requested; execution not yet proven quiescent | paused, blocked, failed |
| paused | Durable continuation state retained; no execution active | queued, blocked, cancelled |
| blocked | Requires a human tracker change | queued after authorization, cancelled |
| publishing | Verified local outcome accepted; PR handoff in progress | completed, paused at a recoverable boundary, failed |
| completed | PR identity confirmed and persisted | Terminal |
| failed | Execution or publication cannot progress under its bounded policy | Terminal; later explicit retry requires a linked attempt/run policy |
| cancelled | Operator ended the run | Terminal |

Planning, implementation, and verification can be displayed as DSH-reported phases. They are not separate model loops owned by Autopilot. A failed run is not automatically restarted indefinitely.

## Queue and dispatch

Ordering: eligible resumptions before new work; within each group, configured normalized tracker priority then oldest queue entry, followed by a stable identity tie-breaker. This means a resumption takes precedence over a higher-priority new issue; do not claim the reverse in UI copy.

Dispatch requires scheduler admission to be enabled and inside its configured window, current tracker eligibility, available concurrency, and the budget authorization in [operations](operations.md). Claiming a slot and recording dispatch must be serialized. Paused and blocked runs consume no execution slot after their execution has stopped.

If eligibility changes while queued, do not start it. Record the reason and retain its history. Already-running work receives material tracker changes at a safe execution boundary; a human scope change cannot silently rewrite the snapshotted brief.

## Pause and continuation

Disabling the scheduler stops admission/dequeue and requests pause for active execution. Drain is a separate command: it stops new admission/dequeue while allowing current work to finish. Scheduler resume reconsiders paused runs through the ordinary gates; it cannot clear a tracker blocker or an unmet budget limit.

A per-run Stop at checkpoint sets a durable operator hold. Global scheduler resume, budget reset and Host restart cannot clear that hold; only Resume paused run clears it and re-enters ordinary eligibility checks. Scheduler/budget pauses without an operator hold can resume automatically when their conditions permit.

A pause is acknowledged only after execution and its owned child/tool processes have stopped or settled, DSH persistence is flushed, and the plugin checkpoint is saved. Keep the Session association and worktree. Record pause reason, last completed phase, pending actions, and any interrupted operation. Pausing a publishing run must first reconcile any in-flight external request.

On continuation, verify the retained Session is readable, worktree ownership matches, Git state is usable, and tracker/PR state has not invalidated the work. Continue the same logical run and supported DSH Session. A missing worktree or incompatible Session is an explicit recovery problem, not permission to start over silently.

The DSH capability and interruption limitations are owned by [DSH execution](dsh-execution.md).

## Blocker and failure

A blocker outcome includes summary, evidence, concrete questions, and the human action needed. Stop execution, persist the blocker, schedule the tracker report and configured notifications, and release the slot after quiescence. Responses belong in tracker comments; only a human readiness change allows continuation.

Separate transient integration delivery failure from execution failure. Retrying a tracker comment must not rerun coding. Notification failure must not remove a successfully published PR or change a completed execution to failed.

The operator may cancel a queued, paused or blocked run once execution is quiescent. Retain its worktree, Session, consumed readiness generation and unresolved delivery/publication receipts. Cancellation is not tracker authorization and does not bypass reconciliation or cleanup policy. To cancel active work, first stop it at a checkpoint; never describe an unconfirmed stop as cancelled.

## Completion and recovery

Accept publication only after DSH returns a successful verified outcome tied to the work being published. Persist publication intent before external side effects. Confirm and store the PR before marking the run completed. Enqueue the final tracker transition/report and notifications durably; show pending or failed deliveries independently.

Creating the PR finishes v1 execution. The tracker moves to its configured review state; people own completion of the ticket. Cleanup conditions are in [operations](operations.md).

After a restart, reconcile unfinished runs before dispatch: compare the journal with DSH Session data, live-process ownership, Git worktrees/branches, and any pending PR publication. A host crash is not a clean pause. Persist the observed recovery result and resume only from a verified usable state. A second process must refuse to operate the same runtime store.

## Acceptance scenarios

- Duplicate webhook plus concurrent reconciliation admits one run.
- An unrelated comment on a completed issue does not create another run.
- A newly blocked queued issue never starts.
- Disable scheduler during tool execution: state remains pausing until execution settles; no new run starts.
- Enable scheduler: eligible paused work precedes new tickets and obeys remaining budget/capacity.
- A reply comment without human readiness change leaves the run blocked.
- Crash after PR creation but before receipt persistence: recovery locates that PR and does not create another.
- Final tracker delivery fails: PR remains completed, delivery remains retryable, coding is not repeated.
