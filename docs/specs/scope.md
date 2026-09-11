# Scope and ownership

## Product

Autopilot coordinates tracker-approved development work through DSH and hands it off as a code host pull request. Ticket requirements and execution instructions come from the Agent Brief, configured DSH skills/preset, and target repository. Autopilot coordinates their execution and human feedback.

V1 selects one tracker provider and one code-host provider for one project scope on one VPS with one active orchestrator. Multiple runs may execute concurrently within configured limits. One authenticated operator role can view, operate, and configure the system. The Web panel is part of DSH Web; unattended work continues when browsers are closed.

## Ownership

| System | Authoritative information and behavior | Autopilot relationship |
| --- | --- | --- |
| Issue tracker (Jira, GitHub Issues or Linear) | Requirements, Agent Brief comments, priority, dependency links, human readiness/unblock decisions, issue status | Read selected issues; apply configured labels/status transitions and append execution reports |
| Target repository | Source, AGENTS.md and applicable instructions, skills, build/test commands, contribution conventions | Supply its workspace to DSH; preserve its rules |
| Git local | Worktree registration, branches, commits, working changes, tracking state | Manage only worktrees allocated to Autopilot runs; query Git before maintenance |
| Code host (GitHub or Bitbucket) | Remote branches, PR identity, review, CI, merge/closure state | Publish completed work; hand review to humans; inspect PR disposition when evaluating cleanup |
| DSH | Execution/Session services and platform infrastructure: presets/skills, MCP, delegation, API/SDK, Web, Settings, credentials and storage | Compose suitable public capabilities from the [reuse map](../research/dsh.md#capability-reading-map); implement only missing domain behavior |
| Autopilot plugin | Admission policy, durable queue/run records, worktree ownership, pause intent, spending policy, integration receipts, notification delivery, UI commands | Coordinates the above systems; does not replace their records |
| VPS deployment | Process supervision, persistent volumes, access authentication/TLS, backups, host credentials | Keeps the DSH profile available and its data recoverable |

An optional remote-access plugin belongs to deployment composition: it owns pairing/transport/device sessions. Autopilot integrates through that access mode after verification; it does not incorporate a tunnel or device-management product.

The DSH agent determines code changes and verification using target-repo rules. Autopilot does not prescribe a universal lint/test checklist or judge code quality independently. It checks that execution supplied the required outcome and evidence before authorizing publication.

Publication and tracker lifecycle writes have one designated execution path controlled by Autopilot. Select the concrete publication executor through the implementation issue on GitHub. Avoid duplicate publication by both an unconstrained agent and a Host publisher.

Provider interfaces, selection and extension are owned by [provider architecture](providers.md). Supported tracker and code-host providers compose independently; provider selection does not add multi-project administration.

Tracker intent, plugin run state, DSH execution state, and code host PR state are distinct. For example, a completed Autopilot run may have a tracker ticket still In Review and a PR still open.

## Scope exclusions

V1 excludes multi-project administration, multi-VPS coordination, leader election, role hierarchies, a replacement issue tracker, an agent-team/DAG editor, automated code host CI repair, PR review, merge automation, and automatic tracker Done transitions. PRs are created ready for review after local work succeeds; no early Draft PRs.

Raw-ticket triage and authoring Agent Briefs may happen through existing human/skill workflows. Automatic triage is not a second product to implement here. Autopilot consumes the approved brief and routes execution blockers back to tracker.
