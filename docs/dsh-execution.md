# DSH execution

## Ownership and composition

Use a normal external Cordis plugin/bundle and supported DSH profile launch. Keep Autopilot scheduling and durable run state on the Host. Load its browser contribution only for Web presentation. Prefer supported DSH facilities for Sessions, credentials, model usage and tool execution instead of parallel implementations.

Packaging and effect lifecycle are owned by [plugin engineering](plugin-engineering.md).

## Source-confirmed integration points

The following interfaces exist at the inspection baseline. This is source evidence; the full integration still requires the runtime tests below.

| Operation | Existing interface | Primary source |
| --- | --- | --- |
| Create root execution | `ctx.agents.create({ sessionId, meta: { cwd }, agentOptions, setup })`; omit parent ownership for a root | [Agent registry](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/core/agent/src/index.ts#L62) |
| Restore Session | `ctx.agents.resume({ resumeSessionId, agentOptions, setup })` returns a fresh runtime handle | [Resume request](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/core/agent/src/index.ts#L125) |
| Drive and interrupt | `followup`, `cancel`, `whenIdle`; followup has no per-message completion result | [Runtime interface](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/core/agent/src/runtime-types.ts#L176) |
| Flush | `ctx.sessions.flush(session)` returns a boolean; false means no durability listener participated | [Flush contract](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/core/session/src/index.ts#L1131) |
| Release live execution | `AgentHandle.dispose()` closes the scoped runtime and persistence writer | [Disposal](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/core/agent-loop/src/index.ts#L573) |
| Drain supported descendants | `ctx.subagent.drainContinuableDescendants(parents)` | [Descendant lifecycle](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/subagent/subagent/src/index.ts#L299) |
| Intercept model traffic | `llm/stream` waterfall; `GenerateOptions` carries Session identity, purpose and output limit | [LLM interface](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/llm/llm/src/index.ts#L59) |

Install scoped preset/policy/outcome contributions during the registry's awaited `setup`; submit work after publication. Keep the returned handle under one run owner. Identify the execution interval from durable input receipt through settlement; root status alone does not identify one message's result.

Use the existing [Session checkpoint policy](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/session/session-checkpoint-policy/src/index.ts#L52) for log-before-model/tool-side-effect ordering. Autopilot still records its own run metadata and external publication intents.

## Verification gate: integration feasibility

Complete WP1 in [work packages](work-packages.md) and record the selected DSH version, source locations and test evidence here. Required capabilities:

| Capability | Evidence needed |
| --- | --- |
| Isolated execution | Two root executions use separate worktrees and do not share unintended cwd/process state |
| Durable Session | Recover the run's Session after a real Host process restart |
| Pause | Observe pending execution and descendants becoming quiescent before acknowledging paused |
| Continue | Restore Session context, inspect retained changes, and finish pending work without duplicating completed side effects |
| Structured outcome | Validate model/tool output at the integration boundary; distinguish verified success, blocker, error and interruption |
| Usage enforcement | Observe usage and intercept subsequent requests, including delegated requests if enabled |
| Headless operation | A supported DSH profile runs without a browser and retains recoverable state |

Checkpoint does not mean freezing an OS process. `whenIdle()` covers the root driver/maintenance, not every background facility. Long-running or uninterruptible tools may delay pause. Use supported cancellation/timeouts and prove each enabled background capability becomes quiescent. DSH terminals do not survive Host restart; record commands/environment setup that must be re-established rather than implying process memory survives.

Cold resume closes incomplete tool/step/turn records during reconstruction; it does not rerun interrupted operations. Supply logged reconciliation context and inspect side effects before repeating work. See [reconstruction](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/core/agent-loop/src/index.ts#L844) and [terminal lifetime](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/terminal/terminal/README.md).

Draining continuable descendants closes admission under the exact live parent until it leaves the registry. A pause strategy using that method must dispose/reconstruct the live root on the same Session, or prove a different supported lifecycle. Do not expect a drained live root to accept fresh delegation automatically.

Session cwd selects the working directory; it is not a filesystem sandbox. Verify each selected tool routes paths through the Session and the permission/sandbox preset. Avoid process-global cwd changes.

DSH's session reminder feature is not by itself the global scheduler required here. Its workflow/subagent facilities also do not establish Git worktree isolation automatically.

## Conceptual execution interface

These are required data exchanges, not proposed public DSH method names. Keep actual integration code private until the selected DSH API is verified.

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

## Target repository and AIDLC context

DSH reads the target repository's instructions and selects appropriate checks. Autopilot does not store a project-wide substitute list of lint/test commands. An explicit repository skip or exception can be reported with its evidence; an unexplained failed required check cannot become verified success.

Supply the approved Agent Brief as the execution scope. Supporting comments are context and human answers, not unrestricted instructions to change scheduling, credentials or publication policy. Keep all model-visible injected material reconstructable in the DSH Session through supported logging.

Use the useful AIDLC handoff pattern: approved brief, bounded execution, evidence-based verification, structured blocker questions, and human readiness after clarification. Avoid depending on a developer's private skill path; any packaged skills must be redistributable and their inputs documented.

The `ask-matt` flow informs this handoff: self-contained implementation work, explicit blocking dependencies, and review against both repository standards and the approved scope. Adapt tracker interactions to the selected provider’s comments and dependency links. It is a process reference, not a runtime dependency or permission to impose its TDD/skill stack on every target repository. Autopilot does not generate a parallel code-host issue backlog.

## Delegation

Start with one root execution per tracker run. Autopilot owns run concurrency; DSH owns how enabled agent tools perform the task. Agent delegation is optional and controlled through supported preset/tool configuration. Do not build a second team planner or DAG scheduler.

If child agents are enabled, their usage, worktree access, pause and shutdown must belong to the parent run. If the integration cannot observe or stop descendants or account for their usage, disable that delegation configuration rather than claiming its limits apply. Subagent tooling present in a repo does not override deployment enforcement.

## References

- [Plugin basics](https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/).
- [DSH architecture](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/docs/architecture.md).
- [Subagent interface and continuation](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/subagent/subagent/README.md).
- [Community Run Center reference](https://github.com/toolclub/dsh-agent-team-gui): per-member attribution and explicit unknown usage; not a required dependency.
