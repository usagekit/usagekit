# Provider UI and headless hooks

Provider administration is a host capability. The Meter owns accounting reads; it does not
store provider credentials, configure OAuth, route connections or own customer wallets.
The React layer composes both capabilities without introducing another balance authority.

`@usagekit/views` exports provider DTOs and the `ProviderManagementPort` contract.
`@usagekit/react` consumes that port without styling. Registry blocks render the same
models with Radix or Base UI primitives in each shadcn style. `@usagekit/views` and
`@usagekit/react` are published at 0.8.0, and the 0.9.0 source cohort awaits publication;
registry and site workspaces remain private.
See [consuming packages](CONSUMING.md) for published packages and reviewed checkout candidates.

## Host adapter

A `ProviderBinding` identifies the current scope, principal and authorization revision.
`scopeKey` must qualify the host service, namespace and tenant whose command journal owns
the action. Two independent backends must never reuse a scope key for the same principal.
`canManage` enables UI actions only when explicitly true. These values fence local reads
and callbacks; the server must authenticate and authorize every read, execute and reconcile
request independently. Never accept a browser-supplied binding as an access grant.

The host supplies three operations:

- `read(binding, query)` returns stored evidence for connections, connection details,
  balances, cost projections or allocations. A read must not test credentials, refresh a
  provider balance through a paid API or dispatch a provider request.
- `execute(binding, command, secrets?)` performs one explicit action. It validates the
  command identifier, target, capabilities, current revision and native storage bounds.
  Configuration changes use optimistic concurrency. Allocation batches require an atomic
  transaction across the submitted rows, or a definitive rejection without partial changes.
- `reconcile(binding, command)` consults the host command journal. It never retries the
  action. `not_applied` requires authoritative proof, not an absent connection in a read.

Commands cover connect, test, reconnect, disconnect, funding source, connection settings,
rates and allocation batches. Testing a draft credential does not create a connection.
All results echo the command identifier. Existing targets and allocation rows carry their
expected revision; the host rejects stale versions instead of overwriting them.

Provider credential values travel only in the ephemeral third argument of `execute`.
They never belong in read DTOs, query keys, command bodies, reconciliation requests or
error copy. OAuth and credential-vault references remain host-owned. Do not log secrets;
the host should return safe, localized error descriptions.

## Shared reads and explicit actions

Wrap related panels in `ProviderManagementProvider`, passing one stable port and the
current binding. Standalone hooks also accept the port and binding directly. Equal reads
share a bounded cache; changing identity or authorization selects a separate read state.
No hooks require registry components or CSS.

Provider actions run only after an explicit call. Pending and ambiguous actions keep a
shared gate, including after an editor is remounted or its read cache or adapter is replaced.
There is no automatic provider retry.
An ambiguous result requires manual reconciliation before another action can run. A stale
callback must not invoke an old adapter after the binding changes. Read-only is the default.

The provider cache is separate from the Meter cache. Hosts should refresh or invalidate
accounting reads after external changes to usage or financial authorities. Successful
provider configuration actions invalidate provider reads.

## Provider editors

`useProviderEditor(query, options?)` is new in the 0.7.0 React package and absent from the
published 0.6.0 package. It accepts the provider context or the same standalone binding options
as the read hooks.

The editor separates two snapshots:

- `editorData` is the immutable initializer for a draft. Details and allocation editors use
  its expected revisions. Background reads never replace it. `editorEpoch` identifies a
  draft identity change or explicit rebase.
- `evidence` is the current read snapshot for non-draft figures, balances, availability
  and rate provenance. Never present retained `editorData` as current financial evidence.

A background refresh in the same binding may retain valid evidence, but `canEdit` and
`action.run` stay fenced until the read finishes. A failed or forbidden read removes
evidence while preserving a disabled draft. An execute-forbidden result also hides evidence
and fences edits until a successful explicit reload; a conflict retains the draft and fences
further writes while independently valid evidence may remain visible. Background recovery
after a read failure can restore evidence, but cannot silently replace the draft base or clear
an action denial or conflict fence.

