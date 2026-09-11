# Official MCP servers as tracker and code-host transports

Source research checked 2026-09-11. GitHub MCP source was inspected at `7d13a7ad6f2a17f351a6d77ce280c85ae1821f4d`, Atlassian's public MCP repository at `9de1ab435251042efbb6839a1ca748eacecf4727`, and DSH at `c291e7961a515f6d7af9304e7fd1d257929aef26`. Hosted Atlassian and Linear server implementations are not published in those documentation repositories, so undocumented output and failure behavior remains unproved. This page records evidence; [provider architecture](../specs/providers.md) owns required behavior.

## Transport conclusion

The official server should own every outbound tracker connection and credential. Autopilot needs no GitHub/Jira REST transport, PAT, email/API-token exchange or MCP connection manager. It keeps exact typed tool contracts, bounded parsing and pagination, domain normalization and admission policy. Raw webhook authentication remains separate because the MCP servers do not receive Autopilot's inbound request bytes, signature headers or delivery ID.

GitHub's official tool inventory covers candidate, issue, comment and dependency reads but not the label-event timeline required for readiness attribution. The safe composition is one GitHub MCP deployment that exposes the official tools plus a narrow `autopilot_read_issue_timeline` extension under the same DSH MCP namespace and identity. If that extension is absent, GitHub admission is unsupported; a direct REST/PAT fallback would create a second authentication owner and is not equivalent.

Atlassian Rovo MCP v2 exposes Jira operations as flat tools when connected with `?tools=all`. That form is suitable for deterministic reconciliation: call exact operation names instead of using `discover` and an execute tier to choose work dynamically. Bitbucket Cloud tools are available through the same official Atlassian service, but behind a distinct normalized code-host adapter.

## DSH execution surface

