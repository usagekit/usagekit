# UI layers

All seven packages, including `@usagekit/react`, `@usagekit/views` and
`@usagekit/store-postgres`, are published at 0.8.0, which adds
`ProviderRate.fallback` to the views package for the dollar rate editor. `useProviderEditor`
arrived in the 0.7.0 React package. The 0.9.0 source cohort adds its draft rebase and
read-refresh signals for the host composition APIs below and awaits publication. The registry
remains private build tooling whose blocks are distributed as public copyable JSON.
Verify exact npm versions before installing a cohort; use reviewed tarballs for unreleased
candidates. See [consuming packages](CONSUMING.md) for both workflows.

| Layer                  | Package or path                                      | Depends on                         | Runs in                   |
| ---------------------- | ---------------------------------------------------- | ---------------------------------- | ------------------------- |
| Headless views         | `@usagekit/views`                                    | core                               | Servers and browsers      |
| Hooks and shared cache | `@usagekit/react`                                    | views, React 19                    | A React tree with a Meter |
| Copyable blocks        | `packages/registry`                                  | hooks, the host's `ui/` primitives | The host's React tree     |
| Pages                  | Host code; `packages/server/ui` for the local server | Selected blocks                    | The host                  |

Authentication, verified access, routes, budget persistence and customer credit balances
belong to the host. A backend-only consumer does not need any UI layer.

## Headless views

Every loader takes a Meter, verified `AccessContext` and input. Use these on the server
without React, or render the returned models with your own design system.

| Loader                   | Input                                                    | Returns              |
| ------------------------ | -------------------------------------------------------- | -------------------- |
| `loadUsageView`          | `UsageQuery`                                             | `UsageView`          |
| `loadUsageSummary`       | usage query without cursor/grouping; optional `maxPages` | `UsageSummaryView`   |
| `loadBudgetsView`        | scope, surface, units, pools, source, crossings          | `BudgetsView`        |
| `loadDefinedBudgetsView` | `DefinedBudgetsQuery`                                    | `DefinedBudgetsView` |
| `loadHeaderStatus`       | same as applicable budgets                               | `HeaderStatus`       |
| `loadCoverageView`       | scope, from, to, optional coverage source                | `CoverageView`       |
| `loadExceptionsView`     | scope, from, to, limit, cursor                           | `ExceptionsView`     |

```ts
import { loadUsageSummary, loadDefinedBudgetsView } from "@usagekit/views";

const summary = await loadUsageSummary(meter, verifiedAccess, {
  scope: verifiedScope,
  from: "2026-10-01T00:00:00.000Z",
  to: "2026-11-01T00:00:00.000Z",
  units: ["requests", "tokens", "customer_cents"],
});
const definitions = await loadDefinedBudgetsView(meter, verifiedAccess, {
  scope: verifiedScope,
});
```

Amounts contain exact `text`, `unit` and `certainty`; never convert the text to a number.
Money uses cents with four fractional digits. Measured zero, estimated values, unknown
measurements and unavailable figures have separate presentations. Unknown has empty text;
unavailable is not zero. A forbidden or failed read must not display stale figures.

Summary loading follows bounded pagination with one watermark and observation time.
`complete: false` makes totals unavailable rather than presenting a partial sum as complete.
`rowCount` counts aggregate rows, not operations. Provider `cost` and funding/cost-owner
breakdowns stay separate from the optional `customer_cents` measurement; this UI does not
calculate customer charges or wallet balances.

Budget status shows used and reserved amounts separately. A block budget is exceeded at
its limit; an allow budget warns at its soft limit and is exceeded at its hard limit.
Alert crossings and the default 80 percent warning are shown without changing admission.
Redacted shared budgets remain visible without amounts. Exceptions expose expired
reservations, expired leases and pending work with age at the page's `asOf`.

## React hooks and shared reads

Wrap related panels in one `MeterProvider`. The default per-provider cache shares equal
reads, has a 30 second stale time and retains at most 128 inactive entries. A host can supply
one stable `createMeterQueryClient({ staleTimeMs, maxEntries })` instance explicitly.
Keys include Meter identity, verified access, loader and query. Changing scope, account or
Meter immediately isolates the rendered state; old requests cannot fill the new binding.

Hooks return `data`, `state`, `error`, `refresh()` and `refreshing`. Initial loading differs
from an unavailable or forbidden read. Refreshing can retain valid data within the same
binding. Use `queryClient.invalidate(meter, verifiedAccess)` after external accounting
changes; successful budget mutations invalidate that binding automatically.

