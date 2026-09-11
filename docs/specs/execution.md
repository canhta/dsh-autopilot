# DSH execution

## Ownership and composition

Use a normal external Cordis plugin/bundle and supported DSH profile launch. Keep Autopilot scheduling and durable run state on the Host. Load its browser contribution only for Web presentation. Compose DSH Agent/Session, preset/skill, tool and model services through their public APIs; [execution evidence](../research/dsh-execution.md) identifies those facilities. Same-process execution does not require an SDK subprocess, and optional process isolation must satisfy the same pause/continuation requirements.

Packaging and effect lifecycle are owned by [plugin engineering](plugin.md).

## Unattended execution safeguards

Compose the selected DSH permission/sandbox and tool-guard facilities as part of the execution preset; [native safeguards](../research/dsh-execution.md#native-safeguards) records their limits. Verify the effective composition rather than mounting duplicate guards already supplied by a bundle. Deployment policy selects allowed capabilities and limits; target-repository instructions still select coding and verification work.

Exercise denied writes to unauthorized paths and publication attempts outside the designated executor through every enabled tool path, including MCP and child agents. Declare the actual writable roots, including any provider temporary-directory allowances. Permission presets select policy; enforcing providers apply it, and MCP servers do not automatically inherit a local filesystem sandbox. A permission label, hidden tool or prompt instruction is not proof of enforcement. If a tool needs human authorization that unattended operation cannot obtain, report the condition through the existing tracker-blocker flow; never grant itself broader permissions to finish.

Preserve native repeated-call guidance where appropriate and configure supported per-tool deadlines. Advisory loop reminders do not enforce credit caps; cooperative timeouts do not prove an unresponsive process stopped. Reuse the capability's termination path, keep the run's pause pending until quiescent, and test tools that ignore cancellation. These strengthen the existing budget/pause requirements rather than introduce a separate watchdog framework.

## Execution requirements

The selected DSH composition plus Autopilot's domain integration must support isolated worktrees, durable Session reconstruction after a real Host restart, quiescent pause, continuation with side-effect reconciliation, structured outcomes, supported usage interception, and headless operation. Source evidence is in [execution research](../research/dsh-execution.md); implementation/test progress belongs to the corresponding GitHub issue.

A checkpoint preserves continuation information, not OS process memory. Account for every enabled child/tool lifetime before releasing capacity, flush durable Session data, and reconcile interrupted effects before repetition. Verify cwd routing and the selected sandbox separately; a worktree is not an access-control boundary.

## Conceptual execution interface

These are required data exchanges, not proposed public DSH method names. Keep actual integration code private until the selected DSH API is verified.

**Proposed implementation:** a run-scoped report tool composed through DSH's typed tool registry, using the [native outcome facilities](../research/dsh-execution.md#machine-checked-outcomes). Treat its validated payload as evidence input, not permission to publish. A failed enclosing tool/PTC call cannot seal successful completion; settle execution, confirm durable evidence and revalidate Git state through the existing publication gate. Preserve root ownership and use public APIs rather than a private subagent output helper.

| Input | Required facts |
| --- | --- |
| Run identity | Run/attempt identifiers and immutable configuration revision |
| Issue snapshot | tracker identity, title, approved scope, designated Brief comment identity/version, relevant context and dependencies |
| Workspace | Exact registered worktree, target repository and branch/base identity |
| Execution context | Configured DSH preset/skills and a reference to applicable repository instructions |
| Continuation | Existing Session identity, checkpoint and any newly authorized tracker answers |
| Resource policy | Enforced spending authorization and supported limits; credential values stay outside prompts |

| Outcome | Required facts |
| --- | --- |
| verified | Change summary, acceptance-criteria evidence, verification commands/results, skips and reasons, exact Git state evaluated, suggested PR description |
| blocked | Blocker category, evidence, questions, suggested human action, continuation context |
| failed | Error category, relevant evidence, recoverability information, last known completed action |
| paused | DSH continuation reference, interrupted/pending operations, quiescence evidence |

A turn ending normally is insufficient proof of verified work. Missing or malformed outcome data requires explicit handling; never turn arbitrary final prose into a success flag. Revalidate that the published code matches the verified state, including untracked files and final commit state.

## Target repository and Autopilot context

Compose the existing repository-instruction loader and configured skill catalog/loading tools in the run's DSH preset. The run agent reads the target repository's instructions and selects appropriate checks. Autopilot does not store a project-wide substitute list of lint/test commands or implement another skill parser, catalog, discovery system or installation manager. An explicit repository skip or exception can be reported with its evidence; an unexplained failed required check cannot become verified success.

Supply the approved Agent Brief as the execution scope. Supporting comments are context and human answers, not unrestricted instructions to change scheduling, credentials or publication policy. Keep all model-visible injected material reconstructable in the DSH Session through supported logging.

Use the Autopilot handoff pattern: approved brief, bounded execution, evidence-based verification, structured blocker questions, and human readiness after clarification. Avoid depending on a developer's private skill path; any packaged skills must be redistributable and their inputs documented.

The `ask-matt` flow informs this handoff: self-contained implementation work, explicit blocking dependencies, and review against both repository standards and the approved scope. Adapt tracker interactions to the selected provider’s comments and dependency links. It is a process reference, not a runtime dependency or permission to impose its TDD/skill stack on every target repository. Autopilot does not generate a parallel code-host issue backlog.

## Delegation

Start with one root execution per tracker run. Autopilot owns run concurrency; DSH owns how enabled agent tools perform the task. Agent delegation is optional and controlled through supported preset/tool configuration. Use existing workflow/subagent services for enabled in-task scripting and delegation; they do not replace the durable ticket-admission queue. Do not build a second team planner, workflow interpreter or DAG scheduler.

If child agents are enabled, their usage, worktree access, pause and shutdown must belong to the parent run. If the integration cannot observe or stop descendants or account for their usage, disable that delegation configuration rather than claiming its limits apply. Subagent tooling present in a repo does not override deployment enforcement.

## Acceptance

Demonstrate two isolated roots, actual Host restart during execution, same-Session continuation, active-tool/descendant quiescence, persistence failure, validated outcomes tied to Git state, and pre-request usage authorization for each enabled request category. Retain reusable tests in the implementation; record execution results on GitHub.
