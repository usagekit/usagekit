# Consuming usagekit

Use Node 22.23.1 and pin packages from a release cohort to the same exact version.
The seven-package 0.9.0 cohort is published. It adds pricing formulas, authorized
`Meter.quote`, host-priced credits calls and React draft rebase signals for the host
composition blocks. See [what 0.9.0 adds](#what-090-adds).
The preceding 0.8.0, 0.7.0 and 0.6.0 cohorts and the four-package 0.5.0 runtime cohort
remain available.
The 0.9.1 source candidate adds conservative estimates for historical provider requests
with explicit date bounds. Both boundary months count, including partial months; the
actual response determines settlement. Requests without both bounds remain unknown.
All seven packages move together. Use reviewed local tarballs for 0.9.1 until separately
approved and published.

Source: <https://github.com/usagekit/usagekit>. Documentation and registry: <https://usagekit.dev>.

```sh
npm install --save-exact @usagekit/core@0.9.0 @usagekit/store@0.9.0 @usagekit/meter@0.9.0 @usagekit/providers@0.9.0
```

The registry is `https://registry.npmjs.org/`. No scope registry mapping is needed.
The packages are public. No registry token is required to install them.
Consumers that configured a read-only token during the private phase should verify a token-free `npm ci` and then remove the token from CI, deployment and user configuration.
For an unpublished candidate, install the reviewed cohort tarballs together as described below.
Consumers upgrading from 0.4.0 must follow the [migration guide](MIGRATING-0.5.md): custom Store
and Meter implementations need the mandatory billing methods; the interfaces are not interchangeable.

## Embedded contract

Create an in-process Meter with a host Store, policy and injected clock.
Authorize writes in the host. Build read AccessContext from verified server credentials.
Reserve before dispatch. Only a first dispatch grant allows a provider call.
Reservation lifetime defaults to five minutes and has a maximum of one day.
Queue producers must obtain intent at enqueue and carry the lease, or cover queue delay in the lifetime.
An expired reservation cannot dispatch and is atomically released when intent is attempted.
Schedule expireReservations for each namespace; repeat batches while hasMore is true.
Admission cleans only one default batch. Embedded consumers own remaining maintenance.
The local server schedules cleanup every thirty seconds.
Expired dispatch leases require evidence recovery; never redispatch or release uncertain exposure.
Reconcile external credit holds through their authoritative ledger.

## Budget alerts

A budget may declare up to eight ascending `alerts`, each a percent of `limit` or a quantity in the budget unit.
The reserve, settle or correct whose admitted or settled figures first reach a threshold returns it in `alerts`
with the budget id, version, epoch, threshold and the figures at that moment. The store records the crossing
atomically with the command, so concurrent commands report it once in total, a replay returns the stored
crossings, and a new epoch reports the threshold again. Soft budgets (`onExceed: "allow"`) still warn past
`limit` and deny past `hardLimit`; alerts never change admission.

## Read-only HTTP mount

`createUsageHandlers({ meter, authenticate, commands: false })` serves only the read routes. Every POST under
`/v1/operations/`, including `expire`, answers 404 after authentication and before any authorization or body
parsing. An embedded host mounts it on one authenticated route, maps its own sessions or API keys to
`AccessContext` in `authenticate`, and an external dashboard consumes it through `createRemoteMeter`, whose
command methods then reject with `RemoteHttpError` 404. Operations stay created in process.

## Adapter conformance

Runtime imports use @usagekit/store. The reference implementation is also exported at /reference.
Import runStoreConformance and runStoreScalingConformance from @usagekit/store/conformance.
The conformance entry ships compiled JavaScript and declarations, not TypeScript sources or test runners.
Consumers running it provide compatible vitest 5 and fast-check 4 peers as development dependencies.
Every case uses the supplied factory. Durable adapters must implement the restart fixture.
Skipped capabilities are not passed guarantees.

## Headless views and React components

`@usagekit/views`, `@usagekit/react` and `@usagekit/store-postgres` belong to the
published seven-package 0.9.0 cohort. The 0.9.1 source candidate uses the same cohort.
In 0.7.0, `@usagekit/react` adds `useProviderEditor(query, options?)`, which keeps a draft base
separate from current evidence and rebases only after an explicit successful reload; see
[provider UI](PROVIDER-UI.md). In 0.8.0, `@usagekit/views` adds `ProviderRate.fallback`, the price
and provenance that apply once a manual rate is cleared. In 0.9.0, `useProviderEditor` adds the
`onRebase` and `onReadRefreshChange` options and `refreshKind`; see
[what 0.9.0 adds](#what-090-adds). Keep packages on the same exact cohort; do not mix cohorts.
The component registry is private build tooling that distributes public shadcn JSON, rather
than an npm package.

Check availability without credentials:

```sh
for package in core store meter providers views react store-postgres; do
  npm view "@usagekit/$package@0.9.0" version --registry https://registry.npmjs.org/
done
```

After all seven versions are available, install the packages your application needs:

```sh
npm install --save-exact @usagekit/core@0.9.0 @usagekit/store@0.9.0 @usagekit/meter@0.9.0 @usagekit/providers@0.9.0 @usagekit/views@0.9.0 @usagekit/react@0.9.0
# Optional server-side Postgres storage:
npm install --save-exact @usagekit/store-postgres@0.9.0
```

The published registry blocks use exact 0.9.0 `@usagekit/react`, `@usagekit/views` and
`@usagekit/core` versions. This checkout builds candidate blocks requesting 0.9.1. Use
reviewed cohort tarballs for those blocks until 0.9.1 is published; do not mix cohorts.
For the published 0.9.0 blocks:

```sh
# Choose the primitive family configured in your shadcn application:
npx shadcn add https://usagekit.dev/r/radix/budget-manager-panel.json
# Or: npx shadcn add https://usagekit.dev/r/base/budget-manager-panel.json
# Any shadcn style: add "@usagekit": "https://usagekit.dev/r/styles/{style}/{name}.json" to
# "registries" in components.json, then: npx shadcn add @usagekit/budget-manager-panel
```

If a version is unavailable, use the reviewed seven-tarball candidate workflow below.
A successful website deployment does not establish npm publication.
Backend consumers need no React dependency unless they install the React package.

From a checkout, run the root `npm ci` and `npm run build`. A workspace host can use
`loadUsageSummary` and the other views directly, or share reads through `MeterProvider`
and the React hooks. The copied blocks use the host's primitives, and their own elements follow
the host's shadcn style: New York, or Vega, Nova, Maia, Lyra, Mira, Luma, Sera or Rhea on Radix
or Base UI when copied from `r/styles/{style}`; `r/radix` stays New York and `r/base` stays
Base UI Vega. Registry artifacts contain their dependency manifest and bundled
component files. Published UI dependencies resolve anonymously from npm; unreleased
candidates require the reviewed tarballs before copying blocks.

For a complete local example without package downloads:

```sh
node packages/registry/consumers/prepare.mjs
```

Run the printed Vite command to open the showcase on loopback port 5177. One page shows every
block and switches all seventeen shadcn styles in place. The preparation copies the blocks,
primitives and style sheets into an ignored host directory and resolves the local workspace
source. The showcase uses one in-memory Meter and a sample budget writer; it includes light/dark
themes, read-only mode and exact budget inputs. It does not access an external provider or
production database.

Use a stable, memoized host `BudgetWriter` to enable edits. Its server implementation must
verify authorization, preserve allowed scope/unit/window and use budget version
compare-and-swap. A timed-out write stays unknown until authoritative reconciliation;
never translate a missing read into permission to retry. Read-only is the default, and
customer credit authority remains in the host. See [UI](UI.md) for APIs, all twenty-two blocks,
shared cache behavior and writer outcomes.

## What 0.9.0 adds

The 0.9.0 cohort is published. Pin all seven packages to 0.9.0 together. `store`, `views` and `store-postgres` have no functional changes.

- **Pricing formulas and BYOK-only manual prices** (`core`, `providers`, `meter`). A catalog price
  row can carry a `PriceCalculation`: additional pages by depth, a base charge plus a per-item
  coefficient, or an option multiplier, computed exactly. DataForSEO rows encode these formulas
  and match the recorded price list; SerpApi plans carry monthly fees that never settle per
  search. Manual prices default to a whole-call basis and accept an item basis through
  `manualPriceBasis`. They are BYOK-only: no manual, measured or list price ever prices a
  platform-funded call. Direct `catalog.estimate` calls throw `InvalidInput` on malformed
  pricing counts; Meter returns `invalid` on `options`. List formulas are evaluated before
  overrides, so malformed counts can also reject a whole-call manual price. Money overrides
  preserve known native units. See
  [catalog pricing](PROVIDERS.md#6-formulas-subscriptions-and-host-local-providers).
- **Conservative DataForSEO estimates** (`providers`). Request extraction uses documented
  defaults only when `limit` is omitted: [keyword ideas: 700](https://docs.dataforseo.com/v3/dataforseo_labs/google/keyword_ideas/live/),
  [suggestions: 100](https://docs.dataforseo.com/v3/dataforseo_labs/google/keyword_suggestions/live/),
  [related keywords: 100](https://docs.dataforseo.com/v3/dataforseo_labs/google/related_keywords/live/),
  [relevant pages: 100](https://docs.dataforseo.com/v3/dataforseo_labs/google/relevant_pages/live/), and
  [backlinks: 100](https://docs.dataforseo.com/v3/backlinks/backlinks/live/).
  [Ranked keywords](https://docs.dataforseo.com/v3/dataforseo_labs/google/ranked_keywords/live/)
  and [domain rank overview](https://docs.dataforseo.com/v3/dataforseo_labs/google/domain_rank_overview/live/)
  also default to 100 and charge per item. Backlinks summary charges one row; history remains
  unknown without a host-supplied count. Checked 2026-10-11; all limit maxima are 1,000.
  These upper bounds on per-returned-item billing
  also apply to manual/measured item coefficients. Keyword overview without `keywords`,
  historical rank overview, and direct catalog/Meter calls without `itemCount` remain unknown.
  Historical rank overview's default six-month range does not define an item count.
  Money budgets reject those unknown estimates with `missing_estimate_unit`. Undocumented
  request `limit: 0` or above 1,000 is unknown; a direct trusted host
  `itemCount: "0"` still prices the base.
  BYOK whole-call overrides still work. SERP depth remains 10 by default; each 10-result page
  reserves the full base price, a conservative upper bound. At depth 100, organic SERP estimates
  are 2.0 cents live (0.2 flat in 0.8.0) and 0.6/1.2 cents queued normal/high. Settlement still
  uses the measured response cost. String `search_param` values such as `"&nfpr=1"` are accepted
  after strict bounded repeated percent-decoding (`+` becomes space); malformed escapes
  remain invalid. Keywords use lenient decoding of valid `%XX` sequences and keep other
  percent signs literally, so `50% off shoes` and `100% cotton` retain their plain depth price.
  Operators are priced, including substring matches such as `android:` containing `id:`.
  Both original and decoded forms are checked with NFKC lowercase, NFKC uppercase then
  lowercase, and NFKD with combining marks and Default_Ignorable_Code_Point characters
  removed, then lowercase; `-site:` is exempt per form.
  Array `stop_crawl_on_match` and `find_targets_in` do not reduce the page bound.
  The surcharge formula in cents is `P * (B + rectangles + async + 0.015 * clicks) * 5^N`,
  where `P = max(ceil(depth / 10), max_crawl_pages)`, `B` is 0.2 live or 0.06/0.12 queued,
  each enabled rectangle/async adds one base and each click adds 0.015 (1–4 clicks).
  Whole-call manual/measured overrides and explicit BYOK estimates cannot undercut this
  documented list upper bound for requests carrying surcharges.
  `url`, `offset_token`, enabled `include_seed_keyword`, undocumented limit values and
  unlisted fields produce unknown estimates that no override may replace. The pricing
  boundary drops caller estimates and provenance, then lets Meter enforce policy:
  money budgets fail closed (`missing_estimate_unit`, proxy **422**), uncertain credits
  calls are rejected, and BYOK passthrough or BYOK without money budgets can dispatch.
  Missing counts alone still permit whole-call overrides or explicit host estimates.
  See the [field inventories and formulas](PROVIDERS.md#6-formulas-subscriptions-and-host-local-providers).
  Request extraction
  requires boolean `include_clickstream_data`: `true` enables it, while `false` or omission
  leaves it disabled. Billable multi-task bodies are rejected by `catalog.match`
  with `InvalidInput: multiple DataForSEO tasks`. `PricedRequest.price` rejects with `RequestPricingError` before admission, even with an explicit estimate;
  the local proxy returns 400 `invalid_provider_request`. Split batches into single-task calls.
- **Generated pricing invariants** (`providers`, `proxy`). Reproducible fast-check properties
  cover all 13 billable DataForSEO operations with independent exact-arithmetic charge bounds,
  media-type variants, duplicate JSON keys, unknown fields, surcharges and numeric edges.
  They verify that the priced body bytes are the bytes dispatched and that unknown fields
  cannot bypass money budgets. Trusted BYOK prices remain configurable; documented
  surcharge floors and host-only credit pricing retain their existing behavior.
- **Credits calls rejected without a host price** (`meter`, `core`). A billable platform-funded
  call needs an explicit `estimate` from the host customer-price policy containing a quantity
  other than `requests`; empty and requests-only estimates are rejected. Without one,
  `Meter.quote` and `Meter.reserve` return `invalid` on `estimate`, even with a manual zero price
  or passthrough tracking, and nothing is counted or reserved. Catalog operations marked
  `billable: false` are still counted as passthrough without a charge. With a host estimate,
  billable platform calls always reserve; hosts supply the customer-charge receipt to settle
  their charge. `executeProviderRequest` records provider evidence only, retaining reservations
  for customer units absent from that evidence. Use a distinct unit such as `customer_cents`
  so provider cost in `cents` cannot be mistaken for a customer debit. Core
  `validateConnectionPolicy` rejects `passthrough` and `unpriced` tracking for them, and rejects
  nonempty `manualPrices` or `manualPriceBasis` on every platform connection; `null`, `{}` and
  omitted fields count as absent. Explicit platform estimates
  cannot use provider provenance (`manual`, `measured` or `list`); omit it for a host price.
- **Connection funding and namespace isolation** (`core`, `meter`, `providers`).
  `ConnectionPolicy.fundingSource` and catalog connection funding are required. Resolvers receive
  `{ namespace, connection }` and return the connection’s actual funding. Quote and new reserve
  reject a provider or funding mismatch, even without a catalog. A configured resolver returning
  no connection yields `invalid` on `estimate` with `unknown connection`, including explicit
  estimates. A resolved policy without valid funding yields `invalid` on `fundingSource` with
  `missing from the resolved connection policy`. Existing reservation replays stay exempt:
  they retain the frozen estimate and provenance without consulting the resolver, even after
  the connection's funding or provider changes.
  Billing imports resolve connections within their namespace and validate provider identity.
  Their funding attribution is a trusted historical projection, independent of current connection
  funding. Authorization, ownership, unresolved connections and provider mismatches remain
  `forbidden`. Rejected imports write nothing to the Store.
  The local server resolves only its `local` namespace and reports `byok`.
  Without a resolver, the host must derive `fundingSource` from
  trusted server state before calling Meter. Direct catalog callers that omit funding at runtime
  receive unknown pricing for billable calls, never provider prices.
- **One request from pricing to transport** (`core`, `providers`, private proxy/server).
  `matchOperation` is no longer exported by `@usagekit/providers`; use `catalog.match` or
  `PricedRequest.price`. `isJsonMediaType` is exported by `@usagekit/providers` and re-exported
  by `@usagekit/proxy`. `ProviderDescriptor.pricingInputs` is required and validated;
  custom descriptors must add it or `createCatalog` rejects them. Matching and option extraction
  see only declared body/query inputs; query constraints require `"query"`, and declared
  queries reject duplicate keys before admission.
  `executeProviderRequest` now takes `{ meter, catalog, request: PricedRequest, dispatch }`;
  `dispatch` preserves the priced method, body and non-authentication fields. Pass credentials
  separately to `dispatchPricedRequest(request, fetch, signal, { secret })`, which adds auth
  only to its transport copy without rewriting unrelated query bytes. The fourth argument
  is required; `null` explicitly selects unauthenticated transport. Pricing strips auth headers/query parameters and rejects
  cross-origin URLs or URL userinfo before matching; the snapshot never retains the injected
  secret. Whole requests can still contain caller data and should not be logged.
  Unknown operations normally reserve without an estimate, counting as unpriced or returning
  invalid without a hold. Execution does not dispatch them. Only the non-strict proxy opts
  into `allowUnknownDispatch: true` to reserve one request for an unpriced dispatch, with money
  budgets failing closed; strict proxy and recorder do not opt in.
- **Scoped proxy JSON normalization** (local proxy). Descriptors declare `pricingInputs`. Billable body-priced requests are parsed
  and re-serialized once; matching, admission and transport share an immutable `PricedRequest`. Every other request body is forwarded byte for byte with its
  original media type, including `+json` types and large numbers. Caller `Content-Length` and
  `Content-Encoding` are never forwarded; fetch sizes the forwarded bytes. See [proxy guarantees](PROXY.md#requests-and-credentials).
- **Authorized `Meter.quote(access, input)` over HTTP** (`core`, `meter`). A quote resolves the
  same estimate as a new reservation and returns quantities, provenance, tracking and the
  applicable budgets. `MeterQuote.estimateSource` is optional: explicit estimates without
  provenance omit the field, matching the stored reservation instead of inventing `unknown`.
  It requires `access.canReadBillingDetail`; otherwise it returns `forbidden` (HTTP 403).
  It also authorizes the principal, group, connection owner and access credential,
  and never creates an operation, counts a request, sweeps expiry, takes a lease or calls a
  provider. The repository's HTTP handlers serve `GET /v1/quotes`, including on read-only mounts,
  and the remote client sends it as a read. See
  [request quotes](PROVIDER-UI.md#request-quotes-and-byok-manual-prices) and
  [the quote API](PROXY.md#advisory-quote-api). The remote client validates quote responses and
  reports a malformed response as `RemoteUnavailable`. The repository's HTTP handler also
  validates responses. Generated OpenAPI budget-surface enums contain each accepted value once,
  including in quote responses.
- **Host composition APIs and credits price lists** (registry). Formatting callbacks reach the
  measurement, summary, cost, usage table, header and allocation blocks. Summaries gain plain
  variants, metadata/details slots and funding selection; cost cards can hide cost, funding and
  cost owners; exception lists paginate with host labels. Chain editors gain a controlled project
  mode, source selectors a controlled mode, provider cards host slots and actions, connect forms
  tested-credential, footer and OAuth policies, and the manager panel `childProps`. Every provider
  block takes `feedbackLabels`. Platform-funded rates render as a read-only credits price list in
  dollars; BYOK rates keep the rate editor.
- **Host form adapters and allocation options** (registry). Allocation editors and panels accept
  a `formAdapter` such as React Hook Form with Zod, input policies with stable validation codes and
  `blank: "unlimited"`, per-row labels and refresh visibility, native observations kept apart from
  Meter availability, aggregate refresh pending callbacks, an `emptyState` and structured feedback
  messages.
- **Draft rebase signal and refresh kind** (`react`). `useProviderEditor` accepts `onRebase`,
  called once after each successful explicit Reload rebases the draft, and `onReadRefreshChange`;
  `editor.refreshKind` is `"reload"`, `"revalidate"` or `null`. `ProviderAllocationPanel` forwards
  them through `formAdapter.rebase(drafts)` and `onReadRefreshChange`, so a host can fence
  dismissal during saves and explicit reloads but not background revalidation.
- **Allocation submit and refresh completion** (`react`, registry). Async form-adapter submissions
  share a synchronous in-flight guard that stays locked after success until refreshed identity
  props remount the editor. Repeated clicks and late validation continuations keep the original
  command's single `onSaved` callback. `onReadRefreshChange` sends `null` through the latest
  committed callback when a refreshing editor unmounts or its identity changes, releasing host
  dismissal fences. Discarded concurrent renders cannot replace that callback, and changing only
  the callback does not restart refresh notifications.
- **Independent credential policies** (registry). `requireNewCredentials` prevents stored-credential
  reuse without requiring a test. `requireTest` still requires a successful test of the current
  credentials and funding selection; when testing is unsupported, Save stays disabled and the
  new `labels.testUnavailable` notice explains why. Revision-only connection updates retain the
  credential draft and successful test. Test and reconnect use the draft's initial CAS revision,
  advanced only by this form's own successful test result with a matching command ID and non-null
  revision. Changes from elsewhere therefore conflict instead of overwriting newer credentials.
- **Budget overflow geometry** (registry). `usageCapFromBudget` preserves percentages above 100
  from used plus reserved exposure. `UsageCapPill` caps only the visual fill and shows the overflow
  notch while retaining the budget's authoritative alert level.
- **Strict host lint and accessibility guards** (registry). `npm run check:workspace` lints the
  blocks with Biome's recommended accessibility rules, `useExhaustiveDependencies` and
  `useIterableCallbackReturn`, and rejects import cycles, counting type-only imports. Header status
  pills are native buttons, filter labels point at their selects, and provider choices and the
  funding confirmation are named fieldsets.
- **Exceptions list principal option** (registry). `showPrincipal={false}` removes the Principal
  column from `ExceptionsList` and `ExceptionsListPanel` for hosts that withhold principal
  identities; the default keeps it.

Intended behaviour changes in the registry blocks:

- The provider conflict notice no longer appends the raw server reason. It shows the conflict copy
  from the labels or the host's structured message.
- An empty allocation snapshot shows no Save button and no read-only notice. The host
  `emptyState`, or the default empty copy, stands alone.

Upgrading from 0.8.0:

- Replace imports of `matchOperation` from `@usagekit/providers` with `catalog.match` or
  `PricedRequest.price`. `isJsonMediaType` now comes from `@usagekit/providers` and remains
  re-exported by `@usagekit/proxy`.
- Add the required, validated `ProviderDescriptor.pricingInputs` to every custom descriptor;
  `createCatalog` rejects a missing declaration. Declare `"body"`/`"query"` only when pricing
  reads them. `catalog.match` hides undeclared components, rejects undeclared query constraints
  and rejects duplicate keys in declared queries. DataForSEO uses `["body"]`, SerpApi `[]`.
- Migrate execution to `executeProviderRequest({ meter, catalog, request: priced, dispatch })`,
  where `priced` is a `PricedRequest.price` result. Pass trusted credentials separately as
  the fourth argument to `dispatchPricedRequest(priced, fetch, signal, { secret })`.
  It preserves the priced method, body and non-authentication fields and adds auth only
  during transport. The fourth argument is required (`null` for intentionally unauthenticated
  transport). Remove any pre-pricing auth injection; authentication headers/query
  parameters are stripped before matching. Cross-origin URLs and URL userinfo are rejected.
- Unknown operations are admitted without an estimate by default (BYOK unpriced count or
  invalid, no hold), and `executeProviderRequest` never dispatches them. Only the non-strict
  proxy uses `allowUnknownDispatch: true` for an unknown-cost dispatch with a one-request
  reservation; money budgets fail closed. Recorder and strict proxy do not opt in.

- Direct `catalog.estimate` callers must handle `InvalidInput` exceptions for malformed `depth`
  or `itemCount` (for example `depth: "abc"`). The list formula runs before manual/measured
  overrides, so even a whole-call override can throw. Meter converts these failures to
  `invalid` on `options`.
- DataForSEO list rows now apply item-count and clickstream formulas instead of flat
  prices. Ranked keywords and domain rank overview now include 0.012 cents per item on top
  of 1.2 cents per task (100 items by default); clickstream doubles the total. Backlinks
  summary adds one row at 0.0036 cents; history requires a defensible row count or whole-call
  BYOK estimate. Money budgets reject history without one. Review hard budgets: corrected
  estimates may reject requests sooner.
- DataForSEO SERP estimates now use `base * ceil(depth / 10)` for live and queued normal/high
  requests and direct catalog/Meter options. Omitted depth remains one page (10 results);
  explicit request depth must be a positive safe integer, and direct options use its decimal
  string representation. At depth 100, organic SERP now estimates 2.0 cents live (0.2 flat in
  0.8.0) and 0.6/1.2 cents queued normal/high. The full base per page is a conservative upper
  bound: later-page discounts and unreturned results can only lower the measured charge.
  Settlement still uses the measured response cost. `search_param` must be a string; `+` is
  replaced with space and percent-decoding repeats until stable within a fixed bound.
  Malformed `search_param` escapes and excessive nesting remain invalid; `"&nfpr=1"`
  is accepted. Keyword percent decoding is lenient. Operators and documented add-ons are
  priced using the full surcharge formula above, with conservative Unicode normalization
  and substring matching (`android:` includes `id:`). `stop_crawl_on_match` must be an
  array and retains the requested page bound; `find_targets_in` remains accepted.
  Unknown estimates replace the old early rejection for unlisted fields, `url`, opaque
  `offset_token`, enabled `include_seed_keyword`, limit zero and limits above 1,000.
  **Upgrade host requests:** stop sending fields that the endpoint does not document,
  for example `include_indirect_links` to `backlinks/backlinks/live`, `priority` to live
  SERP, or `include_clickstream_data` to domain rank overview or Backlinks. Such requests
  now have unknown estimates and fail money budgets closed, even with caller prices.
  Do not add these fields to another endpoint's allowlist to restore a base price.
  Missing counts alone retain whole-call override support; documented surcharges retain
  a list-price floor even with a lower manual/measured override or explicit BYOK estimate.
  See [supported pricing inputs](PROVIDERS.md#6-formulas-subscriptions-and-host-local-providers).
- BYOK money overrides now retain known native quantities. For example, a SerpApi manual
  money price also reserves one `units` search when its plan is known. A units budget that
  previously rejected that override with `missing_estimate_unit` can now admit it and reserve
  the native unit.
- Supply customer-charge evidence when using `executeProviderRequest` for platform funding.
  Its receipt contains the provider's cost, not the host price. Use a separate customer unit
  (such as `customer_cents`), which remains reserved/pending until the host supplies a receipt
  with that measurement. Do not reuse provider `cents` for a different customer charge: it
  would debit the provider amount. This clarifies the existing wrapper behavior; it does not
  add automatic customer settlement.
- A `Meter.quote` caller needs `access.canReadBillingDetail` in addition to scope/ownership
  access; otherwise the result is `forbidden` (HTTP 403). The remote client validates quote
  responses and reports a malformed response as `RemoteUnavailable`.
  OpenAPI budget-surface enums now omit duplicate `app` entries without changing accepted values.
- DataForSEO item-based estimates no longer fall back to the base price when a count is absent.
  Request extraction honors explicit `limit` from 1 through 1,000; only omission uses defaults:
  [ideas: 700](https://docs.dataforseo.com/v3/dataforseo_labs/google/keyword_ideas/live/),
  [suggestions: 100](https://docs.dataforseo.com/v3/dataforseo_labs/google/keyword_suggestions/live/),
  [related: 100](https://docs.dataforseo.com/v3/dataforseo_labs/google/related_keywords/live/),
  [pages: 100](https://docs.dataforseo.com/v3/dataforseo_labs/google/relevant_pages/live/), and
  [backlinks: 100](https://docs.dataforseo.com/v3/backlinks/backlinks/live/)
  (checked 2026-10-11; maximum 1,000 each), plus ranked keywords and domain rank overview
  at 100 each. These bound per-returned-item charges and price
  manual/measured item coefficients too. Supply `keywords` for keyword overview. Do not enable
  `include_seed_keyword`: its item-count effect is unconfirmed, so it yields an unknown estimate.
  [Historical rank overview](https://docs.dataforseo.com/v3/dataforseo_labs/google/historical_rank_overview/live/)
  has no documented default count or `limit`; do not derive a count from its default previous
  six months. Direct catalog/Meter callers must supply `itemCount` for every item formula.
  Without an extracted or explicit count, list and item-override estimates are
  unknown (`requests` only), and money budgets reject with `missing_estimate_unit` (422 from the
  local proxy). Whole-call BYOK manual and sufficiently sampled measured overrides still work.
- Billable DataForSEO request extraction now rejects malformed pricing fields with `InvalidInput`:
  `limit` must be a non-negative safe integer and SERP `depth` a positive safe integer
  (non-SERP depth remains non-negative); `priority` must be numeric 1 or 2,
  `keywords` must be an array of strings, and `include_clickstream_data` must be a boolean.
  Omitted fields retain their defaults. Numeric strings, null and other types are rejected,
  including with manual prices or passthrough tracking. Update callers that relied on coercion.
  Keys that match a pricing field only by case or Unicode compatibility form (`Depth`, `LIMIT`)
  yield unknown estimates. `undefined` fields count as omitted, as JSON serialization drops them, so an
  `undefined` `include_clickstream_data` no longer reserves the clickstream price.
- A present billable DataForSEO body must be a JSON array holding exactly one task object. JSON
  text, bare objects and empty or nested arrays are `InvalidInput` to `catalog.match`.
  `PricedRequest.price` accepts wire JSON or a host array, parses once and creates the only
  request value accepted by `executeProviderRequest`. A request without a body still matches
  with default options.
- For billable DataForSEO bodies, the local proxy recognizes `application/json` and `+json` media
  types case-insensitively, ignoring parameters, and forwards `JSON.stringify` of the priced value
  as `application/json`. Duplicate keys collapse to the last parsed value; original bytes are not
  preserved. JavaScript numeric re-serialization can round integers above `2^53 - 1` and turns
  overflowing numbers such as `1e400` into `null`; invalid pricing-field numbers are rejected.
  Billable DataForSEO bodies need a JSON media type: text, malformed JSON, other body shapes,
  multiple tasks and invalid pricing fields return 400 before reservation or upstream dispatch,
  including BYOK passthrough calls. Caller `Content-Length` and `Content-Encoding` are stripped
  when forwarding, including after canonicalization. All other proxy bodies, including free and unknown operations
  and other providers, retain their exact bytes and original media type; even malformed JSON is
  forwarded without parsing. Local fixture recording applies the same rules: billable
  body-priced text is parsed (untyped text defaults to JSON), while other text retains its
  bytes and media type. See [proxy guarantees](PROXY.md#requests-and-credentials).
- Split billable DataForSEO batches into single-task requests. Direct `catalog.match` callers
  must handle `InvalidInput: multiple DataForSEO tasks`; `PricedRequest.price` throws
  `RequestPricingError` before admission, and the proxy returns 400 `invalid_provider_request`.
  An explicit estimate does not bypass this rejection.
- The core `Meter` interface now includes `quote`. Custom Meter implementations must add it; the
  embedded Meter and the remote client already do.
- A platform-funded host that relied on list, manual or measured catalog prices, or on
  passthrough tracking, for billable calls must now pass its own customer-price `estimate`.
  Empty or requests-only platform estimates are invalid, regardless of applicable budgets.
  Explicit platform estimates labelled `manual`, `measured` or `list` are invalid; remove provider
  provenance from host prices. Without a host estimate, an unknown platform operation now
  returns `invalid`; 0.8.0 counted it as unpriced. Replays of existing reservations retain their frozen estimate
  and provenance, even after the resolved connection's funding or provider changes; those
  changes still apply to new quotes and reservations.
- **Breaking:** add the actual `fundingSource` to every `ConnectionPolicy`, `CatalogConnection`
  and `PricingCatalog.estimate` connection input. Missing funding no longer defaults to BYOK.
  Provider and funding must match the resolved connection, even without a catalog. Missing or
  invalid resolved funding is reported as `missing from the resolved connection policy`.
  Remove nonempty platform `manualPrices` and `manualPriceBasis` settings; both fields are
  BYOK-only, but `null`, `{}` and omitted fields are accepted as absent.
- **Breaking:** change each `ConnectionResolver` from `(connectionId)` to
  `({ namespace, connection })`. Resolve within that namespace for quotes, new reservations and
  billing imports. A configured resolver must return a connection for quotes and new reservations,
  including callers with explicit estimates; otherwise they return `invalid` on `estimate` with
  `unknown connection`. Existing reservation replays remain exempt. Hosts without a resolver must
  derive request funding on the server.
- **Billing imports:** with a resolver, `attribution.fundingSource` must match the connection's
  actual funding. A mismatch returns `invalid` on `attribution.fundingSource` with
  `differs from the connection funding source`; missing or invalid policy funding returns
  `invalid` on `fundingSource` with `missing from the resolved connection policy`.
  These failures write nothing. Authorization, ownership, unresolved connections and provider
  mismatches still return `forbidden`. Without a resolver, host-derived funding remains trusted.
- **Type change:** handle an absent `MeterQuote.estimateSource`. Explicit prices with no source
  now omit it, including over HTTP; `unknown` remains an actual pricing source, not a fallback
  label for a host price.
- Recopy allocation blocks to acquire the synchronous duplicate-submit guard for async form
  adapters. Repeated submissions during and after a successful save keep one command and one
  `onSaved` callback until refreshed identity props remount the editor; hosts must supply the new
  revision/rows before further editing. Late async validation cannot resubmit the saved draft.
  Read-refresh callbacks now receive `null` through the latest committed callback on unmount or
  identity replacement while refreshing; hosts may release their dismissal fence then, even if
  the old read has not finished. Callbacks from discarded concurrent renders are never used.
- The connect form now prioritizes its explicit `fundingSource` prop over
  `connection.fundingSource`; 0.8.0 preferred the connection value. Hosts should pass that prop
  only when deliberately choosing the draft's funding source. Changing funding or connection
  identity resets the draft. A revision-only change preserves it, as described below.
- Recopy credential blocks to separate `requireNewCredentials` from `requireTest`. Hosts that need
  both replacement and testing must set both flags. Localize `labels.testUnavailable` for a required
  test without a `test` capability; Save remains blocked. A connection revision update alone no
  longer clears entered credentials or their test result. Test and Save retain the draft's CAS
  base, advancing it only from this form's own successful test result when its command ID matches
  and its revision is non-null. An external rotation still conflicts; reopen the form with fresh
  data to start a new draft after resolving the conflict.
- `usageCapFromBudget().percent` may now exceed 100. Consumers with their own meters should clamp
  the visual fill while retaining the original percentage for overflow presentation. Header-bound
  projections still cannot infer overflow from remaining headroom alone.
- Copied `provider-allocation-editor` and `provider-manager-panel` blocks need `@usagekit/react`
  0.9.0 for the rebase and read-refresh signals.

## Release operators

Only `npm run release` can publish the allow-listed core, store, meter, providers, views, react
and store-postgres packages. Other workspaces stay private. Each candidate requires
separate approval of its exact SHA, squash title and seven public versions before promotion.
Live release requires clean main, its verified signed version tag, full checks, inspected
tarballs and a token-free consumer installation that checks declarations and React rendering.
A dry run on a clean branch builds and audits packages without checking live authorization or publishing.
Apache-2.0 LICENSE and NOTICE are included in every tarball.

## Trying an unpublished candidate

From its reviewed checkout, run `npm ci`, `npm run check`, `npm run build`,
`npm run check:packages` and `npm run check:consumer`. The last command packs all seven
packages, installs them into a disposable directory outside the repository with empty npm
configuration, compiles a strict TypeScript consumer and renders React on the server. It
uses the registry only for pinned external dependencies and never calls a provider.

To use the candidate in your own test application, run `npm pack --workspace <name>` for
each of the seven allow-listed packages and install those seven resulting tarballs together
with React 19 if you use the UI. Avoid `npm link`: it can hide missing package files and
resolve dependencies from the checkout. The existing 0.5.0 migration rules still apply to
custom Stores and Meters. Neither the 0.6.0 adapters and UI nor the 0.7.0 `useProviderEditor`
hook changes that accounting contract. 0.9.0 adds `quote` to custom Meters and requires host
prices for billable credits calls; see [what 0.9.0 adds](#what-090-adds).

Provider execution in this candidate uses the pricing boundary described in the upgrade notes
above. See the [provider contract](PROVIDERS.md#8-executable-wrapper-and-local-pricing).
