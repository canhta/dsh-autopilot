# Web UI

## Placement and data

Add `Autopilot Operations` as a global DSH Web sidebar entry. The panel works without selecting a conversation. Settings are a separate DSH Settings contribution; link to them from Operations rather than building two configuration editors.

The default view is Queue & Runs, not a metrics dashboard. Use five local tabs: Queue & Runs, Schedule, Budget, Notifications, Worktrees. Keep provider and policy editing in DSH Settings. Do not add a second app-wide sidebar. [UI components](ui-components.md) owns the exact module/component responsibilities and query/command behavior.

The supported extension points and remote configuration restrictions are owned by [plugin engineering](plugin.md). Verify the selected access mode before claiming the Settings editor works through a VPS public URL. Its placement and its ability to persist settings are separate capabilities.

Data, command feedback and Settings behavior are defined in the [component specification](ui-components.md). This page owns navigation, visual rules, user journeys and visual acceptance.

## Navigation and reading order

Navigate from a run to its evidence and external records without losing list position. Present human blockers, operational pauses and delivery failures distinctly. Use the [component catalog](ui-components.md) for table content, filters and commands.

## Layout and visual direction

**Proposed visual specification:** a restrained operational tool integrated into DSH, with strong text hierarchy, aligned rows and generous space around decisions. The existing DSH theme and components are authoritative; numeric values below are fallback layout targets, not invented upstream token names. Validate against the actual shell before fixing CSS.

At wide desktop widths, selecting a run opens a nonmodal detail region beside the list and preserves list filters/scroll. Give the detail approximately 420–480 px only when the remaining list stays readable; otherwise use the full-width detail view with Back to runs. At narrow widths show ticket, state/reason and priority first; secondary columns move into details rather than squeezing unreadable cells. Use one overlay at a time; cleanup confirmation may replace an inspector overlay, not stack three dialogs.

```text
DSH shell / existing navigation
┌─────────────────────────────────────────────────────────────────┐
│ Autopilot Operations · project/provider    Running  [Pause]  ⋯   │
│ Conditional attention: one blocker / access issue → action       │
│ Queue & Runs | Schedule | Budget | Notifications | Worktrees      │
├───────────────────────────────────────┬─────────────────────────┤
│ Search · state · priority · attention │ Ticket · state · links  │
│ Ticket / state / phase / spend        │ Required action or PR   │
│ … run rows …                          │ Evidence / timeline     │
│ Page controls                         │ Secondary details       │
└───────────────────────────────────────┴─────────────────────────┘
```

| Visual rule | Implementation requirement |
| --- | --- |
| Surfaces | Inherit DSH page/panel/input surfaces and borders. No decorative gradients, glass blur, neon glow, hero banner or nested card around every field. |
| Type | Inherit DSH font; use a compact hierarchy around 20 px page title, 14 px body/table and 12 px metadata where host tokens permit. Monospace only for paths, branch/commit ids and diagnostics; tabular numerals for aligned numbers. |
| Spacing | Use the host spacing scale; fallback 4/8/12/16/24 px. Aim for 16–24 px panel padding and 44–48 px readable rows. Avoid both giant empty cards and dense multi-line badge clusters. |
| Color | One inherited accent for active navigation/primary action. Neutral queued/paused/completed labels; accent implementing; amber human attention; red failure/destructive action. Pair every color with readable text and an icon where useful. A completed run with failed delivery shows both facts. |
| Controls | One primary action per region. Label consequential actions; icon-only controls need accessible names and tooltips. No ornamental emoji or duplicate buttons scattered across cards. |
| Motion | Subtle host-standard transitions only; honor reduced motion. No pulsing whole rows, animated counters or auto-scrolling timelines. |
| Data | No synthetic productivity scores, token-saving claims, trend charts without data or fake progress. Use compact text/table for counts, next schedule and spend; visual meters require a meaningful denominator. |

Use sample content long enough to reveal layout failures: long issue titles, multi-line blockers, large numbers, long branch names and non-English labels. Truncate only previews with an accessible full-value path; never hide the blocking reason, money qualification or destructive target. Dynamic updates must not reorder the row currently focused without a deliberate refresh path.

## Primary interaction paths

1. **First setup:** show what is missing and a Configure action; do not render a fake successful overview. Settings guides provider/project selection, mappings, execution/budget and notifications through section validation, not a mandatory new account/onboarding product. Valid setup does not silently enable spending; scheduler activation is explicit.
2. **Normal operation:** enter Runs, identify current/waiting work, select a row, inspect evidence, open the external ticket/Session/PR. Closing detail restores list position.
3. **Human blocker:** attention filter → selected run → questions and Open in the configured tracker. A reply alone does not clear the banner. Display observed authorization/eligibility only after Host confirmation.
4. **Budget/schedule pause:** show the limiting condition and a link to its Settings section. Saving a limit is not proof of resumption; reflect queue/dispatch state from the Host.
5. **Cleanup:** Worktrees → inspect exact target → preview with reasons → confirm → show actual result. A changed run/Git state invalidates the preview.
6. **Provider change:** Settings explains dependent runs/intents and refuses an unsafe switch; do not offer a migration wizard or silently move history to another provider.

## Visual acceptance

Before accepting Client implementation, collect screenshots within the real DSH shell at 1440×900, 1024×768 and 390×844, in light and dark themes. Include populated runs + selected details, human blocker, budget pause, failed delivery, cleanup preview/rejection, provider Settings and empty/disconnected states. These are review deliverables for implementation, not evidence already produced.

Check legibility and consistent alignment without page-level horizontal overflow; all important actions work with keyboard, visible focus and appropriate dialog focus return. Verify normal text contrast of at least 4.5:1 and meaningful non-text control contrast of 3:1, plus status comprehension without color. Test reduced motion, zoom/reflow, long localized copy and screen-reader names/live feedback. Review screenshots against the visual table above; reject the change if it introduces an unrelated design system or obscures operational decisions.

Functional scenarios belong to [component acceptance](ui-components.md#component-acceptance). Public DSH reuse options and source citations belong to [DSH Web research](../research/dsh-web.md).
