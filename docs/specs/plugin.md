# Plugin engineering

This page owns the proposed DSH plugin integration design. Upstream interface names require verification against the selected DSH version; source evidence is in [DSH research](../research/dsh.md). Required provider extensibility is owned by [provider architecture](providers.md).

Implementation and verification follow [engineering standards](../engineering.md); this page owns Autopilot's DSH composition choices.

## Reuse before implementation

For each capability being implemented, follow the [DSH capability reading map](../research/dsh.md#capability-reading-map). Identify the public service/export, compose its provider and consumers, and verify the required behavior through the installed artifact. Autopilot owns ticket-to-PR policy and domain records, not the infrastructure used to execute that policy. A component or service name in these specs denotes a responsibility, not a mandate to write a new framework.

Before introducing replacement infrastructure, record the exact missing behavior and source evidence on the implementation issue. First try supported configuration/composition or a narrow consumer adapter. If an upstream extension is needed, track it as a dependency; use one selected implementation, not parallel native/custom paths. Loading every DSH capability is not a requirement: select only what this deployment needs.

## Cordis lifecycle

- Export a plugin `apply(ctx)` and a runtime `Config` schema. Use service injection for activation dependencies; YAML row order does not determine plugin startup order.
- A missing required service leaves a consumer PENDING. Service withdrawal unloads dependent consumers; replacement remounts them. Startup readiness must detect missing required contributions instead of reporting a functioning scheduler merely because the process is alive.
- Use stable patch row ids and distinctive Autopilot service/event names. The official `@deepseek-ai` npm scope belongs to upstream; publish this project under an available community name such as `dsh-autopilot` or an owner scope.
- Cordis already owns listeners registered with `ctx.on` and child plugins registered with `ctx.plugin`. Acquire external timers, database handles, watchers and subscriptions through effect-owned lifetimes and return their disposers. Check a registry's registration contract before adding redundant cleanup.
- Async disposers can overlap even though they start in reverse order. Put dependent shutdown operations in one awaited sequence: fence new work, settle/cancel owned execution, persist recovery state, then close the store. Unloading the plugin does not mean deleting its durable data.
- Configuration edits can remount a plugin. Distinguish a scheduler pause command from disabling/unloading its Cordis row; lifecycle recovery must handle either without leaving duplicate pollers or dispatchers.
- Type events through declaration merging and document their dispatch mode. `emit` does not await async persistence. Observer middleware must delegate with `next()`; deliberate budget vetoes must respect the intercepted interface's error/result contract.
- Durable `turn/end` and `tool/result` records are Session event types, not same-named Cordis events. Observe them through `session/event` and inspect the record type.

## Packaging and configuration

Distribute a bundle declaring `dsh.bundle.patch` and exporting its Host code. A user profile owns the ordered bundle list and launch; create profiles through the DSH CLI. The standalone Cordis tutorial launcher teaches framework behavior and is not Autopilot's application entry point.

Patch layers replace an entire row's `config`; they do not deep-merge keys. Schema defaults and Settings overrides are different mechanisms. Document effective configuration using those actual semantics. `!!js` applies only under config/disabled and is trusted deployment code, not a syntax for ticket-controlled input.

Use explicit dependency versions compatible with a recorded DSH cohort. Avoid `workspace:` dependencies or build paths into a developer's upstream checkout. Follow package exports and declared Host/Client faces, not unexported source paths.

A Web package declares `dsh.client.platform: web`, exports `./client`, and builds the runtime's lazy factory registration format. Ordinary browser ESM output is insufficient at this baseline. Share the runtime's React/Cordis baseline; declare exact non-baseline externals. `dsh.client.inject` metadata is not runtime service injection.

Git-source installs require self-contained built entry points, typically a `prepare` build subject to the installing profile's pnpm build policy. Packed npm/tarball distribution can supply prebuilt outputs. Test the packed artifact in an isolated profile outside the source checkout, including Host and Client entry resolution. Creating this GitHub repository does not publish an npm package.

## Web and Host interface

Register a root-scoped `main` panel keyed by the same id as its `sidebar.panellist` entry. Contribute one Settings editor through `settings.section` or the existing Plugins namespace-card slot; reuse the existing shell and public components from [Web research](../research/dsh-web.md). An optional Session shortcut uses `conversation.session.header.actions`. Use `ctx.slots.inject` to wait for the slot declaration, not merely for the slots service. Effects must remove and restore contributions across unload/reload.

Keep Host/Client type and build programs separated. A typed Remote requires generated Host descriptors, Client contribution output, and explicit Client mounting. Do not copy an upstream cookbook step that edits the monorepo's central Remote assembly into this external repository. A decorator alone does not expose the plugin's interface remotely.

DSH supports typed unary and explicitly declared stream Remotes. Reuse Gateway transport, cancellation and reconnect handling; use its snapshot/journal helpers where the domain's event protocol fits. Autopilot supplies authorized queries/commands, revisions and domain-specific recovery semantics, not another RPC/WebSocket stack. An iterable alone does not declare a Remote stream. Select and test one update mechanism; bounded polling is acceptable when sufficient, not a required substitute for existing streaming. See [connectivity evidence](../research/dsh-connectivity.md).

Use the Host Settings/credential facilities when the selected access mode supports them; [platform evidence](../research/dsh-platform.md) owns their APIs and limitations. Register Autopilot's schema and policy validation with Settings rather than implementing another configuration store. Keep credentials in the existing credential service and resolve them per operation; secrets are not durable run inputs.


## Installation and access acceptance

Validate packed installation outside the source checkout, effect cleanup/remount without duplicate registrations, headless hosting and actual DSH Web slot mounting. The selected VPS access path must authenticate reads/mutations, retain settings across restart, recover live state and reject unauthorized access. Tracker ingress authentication is independent. Test direct API exposure, credential/pairing revocation and transport unload/reload for the selected deployment. Source limitations belong in [DSH research](../research/dsh.md); validation progress belongs on GitHub.
