# DSH source research

Inspected 2026-09-11 against DeepSeek Harness commit `c291e7961a515f6d7af9304e7fd1d257929aef26`. This is source evidence, not a supported release or live Autopilot compatibility claim. Stable requirements live in [execution](../specs/execution.md) and [plugin design](../specs/plugin.md). Validation work/results belong on GitHub.

## Selected development cohort and installation path

The selected local and VPS policy is to invoke the npm dist-tag `latest`, without a version pin. On 2026-09-11, `npm view @deepseek-ai/dsh dist-tags --json` and `npx --yes @deepseek-ai/dsh@latest --version` both resolved `latest` to [`0.1.5-rc.1`](https://www.npmjs.com/package/@deepseek-ai/dsh/v/0.1.5-rc.1); the inspected checkout declares [`0.1.5-rc.2`](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/apps/cli/package.json#L4) and the registry's `next` tag resolved to rc.2. rc.2 is source evidence, not the selected runtime. DSH explicitly remains a [developer preview with compatibility-breaking changes](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/README.md#L11-L15), so separate invocations of `@latest` can select different implementations and cannot reproduce an earlier deployment by themselves.

The official published path is `npx --yes @deepseek-ai/dsh@latest ...`; `dsh plugin` additionally requires `pnpm` on `PATH` because it forwards package operations into the persistent profile directory. The official source path is `pnpm install`, `pnpm run build`, then `pnpm dsh ...` from a DSH checkout; it exercises that checkout rather than the selected npm tag. A custom Web-derived profile can be created and checked without booting, then receive the bundle from the Autopilot checkout and run through the same profile interface ([profile rules](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/apps/cli/reference/README.md#profile-boot), [plugin rules](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/apps/cli/reference/README.md#plugin-management)):

```sh
npx --yes @deepseek-ai/dsh@latest --profile autopilot --from-default-profile web --dump-config
npx --yes @deepseek-ai/dsh@latest plugin --profile autopilot add .
npx --yes @deepseek-ai/dsh@latest --profile autopilot --dump-config
npx --yes @deepseek-ai/dsh@latest --profile autopilot --no-open
```

The external package must ship an ESM entry, `cordis.patch.yml`, and a `package.json` whose `dsh.bundle.patch` points at that patch; DSH owns the separate profile manifest and ordered Bundle list ([package tutorial](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/docs/user/develop/basic/publish.md#two-concepts-two-manifests)). `dsh plugin --profile autopilot add .` links a local checkout and requires its loadable output to exist. A Git-host install receives source, so the package must provide a self-contained `prepare` build and the operator must explicitly allow that package under the profile's `pnpm-workspace.yaml` `allowBuilds`; this executes package code at install time outside the agent sandbox. An npm package containing built output or a `pnpm pack` tarball needs no build allowance ([install alternatives and security warning](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/docs/user/develop/basic/publish.md#installing-from-github-the-build-script-catch)).

Before production, resolve and record the exact version behind `latest` for that run, validate the Bundle layer with `--dump-config`, boot the real profile, execute the acceptance path in a disposable Git worktree, and pack then install the resulting tarball into a clean `DSH_HOME`; retain the tarball checksum beside the result. DSH's own packed-install gate uses a throwaway consumer specifically so workspace links or stale build output cannot mask missing published files ([gate source](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/scripts/release/verify-packed-install.ts#L1-L16)). The source tree also publishes `runLoaderSmoke`, `resolveExampleLaunch`, `runFixtureTurn`, and `LOADER_SMOKE_TEST_TIMEOUT_MS` from [`@deepseek-ai/dsh-loader-smoke`](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/test-support/loader-smoke/src/index.ts), but its npm `latest` resolved to `0.0.1-rc.1` during this inspection while source is rc.2; do not adopt that helper until its published cohort is proven compatible with the exact CLI resolved for the run. Re-run the clean-profile and packed-artifact checks on the VPS immediately before promotion because the no-pin policy deliberately accepts future `latest` drift.

## Capability reading map

Read only the branch needed by the implementation issue. Each linked page owns its pinned source facts; specs own required behavior.

| Implementing | Source evidence | Reuse direction |
| --- | --- | --- |
| Root execution, continuation, skills, presets and delegation | [Execution](dsh-execution.md) | Compose DSH Agent/Session/skill/workflow services; keep admission and task outcomes in Autopilot. |
| Host APIs, live updates, MCP and external clients | [Connectivity](dsh-connectivity.md) | Reuse typed Remotes/Gateway and protocol clients; add only domain operations. |
| Configuration, credentials, storage, timing, ingress and Git | [Host platform](dsh-platform.md) | Use existing services where their durability and scope meet the requirement. |
| Web components, Settings and Client packaging | [Web](dsh-web.md) | Reuse public atoms and injected slots/services, not private feature components. |

The same capability name does not prove the same semantics: a Session reminder is not global admission, an MCP tool is not human authorization, and a SQLite backend is not a cross-record transaction. Verify the specific requirement before choosing reuse or a narrow extension.

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

## Framework references

System context: [DSH architecture](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/docs/architecture.md) and [subagent continuation](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/subagent/subagent/README.md).

Primary tutorials: [first plugin](https://deepseek-harness.github.io/deepseek-harness/en/develop/cordis-tutorial/01-first-plugin), [effects](https://deepseek-harness.github.io/deepseek-harness/en/develop/cordis-tutorial/02-lifecycle-and-effects), [services](https://deepseek-harness.github.io/deepseek-harness/en/develop/cordis-tutorial/03-services), [events](https://deepseek-harness.github.io/deepseek-harness/en/develop/cordis-tutorial/04-events), [configuration](https://deepseek-harness.github.io/deepseek-harness/en/develop/cordis-tutorial/05-config), [composition/HMR](https://deepseek-harness.github.io/deepseek-harness/en/develop/cordis-tutorial/06-composition-and-hmr), [Harness tools](https://deepseek-harness.github.io/deepseek-harness/en/develop/cordis-tutorial/07-into-the-harness).

References: [package/install guide](https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/publish), [client module format](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/client/modules/README.md), [client bundling source](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/client/tsdown.client.ts).

References: [Remote extension cookbook](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/docs/cookbook/adding-a-remote-api.md), [gateway contract](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/docs/api-gateway.md), [credentials](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/docs/subsystems/credentials.md).
