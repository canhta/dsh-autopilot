# Plugin engineering

This page owns framework conventions and compatibility evidence. Product behavior remains in the other owning documents. The inspection baseline is recorded in [the entry point](README.md). Autopilot-specific Service Definitions and provider composition are owned by [provider architecture](provider-architecture.md).

## Cordis lifecycle

- Export a plugin `apply(ctx)` and a runtime `Config` schema. Use service injection for activation dependencies; YAML row order does not determine plugin startup order.
- A missing required service leaves a consumer PENDING. Service withdrawal unloads dependent consumers; replacement remounts them. Startup readiness must detect missing required contributions instead of reporting a functioning scheduler merely because the process is alive.
- Use stable patch row ids and distinctive Autopilot service/event names. The official `@deepseek-ai` npm scope belongs to upstream; publish this project under an available community name such as `dsh-autopilot` or an owner scope.
- Cordis already owns listeners registered with `ctx.on` and child plugins registered with `ctx.plugin`. Acquire external timers, database handles, watchers and subscriptions through effect-owned lifetimes and return their disposers. Check a registry's registration contract before adding redundant cleanup.
- Async disposers can overlap even though they start in reverse order. Put dependent shutdown operations in one awaited sequence: fence new work, settle/cancel owned execution, persist recovery state, then close the store. Unloading the plugin does not mean deleting its durable data.
- Configuration edits can remount a plugin. Distinguish a scheduler pause command from disabling/unloading its Cordis row; lifecycle recovery must handle either without leaving duplicate pollers or dispatchers.
- Type events through declaration merging and document their dispatch mode. `emit` does not await async persistence. Observer middleware must delegate with `next()`; deliberate budget vetoes must respect the intercepted interface's error/result contract.
- Durable `turn/end` and `tool/result` records are Session event types, not same-named Cordis events. Observe them through `session/event` and inspect the record type.

