# Documentation map

Read [scope](specs/scope.md) for product responsibilities and [CONTEXT](../CONTEXT.md) for terminology. New contributors should start with [Contributing](CONTRIBUTING.md).

## Where information belongs

| Information | Authoritative location |
| --- | --- |
| Agent operating rules | [AGENTS.md](../AGENTS.md); `CLAUDE.md` links to the same source |
| Implementation and verification standards | [Engineering](engineering.md) |
| Domain terms | [CONTEXT.md](../CONTEXT.md) |
| Stable product and integration behavior | `specs/` |
| Accepted architectural decisions | `adr/` |
| Tasks, dependencies, progress and verification evidence | [GitHub Issues](https://github.com/canhta/dsh-autopilot/issues) |

Specifications define required behavior and acceptance rules; they do not claim that a capability has passed its external acceptance gates. Record implementation status and test evidence on the relevant GitHub issue.

## Read by task

| Working on | Read |
| --- | --- |
| Product boundaries | [Scope](specs/scope.md) |
| Host, Client, lifecycle, persistence or tests | [Engineering](engineering.md) |
| Admission, human authorization, pause and recovery | [Lifecycle](specs/lifecycle.md) |
| Provider composition and extension | [Providers](specs/providers.md) |
| DSH execution, repository rules and delegation | [Execution](specs/execution.md) |
| Cordis lifecycle, packaging and Host/Client integration | [Plugin design](specs/plugin.md) |
| Tracker projections, PR handoff and delivery | [Integrations](specs/integrations.md) |
| Configuration, scheduling, budget, persistence and cleanup | [Operations](specs/operations.md) |
| VPS supervision, backup or restore | [Deployment](deployment.md) |
| UI navigation, visual design and journeys | [Web UX](specs/web-ui.md) |
| UI data, commands and states | [Components](specs/ui-components.md) |

Repository-development conventions apply here only; they are not imposed on repositories that Autopilot operates on.
