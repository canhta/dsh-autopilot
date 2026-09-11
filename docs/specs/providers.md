# Provider architecture

This page owns replaceable integration interfaces and tracker transport policy. [Scope](scope.md) owns product responsibilities; [integrations](integrations.md) owns external behavior. Source observations and live-validation limits belong in [tracker MCP research](../research/tracker-mcp.md).

## Composition

Use ordinary Cordis Service Definition / Provider / Consumer roles. The scheduler consumes normalized provider services; admission, execution and Web never call vendor tools or branch on Jira versus GitHub. One deployment selects one tracker binding/project and one independent code-host binding.

Tracker outbound reads are MCP-first. The official GitHub or Atlassian MCP deployment owns vendor authentication and remote request transport; DSH's MCP client owns the MCP connection/reconnect lifecycle and publishes tools on `ctx.tools`. Autopilot invokes a closed set of exact, read-only semantic operations through `ctx.tools.execute()`, validates bounded machine-readable results and normalizes them into tracker facts. It does not contain a second GitHub or Jira REST client, outbound PAT, email/API-token flow or generic vendor-request escape hatch.

Raw webhook verification is the intentional exception. Autopilot receives the exact HTTP bytes and headers, resolves only the inbound webhook secret, verifies the provider signature and returns a provider-qualified delivery identity. MCP then reads current tracker state; webhook payloads are never admission truth.

## Provider interface

The current tracker interface is versioned and read-only:

| Operation | Obligation |
| --- | --- |
| `readCandidates` | Enumerate one bounded page and fully hydrate each issue's comments, blocking dependencies and attributable readiness history. Continuation cursors are generation-local, authenticated and opaque. |
| `verifyIngress` | Authenticate a bounded raw request without external writes and return a retry-stable provider-qualified delivery ID. |

Providers declare candidates, comments, dependencies, readiness and ingress capabilities. The registry rejects missing capabilities, duplicate IDs and incompatible interface versions. It combines caller cancellation with provider-generation withdrawal, drains active operations before disposal and validates normalized results at the seam.

Keep provider entry points independently loadable. Shared MCP code may own exact-name construction, result bounds, tool-failure mapping, generation fencing and cursor protection; vendor modules own only their closed tool contracts, schemas, traversal and normalization. Do not expose a public `invoke(name, args)` module: arbitrary MCP names and vendor JSON must not become core knowledge.

Future code-host and notification services remain separate normalized interfaces. A code host validates repository identity/access, resolves the approved remote/base, finds or creates one marked PR, reconciles ambiguous writes and returns `open`, `merged`, `closed-unmerged` or `unknown`. A notification provider validates a destination, delivers a versioned event and exposes retry/reconciliation facts. Tracker comments still go through the selected tracker provider; they are not a second notification-side tracker client.

## Exact MCP contracts

A tracker provider becomes available only when every required tool exists under its configured `mcp__<serverName>__...` namespace and its live input definition satisfies the pinned contract.

- GitHub requires official `get_me`, `list_issues`, `issue_read` (`get` and `get_comments`), and feature-gated `issue_dependency_read` (`get_blocked_by`), plus `autopilot_read_issue_timeline` in the same MCP namespace. Each traversal compares `get_me` with the configured integration actor. The timeline extension must use the same MCP deployment and identity; there is no direct REST or second-token fallback.
- Jira requires primary `atlassianUserInfo` plus the flat Atlassian `?tools=all` operations `searchJiraIssuesUsingJql`, `listJiraIssueComments`, and `listJiraIssueChangelogs`. Each traversal compares the authenticated account with configuration and verifies the stable project ID returned for every candidate. Autopilot calls those exact tools; it does not use natural-language discovery or deferred execute-tier selection during reconciliation.

All calls use fixed arguments and unique internal call IDs. Prefer `structuredContent`; otherwise accept only the contract's single JSON text block. Enforce per-result byte limits, schema limits, page/item ceilings, repeated/non-advancing cursor rejection and cancellation. Recheck the bound tool definition after execution so a result from a replaced MCP generation cannot cross the seam. Tool errors are sanitized and conservatively classified; unsupported or malformed evidence fails closed.

## Availability and deployment

The MCP mount watches Settings and DSH `tools/change`. It snapshots Settings, binds exact live tool definitions and registers one tracker generation only while they remain current. Any missing tool, schema drift, invalid configuration or definition replacement withdraws the provider; active reads are cancelled and drained. A later conforming generation remounts normally. Do not keep an old REST provider or parallel compatibility mode available during this interval.

Programmatic root calls are incompatible with a DSH ToolRuntime configured globally as PTC-only: that mode admits only `run_code` at the root. Tracker deployments therefore require global `native` or `both` presentation until DSH supplies a distinct trusted Host-programmatic execution path. Never forge a PTC parent token to bypass this rule.

Configure the official MCP deployment itself with read-only, least-privilege access and only required repositories/projects. All required operations for one binding, including the GitHub timeline extension, must share one MCP namespace so outbound authentication has one owner. The namespace is snapshotted with the provider binding; secret values never enter run state.

## Normalized facts and policy

Use provider-qualified stable identities for bindings, issues, comments and readiness generations. Display keys, URLs, names and slugs are not global identities. An issue snapshot carries scope, summary, mapped priority, current labels, designated Brief comments, dependency completion evidence and readiness evidence.

Map priorities and completion states explicitly. Dependency results are `completed`, `not-completed` or `unknown`; missing access or an unrecognized terminal reason is never completion. Providers return immutable actor identity and ordered transition evidence sufficient for [human-readiness authorization](lifecycle.md#human-readiness-authorization). A current label, webhook sender or user-shaped MCP record cannot substitute for a trusted human transition. Missing, partial, contradictory or ambiguous evidence rejects admission.

Operation errors distinguish invalid configuration/response, unavailable capability or generation, timeout, transient failure and conflicts wherever DSH preserves evidence. Never expose raw MCP output, tool errors, credentials or live ticket content in diagnostics.

Snapshot provider binding identity and interpretation with every run and external intent. Reject an ordinary tracker/project/repository switch while unfinished runs or unresolved writes depend on it; rotation inside the same official MCP identity does not reassign the binding. After a provider or tool generation disappears, retain historical receipts and reconcile them through the original binding when it returns. Never reinterpret old receipts through a newly selected provider.

## Future providers and acceptance

Linear follows the same normalized tracker interface only after its official MCP deployment proves exact candidate, comment, dependency and immutable readiness-actor contracts. Do not add a GraphQL/token fallback. Bitbucket Cloud code-host support should use official Atlassian MCP under its Atlassian identity and a separate normalized code-host adapter; Atlassian's Bitbucket tools do not make Bitbucket Issues a supported tracker.

Shared conformance fixtures cover authenticated ingress, duplicate deliveries, complete pagination, stable identities, actor attribution, dependency direction and unknown access, malformed/oversized results, cancellation, tool replacement, Settings remount, redaction, disposal and restart recovery. Mock-tool tests prove the local seam; production support additionally requires an authorized live conformance run against the exact official server/tool generation. Record live evidence on the relevant GitHub issue, not in this specification.
