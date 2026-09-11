# Jira and GitHub connection ownership

Checked 2026-09-11 against first-party provider documentation and local DeepSeek Harness source at `c291e7961a515f6d7af9304e7fd1d257929aef26`. This note records connection boundaries; exact tracker tool contracts and versions live in [official MCP transport evidence](tracker-mcp.md).

## Decision

Jira and GitHub outbound authentication belongs to their official MCP servers. Autopilot configures only the MCP namespace and stable project/repository policy fields; it does not collect an API token/PAT, register a second OAuth flow, or keep a fallback REST client. DSH's MCP client owns connection lifecycle and publishes exact `mcp__<server>__<tool>` names. Provider adapters bind those names, validate results and remain unavailable when the required generation is absent.

The operator connects the official server using its supported OAuth, app or service-token path. Connection status and renewal should eventually reuse the MCP server/client's authorization UX. If DSH cannot project that flow into Web Settings, add a narrow upstream MCP connection UI seam rather than duplicating provider authorization inside Autopilot.

## Least privilege and separate ingress

- The GitHub tracker connection needs repository Issues reads and the feature-gated issue-dependency tool. Code-host publication uses the official GitHub MCP write surface under a separately reviewed least-privilege binding.
- The Atlassian connection exposes the exact Jira or Bitbucket tools needed by the selected provider. Use the flat `?tools=all` catalog for deterministic Host invocation; do not ask a model to discover operations during reconciliation.
- Webhook setup remains an operator/admin action. Autopilot stores only the webhook secret reference needed to verify exact inbound bytes. This secret is not an outbound provider credential and never enters MCP calls.

Jira secure webhooks use HMAC-SHA256 in `X-Hub-Signature` and retry-stable `X-Atlassian-Webhook-Identifier`. GitHub uses `X-Hub-Signature-256` and `X-GitHub-Delivery`. These raw-body checks cannot be delegated to a polling MCP server. [Jira webhooks](https://developer.atlassian.com/cloud/jira/software/webhooks/), [GitHub webhook validation](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries).

## Operational gate

Use loopback/SSH-tunneled DSH administration until the selected DSH deployment supplies authenticated TLS. Never expose outbound credentials through Autopilot settings, logs or run records. Before a provider is called supported, verify its official MCP authentication, renewal/revocation, exact schemas, permissions and reconnection behavior against authorized synthetic resources.