`reload()` explicitly requests a fresh draft base. Only a successful reload rebases the
form and clears an action denial or conflict fence; it may discard unsaved draft changes.
A failed reload preserves the draft, and a later background read cannot complete that failed
reload. Scope, principal, authorization revision, port, query or query-client changes isolate
the editor immediately. Late reads and callbacks from the old identity cannot restore it.

The existing command journal remains authoritative. Reload is unavailable while a command
is pending or ambiguous, and cannot erase the original submitted command or bypass its
write fence. Remounting the same query preserves its exact submitted values as pending or
ambiguous command state; another query cannot use them to initialize its draft.
`action.reconcile` checks that command's status without retrying it; it does not require
displayed financial evidence, but the host must independently authorize the request.

A connections list can open a new selected editor from current evidence after a background
refresh or an explicit connection action. That selected form owns a stable draft and CAS base;
it does not inherit the list's initial revision. The hook checks the current target and command
capability, while the host independently enforces the submitted CAS revision. Existing dirty
forms still require a successful explicit reload to adopt a different base.

Hook-backed editor panels enforce this lifecycle. Pure leaf components render explicit
props; a host composing those leaves owns draft identity, current evidence and write fencing.
For a details editor, a minimal host composition looks like this:

```tsx
import { useProviderEditor } from "@usagekit/react";
import { HostRateForm } from "./host-rate-form";

function Rates({ connectionId }: { connectionId: string }) {
  const editor = useProviderEditor({ kind: "details", connectionId });
  return (
    <>
      <button
        type="button"
        onClick={editor.reload}
        disabled={editor.refreshing || editor.action.pending || editor.action.ambiguous}
      >
        Reload rates
      </button>
      {editor.editorData?.connection && (
        <HostRateForm
          key={editor.editorEpoch}
          base={editor.editorData.connection}
          evidence={editor.evidence?.connection ?? null}
          action={editor.action}
          disabled={!editor.canEdit}
        />
      )}
    </>
  );
}
```

`HostRateForm` is host UI: initialize exact draft strings from `base`, display non-draft
figures only from `evidence`, honor `disabled` and current per-command capabilities, and
submit through `action.run`. Render the hook's read state and error alongside the form.
The copyable `ProviderRatePanel` supplies this read feedback and composition already.

## Rates

A `ProviderRate` prices one `unit`, named in the singular ("request", "keyword"), in its
native `priceUnit`. Usagekit money is USD cents, so the rate editor shows a `cents` price
as exact dollars ("$0.00625") and takes dollars with at most six decimal places, converting
them to cents without floating point. Other price units are shown and entered as they are.

`provenance` says where the current price comes from: a manual price, a measured rate, a
list price or nothing yet. For a manual price, the host may add `fallback`: the price and
provenance that apply once the manual price is cleared; `fallback` is new in the 0.8.0 views
package. The editor then names the reset
after it ("Use measured rate", "Use list price") and shows it as "Without your rate". Without
`fallback` the reset reads "Clear your rate". Only a manual rate offers a reset.

Each rate is a collapsed row with its price per unit and source. Opening it shows when the
rate was checked, its samples and version where known, the operation and funding source,
and the form.

Every provider block accepts host copy through `labels` and `feedbackLabels` for status,
recovery, funding and figure text. Every panel accepts `onReload`, called first on each
explicit reload so the host can reverify access before the panel refreshes or rebases its form.
A refused allocation or rate change is stated once in the action feedback.

## Exact limits and separate authorities

An allocation row has its own funding source, surface, unit and revision. In the common
configuration, rows form a two-by-two matrix: own provider keys and platform-funded keys,
each with app and programmatic access. An omitted limit keeps the stored value; `null`
clears a limit. An unlimited row differs from a row whose limit is unavailable.

