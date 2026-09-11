# Scope and ownership

## Product

Autopilot coordinates tracker-approved development work through DSH and hands it off as a code host pull request. AIDLC requirements and execution instructions come from the Agent Brief, configured DSH skills/preset, and target repository. Autopilot coordinates their execution and human feedback.

V1 selects one tracker provider and one code-host provider for one project scope on one VPS with one active orchestrator. Multiple runs may execute concurrently within configured limits. One authenticated operator role can view, operate, and configure the system. The Web panel is part of DSH Web; unattended work continues when browsers are closed.

## Ownership

| System | Authoritative information and behavior | Autopilot relationship |
| --- | --- | --- |
| Issue tracker (Jira or Linear) | Requirements, Agent Brief comments, priority, dependency links, human readiness/unblock decisions, issue status | Read selected issues; apply configured labels/status transitions and append execution reports |
| Target repository | Source, AGENTS.md and applicable instructions, skills, build/test commands, contribution conventions | Supply its workspace to DSH; preserve its rules |
| Git local | Worktree registration, branches, commits, working changes, tracking state | Manage only worktrees allocated to Autopilot runs; query Git before maintenance |
| Code host (GitHub or Bitbucket) | Remote branches, PR identity, review, CI, merge/closure state | Publish completed work; hand review to humans; inspect PR disposition when evaluating cleanup |
| DSH | Model/tool execution, Session history, supported persistence/continuation, preset/skills, subagent capabilities | Start or resume execution and consume evidence through supported interfaces |
| Autopilot plugin | Admission policy, durable queue/run records, worktree ownership, pause intent, spending policy, integration receipts, notification delivery, UI commands | Coordinates the above systems; does not replace their records |
| VPS deployment | Process supervision, persistent volumes, access authentication/TLS, backups, host credentials | Keeps the DSH profile available and its data recoverable |

An optional remote-access plugin belongs to deployment composition: it owns pairing/transport/device sessions. Autopilot integrates through that access mode after verification; it does not incorporate a tunnel or device-management product.

The DSH agent determines code changes and verification using target-repo rules. Autopilot does not prescribe a universal lint/test checklist or judge code quality independently. It checks that execution supplied the required outcome and evidence before authorizing publication.

Publication and tracker lifecycle writes have one designated execution path controlled by Autopilot. The concrete Git/PR mechanism remains D4 in [the decision register](README.md). Avoid duplicate publication by both an unconstrained agent and a Host publisher.

Provider interfaces, selection and extension are owned by [provider architecture](provider-architecture.md). All four tracker/code-host combinations are in the implementation scope; provider selection does not add multi-project administration.

## Terminology

| Term | Meaning |
| --- | --- |
| Tracker provider | Cordis plugin adapting an issue system to Autopilot admission and human-feedback operations |
| Code-host provider | Cordis plugin adapting a hosting system to PR publication and disposition queries |
| Provider binding | Persisted selection of a provider implementation and configured connection; not the credential value |
| Project scope | One configured tracker project; team/workspace context is provider-specific |
| Plugin repository | This repository, `canhta/dsh-autopilot` |
| Target repository | The codebase modified for a tracker ticket |
| Agent Brief | A designated tracker comment defining approved execution scope and acceptance criteria |
| Run | Durable Autopilot record for one admitted ticket execution, including pause/resume history |
| Attempt | An execution interval within a run; resumption does not silently create a new run |
| Session | DSH-owned execution history associated with the run |
| Checkpoint | Recorded continuation information after execution becomes quiescent; not a snapshot of arbitrary processes |
| Worktree | Git working directory allocated to a run |
| Blocker | A question or condition requiring a human tracker decision before work continues |
| Operational pause | Resumable stop caused by scheduler, operator, or budget policy |
| Completed | PR publication has been confirmed; subsequent delivery state is tracked separately |

Tracker intent, plugin run state, DSH execution state, and code host PR state are distinct. For example, a completed Autopilot run may have a tracker ticket still In Review and a PR still open.

## Scope exclusions

V1 excludes multi-project administration, multi-VPS coordination, leader election, role hierarchies, a replacement issue tracker, an agent-team/DAG editor, automated code host CI repair, PR review, merge automation, and automatic tracker Done transitions. PRs are created ready for review after local work succeeds; no early Draft PRs.

Raw-ticket triage and authoring Agent Briefs may happen through existing human/skill workflows. Automatic triage is not a second product to implement here. Autopilot consumes the approved brief and routes execution blockers back to tracker.