The pinned `@deepseek-ai/dsh-mcp-client` connects stdio or Streamable HTTP servers, drains `tools/list`, registers deterministic `mcp__<serverName>__<rawName>` tools, reconnects with bounded backoff, forwards cancellation/timeouts to `tools/call`, and removes definitions with its Cordis lifetime. [`MCP client entry`](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/mcp/mcp-client/src/index.ts), [`tool synchronization`](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/mcp/mcp-client/src/tools.ts#L69), [`connection supervisor`](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/mcp/mcp-client/src/connection.ts#L108).

Autopilot can therefore invoke a fixed tool through `ctx.tools.execute()` without an LLM. The call traverses DSH visibility, policy, validation and cancellation. Binding the exact live `ToolDefinition` before and after a call prevents a result from a replaced MCP generation being accepted. [`ToolRuntime.execute`](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/core/tools/src/index.ts#L1304).

One DSH limitation is operationally important: a root `ctx.tools.execute()` call without an Agent uses the global presentation mode. In PTC-only mode, ToolRuntime permits only `run_code` at the root and rejects the MCP tool as `UNKNOWN_TOOL`; `native` and `both` do not apply that collapse. Tracker deployments must therefore use global `native` or `both` until DSH exposes a distinct trusted Host-programmatic execution path. Fabricating a PTC parent token would bypass an intentional invariant.

The bridge returns canonical MCP `content` and optional `structuredContent`. Most GitHub tools serialize JSON in one text block, and unsupported output-schema vocabulary becomes unconstrained JSON. An MCP `isError` is generally flattened into a failed DSH tool result. Autopilot must bound the serialized result, accept only the expected machine-readable shape, validate vendor schemas and sanitize failures. DSH currently cannot preserve every vendor authentication/rate-limit distinction; unknown failures must remain conservative rather than parsing prose. [`MCP result limitations`](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/mcp/mcp-client/README.md#known-limitations-and-deferred-work).

Configured MCP headers/environment are transport inputs materialized by DSH, not per-call Autopilot credentials. Rotation therefore belongs to the official server/DSH connection lifecycle. For example, the local official GitHub server can authenticate as a GitHub App and refresh installation tokens internally; Atlassian supports OAuth 2.1 and admin-enabled headless API tokens. [`GitHub App authentication`](https://github.com/github/github-mcp-server/blob/7d13a7ad6f2a17f351a6d77ce280c85ae1821f4d/docs/github-app-auth.md), [`Atlassian authentication`](https://support.atlassian.com/atlassian-ai-gateway/docs/authentication-and-authorization/).

## Required read contracts

| Provider | Exact operations | Evidence and limitations |
| --- | --- | --- |
| GitHub Issues | `get_me`; `list_issues`; `issue_read` with `get` and `get_comments`; `issue_dependency_read` with `get_blocked_by`; same-namespace `autopilot_read_issue_timeline` | `get_me` binds the authenticated numeric actor. `list_issues` has cursor `pageInfo`; comments use page/per-page; dependencies have page metadata and require the `issue_dependencies` feature. The extension must return ordered labeled/unlabeled events with actor and repository identity. |
| Jira Cloud | Primary `atlassianUserInfo`; flat `?tools=all` operations `searchJiraIssuesUsingJql`, `listJiraIssueComments`, `listJiraIssueChangelogs` | The identity call binds the authenticated account. Search supplies stable project ID, issue fields and links; comments and oldest-first changelogs paginate by start/max/total. Live conformance must prove exact identity output, immutable author account IDs and complete link direction. |

The caller supplies fixed arguments and drains every continuation under local page/item ceilings. A candidate cursor is generation-local, authenticated and carries cumulative traversal counts. Repeated, absent or non-advancing continuation evidence fails; a partial nested traversal never means no comments, dependencies or readiness events.

Successful results still need provider-owned schemas. GitHub's public minimal comment output preserves numeric comment/user IDs; its dependency tool is feature-gated rather than part of the default surface. [`GitHub issue tools`](https://github.com/github/github-mcp-server/blob/7d13a7ad6f2a17f351a6d77ce280c85ae1821f4d/pkg/github/issues.go#L792), [`minimal outputs`](https://github.com/github/github-mcp-server/blob/7d13a7ad6f2a17f351a6d77ce280c85ae1821f4d/pkg/github/minimal_types.go#L562), [`dependency tool`](https://github.com/github/github-mcp-server/blob/7d13a7ad6f2a17f351a6d77ce280c85ae1821f4d/pkg/github/issue_dependencies.go#L20), [`feature gate`](https://github.com/github/github-mcp-server/blob/7d13a7ad6f2a17f351a6d77ce280c85ae1821f4d/pkg/github/feature_flags.go#L27).

Atlassian v2 normally presents primary tools plus deferred operations through `discover` and execute tiers; `?tools=all` publishes a paginated flat list for gateways. Its packaged instructions warn that unrecognized parameters may be dropped, so presence by name is insufficient: startup must verify required input fields and runtime output must pass exact schemas. [`Atlassian supported tools and exposure modes`](https://support.atlassian.com/atlassian-ai-gateway/docs/supported-tools/), [`official calling convention`](https://github.com/atlassian/atlassian-mcp-server/blob/9de1ab435251042efbb6839a1ca748eacecf4727/skills/generate-status-report/SKILL.md#calling-non-primary-tools).

## Readiness and ingress gaps

The inspected GitHub server does not register a general timeline/issue-event reader. A current label, webhook sender or issue update time cannot prove which human created a readiness generation. The narrow extension needs only a paginated issue timeline projection: event ID, labeled/unlabeled action, occurrence time, label, actor ID/type, app attribution, repository ID and advancing page information. It remains inside the same MCP deployment; the operator does not configure another token in Autopilot. GitHub's REST event documentation is the source contract the extension must project. [`Timeline event shapes`](https://docs.github.com/en/rest/using-the-rest-api/issue-event-types#labeled).

Neither official server authenticates Autopilot's inbound webhooks. GitHub ingress still requires constant-time HMAC-SHA-256 over exact raw bytes and the retry-stable `X-GitHub-Delivery`; Jira ingress requires its configured provider verification mechanism and delivery identity. Only these inbound secrets belong to Autopilot Credentials. Accepted ingress triggers a current-state MCP reconciliation, and startup/scheduled reconciliation covers missed events. [`GitHub webhook validation`](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries), [`Jira webhooks`](https://developer.atlassian.com/cloud/jira/platform/webhooks/).

## Generation and conformance evidence

DSH emits `tools/change` as MCP definitions are swapped. A correct mount must snapshot Settings, resolve every exact tool definition, register the tracker only when all contracts conform, withdraw and drain the generation when any definition changes, then retry against the new complete set. Calls recheck definition identity after execution and discard stale results. This is availability fencing for one authoritative provider implementation.

Local mock-tool fixtures can prove exact naming, schema rejection, byte bounds, sanitized failure mapping, cancellation, Settings remount and mid-call definition replacement. They do not certify a hosted server. Live support additionally needs an authorized conformance run proving:

- stable binding/issue/comment/actor identities and complete pagination;
- authenticated MCP identity matching and stable Jira project identity across rename;
- GitHub dependency feature enablement and timeline-extension identity sharing;
- Jira changelog authors, label history, issue-link direction and inaccessible links;
- malformed/oversized output rejection and conservative errors;
- cancellation quiescence, reconnect, rotation and provider withdrawal.

## Future Linear and Bitbucket

Linear publishes an official hosted MCP server and read-only endpoint, but its public documentation does not pin the complete tool/result schemas, immutable readiness actors or dependency traversal needed here. A future Linear tracker adapter should bind exact official operations behind the same normalized interface only after live conformance. Do not compensate with a parallel GraphQL/API-key path. [`Linear MCP`](https://linear.app/docs/mcp).

Atlassian Rovo MCP v2 documents Bitbucket Cloud repositories, branches, commits, pull requests, comments, tasks, pipelines and merge operations. This supports a future code-host adapter using the existing Atlassian MCP identity after PR identity/disposition and ambiguous-write conformance. It exposes no Bitbucket Issues tracker or webhook verifier, so it does not establish a Bitbucket tracker provider. [`Bitbucket Cloud tools`](https://support.atlassian.com/atlassian-ai-gateway/docs/supported-tools/#Bitbucket-Cloud-tools).