```tsx
import { useMemo } from "react";
import { MeterProvider, createMeterQueryClient } from "@usagekit/react";
import type { BudgetWriter } from "@usagekit/react";
import { saveAuthorizedBudget, reconcileAuthorizedBudget } from "./budget-api";

function UsagePage({ meter, verifiedAccess, children }) {
  const queryClient = useMemo(() => createMeterQueryClient(), []);
  const budgetWriter = useMemo<BudgetWriter>(
    () => ({ save: saveAuthorizedBudget, reconcile: reconcileAuthorizedBudget }),
    [],
  );
  return (
    <MeterProvider
      meter={meter}
      access={verifiedAccess}
      queryClient={queryClient}
      budgetWriter={budgetWriter}
    >
      {children}
    </MeterProvider>
  );
}
```

Keep the writer stable across renders. Read access is still enforced by the Meter and the
host transport; a browser-supplied scope or `canManageBudgets` is not server authorization.
A remote Meter may use a read-only `createUsageHandlers({ commands: false })` mount.
The budget writer is a separate host adapter, not a new Meter write endpoint.

## Budget editing

`useBudgetEditor` and `BudgetEditor` accept an existing Budget, or a host-authored
`BudgetTemplate` containing id, version, scope, surface, unit and window. Version zero is a
create template; a save builds version one. Editing builds the next version. The draft
contains exact decimal strings for limit, optional hard limit and alert quantities. It
cannot change the trusted scope, unit, id or window.

Editing is disabled by default. Both a writer and `canManageBudgets` are required to enable
it. The host writer must independently authorize the caller, validate the allowed template
and perform version compare-and-swap in its own persistence transaction.

The writer returns `saved`, `conflict`, `invalid`, `forbidden` or `unavailable`. A conflict
keeps the draft; the manager offers an explicit reload of the latest version before a new
edit. Invalid input shows the field and reason without calling the writer. Choosing Block
or No limit clears an incompatible hard limit. Percent alerts remain visible so an
unlimited budget can remove them or choose quantity thresholds.

A pending or ambiguous save freezes the submitted values and disables duplicate writes,
reset and draft edits. An ambiguous result offers **Check save status**. The writer's
`reconcile` may confirm saved, conflict or explicitly not saved. Without it, a defined-budget
read can confirm the exact saved version or a conflict; an absent or older row cannot prove
that the write did not happen. Replacing a writer or remounting an editor does not clear an
unknown write. No automatic write retry, budget deletion or wallet mutation is supplied.

`BudgetManagerPanel` lists definitions and opens the selected editor. Creation choices come
only from the host's matching version-zero templates. Pass `budgetTitles`, template titles
and labels to provide application copy; all strings have English defaults.

## Copyable registry blocks

Both Radix/New York and Base UI/base-vega contain the same twenty-two blocks:

| Block                        | Purpose                                                          |
| ---------------------------- | ---------------------------------------------------------------- |
| `measurement-card`           | One exact figure with certainty                                  |
| `usage-summary-cards`        | Complete totals by measurement unit                              |
| `cost-summary-card`          | Provider cost and funding/cost-owner breakdown                   |
| `usage-table`                | Detail and cursor pagination                                     |
| `budget-card`                | Used and reserved figures, labelled limit, hard-limit and alerts |
| `budget-editor`              | View or edit one trusted definition/template                     |
| `budget-manager-panel`       | Browse, reload, edit and create from host templates              |
| `usage-overview-card`        | Host-authoritative budget figure, meter, metrics and connections |
| `usage-cap-pill`             | Compact header meter for known, partial, unknown and no-cap use  |
| `header-status`              | Compact applicable-budget status, including empty state          |
| `coverage-summary`           | Tracked and untracked coverage                                   |
| `exceptions-list`            | Work needing evidence or recovery                                |
| `usage-filters`              | Controlled period and scope choices                              |
| `connection-list`            | Funding, tags and plan per connection                            |
| `provider-card`              | Connection status, availability and explicit actions             |
| `provider-connect-form`      | Draft credentials, test, connect and reconnect                   |
| `provider-source-selector`   | Own-key or platform funding with explicit confirmation           |
| `provider-rate-editor`       | Exact dollar rates, provenance, fallback and editing             |
| `provider-chain-editor`      | Enable connections and edit fallback ordering                    |
| `provider-balance-card`      | Separate provider or host-wallet balance and freshness           |
| `provider-allocation-editor` | Funding-by-surface limits and availability suggestions           |
| `provider-manager-panel`     | Compose connection, rate, funding and allocation tools           |

