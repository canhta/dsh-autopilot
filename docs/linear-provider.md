# Linear tracker provider

**Status:** planned provider; source research checked 2026-09-11, not a working integration. Shared admission, Agent Brief, reporting and delivery rules remain in [lifecycle](lifecycle.md) and [integrations](integrations.md). This document owns Linear-specific mappings and verification gaps.

## Identity and configuration

Persist provider-instance/organization identity plus the issue UUID; retain the human-readable identifier and URL only for display. Configure the project UUID and participating team IDs, not names. Linear exposes model UUIDs through its API/UI; issue queries also accept shorthand identifiers. [GraphQL guide](https://linear.app/developers/graphql).

A Linear project can span teams; issue workflow states are team-specific. One configured project therefore requires explicit mappings for every admitted team, not an assumption that a project has one workflow. Validate ready/agent label IDs, dependency-completed state IDs, review state IDs, priority ordering and access before enabling dispatch. Unknown or inaccessible teams fail eligibility. Do not create workflows automatically. [Projects](https://linear.app/docs/projects), [issue status](https://linear.app/docs/configuring-workflows).

Resolve the designated Agent Brief from paginated issue comments and preserve its comment ID, revision metadata and digest. Use the shared comment convention, not the issue description as a silent fallback. The official SDK supports comment creation and issue updates. Mutation success requires checking both GraphQL errors and returned mutation results. [SDK mutations](https://linear.app/developers/sdk-fetching-and-modifying-data), [GraphQL errors](https://linear.app/developers/graphql#error-handling).

## Dependencies and readiness evidence

Linear distinguishes blocking, blocked-by, related and duplicate relationships. Resolve incoming blockers, not every related issue. Its UI moves resolved blocking relationships under Related; test actual API relation direction and resolution behavior against the selected schema. Preserve observed dependency evidence; missing access is unknown, not completed. Canceled/duplicate must not implicitly mean successful completion. [Issue relations](https://linear.app/docs/issue-relations).

Webhooks expose an actor and previous updated-property values, but the exact label-transition payload must be verified before declaring readiness support. Persist the authenticated transition evidence before acknowledging it. [Webhook payloads](https://linear.app/developers/webhooks#webhook-payload).

**Critical limitation:** default API authentication attributes automated mutations to the authenticating user. Therefore `actor.type=user` does not prove a person clicked a label. Prefer Autopilot credentials using OAuth `actor=app`, and record all bot identities. Even that cannot distinguish another automation using a human's token. A trusted-human actor policy needs an explicit deployment assumption that those identities are not used for automation; surface that assumption. If required attribution cannot be established, fail closed and request a fresh attributable tracker transition; comments/current labels/timestamps cannot substitute. [Actor authorization](https://linear.app/developers/oauth-actor-authorization).

Do not promise complete reconstruction from issue activity: Linear documents that property edits during the first three minutes are treated as creation and omitted from that log. A historical-readiness recovery path remains an integration gate. [Issue editing](https://linear.app/developers/graphql#creating-editing-issues).

## Transport and credentials

Use Host-held credential references. OAuth supports app actors and token refresh; select one supported authentication mode and test renewal/revocation. Read/write scope is needed for labels/status; comment-only permissions are insufficient. Avoid requesting admin merely for normal execution; an administrator can provision the webhook separately. [OAuth](https://linear.app/developers/oauth-2-0-authentication).

Linear webhook subscriptions are organization/team scoped, so enforce the configured project locally. Verify raw-body HMAC-SHA256 and the signed-body timestamp, with length-safe constant-time comparison. Require public HTTPS ingress separately from operator-browser access. Persist ingress, then return HTTP 200 within five seconds; Linear documents three retries after one minute, one hour and six hours, and possible disabling. Deduplicate `Linear-Delivery`; maintain reconciliation because delivery is finite. Unknown actor, stale or reordered events cannot authorize resume. [Webhooks](https://linear.app/developers/webhooks).

Paginate candidates/comments/dependencies to completion using cursors; filter queries and bound nesting. Handle partial GraphQL errors and `RATELIMITED` responses, including HTTP 400; use returned reset/remaining headers rather than hardcoded quotas. [Pagination](https://linear.app/developers/pagination), [filtering](https://linear.app/developers/filtering), [rate limits](https://linear.app/developers/rate-limiting).

## Required integration evidence

- Project/team movement or renamed identifiers does not duplicate a run; out-of-scope issues never dispatch.
- Brief beyond page one is found; ambiguous/edited/deleted briefs follow shared policy.
- Incoming/outgoing blockers, resolved/canceled/duplicate dependencies and inaccessible dependencies normalize correctly.
- Human UI versus app/PAT mutations, null actor, remove/re-add ready label, lost/reordered events and missed downtime transitions prove attribution limits; no inferred approval.
- Valid/replayed/tampered/malformed signatures and delayed retries exercise ingress deduplication and reconciliation.
- Label/status writes preserve unrelated fields; lost comment acknowledgements reconcile markers without duplicate reports.
- Rate limits, partial errors, pagination, revoked access and token renewal stop or retry safely without rerunning coding.

Record schema/SDK versions and sanitized fixtures. Documentation evidence alone does not close these gates.
