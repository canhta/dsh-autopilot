# Provider architecture

This page owns replaceable integration interfaces. [Scope](scope-and-ownership.md) owns product responsibilities; [integrations](integrations.md) owns external behavior. Interface names below are proposed Autopilot types, not existing DSH APIs.

## Composition

Use ordinary Cordis plugins with Service Definition / Provider / Consumer roles. Required implementations are Jira and Linear tracker providers, GitHub and Bitbucket code-host providers, and webhook/ntfy notification providers. Tracker comments use the selected tracker provider; do not implement a second tracker client inside notifications.

The core scheduler consumes provider services, never vendor clients. Host queries expose normalized run data to Web. No `if provider === 'jira'` branches in admission, execution, worktree cleanup or the shared UI. Provider implementations own vendor SDKs, wire validation, pagination, authentication, mapping, retry classification and external receipts.

One deployment selects one tracker binding/project and one code-host binding; any supported tracker can pair with any supported code host. Multiple configured notification destinations are allowed. This is composition, not a cross-project control plane.

Publish the Service Definitions and registration types for external plugins. Keep provider entry points independently loadable; a convenience bundle composes selected providers without forcing unused dependencies or credentials. Separate npm packages are appropriate for independently distributed providers, not mandatory for every internal module. Do not build a second plugin loader or a custom dependency-injection framework.

## Required interfaces

| Service Definition | Provider operations | Consumers |
| --- | --- | --- |
| Tracker | Validate binding/scope; enumerate candidates with cursors; read issue, Brief comments and dependencies; resolve readiness evidence; write/reconcile marked reports; apply configured agent labels/review status | Admission, blocker/completion reporting, Settings lookups |
| Code host | Validate repository/access; resolve Git remote/base; find/create/reconcile PR; read normalized disposition | Publication controller, maintenance, Settings lookups |
| Notification | Validate destination; deliver a versioned event; classify result/retry and reconcile where supported | Durable delivery worker, Settings test action |

Registration supplies a stable provider id, interface version, display metadata, validated configuration schema, capability declaration and a binding factory returning a disposer. Reject duplicate ids and incompatible versions. Register through an effect-owned lifetime; required service injection uses Cordis activation rules. Schemas are Host authoritative; optional Client contributions may improve selectors but cannot change validation.

Expose small operation groups, not a universal HTTP request escape hatch. An installed provider can use REST, GraphQL, a maintained SDK or a constrained MCP integration internally only if it satisfies the same evidence/recovery obligations. Credential values, client objects and arbitrary vendor JSON do not become core run fields.

## Normalized facts

Use branded references qualified by provider binding and stable external identity: issue, project, repository, comment and PR. Display keys, URLs, names and slugs can change; they are not durable uniqueness keys. Version durable provider receipts and validate them when loaded. Vendor-specific recovery data stays opaque to other providers.

An issue snapshot carries scope, summary, selected Brief identity/version, mapped priority rank, dependency completion evidence and readiness evidence. Map priorities explicitly; vendor numeric values are not comparable. Dependency results are `completed`, `not-completed` or `unknown`; lack of access is never completion. Review/done states and label IDs resolve through provider configuration, not English string comparison.

A PR receipt carries provider-qualified identity, repository/base/head association, URL and normalized disposition: `open`, `merged`, `closed-unmerged` or `unknown`. Bitbucket decline and GitHub unmerged closure normalize to `closed-unmerged`, not `merged`. Local Git remains a shared facility; PR REST operations do not push commits.

Operation errors distinguish authentication, permission, invalid configuration, not found, conflict, rate limit, transient failure, unsupported capability and ambiguous acknowledgement. Include sanitized diagnostic context and retry timing where available. Core policies decide whether to wait, pause or request operator action; providers never independently rerun coding.

## Readiness and capabilities

The shared requirement is an attributable human readiness transition on the tracker, never a reply alone or a Web override. Providers return actor identity, transition identifier/order evidence, before/after readiness and origin confidence. Authenticated ingress proves sender integrity, not that the actor is human. Reject known automation; require explicit trusted-actor policy where user-token automation is indistinguishable. Unknown attribution fails closed. Polling a currently ready label cannot reconstruct a missed human transition by itself.

Require scope reads, designated comments, dependencies, configured label/status writes, human-readiness evidence and PR reconciliation for the selected workflow. Validate required capabilities before enabling dispatch. Optional webhooks or rich selectors can fall back to reconciliation/basic inputs only if required semantics remain provable. Do not silently omit dependency checks or weaken authorization to accommodate a provider. Explain unsupported configurations in health and Settings.

## Configuration and provider changes

Configuration selects installed provider ids and validated binding fields: tracker/project, code host/repository mapping, notifications, credential references and policy mappings. Supply examples for Jira + GitHub and Linear + Bitbucket; document that the other two combinations work identically. These are future schema examples to ship after the interface is implemented, not runnable YAML in this specification.

Operators may change mappings, labels, schedules and connection settings without editing source. Adding a genuinely new protocol requires installing a compatible provider plugin; an arbitrary URL/JSON template is not automatically a complete tracker integration. Install through trusted DSH composition, not code pasted into a ticket or a browser form.

Snapshot binding identity/version with each run and each external intent. Credential rotation changes the resolved secret without reassigning that identity. In v1 reject a provider/project/repository-binding switch while unfinished runs or unresolved external intents depend on it; pause is not migration. Require explicit resolution/cancellation and successful reconciliation first. Mapping changes follow the same dependency restrictions in [operations](operations.md). Preserve historical references after a switch; maintenance still requires the original provider/binding or reports unknown and retains worktrees. Never reinterpret old receipts through a newly selected provider.

On provider unload, fence dependent dispatch/publication and await owned requests before disposal. Reconcile uncertain effects after remount; no duplicate pollers, sends or PRs. A temporarily unavailable provider must not delete queued work or erase receipts.

## Extension and acceptance

Ship shared conformance fixtures/helpers with the public interface: paginated reads, unknown access, actor attribution, label preservation, mapped priorities/statuses, ambiguous writes, replay, rate limits, redaction, disposal and restart recovery. Code-host fixtures include PR identity matching and open/merged/closed-unmerged/unknown cleanup dispositions.

Prove all four tracker/code-host combinations through the same fixture end-to-end suite. Obtain live evidence for each shipped provider on authorized test resources. A third-party fixture provider must load, register Settings and pass conformance without modifying core imports, switch statements or UI routing. Record supported DSH/interface/provider versions. Source research in [Linear](linear-provider.md) and [Bitbucket](bitbucket-provider.md) is not a supported-provider certification.
