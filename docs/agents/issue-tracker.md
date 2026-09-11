# Development tracker: GitHub

Use GitHub Issues in `canhta/dsh-autopilot` through `gh` for this repository's development work. Autopilot's runtime Jira/Linear providers are unrelated to this choice.

## Authority

Tasks, priorities, assignments, blocking dependencies, unresolved choices and implementation progress live only on GitHub. Task-specific scope and acceptance criteria belong in the issue body; progress, review findings and verification evidence belong in issue/PR comments. Link stable design requirements in docs instead of copying them into each update. Do not maintain task mirrors, progress checklists or open-decision registers in repository Markdown.

## Operations

Resolve the repository from the remote and use `--repo canhta/dsh-autopilot` when working elsewhere. Read the issue body, labels, comments and blocking dependencies before starting. Use `gh issue view`, `gh issue list`, `gh issue create`, `gh issue edit` and `gh issue comment` for the corresponding operations. Update or link existing issues rather than create duplicates. Close only when completion evidence meets the issue's criteria.

Use native sub-issues for decomposition and native issue dependencies for blocking relationships when supported. Preserve the same facts in issue-body links if a GitHub feature is unavailable; never fall back to a local status mirror. Tracker configuration does not grant blanket authority to create, close or publish work outside the user's requested scope.

## Skill requests

“Publish to the issue tracker” means create/update a GitHub issue within the authorized task. “Fetch the relevant ticket” means read the GitHub issue and its comments. Task specs belong in issue bodies; stable product/interface specifications belong in `docs/specs/` and are linked from issues.

## Pull requests as a triage surface

PRs as a request surface: no.
