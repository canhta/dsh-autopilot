# GitHub Issues tracker provider

Source research checked 2026-09-11 against GitHub.com and GitHub's official MCP server at `7d13a7ad6f2a17f351a6d77ce280c85ae1821f4d`. These observations do not establish live-supported deployment. Shared transport gates belong to [tracker MCP research](tracker-mcp.md); admission and human-readiness rules belong to [lifecycle](../specs/lifecycle.md). GitHub Enterprise Server is not covered.

## MCP deployment and identity

GitHub's official MCP server owns all outbound authentication, token refresh and GitHub transport. It supports remote OAuth/PAT configurations and a local server authenticated by PAT, OAuth or GitHub App; the App form can refresh installation tokens inside the server. Configure the MCP deployment read-only and limited to the selected repository/tool surface. Autopilot stores only `mcpServerName`, repository owner/name and stable numeric repository ID plus policy mappings; it does not accept an outbound PAT. [`Remote configuration`](https://github.com/github/github-mcp-server/blob/7d13a7ad6f2a17f351a6d77ce280c85ae1821f4d/docs/remote-server.md), [`GitHub App authentication`](https://github.com/github/github-mcp-server/blob/7d13a7ad6f2a17f351a6d77ce280c85ae1821f4d/docs/github-app-auth.md).

All required tools must be registered under one DSH `mcp__<serverName>__...` namespace. This makes one MCP client row and deployment the sole outbound authentication owner. The required surface is:

- official `get_me` to bind the authenticated numeric actor ID;
- official `list_issues` for ready candidates;
- official `issue_read` with both `get` and `get_comments` methods;
- official `issue_dependency_read` with `get_blocked_by`, with the `issue_dependencies` feature enabled;
- extension `autopilot_read_issue_timeline` in that same namespace.

Before every candidate traversal, `get_me` must match the configured integration actor ID. Missing, mismatched or schema-incompatible tools make the provider unavailable. The timeline extension cannot be replaced by a direct REST call or another PAT-bearing Autopilot module.

## Candidate and comment evidence

Call `list_issues` with the configured owner, repository, open state and ready label, ordered by creation ascending. Request only number, title, state, labels and creation time; use the repository binding plus issue number as the provider-qualified identity. Drain `pageInfo.endCursor`, reject missing/repeated continuation and retain cumulative page/item bounds in an authenticated generation-local cursor. [`list_issues` source](https://github.com/github/github-mcp-server/blob/7d13a7ad6f2a17f351a6d77ce280c85ae1821f4d/pkg/github/issues.go#L3327).

Call `issue_read(get_comments)` with explicit page and per-page. The official result preserves numeric comment and user IDs, raw body and update time, but does not provide a next-page marker; continue until a short page and fail when the local page/item ceiling is reached. Select the versioned Agent Brief deterministically after the complete traversal. [`issue_read` comments](https://github.com/github/github-mcp-server/blob/7d13a7ad6f2a17f351a6d77ce280c85ae1821f4d/pkg/github/issues.go#L792), [`minimal comment/user output`](https://github.com/github/github-mcp-server/blob/7d13a7ad6f2a17f351a6d77ce280c85ae1821f4d/pkg/github/minimal_types.go#L562).

Map priority through configured labels with a deterministic default. Current labels are eligibility facts, not transition authorization. MCP results may place JSON in `structuredContent` or one text block; either form must fit the configured byte bound and exact provider schema before normalization.

## Dependencies

Use `issue_dependency_read` with `method: get_blocked_by`; the inverse blocking relation and task-list/cross-reference events are not substitutes. This official tool is gated by the `issue_dependencies` feature and returns page information that must be drained under local bounds. [`Dependency tool`](https://github.com/github/github-mcp-server/blob/7d13a7ad6f2a17f351a6d77ce280c85ae1821f4d/pkg/github/issue_dependencies.go#L20), [`feature flag`](https://github.com/github/github-mcp-server/blob/7d13a7ad6f2a17f351a6d77ce280c85ae1821f4d/pkg/github/feature_flags.go#L27).

An open blocker is `not-completed`. For a closed blocker, call `issue_read(get)` through the same MCP identity and map only configured completion state reasons to `completed`; an absent/unrecognized reason is `unknown`. Cross-repository dependencies are valid only when that same MCP identity can read the referenced repository. Missing or malformed evidence never means no blocker.

## Human readiness timeline extension

The inspected official MCP inventory contains no general issue timeline/event reader, while the authorization policy requires the actor who added the ready label. The required `autopilot_read_issue_timeline` extension projects only the missing read capability through the same MCP deployment and authentication identity.

Its fixed input is owner, repository, issue number, page and per-page. Its bounded output contains labeled/unlabeled events with stable event ID, timestamp, label name, nullable actor ID/type, nullable GitHub App attribution and numeric repository ID, plus `hasNextPage` and an advancing next page. The repository ID must match the configured binding. This shape follows GitHub's documented labeled/unlabeled timeline events. [`Timeline endpoint and permissions`](https://docs.github.com/en/rest/issues/timeline#list-timeline-events-for-an-issue), [`event shapes`](https://docs.github.com/en/rest/using-the-rest-api/issue-event-types#labeled).

Sort by occurrence time and event ID, reject ambiguous same-time final transitions, and require the final ready-label event to agree with the current label snapshot. A non-null App, Bot actor, integration actor or configured automation actor is automation. A User becomes human only when its immutable numeric ID is in the disjoint trusted-human mapping. Null, unknown or otherwise untrusted attribution remains unknown and cannot admit work.

GitHub cannot generally distinguish a person's UI action from automation using that person's PAT. Trusted identities therefore require the deployment guarantee that their credentials are not used for automation. If that guarantee is unavailable, actor attribution is not technical proof of a manual action. [`PAT identity semantics`](https://docs.github.com/en/rest/authentication/authenticating-to-the-rest-api#authenticating-with-a-personal-access-token).

## Webhook authentication

Webhook ingress is the only GitHub credential retained by Autopilot. Require POST JSON, exactly one `X-Hub-Signature-256` and one `X-GitHub-Delivery`, compute HMAC-SHA-256 over the exact raw bytes, and compare equal-length values in constant time. Validate event/action and configured repository ID only after authentication. Return a provider-qualified delivery identity using GitHub's retry-stable delivery GUID. [`Webhook validation`](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries), [`delivery headers`](https://docs.github.com/en/webhooks/webhook-events-and-payloads#delivery-headers).

Subscribe only to required `issues`, `issue_comment` and `issue_dependencies` events. Persist admission before acknowledging; fetch current truth through MCP rather than trusting the event snapshot. Keep a local ingress byte bound below GitHub's upstream payload maximum and use startup/scheduled reconciliation for missed or rejected deliveries. [`Webhook best practices`](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks).

## Failure and live-conformance limits

DSH surfaces exact tool-generation loss, invalid arguments/output and configured tool timeout codes, but the official server often converts GitHub failures and rate-limit timing into prose. Autopilot must sanitize generic failures and classify them conservatively; it must not parse ticket content or secret-bearing prose into diagnostics. [`GitHub MCP error mapping`](https://github.com/github/github-mcp-server/blob/7d13a7ad6f2a17f351a6d77ce280c85ae1821f4d/pkg/errors/error.go#L161).

Mock tools prove local exact-name binding, schemas, cursor/bounds, cancellation, redaction and mid-call generation fencing. An authorized live gate must additionally prove official server result shapes, `issue_dependencies` enablement, same-identity timeline extension, cross-repository visibility, human/automation attribution and reconnect/credential rotation. Documentation evidence alone does not close these gates.
