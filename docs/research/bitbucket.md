# Bitbucket provider

## Status and scope

**Proposed initial target:** Bitbucket Cloud REST 2.0 at `https://api.bitbucket.org/2.0`; Bitbucket Data Center requires a separate adapter and validation. This file owns Cloud-specific behavior. Shared publication authorization, recovery and completion remain in [integrations](../specs/integrations.md); retention remains in [operations](../specs/operations.md).

## Repository identity and Git transport

Resolve the configured workspace/repository locator before publication. Persist workspace UUID, repository UUID, current slug/full name and approved clone URL. Names are locators/display values; durable ownership uses UUIDs. Revalidate identity after rename, transfer or credential changes. Use explicit workspace-scoped routes; do not depend on global repository discovery or legacy empty-workspace examples. [Repository API](https://developer.atlassian.com/cloud/bitbucket/rest/api-group-repositories/), [UUID semantics](https://developer.atlassian.com/cloud/bitbucket/rest/intro/#uri-uuid-and-structures), [cross-workspace API changes](https://community.developer.atlassian.com/t/bitbucket-cloud-announcing-end-of-life-for-cross-workspace-apis-timeline-next-steps-and-instructions-for-connect-apps/99972).

Publish commits through Git push; REST creates the PR referencing that branch. Configure Git and REST credentials independently when necessary. For HTTPS Git, API-token authentication supports the Bitbucket username or `x-bitbucket-api-token-auth`; supply the token through a credential helper, never persist it in the remote URL. [Token usage](https://support.atlassian.com/bitbucket-cloud/docs/using-api-tokens/).

## Authentication

**Implementation option:** scoped API tokens suit a simple VPS deployment; OAuth is another supported integration option. App passwords are obsolete setup guidance. REST API tokens support Basic authentication with Atlassian email/token and currently Bearer authentication; Git username rules differ. Keep token expiry/refresh behavior explicit for the chosen mode. [API tokens](https://support.atlassian.com/bitbucket-cloud/docs/api-tokens/), [authentication](https://support.atlassian.com/bitbucket-cloud/docs/using-api-tokens/).

For API tokens, provision `read:repository:bitbucket`, `write:repository:bitbucket`, `read:pullrequest:bitbucket` and `write:pullrequest:bitbucket` as required by the chosen transport. Write scopes do not automatically grant read or other resource scopes. Do not request repository administration or deletion. PR write permission also permits merge/decline; the adapter must expose only authorized operations. OAuth scope names differ and require their own mapping. [Permissions](https://support.atlassian.com/bitbucket-cloud/docs/api-token-permissions/).

## PR operations

| Operation | Cloud route beneath `/2.0` |
| --- | --- |
| Create | `POST /repositories/{workspace}/{repo_slug}/pullrequests` |
| Reconcile candidates | `GET /repositories/{workspace}/{repo_slug}/pullrequests` |
| Read known PR | `GET /repositories/{workspace}/{repo_slug}/pullrequests/{pull_request_id}` |

Creation explicitly supplies `title`, `description`, `source.branch.name`, `destination.branch.name`, and `draft: false`. Set `close_source_branch: false`; branch deletion is separate policy. Persist PR id, returned HTML URL, repository identities and source commit. Listing defaults to open PRs: recovery must explicitly include terminal states and paginate. Normalize `OPEN` to open, `MERGED` to merged, and `DECLINED` to closed-unmerged; unknown states stay unknown. [PR API](https://developer.atlassian.com/cloud/bitbucket/rest/api-group-pullrequests/).

The documented create operation supplies no idempotency-key contract. Autopilot must reconcile uncertain writes using its persisted run marker, source/destination identities and branch names. Branch-name equality alone is insufficient. Multiple matches, changed source commits or terminal conflicting candidates require explicit conflict handling. Do not blindly retry a timed-out POST. [Create reference](https://developer.atlassian.com/cloud/bitbucket/rest/api-group-pullrequests/#api-repositories-workspace-repo-slug-pullrequests-post).

For retention, `updated_on` is not inherently merge time. Establish a trustworthy merge timestamp from provider history, or conservatively start retention from the first persisted observation of merged state. If neither exists, retain the worktree.

## Pagination and failures

Follow opaque `next` URLs after validating the provider origin; do not require `size` or construct page numbers. [Pagination](https://developer.atlassian.com/cloud/bitbucket/rest/intro/#pagination).

Bound retries for throttling/transient errors, honoring retry guidance when supplied. Do not assume one fixed quota or universal rate headers: documented scaled headers depend on authentication/resource eligibility; `X-RateLimit-Limit` means allowance, not remaining requests. Authentication/access failures remain visible. [Limits](https://support.atlassian.com/bitbucket-cloud/docs/api-request-limits/).

## Provider conformance tests

- Rename preserves repository identity; same-name replacement rejects publication.
- Push failure prevents PR creation; source mismatch prevents completion.
- Lost create response resolves one matching receipt without another POST.
- Pagination finds terminal candidates beyond the first page.
- Declined, unknown and inaccessible PRs never qualify as merged cleanup.
- Git and REST authentication use correct identities and redact secrets.
- Throttling preserves publication intent; restart resumes reconciliation.

Evidence here is documentation research only. Implementation must add adapter fixtures and an authorized Cloud smoke before claiming support.
