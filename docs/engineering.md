# Plugin engineering standards

These are rules for implementing this repository, not instructions imposed on target repositories. [DSH practice evidence](research/dsh-practices.md) records their upstream basis and limits. Product behavior stays in `specs/`; exact upstream APIs stay in the [capability map](research/dsh.md#capability-reading-map).

## Host code and public APIs

- Use strict TypeScript and ESM. Reuse owner-exported types; brand opaque ids crossing services. Handle closed discriminated unions exhaustively; merge-extensible registries need an explicit unknown-provider/event path.
- Validate configuration, provider/model JSON, durable records and process/wire inputs where they enter. Trust required types inside the same typed process; avoid defensive fallback branches for impossible inputs. Normalize provider failures at the provider service, preserving independent facts such as timeout and process exit.
- Give every public operation a current consumer and documented preconditions, effects, failures and cancellation behavior. Keep helpers private. Deployment-varying choices belong in validated configuration; protocol constants and security invariants are not user tunables.
- Follow the selected Loader export form: a service-class default export or named function-plugin exports, not both. Declare required service injection; read genuinely optional services through `ctx.get`. Packaging and resource lifetimes follow [plugin integration](specs/plugin.md), not a second local convention.
- One asynchronous operation has one lifecycle owner. Capture its run/Session identity before awaiting; keep that identity explicit at service, persistence, worker and authority boundaries. Cancellation requested, process exited and all descendants stopped are different observations.
- Publish derived state and notifications after the durable operation commits. Observer failure cannot undo a committed operation or starve other observers; policy vetoes remain in the deciding operation, not an observer. Enforce authorization through the actual executor, including direct and alternate callers.
- Bound complete retained/emitted values, including framing and metadata. Own temporary paths, output files and child lifetimes; use private unpredictable paths and the configured subprocess environment policy. Worktree removal follows [cleanup requirements](specs/operations.md#worktrees-and-cleanup), not generic recursive deletion.

## Client code

Compose in `apply` through DSH slots and injected services. Derive the framework's runtime, child-slot, store and inject prop types rather than restating them. Components receive data and callbacks; they do not receive `ctx`, whole services or custom service-access hooks.

Keep Host-derived business data in its owning data object. Declared stores hold shared view state such as selection and drafts; local component state holds local interaction. Subscribe through framework-provided hooks; do not mirror external snapshots with manual subscriptions. Keep observable and unchanged snapshot identities stable. Command/query behavior belongs to [UI components](specs/ui-components.md).

Use public static primitives, not another feature plugin's private exports. Route cross-feature UI through declared slots, not ReactNode-valued service props. Use CSS Modules and semantic DSH tokens; route product copy, accessibility names and formatters through typed locale dictionaries. Keep external ticket text and stable identifiers verbatim. [Web evidence](research/dsh-web.md) owns exact imports; [visual requirements](specs/web-ui.md) own appearance and accessibility acceptance.

## Verification by changed surface

Plan the relevant tiers on the implementation issue before coding. Use real DSH services beneath controlled external/model/clock inputs. Keep source tests and packed-artifact tests explicit so stale build outputs cannot make a source test pass.

| Changed surface | Required evidence |
| --- | --- |
| Policy, provider or durable operation | Behavior tests for success, denial, malformed external input, uncertain acknowledgement and recovery; relevant [provider conformance](specs/providers.md#extension-and-acceptance). |
| Registration, async resource or composition | Loader-booted fixture through a supported profile; missing dependency, withdrawal, unload/remount and no surviving resources or duplicate registrations. Hand-built plugin mounting alone is insufficient. |
| Persistence, pause or external side effect | Real storage/fixture Git state across actual restart; verify committed and uncommitted outcomes independently, not just a returned status. |
| Model-visible input/output | Keyless assembled Session replay/expected-output evidence; inspect persisted events and actual workspace effects. Update intended expectations explicitly, never refresh them in CI. |
| Client data or presentation | Data-layer tests plus realistic component fixtures; assembled DSH browser evidence for slot/loading, interaction or visible changes. Follow [visual acceptance](specs/web-ui.md#visual-acceptance). |
| Distribution or public exports | Install the packed artifact outside the checkout; exercise built Host/Client and worker entries actually shipped. Declare assets/dependencies completely; do not rely on upstream source paths. |
| Live-provider support | Explicitly authorized, bounded test resources and spending. Keyless/mocked success does not certify live support; skipped checks remain reported as skipped. |

Tests own unique ports, directories and processes, clean up on failure, and synchronize on observed events rather than guessed sleeps. Include empty, exact-limit, multibyte and oversized-result cases when adding bounds. A regression test must fail when its guarded defect is reintroduced. Verify files, Git state and external receipts independently of model prose.

Run the smallest checks covering the changed surface; broader CI supplies the supported platform matrix. Define this repository's runnable gates when build tooling exists, using maintained DSH test helpers where externally usable. Upstream command names and coverage percentages are not evidence that this repository has those gates. Report exact commands, skips and remaining gaps on GitHub.

## Documentation and diagnostics

Update affected public usage/error documentation with behavior. Explain non-obvious constraints and model/token/cache effects when a plugin contributes model-visible material; link shared definitions instead of repeating them. Add executable invariant checks only for independent observations that can diverge, not empty companions or assertions of registration metadata. [AGENTS.md](../AGENTS.md) owns prose discipline and discovered-bug handling.
