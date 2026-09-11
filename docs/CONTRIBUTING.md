# Contributing to dsh-autopilot

Start with a [GitHub issue](https://github.com/canhta/dsh-autopilot/issues). Documentation corrections can go straight to a focused PR; for implementation or design changes, agree on scope and acceptance criteria before substantial work. Questions and proposals also belong in Issues.

## Set up locally

Follow the [checkout instructions](../README.md#local-development). To submit changes without repository write access, fork the repository on GitHub and clone your fork instead. Create a branch for your contribution:

```sh
git switch -c docs/clarify-onboarding
```

Choose a branch name describing your own change. Plugin work requires [Node.js](https://nodejs.org/) 24 or newer and [pnpm](https://pnpm.io/). Install dependencies after cloning:

```sh
pnpm install
pnpm run hooks:install
```

No API credentials are needed for documentation or the bootstrap test suite.

## Find the right context

1. Read the issue body, comments and dependencies. [Tracker conventions](agents/issue-tracker.md) explain development labels and where work updates belong.
2. Read [AGENTS.md](../AGENTS.md) for repository-wide contribution rules. These apply to human and agent-authored changes.
3. Use the [documentation map](README.md) to select only the relevant specs and research. Read [engineering standards](engineering.md) when implementing or reviewing code.

Do not copy the entire documentation set into an issue or agent prompt. Link the authoritative sections and state the task's scope and acceptance criteria.

## Make and verify a change

For documentation, update the existing owner of a fact instead of adding a second explanation. Check relative links and anchors, verify commands against the actual repository, and distinguish required behavior from implemented behavior. When changing an upstream API claim, cite the source version and its limitations in the relevant research document.

Check whitespace errors before submitting:

```sh
git diff --check
```

This checks whitespace only, not links, technical accuracy or plugin behavior. Review the rendered Markdown and verify affected references separately.

For code, follow the engineering guide's [verification requirements](engineering.md#verification-by-changed-surface). Run the complete local bootstrap gate before submitting:

```sh
pnpm run check
```

Use `pnpm test -- tests/<name>.spec.ts` while iterating on one behavior. Package or export changes also require `mkdir -p .artifacts`, `pnpm pack --pack-destination .artifacts`, and `pnpm run verify:package`; the last command installs the tarball into a disposable DSH profile and verifies the effective bundle layer. Report exactly what ran; do not substitute upstream DSH tests for this plugin's integration evidence. Live-provider tests require explicitly authorized resources and spending.

Biome is the repository formatter and linter. Run `pnpm run format` to apply safe formatting and lint fixes. Lefthook runs Biome on staged JavaScript, TypeScript and JSON before commit, then runs the complete local gate before push.

## Submit a pull request

Push your branch to your fork and open a PR against `main`. Include:

- The related issue and the behavior or documentation changed.
- Verification performed, results and any untested conditions.
- UI evidence when the change affects an implemented interface.

Keep the PR focused. Put progress updates, review findings and test evidence in the issue or PR; keep committed docs about lasting behavior and usage. A documentation update alone is not evidence that a planned feature ships.
