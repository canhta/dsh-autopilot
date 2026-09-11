# Agent entry point

Read [docs/README.md](docs/README.md) and [docs/scope-and-ownership.md](docs/scope-and-ownership.md) before implementation. Follow the reading map for the work package you are implementing.

This repository builds the Autopilot plugin. The target repository is the separate repository an Autopilot execution modifies. Keep their instructions, tests, and configuration distinct.

Resolve required DSH capabilities against a recorded upstream version before coding against them. The documents describe required behavior; conceptual interfaces are not existing DSH APIs.

Read [provider architecture](docs/provider-architecture.md) before integration work. Jira/Linear and GitHub/Bitbucket belong in provider plugins; core lifecycle and UI must not depend on a vendor. Read [Web UI](docs/web-ui.md) and [UI components](docs/ui-components.md) before Client work; do not invent another dashboard or visual system.

Each requirement has one owning document. Change that document and link to it from related work; do not duplicate it in summaries or new plans. Keep unresolved decisions explicit in docs/README.md.

Report the behavior implemented, evidence collected, and remaining work. Keep the public README's implementation status accurate. Never commit credentials, live ticket data, execution transcripts, or runtime worktrees.