Primary tutorials: [first plugin](https://deepseek-harness.github.io/deepseek-harness/en/develop/cordis-tutorial/01-first-plugin), [effects](https://deepseek-harness.github.io/deepseek-harness/en/develop/cordis-tutorial/02-lifecycle-and-effects), [services](https://deepseek-harness.github.io/deepseek-harness/en/develop/cordis-tutorial/03-services), [events](https://deepseek-harness.github.io/deepseek-harness/en/develop/cordis-tutorial/04-events), [configuration](https://deepseek-harness.github.io/deepseek-harness/en/develop/cordis-tutorial/05-config), [composition/HMR](https://deepseek-harness.github.io/deepseek-harness/en/develop/cordis-tutorial/06-composition-and-hmr), [Harness tools](https://deepseek-harness.github.io/deepseek-harness/en/develop/cordis-tutorial/07-into-the-harness).

## Packaging and configuration

Distribute a bundle declaring `dsh.bundle.patch` and exporting its Host code. A user profile owns the ordered bundle list and launch; create profiles through the DSH CLI. The standalone Cordis tutorial launcher teaches framework behavior and is not Autopilot's application entry point.

Patch layers replace an entire row's `config`; they do not deep-merge keys. Schema defaults and Settings overrides are different mechanisms. Document effective configuration using those actual semantics. `!!js` applies only under config/disabled and is trusted deployment code, not a syntax for ticket-controlled input.

Use explicit dependency versions compatible with a recorded DSH cohort. Avoid `workspace:` dependencies or build paths into a developer's upstream checkout. Follow package exports and declared Host/Client faces, not unexported source paths.

A Web package declares `dsh.client.platform: web`, exports `./client`, and builds the runtime's lazy factory registration format. Ordinary browser ESM output is insufficient at this baseline. Share the runtime's React/Cordis baseline; declare exact non-baseline externals. `dsh.client.inject` metadata is not runtime service injection.

Git-source installs require self-contained built entry points, typically a `prepare` build subject to the installing profile's pnpm build policy. Packed npm/tarball distribution can supply prebuilt outputs. Test the packed artifact in an isolated profile outside the source checkout, including Host and Client entry resolution. Creating this GitHub repository does not publish an npm package.

References: [package/install guide](https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/publish), [client module format](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/client/modules/README.md), [client bundling source](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/client/tsdown.client.ts).

## Web and Host interface

Register a root-scoped `main` panel keyed by the same id as its `sidebar.panellist` entry. Contribute Settings through `settings.section` and an optional Session shortcut through `conversation.session.header.actions`. Use `ctx.slots.inject` to wait for the slot declaration, not merely for the slots service. Effects must remove and restore contributions across unload/reload.

Keep Host/Client type and build programs separated. A typed Remote requires generated Host descriptors, Client contribution output, and explicit Client mounting. Do not copy an upstream cookbook step that edits the monorepo's central Remote assembly into this external repository. A decorator alone does not expose the plugin's interface remotely.

At this baseline typed Remotes are unary. Use bounded snapshot polling first or a separately verified event stream with full snapshot recovery. Do not assume an async iterable returned from a Remote method creates a supported streaming protocol.

Use the Host Settings/credential facilities when the selected access mode supports them. `CredentialRef` is an environment-style reference resolved per operation; metadata describes configured/source/writable status without revealing values. Credential rotation applies to future requests; secrets are not durable run inputs. Authentication grant records use the separate upstream record mechanism when needed.

References: [Remote extension cookbook](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/docs/cookbook/adding-a-remote-api.md), [gateway contract](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/docs/api-gateway.md), [credentials](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/docs/subsystems/credentials.md).

## Remote-access verification gate

The baseline Web CLI [rejects `--host 0.0.0.0`](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/bundle/web-app/src/startup.ts#L64). A loopback DSH profile with SSH port forwarding is a candidate VPS administrative path. A browser opened on a remote public hostname has [inert durable Settings by default](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/client/ui-settings/README.md); generic reverse-proxy authentication alone does not change that Client behavior.

Resolve D6 with an actual browser/Host test. Check authenticated launch, reads, mutations, persistence after restart, live-state recovery and unauthorized access. Keep tracker webhook ingress independently authenticated. If using a community transport, pin it and test its complete access path before selecting it as a dependency.

The inspected remote-web-ui provides a concrete candidate: its [parse-time bootstrap](https://github.com/zhu1090093659/dsh-web/blob/33ce09cde617e2a7dd05358b169d1c8733a65ded/packages/dsh-remote-web-ui/src/remote-channel-boot.ts#L32) sets `__DSH_TRANSPORT__.ownsHost` before Connection initializes and routes requests through a paired-device `/remote` channel. The current DSH Connection honors that flag, so it may enable durable Settings. This is a custom full-control transport adaptation; it has not been validated with Autopilot. Keep pairing, tunneling and device-session lifecycle in that separately composed capability.

D6 tests must cover unpaired/revoked access, ordinary loopback operation without the plugin, reconnect, Settings write/read after restart, and direct `/api` exposure. Revoking a paired channel does not imply revocation of independent DSH browser credentials. Verify that unload/reload does not stack global transport wrappers.

Use source versions rather than catalog claims: at the inspected commit remote-web-ui is v0.3.20 with a declared DSH floor of `0.1.5-rc.1`, while its README describes an older cohort. Its listing's public-bind command also differs from the current upstream CLI. These discrepancies require a real compatibility test, not copying an installation example.

## Community source comparison

Sources were read without installing or executing their plugins. These observations inform implementation choices; they do not certify compatibility or security.

| Pinned source | Useful implementation evidence | Difference from Autopilot |
| --- | --- | --- |
| [titanwings/dsh-automation, 0d73a4e](https://github.com/titanwings/dsh-automation/tree/0d73a4e03639d4f63d0771ae4490e2718b7e7aa0) | `src/executor.ts`: creates a scoped root, applies preset/permission, submits logged work, waits and flushes; `src/service.ts`: durable occurrence handling | Its turn-end success is not repo verification; its fresh-run/restart semantics do not prove resumable worktrees |
| [SingleOne/dsh-notify-center, c8a38ab](https://github.com/SingleOne/dsh-notify-center/tree/c8a38ab945bfdaa8cd240fbe1ebfd4a55183cc5b) | `src/settings-api.ts`: revisioned mutations and local access checks; `src/hub.ts`: per-channel dispatch | In-flight delivery is memory-owned and can be dropped; Autopilot requires durable delivery intents |
| [dsh-task-board, 33ce09c](https://github.com/zhu1090093659/dsh-web/tree/33ce09cde617e2a7dd05358b169d1c8733a65ded/packages/dsh-task-board) | `src/host-ledger.ts`: revisioned Host transactions, request fingerprints and single-owner storage; `src/host-routes.ts`: snapshots, SSE invalidation, authenticated proxy checks | Owns a separate task ledger; Autopilot keeps task approval on the selected tracker. Session reuse can fall back to a fresh Session; Autopilot continuation cannot silently do so |
| [dsh-remote-web-ui, 33ce09c](https://github.com/zhu1090093659/dsh-web/tree/33ce09cde617e2a7dd05358b169d1c8733a65ded/packages/dsh-remote-web-ui) | Paired-device transport and official-shell reuse; investigate authenticated remote configuration | A full-control transport with its own access lifecycle, not a simple Settings toggle; reuse requires the D6 compatibility test |

Task-board's proxy pattern requires a same-host authenticated proxy to replace its internal token header after authentication. Origin or Fetch Metadata alone is not authentication. Apply this lesson to Autopilot-owned routes rather than copying a plugin-specific header or trusting client-supplied identity.

Do not inherit unrelated capabilities such as desktop sleep prevention, plugin self-update, automatic public tunnels, shared relay infrastructure, or install telemetry merely by copying an example package. They are outside the [product scope](scope-and-ownership.md).

## Evidence completed and remaining

Completed during specification preparation: all seven official tutorial chapters and relevant source were inspected; a keyless framework-only probe against the local Cordis source on Node 24.20.0 demonstrated missing-service PENDING, awaited cleanup after provider loss, remount after replacement, and no duplicate event listeners. This probe used temporary research files and Node's TypeScript transform for framework inspection, not the supported DSH product launcher.

Not yet demonstrated: an installed Autopilot bundle, live model execution, durable Autopilot pause/resume, monetary hard caps, or remote Settings through a chosen deployment. WP1 owns these implementation proofs. Existing compiled upstream artifacts and community tests do not substitute for them.
