# Documentation map

Read [scope](specs/scope.md) for product responsibilities and [CONTEXT](../CONTEXT.md) for terminology. Then select the material relevant to the GitHub issue being worked on.

## Where information belongs

| Information | Authoritative location |
| --- | --- |
| Agent operating rules | [AGENTS.md](../AGENTS.md); CLAUDE.md links to the same source |
| Implementation and verification standards | [Engineering](engineering.md), adapted to this external plugin |
| Domain terms | [CONTEXT.md](../CONTEXT.md), glossary only |
| Stable behavior and proposed integration designs | `specs/`, using the reading map below |
| Pinned sources and their limitations | `research/`, not implementation status |
| Accepted architectural decisions | `adr/`, created only for actual decisions |
| Engineering-skill configuration | [Tracker](agents/issue-tracker.md), [labels](agents/triage-labels.md), [domain](agents/domain.md) |
| Tasks, dependencies, open decisions, progress and review/test evidence | [GitHub Issues](https://github.com/canhta/dsh-autopilot/issues) and related PRs |

Specs define required behavior and acceptance rules; a rule's existence does not mean it has been implemented or tested. Label replaceable design choices **Proposed implementation**; source observations are evidence, not owner mandates. Validation progress belongs on GitHub, not in this index or a local work checklist. Autopilot runtime run state belongs to the Host/DSH stores described in the specs, not to the development tracker.

## Read by task

| Working on | Read |
| --- | --- |
| Product boundaries | [Scope](specs/scope.md) |
| Implementing or reviewing Host, Client, lifecycle, persistence or tests | [Engineering standards](engineering.md), [upstream basis](research/dsh-practices.md) |
| Admission, human authorization, pause and recovery | [Lifecycle](specs/lifecycle.md) |
| Provider composition and extension | [Providers](specs/providers.md) |
| DSH execution outcomes, repo rules and delegation | [Execution](specs/execution.md) |
| Cordis lifecycle, packaging and Host/Client integration | [Plugin design](specs/plugin.md), [DSH evidence](research/dsh.md) |
| Tracker projections, PR handoff and delivery | [Integrations](specs/integrations.md) |
| Configuration, repair, scheduling, budget, persistence and cleanup | [Operations](specs/operations.md) |
| UI navigation, visual design and journeys | [Web UX](specs/web-ui.md) |
| UI component data, commands and states | [Components](specs/ui-components.md) |
| Selecting DSH capabilities before implementation | [Capability map](research/dsh.md#capability-reading-map) |
| Public Web components, Settings placement and Client imports | [Web reuse](research/dsh-web.md) |
| API, streaming, MCP, SDK and process integration | [Connectivity reuse](research/dsh-connectivity.md) |
| Presets, skills, execution, continuation and delegation | [Execution reuse](research/dsh-execution.md) |
| Settings, credentials, storage, timing, ingress and Git | [Host platform reuse](research/dsh-platform.md) |
| Linear-specific mappings and limitations | [Linear evidence](research/linear.md) |
| Bitbucket-specific mappings and limitations | [Bitbucket evidence](research/bitbucket.md) |

Engineering-skill configuration applies to work on this repository, not to Autopilot's runtime provider settings.
