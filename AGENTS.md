# Engineering instructions

Read the relevant GitHub issue and [documentation map](docs/README.md) before work. Keep this plugin repository's rules separate from those of repositories Autopilot modifies. `CLAUDE.md` links to this file; edit this source only.

## Implementation discipline

- Continue work on the checked-out branch and deliver commits there. Create or switch to a feature branch, and open a pull request, only when the user explicitly requests that action.
- Build the approved requirement; actively look for native capabilities that improve its reliability, usability or execution quality. Apply improvements within that behavior; propose material product changes on GitHub with evidence, benefit, cost and acceptance criteria. YAGNI limits speculative implementation, not discovery or proposals. Search the codebase first and reuse an existing implementation.
- Autopilot is a DSH plugin. Before implementing a capability, inspect supported DSH services, plugins, presets and extension points; reuse or compose them. Implement only missing Autopilot behavior, not a replacement agent loop, Session store, credential system or Web shell. Verify suitability against current source/docs; surface a missing extension instead of silently rebuilding the harness.
- Before adding code, check in order: standard library, native platform capability, then installed dependencies. Use the first suitable maintained option; write only the missing behavior.
- Prefer the smallest readable implementation. Keep a one-line solution when it is clear; do not compress code at the cost of comprehension or add speculative abstractions.
- Organize modules by responsibility and cohesion, not line-count targets. Keep a long file when it owns one clear role behind a deep interface; split when it mixes reasons to change, exposes internal detail, duplicates behavior or couples unrelated callers. Do not create mechanical fragments solely to satisfy a size threshold.
- Let names, types and structure explain the code. Add brief comments only for non-obvious intent, constraints or failure behavior; do not narrate the code or repeat it in JSDoc. Preserve documentation required by an actual public interface or toolchain.
- Deliver production-ready behavior: validate external inputs, propagate actionable failures, own resource cleanup, protect secrets and verify relevant behavior. Do not present stubs, happy-path demos or unverified integrations as finished features.
- Maintain one authoritative implementation. Update affected callers and tests together; do not add parallel versions, compatibility shims or legacy modes. If a real external compatibility obligation or durable-data migration conflicts with this rule, raise it on the GitHub issue before changing or discarding data.
- Fix a discovered bug in the current task when its cause is clear and the correction is small, safe and verifiable; include a regression test. For larger or independently scoped bugs, search for an existing GitHub issue, then create or update one with evidence, impact, reproduction and acceptance criteria. Link the current task and add a blocking dependency when necessary. Reporting a bug only in chat or leaving it untracked is insufficient; distinguish suspected from reproduced failures.
- Keep tests risk-based and high-signal. Update affected tests and add the smallest regression, boundary or integration case that proves a real behavior, security or lifecycle contract; each test must identify the failure it prevents. Remove superseded fixtures with their implementation, prefer shared conformance coverage over duplicate vendor cases, and keep suites bounded and fast. Coverage percentage alone does not justify a test.

## Integration and documentation

Verify DSH interfaces against the pinned dependency and current upstream source; conceptual spec interfaces are not existing APIs. Keep vendor logic in provider plugins and use the shared Host policy for Web commands. Read the relevant stable specs through the documentation map.

When implementing or reviewing Host services, Client UI, lifecycle, persistence, public APIs or tests, follow [plugin engineering standards](docs/engineering.md). They adapt DSH's practices to this external plugin; upstream monorepo conventions do not automatically become this repository's policy.

Each rule has one public documentation owner. Keep reusable behavior in specs; record work progress, open questions, review findings and test results on GitHub. Never commit credentials, live ticket content, runtime worktrees or execution transcripts. Report only verification actually performed.

Local upstream research lives in `docs/research/`. Agents may read and update it to verify DSH behavior, but it is intentionally excluded from Git and npm and public tracked documents must not link to it. Do not delete this directory merely because Git reports it as ignored. Before shipping a durable fact learned there, record the cited upstream version in the owning spec, ADR or GitHub issue so a clean checkout remains self-contained. If the local directory is absent, inspect the pinned dependency and current upstream source directly.

## Agent skills

### Issue tracker

Development work and progress live in GitHub Issues for `canhta/dsh-autopilot`; see [tracker conventions](docs/agents/issue-tracker.md).

### Triage labels

Use the five configured triage roles; see [label mapping](docs/agents/triage-labels.md).

### Domain docs

Single-context: root `CONTEXT.md` and relevant accepted decisions in `docs/adr/`; see [domain reading rules](docs/agents/domain.md).
