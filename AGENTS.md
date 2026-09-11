# Engineering instructions

Read the relevant GitHub issue and [documentation map](docs/README.md) before work. Keep this plugin repository's rules separate from those of repositories Autopilot modifies. `CLAUDE.md` links to this file; edit this source only.

## Implementation discipline

- Build only what the current requirement needs. Search the codebase first and reuse an existing implementation.
- Autopilot is a DSH plugin. Before implementing a capability, inspect supported DSH services, plugins, presets and extension points; reuse or compose them. Implement only missing Autopilot behavior, not a replacement agent loop, Session store, credential system or Web shell. Verify suitability against current source/docs; surface a missing extension instead of silently rebuilding the harness.
- Before adding code, check in order: standard library, native platform capability, then installed dependencies. Use the first suitable maintained option; write only the missing behavior.
- Prefer the smallest readable implementation. Keep a one-line solution when it is clear; do not compress code at the cost of comprehension or add speculative abstractions.
- Let names, types and structure explain the code. Add brief comments only for non-obvious intent, constraints or failure behavior; do not narrate the code or repeat it in JSDoc. Preserve documentation required by an actual public interface or toolchain.
- Deliver production-ready behavior: validate external inputs, propagate actionable failures, own resource cleanup, protect secrets and verify relevant behavior. Do not present stubs, happy-path demos or unverified integrations as finished features.
- Maintain one authoritative implementation. Update affected callers and tests together; do not add parallel versions, compatibility shims or legacy modes. If a real external compatibility obligation or durable-data migration conflicts with this rule, raise it on the GitHub issue before changing or discarding data.
- Fix a discovered bug in the current task when its cause is clear and the correction is small, safe and verifiable; include a regression test. For larger or independently scoped bugs, search for an existing GitHub issue, then create or update one with evidence, impact, reproduction and acceptance criteria. Link the current task and add a blocking dependency when necessary. Reporting a bug only in chat or leaving it untracked is insufficient; distinguish suspected from reproduced failures.

## Integration and documentation

Verify DSH interfaces against a recorded source version; conceptual spec interfaces are not existing APIs. Keep vendor logic in provider plugins and use the shared Host policy for Web commands. Read the relevant specs and source research through the documentation map.

Each rule has one documentation owner. Keep reusable behavior in specs and dated source observations in research; record work progress, open questions, review findings and test results on GitHub. Never commit credentials, live ticket content, runtime worktrees or execution transcripts. Report only verification actually performed.

## Agent skills

### Issue tracker

Development work and progress live in GitHub Issues for `canhta/dsh-autopilot`; see [tracker conventions](docs/agents/issue-tracker.md).

### Triage labels

Use the five configured triage roles; see [label mapping](docs/agents/triage-labels.md).

### Domain docs

Single-context: root `CONTEXT.md` and relevant accepted decisions in `docs/adr/`; see [domain reading rules](docs/agents/domain.md).