Provider blocks use a separate host-owned `ProviderManagementPort`. They do not infer
provider credentials, connection ownership, prices or wallet balances from Meter reads.
Headless hooks provide connection, balance, quote and allocation reads plus explicit
administrative actions. See [provider UI](PROVIDER-UI.md) for the adapter contract,
concurrency, reconciliation and exact-limit semantics. The 0.7.0 React package adds
[`useProviderEditor`](PROVIDER-UI.md#provider-editors), which keeps a draft base separate from
current evidence and rebases only after an explicit successful reload. Hook-backed editor
panels enforce that lifecycle; hosts supplying props to pure leaves are responsible for their
validity. This API is absent from the published 0.6.0 React package.

Data-driven blocks expose pure components and hook-backed Panels where applicable.
Filters and connection lists take host data. Styling uses the host's semantic tokens;
there is no bundled stylesheet or second theme. Labels, accessible field names and titles
are overridable. Error, forbidden and empty states are distinct from loading.

```sh
npm run registry:build
npx shadcn add ./packages/registry/dist/r/radix/budget-manager-panel.json
npx shadcn add ./packages/registry/dist/r/base/usage-summary-cards.json
```

Each JSON artifact declares package dependencies, host primitives and all copied files.
The manager bundles its editor; summary cards bundle their measurement card. Files land in
`@/components/usagekit/` and import `@/components/ui/*`. Root `r/<name>.json` defaults to
Radix. The header status tooltip trigger and the filter selects have variant-specific files;
other block source is shared.
The shadcn CLI requests exact 0.9.0 UI package versions, which resolve anonymously from npm once
0.9.0 is published. The
[public examples](https://usagekit.dev/examples/) show every block in every shadcn style and
provide each block's install command. See [consuming packages](CONSUMING.md) for local tarball
validation of unreleased candidates.

To use another design system, copy every artifact file and replace the listed table, card,
badge, button, tooltip, select, input and label imports with equivalent host primitives.
Keep the view model semantics, exact text and accessible labels.

### Styles

The blocks follow every shadcn style: New York and Vega, Nova, Maia, Lyra, Mira, Luma, Sera and
Rhea for both Radix and Base UI. Host primitives already come in the host's style. Usagekit's own
elements (meters, statuses, pills, segmented choices, notices, panels, rows, tables and type
roles) carry `cn-usage-*` tokens instead of fixed classes, and
`packages/registry/styles/<style>.css` defines every token for one style in the format of
shadcn's style sheets: `.style-<style> { .cn-usage-track { @apply ...; } }`. Each value mirrors
the shadcn primitive with the same role in that style, such as the progress track for meters,
the badge for pills, tabs for segmented choices and the alert for notices. Where a style fills
chips, badges or fields (Maia, Mira, Luma and Rhea), quiet text on them uses
`text-foreground/70`, because the muted foreground falls below 4.5:1 contrast on those fills.

`npm run registry:build` bakes one sheet into the sources for each style and writes
`r/styles/<style>/<name>.json`, so installed code contains plain Tailwind classes and no
tokens. `r/radix` stays New York and `r/base` stays Base UI Vega. A host on any style points a
registry at the style placeholder, which the shadcn CLI fills from `components.json`:

```json
{ "registries": { "@usagekit": "https://usagekit.dev/r/styles/{style}/{name}.json" } }
```

```sh
npx shadcn add @usagekit/usage-overview-card
```

Tests require every sheet to define exactly the tokens the sources use, with semantic colors
and no motion, and every published file to match its source with that style's sheet baked in.
To add a style, add its sheet, list it in `styles/styles.mjs` and add its primitives under
`consumers/styles/<style>` for the showcase.

`consumers/styles/<style>` holds the eight primitives the blocks import, as
`shadcn add card button badge input label select table tooltip` writes them with shadcn 4.21 and
the lucide icon library, for every style beyond the two consumer hosts (`radix` is New York and
`base` is Base UI Vega). Only the `cn` import changes, to the host's `@/lib/utils`, and Prettier
formats the files. `consumers/styles/index.css` is their host stylesheet: the consumer theme with
`shadcn/tailwind.css` and the radius scale that `shadcn init` writes. The showcase loads every
folder at once and renders the current style's files, so its pickers switch in place.

## Meter and motion

Blocks share two helper files that are copied with the blocks that use them; neither adds a
dependency or a stylesheet.

`usage-meter.tsx` draws every usage reading with one vocabulary. A confirmed reading is a solid
fill in the level tone. A partial reading, a confirmed lower bound, adds a short hatched tail
after the fill. An unknown reading is an empty hatched track and never a zero fill. A reading
without a limit is a dashed baseline. A reading past its limit clamps at the end of the scale
and adds a notch beyond it. Meter budgets add a lighter reserved segment and labelled marks for
the limit, hard limit and alerts; a ring in the surface color cuts each mark into the fill, so a
crossed alert stays visible. A nonzero reading always leaves a visible trace. Levels use
`primary`, `chart-4` and `destructive`; the track takes the shape, height and color of the
style's progress track. `UsageMeter` takes a host
percent, while `UsageTrack` takes exact percent text from the view models. A host that knows
more than the percent, such as reserved usage or a crossed alert, passes `level`, and the meter
shows the more severe of that level and the level of the percent.

`usage-motion.tsx` holds the motion vocabulary. Meters settle from empty on first render and
glide to new readings; related meters are staggered. Changed figures, status words, feedback
and revealed fields rise in once from `@starting-style`. Disclosures unfold their height,
segmented choices slide their indicator, the fallback chain slides reordered items and a
spinner marks only the control doing the work. Nothing else loops. Transitions use the host's
`ease-out` token, so a host can supply its own curve. With `prefers-reduced-motion: reduce`,
every transition and animation is removed and content appears in its final state; a test
guards that every animated class has a reduced-motion counterpart.

Paging a usage table keeps the current page visible and marked busy until the next page
arrives, within the same query and binding only. Failed and forbidden reads never show
retained figures and discard the retained page, so a later reload starts from loading.

## Local showcases and coverage

After the root `npm ci`, prepare a complete local dashboard without downloads or publication:

```sh
node packages/registry/consumers/prepare.mjs
```

The command prints a Vite invocation for `http://127.0.0.1:5177`. One page shows every block
with one in-memory Meter, sample host adapters, light/dark controls and a view-only switch. Its
library and style pickers switch all seventeen styles in place, like the shadcn create preview:
every sheet loads under its `.style-<style>` class, the pickers swap that class on `<html>`, and
each host primitive, the pickers' own Select included, renders the exact file `shadcn add`
writes for the current style. The style, the state and the theme stay in the address. A state switcher shows the native usage card within
budget, near and over the limit, with partial or unknown data, without a budget or connections,
loading and after a failed read; it can replay the first render. Fixtures and generated copies
stay local; they make no provider calls. Use it for desktop/mobile review.

`loadCoverageView` accepts a `CoverageSource` for bigint counts of metered, passthrough,
unpriced, cached and rate-limited requests. Without it, the Meter's tracked requests are
shown and other counts remain unavailable. The Meter read authorizes the scope before the
coverage port runs. `createMemoryCoverageSource` is available for tests and demos.

The existing local server builds its Base UI page with `npm run build` and serves it at `/`.
Its bearer token is kept in memory; reloading asks for it again.

## Native accounting adapters

`UsageOverviewCard` and `UsageCapPill` also accept authorized observations from a host's
existing accounting system. They do not read the supplemental Meter or infer a provider
balance. The host supplies localized exact value strings, actions and routing; the blocks
own presentation and meter geometry. Unknown usage never renders a confirmed zero meter.
Partial positive amounts must be qualified as lower bounds by the host adapter.

The card's `budget` takes a complete `value`, announced by the meter, plus an optional short
`figure`, a `qualifier` such as "At least", a `caption` and `warningAt` for the warning mark.
Status words come from the level labels; a partial reading below the warning point reads
"Still measuring" rather than claiming to be within budget. `level` raises the status the same
way as on the meter, so a budget that reservations already exhaust reads as over the limit. `loading` keeps the layout with
placeholders instead of figures, and `emptyAction` adds an action to the empty state.
`size` sets the headline figure: `lg` (the default) leads a page, while `md` and `sm` suit
denser hosts.

`UsageConnectionRow` (in `usage-connection-row.tsx`, bundled with the card) is one connection:
a summary line with the tightest reading that unfolds labelled readings per funding source,
notes and a per-feature breakdown. A `notice` stays visible while the row is collapsed. An
unknown summary shows its label, never the host figure. `UsageCapPill` takes `size="sm"` for
compact header chips.

Both artifacts bundle `usage-progress.tsx`, a pure `usageProgress(percent, partial)`
projection with no React, DOM or styling imports. It can be used without the styled blocks.
It preserves complete zero, partial positive usage, unknown zero and over-limit status.
The existing headless Meter and provider hooks remain available from `@usagekit/react`.
Like every registry item, these blocks request exact 0.9.0 package versions. The provider
rate, allocation and manager blocks also need `useProviderEditor`, new in the 0.7.0 React
package, and the rate editor reads `ProviderRate.fallback`, new in the 0.8.0 views package.
The allocation editor and manager panel use its rebase and read-refresh signals, new in the
0.9.0 React package.

## Formatting and host composition

Registry values remain exact decimal strings in their accounting denominations. `formatFigure`
receives a known Figure (including text, unit and certainty), and `formatUnit` receives the
accounting unit. Unknown and unavailable figures keep their distinct localized labels and never pass
through a numeric formatter. `MeasurementCard` propagates these callbacks to `MeasurementValue`.
`UsageSummaryCards`, `CostSummaryCard` and their panels propagate them to every measurement child;
allocation rows and `UsageTable` expose the same callbacks. Dates use `formatTime` in header bounds,
provider cards and allocation forecasts. Summary blocks also accept it for an optional localized
as-of caption, including incomplete summaries.

Summary blocks accept `variant="plain"`, `metadata` and `details` for host period, as-of and
retained-exposure disclosures. `UsageSummaryCards.fundingSource` selects complete measurements from
one funding source; `selectMeasurements` allows a further explicit host selection. Funding selection
sums exact quantities and preserves the weakest certainty. With `fundingSource`, unknown-operation
counts are the exact sum of the selected funding rows. Complete views with no rows for the selected
source show each summary block's localized `labels.empty`. Incomplete summaries never infer totals
from a visible page. `CostSummaryCard` supports `showCost`, `showFunding`, `showCostOwner`,
`formatCostOwner` and `fundingSource`. Returning null or undefined from the owner formatter omits
the whole cost-owner line, including its caption. A customer host selects BYOK provider cost
separately from platform `customer_cents` measurements. Hiding a column does not sanitize serialized
identities: the host must redact private cost-owner IDs and upstream platform costs before
serialization.

`UsageTable` supports `formatDimension(dimension, value, row)`, unit and figure formatters, explicit
`showFunding`/`formatFunding`, and metadata/details slots. `ExceptionsList` supports `formatState`,
`formatProvider`, `formatOperation`, `formatOperationId`, `formatAge`, metadata/details, `busy`,
`onNextPage(cursor)` and `onFirstPage`. `showPrincipal={false}` on `ExceptionsList` or
`ExceptionsListPanel` drops the Principal header and cells together, and the empty-state row then
spans the five remaining columns; the default `true` keeps the column. Hiding it does not sanitize
serialized identities: a host that withholds principals must remove them before data reaches the
browser. The panel preserves cursor continuity even when a page has no classified rows, retains
readable rows during pagination, and drops financial rows after a failed read or a changed
query/access binding.

`HeaderStatusBar` and its panel accept `formatBound`, `formatFigure`, `formatUnit`, `formatTime`,
`boundHref` and `renderLink`. Keyboard-operable links preserve the bound tooltip, the bound's
`data-level`, reduced-motion behavior and wrapping for long localized labels. `renderLink` receives
`href`, `aria-label`, `data-level`, `className` and `children`; forward all of them to the host
link. The same status and motion attributes apply to non-link pills. `usageCapFromBound` maps a
visible HeaderBound to UsageCapPill props using exact integer arithmetic, flooring its display
percentage to hundredths. Remaining already includes reserved consumption; do not add reservations
again. Unknown/unavailable figures keep a null percentage. `usageCapFromBudget` accepts a full
BudgetRow to preserve the soft/hard policy, actual alert level and separate used/reserved
quantities; its geometry uses the hard limit when present. Percentages above 100 are preserved so
`UsageCapPill` can show the overflow notch while clamping the fill to 100%. Header bounds cannot
infer overflow from remaining headroom alone. Its `labels` localize unknown,
unavailable and unlimited values. Reserved exposure does not imply incomplete coverage.
`renderTooltip` composes a host tooltip around the keyboard-operable pill. The host distinguishes no
configured budgets, unlimited-only budgets, redacted/unavailable bounds and no eligible provider; an
empty bound array cannot distinguish those states.

See [registry composition APIs](PROVIDER-UI.md#registry-composition-apis) for controlled provider
editors and credential policies. New bundled helpers ship with both Radix and Base variants;
regenerate local server copies with `node scripts/sync-server-ui.mjs` after source changes.