Native provider usage, provider cost and customer charges must remain separate. A host
wallet balance is not a provider balance. Do not add rows in different units or funding
sources. Exact decimal strings survive values above JavaScript's integer precision.
`parseProviderDecimal` supplies generic validation; the host also enforces its own native
precision, maximum allocation and monetary bounds.

`allocationLimitFromAvailable` suggests a limit from measured usage, reservations and
availability in one unit. The host explicitly declares whether availability is before or
after those reservations. Before-reservation availability produces `used + available`;
after-reservation availability produces `used + reserved + available`. Unknown, estimated,
unavailable and incompatible figures cannot silently become zero or a usable suggestion.
The suggestion changes an editor draft only; it never refreshes or mutates a balance.

`projectBudgetExhaustion` estimates exhaustion from settled average pace and remaining
headroom. Reservations consume headroom without increasing settled pace. It returns
no usage, already exhausted, within limits, an estimated timestamp or unavailable. A
forecast is an estimate, not an admission decision or a promise about future spending.

## Host adoption

A host adapter maps its provider catalog and connection read state into the DTOs, its
provider actions into `execute`, and its versioned action journal into `reconcile`.
Authorization, credential encryption, OAuth, provider dispatch, fallback policy, billing
and wallet writes stay in the host. Labels and primitive components are replaceable.

The local showcase uses an isolated example adapter and never contacts a provider.
Passing its tests verifies library composition; it does not establish production adoption
or authorize a release. See [UI layers](UI.md) and [the project website](SITE.md).

## Two application consumers

Host applications and the Usagekit dashboard are the intended consumers of the same React hooks
and registry blocks. Changes to shared behavior belong in this library. Each application
supplies its verified identity, adapters, labels, primitives and product-specific slots.
Neither application should maintain a second implementation of provider or budget editors.

