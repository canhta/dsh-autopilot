# Bitbucket provider

Source research checked 2026-09-11. These observations do not establish a working integration. Shared publication authorization, recovery and completion remain in [integrations](../specs/integrations.md); official connector ownership lives in [tracker MCP evidence](tracker-mcp.md).

## Selected transport and scope

Use the official Atlassian Rovo MCP server as the Bitbucket Cloud code-host transport. Do not add an Autopilot REST client or another token/OAuth flow. Atlassian's v2 catalog exposes repository metadata, files, branches, commits, pull requests, comments, tasks, pipelines, deployments and merge operations. Configure the flat `?tools=all` surface and bind exact tool names through DSH; hosted output/error schemas must pass conformance before support is claimed. [Atlassian supported tools](https://support.atlassian.com/atlassian-ai-gateway/docs/supported-tools/), [Atlassian authentication](https://support.atlassian.com/atlassian-ai-gateway/docs/authentication-and-authorization/).

The current catalog has no Bitbucket Issues tracker tools and no webhook verifier. Bitbucket is therefore a future code-host provider, not a tracker substitute. Data Center also needs separate official-server evidence and is outside the initial Cloud target.

## Required normalized behavior

Persist workspace UUID, repository UUID, current locator and approved clone URL. Names are display/routing values, not durable ownership. Local Git push stays a separate controlled operation; MCP reconciles and creates the PR using the persisted repository, base, head, source commit and run marker.

Normalize PR state to `open`, `merged`, `closed-unmerged` or `unknown`. After a timeout, cancellation or lost response, search by the complete persisted identity before retrying. Multiple matches, a changed source commit or an inaccessible result is a conflict; it never authorizes another blind create. Keep all continuations and results bounded and reject malformed, repeated or incomplete traversal.

## Provider conformance gate

- Rename preserves repository identity; a same-name replacement is rejected.
- Push failure prevents PR creation; base/head/source mismatch prevents completion.
- Lost create response resolves exactly one marked PR without another write.
- Pagination finds open and terminal candidates beyond the first page.
- Declined, unknown and inaccessible PRs never qualify as merged cleanup.
- Official MCP auth owns credentials and renewal; Autopilot logs/results remain redacted.
- Tool-generation replacement, timeout, cancellation and reconnect quiesce without duplicate publication.

Record the exact Atlassian tool schemas and authorized Cloud evidence before claiming support. No REST fallback is maintained.
