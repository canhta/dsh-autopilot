# Implementation context

Build `dsh-autopilot` as an external DeepSeek Harness plugin. These documents are the implementation requirements, not end-user installation instructions. Read scope first, select a work package, then load its references.

## Reading map and authority

| When working on | Read | Owns |
| --- | --- | --- |
| Any implementation | [Scope and ownership](scope-and-ownership.md) | Product scope, system responsibilities, terminology |
| Provider selection, external extensions, shared integration types | [Provider architecture](provider-architecture.md) | Service Definitions, provider registration, capabilities, conformance |
| Linear-specific integration | [Linear provider](linear-provider.md) | Official-source findings and required provider tests |
| Bitbucket-specific integration | [Bitbucket provider](bitbucket-provider.md) | Official-source findings and required provider tests |
| Packaging, lifecycle wiring, configuration transport | [Plugin engineering](plugin-engineering.md) | Cordis conventions, distribution, source evidence and compatibility checks |
| Admission, transitions, retries, recovery | [Lifecycle](lifecycle.md) | Run state machine and completion semantics |
| Model execution, repo rules, Sessions, delegation | [DSH execution](dsh-execution.md) | Execution interface and compatibility evidence |
| Tracker, code host, outbound delivery | [Integrations](integrations.md) | External reads, writes, payloads, delivery recovery |
| Scheduler, storage, budget, worktrees, VPS | [Operations](operations.md) | Operational policy and configuration |
| Web panels and operator actions | [Web UI](web-ui.md) | Presentation and interaction behavior |
| Client module/component implementation | [UI components](ui-components.md) | Component responsibilities, data, commands and reuse |
| Selecting or handing off implementation work | [Work packages](work-packages.md) | Sequence, dependencies, completion evidence |

Each fact belongs in the owning document. Other documents may reference it or exercise it in a test scenario. Preserve external system ownership when resolving implementation details.

## Decision status

Unqualified requirements are product decisions. A paragraph marked **Proposed implementation** is replaceable with a simpler implementation satisfying the same behavior. A **Verification gate** requires source inspection and executable evidence before claiming the capability works.

The following choices remain open. Resolve the affected choice before its dependent work; continue independent work meanwhile. Record the resolution here and update its owning document.

| ID | Choice | Resolution method | Blocks |
| --- | --- | --- | --- |
| D1 | Supported DSH version and execution/pause/resume/usage interfaces | Implementation agent verifies a pinned release or commit and records evidence in dsh-execution.md | Live execution and exact deployment commands |
| D2 | Whether one tracker project maps to one target repo or several explicitly mapped repos | Owner choice; do not infer a repository from ticket prose | Final routing configuration and live dispatch |
| D3 | Provider edition, connection and authentication | Select Jira or Linear and GitHub or Bitbucket through configuration; initial Jira/Bitbucket research targets Cloud, with other editions requiring separate validation | Live provider connections |
| D4 | Who performs local commit and code host publication: dedicated Host code or a constrained DSH integration | Implementation agent proposes and records one owner, preserving plugin-controlled publication and repo conventions | Publication implementation |
| D5 | Budget units, limits, pricing source and metering coverage for the selected provider | Operator values plus D1 evidence; no monetary defaults are approved | Enabling metered live execution |
| D6 | VPS browser access and durable settings transport | Verify SSH-forwarded loopback or a compatible authenticated remote transport; standard non-loopback Settings is insufficient at the inspection baseline | Remote configuration and deployment acceptance |

Jira, Linear, GitHub and Bitbucket providers are required implementation scope, not deferred suggestions. Edition-specific claims still require evidence. One configured tracker project and one code-host binding remain the deployment scope.

Do not infer open decisions from the reference plugins. Community code is research input, not product authority.

## Source baseline

Initial local inspection used DeepSeek Harness commit `c291e7961a515f6d7af9304e7fd1d257929aef26`. This is an inspection baseline, not a supported-version promise. Read the corresponding source before selecting dependencies.

- [Official first-plugin guide](https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/): Cordis plugin lifecycle and configuration.
- [Pinned upstream source](https://github.com/deepseek-ai/deepseek-harness/tree/c291e7961a515f6d7af9304e7fd1d257929aef26): primary reference for implementation interfaces.
- [Community catalog](https://awesome-dsh-plugin.com/): discovery; individual references are attached to the relevant documents.

Public examples and tests use synthetic tracker issues, repository names, credentials, and notification destinations.
