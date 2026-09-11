# DSH source research

Inspected 2026-09-11 against DeepSeek Harness commit `c291e7961a515f6d7af9304e7fd1d257929aef26`. This is source evidence, not a supported release or live Autopilot compatibility claim. Stable requirements live in [execution](../specs/execution.md) and [plugin design](../specs/plugin.md). Validation work/results belong on GitHub.

## Source-confirmed integration points

The following interfaces exist at the inspection baseline. Runtime requirements are defined in [execution](../specs/execution.md#acceptance); their validation is tracked on GitHub.

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

Checkpoint does not mean freezing an OS process. `whenIdle()` covers the root driver/maintenance, not every background facility. Long-running or uninterruptible tools may delay pause. Use supported cancellation/timeouts and prove each enabled background capability becomes quiescent. DSH terminals do not survive Host restart; record commands/environment setup that must be re-established rather than implying process memory survives.

Cold resume closes incomplete tool/step/turn records during reconstruction; it does not rerun interrupted operations. Supply logged reconciliation context and inspect side effects before repeating work. See [reconstruction](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/core/agent-loop/src/index.ts#L844) and [terminal lifetime](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/terminal/terminal/README.md).

Draining continuable descendants closes admission under the exact live parent until it leaves the registry. A pause strategy using that method must dispose/reconstruct the live root on the same Session, or prove a different supported lifecycle. Do not expect a drained live root to accept fresh delegation automatically.

Session cwd selects the working directory; it is not a filesystem sandbox. Verify each selected tool routes paths through the Session and the permission/sandbox preset. Avoid process-global cwd changes.

DSH's session reminder feature is not by itself the global scheduler required here. Its workflow/subagent facilities also do not establish Git worktree isolation automatically.

## Remote-access observations

The baseline Web CLI [rejects `--host 0.0.0.0`](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/bundle/web-app/src/startup.ts#L64). A loopback DSH profile with SSH port forwarding is a candidate VPS administrative path. A browser opened on a remote public hostname has [inert durable Settings by default](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/client/ui-settings/README.md); generic reverse-proxy authentication alone does not change that Client behavior.

The inspected remote-web-ui provides a concrete candidate: its [parse-time bootstrap](https://github.com/zhu1090093659/dsh-web/blob/33ce09cde617e2a7dd05358b169d1c8733a65ded/packages/dsh-remote-web-ui/src/remote-channel-boot.ts#L32) sets `__DSH_TRANSPORT__.ownsHost` before Connection initializes and routes requests through a paired-device `/remote` channel. The current DSH Connection honors that flag, so it may enable durable Settings. This is a custom full-control transport adaptation; it has not been validated with Autopilot. Keep pairing, tunneling and device-session lifecycle in that separately composed capability.

Use source versions rather than catalog claims: at the inspected commit remote-web-ui is v0.3.20 with a declared DSH floor of `0.1.5-rc.1`, while its README describes an older cohort. Its listing's public-bind command also differs from the current upstream CLI. These discrepancies require a real compatibility test, not copying an installation example.

## Community source comparison

Sources were read without installing or executing their plugins. These observations inform implementation choices; they do not certify compatibility or security.

| Pinned source | Useful implementation evidence | Difference from Autopilot |
| --- | --- | --- |
| [titanwings/dsh-automation, 0d73a4e](https://github.com/titanwings/dsh-automation/tree/0d73a4e03639d4f63d0771ae4490e2718b7e7aa0) | `src/executor.ts`: creates a scoped root, applies preset/permission, submits logged work, waits and flushes; `src/service.ts`: durable occurrence handling | Its turn-end success is not repo verification; its fresh-run/restart semantics do not prove resumable worktrees |
| [SingleOne/dsh-notify-center, c8a38ab](https://github.com/SingleOne/dsh-notify-center/tree/c8a38ab945bfdaa8cd240fbe1ebfd4a55183cc5b) | `src/settings-api.ts`: revisioned mutations and local access checks; `src/hub.ts`: per-channel dispatch | In-flight delivery is memory-owned and can be dropped; Autopilot requires durable delivery intents |
| [dsh-task-board, 33ce09c](https://github.com/zhu1090093659/dsh-web/tree/33ce09cde617e2a7dd05358b169d1c8733a65ded/packages/dsh-task-board) | `src/host-ledger.ts`: revisioned Host transactions, request fingerprints and single-owner storage; `src/host-routes.ts`: snapshots, SSE invalidation, authenticated proxy checks | Owns a separate task ledger; Autopilot keeps task approval on the selected tracker. Session reuse can fall back to a fresh Session; Autopilot continuation cannot silently do so |
| [dsh-remote-web-ui, 33ce09c](https://github.com/zhu1090093659/dsh-web/tree/33ce09cde617e2a7dd05358b169d1c8733a65ded/packages/dsh-remote-web-ui) | Paired-device transport and official-shell reuse; investigate authenticated remote configuration | A full-control transport with its own access lifecycle, not a simple Settings toggle; reuse requires the access compatibility test |

Task-board's proxy pattern requires a same-host authenticated proxy to replace its internal token header after authentication. Origin or Fetch Metadata alone is not authentication. Apply this lesson to Autopilot-owned routes rather than copying a plugin-specific header or trusting client-supplied identity.

Do not inherit unrelated capabilities such as desktop sleep prevention, plugin self-update, automatic public tunnels, shared relay infrastructure, or install telemetry merely by copying an example package. They are outside the [product scope](../specs/scope.md).

## Model usage observations

The inspected `TokenUsage` fields are disjoint: `inputTokens` means uncached input; cache-read and cache-write are separate categories. Reasoning usage must not be added again when already included in output usage. Provider adapters determine the available categories; absent usage is not evidence of zero. See [usage types](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/llm/llm/src/types.ts#L141).

`GenerateOptions` carries Session identity, auxiliary request purpose and output limit, enabling attribution beyond conversational requests; see [request options](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/llm/llm/src/types.ts#L425). The [token-meter](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/llm/token-meter/README.md) uses heuristic estimates and cannot establish a billing-grade monetary bound. Enforcement requirements remain in [operations](../specs/operations.md#credit-and-spending).

## Framework references

System context: [DSH architecture](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/docs/architecture.md) and [subagent continuation](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/subagent/subagent/README.md).

Primary tutorials: [first plugin](https://deepseek-harness.github.io/deepseek-harness/en/develop/cordis-tutorial/01-first-plugin), [effects](https://deepseek-harness.github.io/deepseek-harness/en/develop/cordis-tutorial/02-lifecycle-and-effects), [services](https://deepseek-harness.github.io/deepseek-harness/en/develop/cordis-tutorial/03-services), [events](https://deepseek-harness.github.io/deepseek-harness/en/develop/cordis-tutorial/04-events), [configuration](https://deepseek-harness.github.io/deepseek-harness/en/develop/cordis-tutorial/05-config), [composition/HMR](https://deepseek-harness.github.io/deepseek-harness/en/develop/cordis-tutorial/06-composition-and-hmr), [Harness tools](https://deepseek-harness.github.io/deepseek-harness/en/develop/cordis-tutorial/07-into-the-harness).

References: [package/install guide](https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/publish), [client module format](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/client/modules/README.md), [client bundling source](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/client/tsdown.client.ts).

References: [Remote extension cookbook](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/docs/cookbook/adding-a-remote-api.md), [gateway contract](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/docs/api-gateway.md), [credentials](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/docs/subsystems/credentials.md).