The local dashboard under `packages/server/ui` consumes unchanged Base UI registry blocks
for accounting, provider cards, credential forms, rate editing and budget management.
Its parity test checks copied sources against the registry. Its authenticated host adapters
support own-key connections, format-only tests, exact manual prices and versioned budgets.
The server supplies connection CAS revisions and a durable content-free command journal;
budget reconciliation reads immutable version evidence. Unsupported capabilities stay hidden.
See [local dashboard controls](LOCAL-SERVER.md#dashboard-controls) for the API and restart rules.

The website's example host integration shows an existing metering integration. Adoption of these
new React blocks there is still pending. Its application adapter keeps OAuth, credential storage,
funding permissions and wallet ownership in the application while projecting neutral DTOs
into the shared UI. Both integrations should exercise the same read-only, exact-value,
conflict and unknown-result cases before replacing their current screens.

## Request quotes and BYOK manual prices

The 0.9.0 source cohort adds `Meter.quote(access, input)`; published 0.8.0 does not have
this method. `MeterQuoteInput` has the same request scope, funding, provider, operation,
options, optional explicit estimate and provenance as `MeterReserveInput`, without
`operationId`, `reservationTtlMs`, `correlationId` or `parentOperationId`.

```ts
const quote = await meter.quote(access, {
  scope: { namespace, principal, connection },
  fundingSource: "byok",
  costOwner: principal,
  surface: "app",
  source: "app",
  provider: "dataforseo",
  operation: "dataforseo_labs.google.keyword_overview.live",
  options: { itemCount: "1000" },
});
// quote.outcome === "ok": quote.value.quantities, estimateSource?,
// providerPriceVersion?, checkedAt?, sampleSize?, tracking, budgets, asOf
```

Quote requires `access.canReadBillingDetail`; otherwise the result is `forbidden` (HTTP 403).
Quote and new reservation share pricing resolution. Use identical request fields for
preview and reservation. Quote authorizes the principal, optional group, connection owner
and optional access credential through the host's `resolveOwnership`. Missing ownership
proof denies the read even when no connection budget exists. Applicable shared budgets
retain the existing pool/tag redaction. A quote never creates an operation, counts a
request, sweeps expiry, acquires a lease or calls a provider. Budget status is advisory;
reservation repeats admission atomically. A replay uses its frozen reservation estimate,
while a new quote reflects current policy. `tracking` is `metered`, `passthrough` or
`unpriced`; unknown BYOK pricing has `estimateSource: "unknown"`, without an invented zero.
For an explicit estimate without provenance, `estimateSource` is omitted, matching the
stored reservation. It is not labelled as unknown pricing.
Passthrough is a BYOK-only opt-out of spend enforcement. Billable platform-funded
operations always quote as `metered` and reserve before dispatch. Hosts must supply receipt
measurements for their customer charge; an estimate alone does not settle that charge.
`executeProviderRequest` settles provider evidence only. Use a distinct customer unit such as
`customer_cents` and supply its measurement in a host receipt; until then it stays reserved
and the operation stays pending. Provider `cents` must not represent a different customer price. Credits charges cannot be opted out through
tracking, including existing passthrough or unpriced settings. Validate connection
configuration with core's `validateConnectionPolicy`: platform connections reject
`manualPrices` and `manualPriceBasis`, and billable platform operations reject
`passthrough` and `unpriced` with an `invalid` tracking result. The local connection HTTP
API reports that validation failure and continues to support only BYOK credentials.

**A manual provider price is BYOK-only.** It estimates the host user's own provider
cost. `ConnectionPolicy.manualPrices` and `manualPriceBasis` must never price a
platform-funded credits call. For a billable operation with `fundingSource: "platform"`, the host supplies an
explicit `estimate` from its customer-price policy, with any native/customer dimensions
and customer price version. Meter does not fall back to manual, measured or list prices
for platform funding. Without that estimate, both `Meter.quote` and `Meter.reserve` return
`invalid` on the `estimate` field for billable operations, even with a manual price of zero
or connection tracking set to `passthrough`. Without a host estimate, no billable request is counted or reserved.
On a resolved connection, catalog-declared nonbillable operations (`billable: false`)
remain admitted without an estimate: quotes contain no quantities,
and reservations only count a passthrough request, never creating a charge. Without a host
estimate, an unknown platform operation is now invalid (0.8.0 counted it as unpriced).
An unknown connection or a Meter without a catalog is also invalid without an estimate.
Empty or requests-only platform estimates are rejected, regardless of budgets. Explicit
platform estimates marked `estimateSource: "manual"`, `"measured"` or `"list"` are rejected;
omit provider provenance for host customer prices. Settlement
uses receipt evidence and never consults a manual price. Existing dispatched operations
retain their frozen prices and provenance.

`ConnectionPolicy.fundingSource` is required and must reflect the connection’s actual funding.
The host resolver receives `{ namespace, connection }`; resolve within that namespace.
Quote and new reserve reject mismatched request provider or funding, even without a catalog. Billing
imports use the same namespace-aware lookup. A Meter without a resolver relies on the host
to derive request `fundingSource` from trusted server state, never from client input.

Manual amounts default to `"call"`, preserving existing callers, including zero. A call
price covers the whole request and receives no further depth or clickstream multiplier.
Set `manualPriceBasis[operation] = "item"` for a coefficient: the catalog retains the
base charge and applies `base + coefficient * itemCount` and any declared multiplier.
Measured prices may also return `basis: "item"`, `checkedAt` and `samples`; the default
basis is call and the minimum sample count remains five. A money override preserves
independently known native units (for example SerpApi searches). It cannot invent native
usage when a plan or native estimate is unknown.

See [catalog pricing](PROVIDERS.md#6-formulas-subscriptions-and-host-local-providers)
for formulas, subscription fees and the host-supplied local provider pattern.

## Registry composition APIs

Registry items request exact 0.9.0 packages. The `provider-allocation-editor` and
`provider-manager-panel` items require `@usagekit/react` 0.9.0 for their rebase and
read-refresh APIs. The other copied-source APIs also work with the 0.8.0 runtime packages.
These APIs do not add commands to
`ProviderManagementPort`. The host still authenticates every read, refresh, mutation and
reconciliation. The registry never starts provider I/O on mount. Registry blocks use no `useEffect`
for reads, drafts, completion or lifecycle notifications; event handlers own async commands and
explicit reconciliation.

- `ProviderAllocationEditor` and `ProviderAllocationPanel` accept `inputPolicy` (one policy or a
  function per row), `formatValidation`, `suggestionEligible`, `onRefreshBalance`, `renderEvidence`,
  `evidenceBefore`, `evidenceAfter`, `help`, `variant="plain"`, and `onSaved`. Above/below evidence
  slots may also be callbacks receiving current evidence rows (or null after a failed read).
  Formatting props are `formatFigure`, `formatUnit`, and `formatTime`. Panels propagate all
  presentation props.
- `inputPolicy` supplies `denomination` (`native` or `dollars`), input `precision`,
  `nativePrecision`, native `min`/`max`, and optional `unitLabel`. Dollars are only a presentation
  of cents/customer cents. Commands carry exact native decimal strings. There is no legacy integer
  maximum built into the block. The host chooses bounds from its current storage contract and
  validates them again on the server. `formatValidation` receives `{ code, row }`; stable codes are
  `decimal`, `precision`, `minimum`, `maximum`, `storage`, and `policy`.
- `suggestionEligible` receives each current evidence row, or the matching successful availability
  result after an explicit legacy refresh. It overrides the panel-wide `fresh` flag for that row,
  allowing independent wallet and scoped native-unit evidence. Suggestions still require compatible
  measured usage, reservations and availability. They change a draft, never save it.
- `onRefreshBalance` runs on an explicit button click with the current row. It returns a matching
  row with scoped availability or null; use `onRefreshNative` for provider-account observations.
  The block clears previous availability first, shows localized pending/failure feedback, and
  rejects results after a row, connection, funding, unit or revision change. Returned
  availability cannot replace scoped Meter usage/reservations. `renderEvidence` receives current
  evidence with unavailable probe evidence suppressed.
- `onSaved` fires for the editor's confirmed successful allocation command, exactly once, including
  explicit successful reconciliation. Completion is reported by the save/reconcile handler for its
  original command. It does not fire for a failed read, conflict, forbidden result, ambiguous
  acknowledgment or an unrelated command. Hosts retain modal dismissal and focus restoration.

`ProviderChainEditor` supports `mode="project"` without a synthetic provider connection. Supply
`snapshot`, separately current `evidence`, `canEdit`, and `onCommit`. A snapshot has an
authorization-scoped `identity`, project `revision`, and ordered `entries` containing public `id`,
`label`, `enabled` and row `revision`. One commit receives
`{ commandId, expectedRevision, entries }`, with `expectedRevision` on every entry. The host
validates the complete connected set, permissions and revisions and persists the ordered/enabled set
atomically.

`onReconcile` receives that original command. Ambiguous results survive modal remounts in the
browser-only shared content-free controller and block both resubmission and Reload. The host must
journal commands durably for page reloads. `onReload` returns a fresh snapshot or null; a successful
same-identity reload rebases the draft. A new `snapshot` revision or entry revision also rebases the
base and draft and clears stale results when no command is pending or ambiguous, including after
remount. Conflicts and successful writes require fresh revisions before more editing. Server renders
always use a fresh controller and never read or write the browser journal. `formatCount` receives
the number of enabled draft entries; `formatPosition` keeps the total entry count. These formatters,
labels (`first`, `next`, `paused`, move and toggle labels), and `variant="plain"` support host
composition. Connection mode retains its existing behavior and can hide membership controls with
`showMembershipControls={false}`.

`ProviderSourceSelector` also supports `mode="controlled"`. Supply current `value`, optional
authorization/connection `identity`, `choices` with individual `disabled` and `description` values,
and async `onSelect`. `confirmTransition` returns a localized confirmation body or null for a direct
transition. The current source only changes when the host changes `value`. `canEdit`, `busy`,
`error`, feedback labels and the plain variant preserve host policy and recovery.

`ProviderCard` accepts `identity`, `description`, `metadata`, `body`, `source` and `actions` slots.
An actions function receives `{ connection, canEdit }`; hosts must apply this fence to their
buttons. `onTest` and `onToggle` replace supported port actions, while capability checks still
govern their buttons. `onManage` remains host-owned navigation. `canEdit` can withdraw mutation
permission, and `formatTime` formats the observation timestamp.

`ProviderConnectForm` supports `requireTest`, `reuseStoredCredentials`, `requireNewCredentials`, and
`readOnlyCredentials`. A successful test only enables Save for the exact current credential values
and funding selection; editing them invalidates the test. A connection revision update alone
preserves the draft and its test result. Test and reconnect submit the draft's initial CAS revision;
only this form's own successful test with a matching command ID and non-null `result.revision`
advances that base. A concurrent external change therefore conflicts instead of being overwritten,
while a test that bumps the revision keeps the draft usable even before the refreshed read arrives.
`requireNewCredentials` only prevents reuse and does not imply `requireTest`. When a required test has no `test` capability,
Save stays disabled and `labels.testUnavailable` explains the unavailable test. Blank values reuse
stored credentials only with explicit host policy, a stored credential and the same funding source. `formId` and
`renderFooter({ formId, canSave, pending, dismissalBlocked })` support external sheet footers. The
OAuth slot is outside the credential form and can contain a host form. `renderTestFeedback` receives
a structured action result. `renderFields` and `validateCredentials` allow host form adapters,
including RHF/Zod, without replacing the block's test/save policy. Credentials remain ephemeral
execution arguments. `onPendingChange` and `onDismissalBlockedChange` notify from submit, disconnect
and explicit reconciliation handlers: pending blocks dismissal, definitive settlement releases it,
and an ambiguous result keeps it blocked. Footer context reflects shared pending/ambiguous state
even on remount. `onConnected` fires only for a confirmed credential save.

`ProviderManagerPanel.childProps` propagates child-specific labels and slots via `card`, `connect`,
`source`, `rate`, `chain`, `balance` and `allocation`. Internal targets, evidence, action fences and
selection callbacks remain owned by the manager. This API does not imply that a host supports every
manager command.

Platform rate rows are a credits price list, regardless of an erroneous `editable` flag or
provenance supplied by a host. They display exact prices in the customer unit. Money units (`cents`
and `customer_cents`) use exact USD dollar text, so `123.4500 customer_cents` displays as `$1.2345`;
other units stay native. All-platform lists show `platformTitle` (default **Credits prices**) and
`platformNote` (default **Prices are set by the host.**) once in the card header. Mixed lists keep
the BYOK header and place platform rows in one section with that title and note once. Individual
rows carry no note. Null evidence or an unavailable price hides the figure; existing unknown-price
evidence uses `labels.unknown`. They never show rate provenance, a fallback, an input, Save or
reset. BYOK retains its existing rate editor behavior.

### Allocation form adapters and native observations

Allocation panels and editors also accept these optional host composition props:

- `formAdapter.field(row)` returns `{ value, setValue, name?, ref?, onBlur?, error? }`.
  Values are exact **display strings**; Usagekit still computes changed rows, converts to native
  units and sends one atomic command. `formAdapter.handleSubmit(save)` wraps submission in host
  validation. Field errors render beside their inputs with `aria-invalid` and `aria-describedby`;
  registered refs let the host focus its first invalid field. No form library is installed by
  Usagekit. With an adapter, the editor renders its own form and Save submits through the adapter;
  do not place an adapter-backed editor inside another form. Without an adapter, the editor renders
  no form and Save stays a click-only button, preserving host form and Enter-key behavior. Mount the
  host adapter component with the editor epoch as its key, or implement optional
  `formAdapter.rebase(drafts)` on `ProviderAllocationPanel`. The panel calls it once after each
  successful explicit Reload has rebased the editor, including unchanged revisions. `drafts`
  maps row IDs to exact display strings using the current `inputPolicy`, including blank
  unlimited limits. Initial loads, failed Reloads, background revalidation and changes of
  binding/query do not call it. Failed/background reads must retain the host's draft.
  `allocationDraftValue(row, policy)` from `provider-allocation-policy` returns exactly the editor's
  initial field string, including dollar display, unavailable/unknown limits and blank unlimited
  limits. Use the same per-row policy for host defaults and the editor.
- `inputPolicy.blank: "unlimited"` makes an empty field clear a limit, keeps confirmed unlimited
  rows editable, and hides the separate unlimited toggle. Unknown non-unlimited limits stay
  disabled and cannot enter the command. Existing precision and native bounds still apply.
- `rowLabels(row)` overrides `section`, `field`, `available`, `refreshBalance`, `unlimited` and
  `limited` accessible names. Include the provider, funding source and surface for unique names.
  `canRefreshBalance(row)` controls each row's refresh visibility.
- `onRefreshNative(row)` returns `{ identity, value, observedAt? }` or null. `identity` includes
  `id`, `connectionId`, `fundingSource`, `surface`, `unit` and `revision`; `value` is a `Figure` in
  the provider account's unit, which may differ from the allocation unit.
  `renderNativeObservation(observation, row, { pending, failed })` renders this separate evidence.
  Native refresh is available only for own-key rows and only after an explicit click. It takes
  precedence over legacy `onRefreshBalance` when both are supplied. It never replaces Meter
  usage, reservations, availability or suggestions. Repeated refreshes clear earlier native
  observations; identity changes and mismatched results discard them.
- `onRefreshPendingChange(boolean)` reports aggregate in-flight native/legacy refreshes, so a
  modal can fence dismissal. The editor fences Save and the panel fences Reload until they settle,
  including work whose identity has changed. The panel aggregates transitions from all editor
  instances, including pending work from an earlier editor epoch, and only notifies the host when
  that aggregate changes. Refreshing does not change write permission or show read-only feedback.
  The host must also fence its own close controls.
- `emptyState` supplies host connect guidance; empty snapshots render no Save button.
- `feedbackMessage(subject)` returns a `ProviderFeedbackMessage` or null, and
  `formatFeedback(message)` formats it. The editor and panel accept both; the panel passes the
  mapper to its read feedback as well as to the editor's action feedback. `ProviderActionFeedback`
  and `ProviderReadFeedback` directly accept `message` (a message object or the same mapper) and
  `formatMessage`. Structured feedback only replaces an existing notice: an ambiguous action or a
  result with default copy, or any non-loading read state. It never creates an idle notice or
  replaces loading/pending text. A mapper returning null keeps the existing string copy. With a
  structured message but no formatter, the standard label for that outcome or state is used, never
  server diagnostics. The default conflict copy never includes its raw reason. The mapper can
  localize invalid, unavailable and ambiguous results, including Usagekit's built-in English
  unavailable messages. Hosts own safe parameter labels and localization. `provider-feedback`
  exports both types:
  - a message is `{ code: string, params?: Readonly<Record<string, string | number | boolean | null>> }`;
  - an action subject is `{ kind: "action", result: ProviderReconciliation | null, ambiguous: boolean }`;
  - a read subject is `{ kind: "read", state: string, error: { message?: string, kind?: string } | null }`.

For example, a host can use its own React Hook Form and Zod resolver without replacing any inputs
or allocation arithmetic. Here `allocationSchema` is the host's schema for `{ limits: string[] }`,
including its per-row blank, positive-value and storage rules:

```tsx
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { ProviderAllocationPanel } from "@/components/usagekit/provider-allocation-editor";
import {
  allocationDraftValue,
  type AllocationProps,
  type AllocationInputPolicy,
} from "@/components/usagekit/provider-allocation-policy";
import { allocationSchema, policyFor } from "./host-allocation-schema";

function HostAllocationForm({
  rows,
  connectionIds,
  ...props
}: Omit<AllocationProps, "action" | "revision"> & { connectionIds: readonly string[] }) {
  const inputPolicy = (row: AllocationProps["rows"][number]): AllocationInputPolicy => ({
    ...policyFor(row),
    blank: "unlimited",
  });
  const form = useForm<{ limits: string[] }>({
    mode: "onBlur",
    resolver: zodResolver(allocationSchema(rows)),
    defaultValues: {
      limits: rows.map((row) => allocationDraftValue(row, inputPolicy(row))),
    },
  });
  const values = form.watch("limits");
  return (
    <ProviderAllocationPanel
      {...props}
      connectionIds={connectionIds}
      inputPolicy={inputPolicy}
      formAdapter={{
        rebase: (drafts) => form.reset({ limits: rows.map((row) => drafts[row.id] ?? "") }),
        field: (row) => {
          const index = rows.findIndex((item) => item.id === row.id);
          const name = `limits.${index}` as const;
          const { ref, onBlur } = form.register(name);
          return {
            name,
            ref,
            onBlur,
            value: values[index] ?? "",
            setValue: (value) => form.setValue(name, value, { shouldDirty: true }),
            error: form.formState.errors.limits?.[index]?.message,
          };
        },
        handleSubmit: (save) => form.handleSubmit(() => save()),
      }}
    />
  );
}
```

The host supplies the field ordering in `rows` and remounts the form when its target row set
changes. Pure `ProviderAllocationEditor` leaves take their rows from the host; they
have no Reload operation and do not invoke `rebase` themselves. Async adapter submissions share a
synchronous in-flight guard: repeated Enter or submit events keep one command and call `onSaved`
once after that command's confirmed success. Success, including reconciled success, keeps Save
and editing disabled until refreshed identity props remount the editor. Delayed async validation
continuations cannot resubmit the old revision. Non-success outcomes release the local guard;
the shared action's conflict and ambiguity fences still apply.

The headless equivalent is `useProviderEditor(query, { onRebase(snapshot) { ... } })`.
`onRebase` receives the new draft base after a confirmed successful explicit Reload, once per
rebase. It does not report initial loads or background updates. `editor.refreshKind` is
`"reload"` during that explicit operation, `"revalidate"` during a background read with a retained
draft (including recovery after a failed read), and `null` when neither is in flight. A newer read that supersedes an outstanding
Reload remains part of that Reload until it settles. The existing `refreshing` flag and write
fences retain their behavior. Hosts need no access to `client.entry`.

The hook's optional `onReadRefreshChange(kind)` and
`ProviderAllocationPanel.onReadRefreshChange(kind)` expose the same distinction. For example,
a host can fence its Cancel button and Escape handler using the shared action and the two
panel callbacks. An unmount or editor identity change during a refresh sends `null` through the
latest committed callback, even if the old read is still pending. The callback ref updates in a
layout effect so a discarded concurrent render cannot redirect this cleanup. Replacing only the
callback does not restart notifications:

```tsx
const action = useProviderAction();
const [readRefresh, setReadRefresh] = useState<"reload" | "revalidate" | null>(null);
const [nativePending, setNativePending] = useState(false);
const dismissalBlocked = action.pending || readRefresh === "reload" || nativePending;

<ProviderAllocationPanel
  connectionIds={connectionIds}
  formAdapter={adapter}
  onReadRefreshChange={setReadRefresh}
  onRefreshPendingChange={setNativePending}
/>;
```

Window-focus and interval invalidations use `"revalidate"` and do not block dismissal. Keep
the host's existing ambiguous-command recovery policy separately. As with the read hook,
initial loading has no retained draft and is not classified as background revalidation.
