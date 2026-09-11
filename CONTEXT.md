# Autopilot language

Vocabulary for coordinating tracker-approved development through DSH.

## Work and systems


**Plugin repository**: The codebase that develops Autopilot itself.

**Target repository**: The codebase modified by an Autopilot execution. Avoid using “repo” when either repository could be meant.

**Project scope**: The one configured tracker project from which Autopilot admits work; team/workspace context depends on the tracker.

**Tracker provider**: An integration that supplies issue context and applies execution reports to the issue system.

**Code-host provider**: An integration that publishes pull requests and resolves their disposition.

**Provider binding**: A selected provider implementation and configured connection identity, excluding secret values.

**Agent Brief**: The designated tracker comment defining approved scope, constraints and acceptance criteria.

## Execution


**Run**: One admitted ticket execution, including its continuation history. Avoid “task” when referring specifically to this execution record rather than the tracker issue.

**Attempt**: An execution interval within a run; resumption is not a new run.

**Session**: DSH-owned execution history associated with a run.

**Checkpoint**: Continuation information recorded after execution becomes quiescent, not a frozen operating-system process.

**Managed worktree**: The Git working directory allocated to an Autopilot run.

**Human blocker**: A question or condition requiring a human tracker decision before work continues.

**Operational pause**: A resumable stop caused by scheduling, operator hold or spending policy; distinct from a human blocker.

**Completed run**: A run whose PR publication has been confirmed; delivery and PR review may still be pending.
