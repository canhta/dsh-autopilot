# Work packages

Implement in dependency order. A package is complete only when its behavior is demonstrated and any changed requirement is updated in its owning document. Source inspection alone does not close a runtime feasibility gate.

The module/file layout below is deliberately not prescribed before DSH compatibility is established. Prefer one external plugin repository with ordinary internal modules; split published packages only when independent consumers require it.

## WP1 — DSH integration and package foundation

Read [scope](scope-and-ownership.md), [plugin engineering](plugin-engineering.md) and [execution](dsh-execution.md). Resolve D1 and test the D6 access path early. Set up the smallest external bundle and test/build tooling appropriate to the selected DSH version. Keep a compact compatibility record in dsh-execution.md with exact versions and source pointers.

Deliver executable evidence for isolated execution, structured outcome, interruption, cold continuation and request usage/control. Probe two worktrees and a real Host restart. If a capability is unavailable, document the limitation and the smallest required integration change; do not substitute simulated evidence for live Session behavior.

Done: a supported profile loads the plugin, a controlled local execution edits a fixture repo and reports evidence, pause/restart/continue is exercised, and the feasible budget/delegation boundary is recorded. Use synthetic data and explicit integration-test credentials.

Also prove artifact-only installation outside the upstream checkout, dependency-loss/HMR teardown, and the selected remote browser's durable settings path. Community stub tests are insufficient evidence of current DSH compatibility.

## WP2 — Provider interfaces, durable runs and tracker admission

Depends on WP1's Host composition. Read [lifecycle](lifecycle.md), tracker sections of [integrations](integrations.md), and storage/configuration in [operations](operations.md). Implement the tracker Service Definition/registry and Jira/Linear provider plugins from [provider architecture](provider-architecture.md); use [Linear evidence](linear-provider.md) for its provider-specific checks. Resolve D3 for live tracker validation; fake fixtures may proceed earlier.

Deliver validated configuration, durable run/queue records, webhook and reconciliation ingress, Brief selection, dependency/readiness evaluation, one-run uniqueness and readiness-generation tracking. Establish revisioned queries for the later UI.

Done: the same tracker conformance suite passes for both providers and an independently registered fixture provider; no provider-name switch lives in core admission. Duplicate deliveries and concurrent reconciliations produce one run; invalid/missing/ambiguous briefs do not execute; queue saturation is visible; a human-ready transition is distinguished from a bot update; restart preserves queue identity/order.

## WP3 — Dispatch, worktrees, budget and continuation

Depends on WP1–2. Read [execution](dsh-execution.md), [lifecycle](lifecycle.md), and [operations](operations.md). Resolve D2 and D5 before live dispatch; implement budget authorization before running concurrent paid work.

Deliver managed worktree allocation, capacity admission, execution integration, usage/reservation tracking, scheduler pause/resume/drain, structured blocker persistence and safe restart reconciliation. Use the same runtime for headless and Web hosting.

Done: paused work survives Host restart and continues in its owned Session/worktree; capacity is released only after quiescence; resumptions obey queue order; concurrent requests cannot oversubscribe a declared enforced budget; missing usage never becomes zero; a tracker blocker stays blocked until human authorization.

## WP4 — PR handoff and durable delivery

Depends on WP3. Read [integrations](integrations.md) and completion rules in [lifecycle](lifecycle.md). Resolve D4 and implement one publication owner. Implement the code-host Service Definition/registry plus GitHub/Bitbucket providers; use [Bitbucket evidence](bitbucket-provider.md). Register webhook/ntfy delivery as notification provider plugins and tracker comments through the selected tracker provider.

Deliver verified-state publication, recoverable push/PR intent, tracker lifecycle reports/status mapping, ntfy/generic webhook adapters, durable delivery outbox and operator retry. Agent Brief and blocker examples must use synthetic ticket data.

Done: both code-host providers pass the shared conformance suite and each creates a PR in an authorized test target; all four tracker/code-host combinations pass fixture end-to-end tests. One completed local fixture run creates one PR in an explicitly configured test repository; inject a lost response to prove duplicate PR prevention; tracker and notification failures retry independently without repeating execution; evidence and cost qualifiers appear in the final report. Tests requiring external writes must target explicit test resources.

## WP5 — Worktree maintenance and VPS operation

Depends on WP3–4. Read [operations](operations.md). Deliver cleanup preview/rechecks, conservative automatic retention, orphan reconciliation, audit, health and a tested deployment/backup/restore recipe.

Done: cleanup refuses active/dirty/unpushed/open-PR work; a resumed worktree invalidates its stale cleanup preview; eligible merged work is removed through Git while history remains; a second Host is excluded; restart/restore reconciles unfinished work and pending deliveries before dispatch.

## WP6 — DSH Web operations

Depends on the Host behaviors from WP2–5; UI may be developed against their agreed query/command fixtures in parallel. Read [web UI](web-ui.md), [UI components](ui-components.md) and the owner doc for each action being wired.

Deliver the global panel, Settings contribution, Worktrees view, operator commands and optional Session shortcut using supported Client extension points. Reuse Host validation and state transitions.

Done: all acceptance scenarios in web-ui.md pass; keyboard/error/reconnection paths are exercised; closing the browser leaves Host execution active; secrets do not enter browser responses. Verify with the actual supported DSH Web build, not only a standalone component demo. Deliver the required viewport/theme screenshots, component-state fixtures and a visual review against the documented rules; a generic dashboard screenshot is insufficient.

## Final handoff

Before release, run the provider conformance and composition checks from [provider architecture](provider-architecture.md); missing live-provider evidence remains a support gap, not a supported-provider claim.

Run the vertical path on one VPS with a synthetic tracker ticket and an authorized test target: admission, queue, execution, pause/restart/resume, verification, PR creation, tracker In Review and configured notification delivery. Exercise a human blocker and a budget pause separately. Check worktree retention after handoff.

Review every owning document's acceptance scenarios and report evidence or a precise remaining gap. Update the root README from specification-only status only when its claims are demonstrated. Add user-facing installation/configuration instructions under docs/ when runnable behavior exists, linking to configuration definitions rather than duplicating them.
