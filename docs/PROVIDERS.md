# Provider descriptor design (P5)

Status: P5 shipped in the 0.4.0 release and the P8 billing parser in 0.5.0; both are part of the published `@usagekit/providers` package. This file is the specification of the provider catalog and is kept in
sync with the types in `packages/core/src/providers.ts` and the `@usagekit/providers` package.

## 1. What a descriptor is

A descriptor is data plus a small amount of pure code that tells usagekit everything it needs
to price, route, meter and reconcile one provider. It lives in `@usagekit/providers`, one
directory per provider, and is loaded by hosts, the local server and the proxy through one
`Catalog` object. The core contract does not depend on descriptors; descriptors depend on core.

Facts the design rests on, verified on the first two providers:

- One provider reports cost per call in every response (`cost` at top level and per task) and
  exposes its price list and account identity through an API; its balance is prepaid money.
- The other provider reports no cost per call, only a search id; its account endpoint exposes
  the plan, the searches left, the renewal date and the account e-mail; its allowance is a
  monthly plan with purchasable extra credits.
- Both authenticate differently (basic auth versus query parameter) and both have free
  endpoints (account, user data) that must never be metered as paid.

## 2. Types (in `@usagekit/core`, no runtime)

```ts
export type ProviderId = string; // "serpapi", "dataforseo"
export type OperationId = string; // "search", "serp.google.organic.live"

export type ProviderAuth =
  | { kind: "query"; param: string }
  | { kind: "header"; name: string; prefix?: string }
  | { kind: "basic" }
  | { kind: "bearer" };

export type BillingUnit = "cents" | "units" | "requests";

export type ProviderPlan = {
  id: string;
  label: string;
  cycle: "monthly_plan" | "prepaid" | "trial" | "none";
  allowance?: { unit: BillingUnit; value: bigint };
  allowanceMode: "hard" | "soft";
  subscription?: { period: "month"; fee: Money; source: string; checkedAt: string };
};

export type PriceRow = {
  validFrom: string; // ISO date
  operation: OperationId;
  plan?: string; // plan id; absent = any plan
  option?: Readonly<Record<string, string>>; // request options that select this row
  overage?: true; // applies past the plan allowance
  unit: BillingUnit;
  perUnit: string; // exact decimal in that unit
  calculation?: PriceCalculation;
  source: string; // URL
  checkedAt: string; // ISO date
};

export type RequestMatch = {
  method: "GET" | "POST" | "PUT" | "DELETE" | "ANY";
  path: string; // pattern with :params and *
  query?: Readonly<Record<string, string | RegExp>>;
};

export type ProviderOperation = {
  id: OperationId;
  label: string;
  billable: boolean;
  match: readonly RequestMatch[];
  /** Options that move the price; values are extracted from the request by `options`. */
  optionKeys?: readonly string[];
  /** Exhaustive documented request fields; unknown fields prevent pricing. */
  requestPricing?: {
    source: string;
    formula: string;
    priceFields: Readonly<
      Record<
        string,
        {
          formula: string;
          unpricedWhen?: "present" | "true";
          defaultCount?: number;
        }
      >
    >;
    neutralFields: readonly string[];
  };
  /** Cost is known from the response body, only after a later call, or never per call. */
  costEvidence: "response" | "deferred" | "none";
  /** Idempotent replay is safe for this operation when the provider returns the same result. */
  cacheable?: { keyParams: readonly string[]; defaultTtlMs: number };
};

export type BalanceProbe = {
  operation: OperationId; // the free account endpoint
  fields: {
    remaining?: string; // JSON pointer
    remainingUnit?: BillingUnit;
    allowance?: string;
    used?: string;
    resetsAt?: string;
    plan?: string;
    accountIdentity?: string; // e-mail or login, for duplicate detection
    rateLimitPerHour?: string;
  };
};

export type PriceListSource =
  | { kind: "static" } // rows in the descriptor only
  | { kind: "endpoint"; operation: OperationId; pointer: string; mapping: "provider-specific" };

export type BillingExport = {
  kind: "task-history" | "daily-csv" | "none";
  operation?: OperationId; // for API-backed history
  granularity: "per-request" | "per-day";
  matchKey: "providerRequestId" | "window";
};

export type ProviderDescriptor = {
  id: ProviderId;
  label: string;
  upstream: string; // "https://api.example.com"
  auth: ProviderAuth;
  pricingInputs: readonly ("body" | "query")[];
  stripRequestHeaders?: readonly string[];
  billing: { unit: BillingUnit; cycle: ProviderPlan["cycle"] };
  plans: readonly ProviderPlan[];
  prices: readonly PriceRow[];
  priceList: PriceListSource;
  operations: readonly ProviderOperation[];
  balance?: BalanceProbe;
  billingExport: BillingExport;
  rateLimits?: readonly { scope: "account"; perMinute?: number; perHour?: number }[];
  docs: { pricing: string; api: string };
};
```

Core also exports `BalanceSnapshot` (optional `remaining`, `allowance`, `used` quantities,
`resetsAt`, `plan`, `accountIdentity`, `rateLimitPerHour`), `BillingLine` and
`validateDescriptor(d)`, which returns a typed list of `DescriptorProblem`: duplicate operation
or plan ids, an operation without `match`, price rows naming an unknown operation, plan or
option key, invalid price fields, a probe on an unknown or billable operation, and a price list
or billing export naming an unknown operation. The catalog refuses a descriptor with problems.

The only code in a descriptor lives beside the data, in the `providers` package. Extractors
take requests and responses as data, not web `Request` and `Response` objects: every extractor
is synchronous, and a request body stream cannot be read synchronously. `extract` returns a
receipt draft; the host wrapper adds the receipt id and timestamps.

```ts
export type ProviderRequest = {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
};
export type ProviderResponse = { status: number; headers?: Record<string, string> };
export type ReceiptDraft = Omit<Receipt, "id" | "supersedes" | "occurredAt" | "recordedAt">;

export type Extractors = {
  /** False means request uncertainty cannot be overridden by a host or BYOK price. */
  canEstimate?(options: Readonly<Record<string, string>>): boolean;
  /** Estimate before the call; empty means no list price. `listEstimate` is the default. */
  estimate(input: {
    operation: ProviderOperation;
    options: Record<string, string>;
    plan?: string;
    overage?: boolean;
    prices: PriceRow[];
  }): Quantity[];
  /** Options that select a price row, read from the request. */
  options(operation: ProviderOperation, request: ProviderRequest): Record<string, string>;
  /** Receipt from the response; body is fully read. Returns unknown cost when evidence is absent. */
  extract(
    operation: ProviderOperation,
    request: ProviderRequest,
    response: ProviderResponse,
    body: unknown,
  ): ReceiptDraft;
  /** Provider request id for replay and reconciliation, when present. */
  requestId(body: unknown): string | undefined;
  /** Parse the balance probe body; without it the catalog reads the declared JSON pointers. */
  balance?(body: unknown): BalanceSnapshot;
  /** Parse a price-list endpoint body into PriceRow[] (for priceList.kind endpoint). */
  priceList?(body: unknown, checkedAt: string): PriceRow[];
  /** Parse a billing export into matchable lines. */
  billingExport?(input: unknown): BillingLine[];
};
export type ProviderModule = { descriptor: ProviderDescriptor; extractors: Extractors };
```

Every extractor is tested against redacted fixtures under
`packages/providers/src/<id>/fixtures/<operation>/<case>.json` with request, response and the
expected receipt draft or parsed value. A fixture file has `origin` (`documentation` when
authored from public API documentation, `recorded` when written by the recorder, `synthetic`
for catalog tests), `provider`, `operation`, `request`, `response` (`status`, `body`) and
`expect` with any of `options`, `receipt`, `requestId`, `balance`, `priceList`
(`{ checkedAt, rows }`) and `billingLines`. Quantities and money are decimal strings. The
folder must name the operation.

A descriptor may advertise an operation only when at least one fixture exists for it.
`runDescriptorConformance(descriptor, extractors, fixturesDir)` from
`@usagekit/providers/testing` enforces that and checks every fixture. Because the package is
web runtime, `fixturesDir` is a map of path to parsed JSON, built in tests with
`import.meta.glob("./fixtures/**/*.json", { eager: true, import: "default" })`.

## 3. Rules

- **Free endpoints are operations too**, with `billable: false`. They are matched, counted and
  never reserved. The balance probe references one of them.
- **Operation identity is the pricing key.** `manual` overrides, tracking policy and budgets
  per operation all key on `OperationId`, never on a raw path.
- **BYOK estimate resolution** per connection: `manual` for (connection, operation), then `measured`
  from that connection's settled receipts when the sample is at least the catalog default (5),
  then the `PriceRow` matching (operation, plan, options, overage state), then `unknown`. A
  plan-priced descriptor with no plan on the connection resolves to `unknown`.
- **Price list from an endpoint** is a refresh source for `prices`, not a replacement: a pull
  request updates the rows with the fetched values and the check date; runtime never fetches
  prices to decide admission.
- **Cost evidence drives lifecycle.** `response`: settle on stream close. `deferred`: settle
  with unknown cost, keep `pending`, resolve through the task-get operation or billing export.
  `none`: settle with the estimate as `estimated`, reconcile from balance deltas or export.
- **Failures can cost money.** The extractor reads provider error codes and marks
  `failed: true` with the charged amount when the provider bills failures.
- **Options are request data, never guessed.** If an option that moves the price cannot be
  read from the request, the estimate is `unknown`; it must not fall back to a cheaper row.
- **Tracking policy** (`metered`, `passthrough`) lives on the connection, keyed by
  `OperationId`. Passthrough is a BYOK-only opt-out of spend enforcement. Billable
  platform-funded operations always reserve before dispatch and require host receipt evidence
  to settle the customer charge;
  tracking cannot waive credits charges. Core's `validateConnectionPolicy` rejects
  `passthrough` or `unpriced` for billable platform operations with an `invalid` tracking
  result, and rejects nonempty `manualPrices` and `manualPriceBasis` on platform connections.
  `null`, `{}` and omitted price fields count as absent; they never supply a credits price. Hosts
  must validate settings before saving; runtime also meters legacy tracking settings.
  The catalog exposes `operationsOf(providerId)` so hosts can render and validate the policy.
- **Host allowlist.** `createCatalog({ providers: [...descriptors], enabled: ["serpapi"] })`.
  Disabled descriptors are not matched; their operations are `unpriced`.
- **Account identity** from the balance probe is returned to the host as data. Duplicate
  detection is a host decision.
- **Implementer contract.** The only paid path in a host is the wrapper that takes a
  descriptor and does reserve, dispatch, extract, settle. `@usagekit/providers` ships an
  ESLint rule `usagekit/no-direct-provider-call` configured with the host's client module
  patterns; the rule reports imports of those modules outside an allowlist of wrapper files.

## 4. Catalog API

```ts
const catalog = createCatalog({ providers: [serpapi, dataforseo], enabled: ["serpapi", "dataforseo"], measuredMinSamples: 5 });
catalog.match(providerId, request) -> { operation, options } | { operation: "unknown" }
catalog.estimate(connection, operationId, options) -> { quantities, source: "manual"|"measured"|"list"|"unknown", priceVersion?, checkedAt?, sampleSize? }
catalog.extract(providerId, operationId, request, response, body) -> ReceiptDraft
catalog.requestId(providerId, body) -> string | undefined
catalog.probe(providerId, body) -> BalanceSnapshot
catalog.parsers(providerId) -> { priceList?, billingExport? }
catalog.operationsOf(providerId) -> ProviderOperation[]
catalog.plansOf(providerId) -> ProviderPlan[]
catalog.proposeBudget(providerId, planId, { namespace, connection, probe?, now? }) -> Budget
```

`connection` in `estimate` is `{ id, provider, fundingSource, plan?, manualPrices?: Record<OperationId, Quantity>,
manualPriceBasis?: Record<OperationId, "call" | "item">,
measured?: (operation) => { quantity, samples, basis?, checkedAt? } | undefined, overage? }` so the catalog stays
storage-free. Funding is required; a billable call with missing funding at runtime returns
`unknown` instead of defaulting to BYOK. `measured` reports its sample size; the catalog uses it only at or above
`measuredMinSamples`. `overage` is true when the host knows the plan allowance is exhausted, so
only `overage` rows apply.

For `Meter.quote` and new `Meter.reserve` calls, a configured connection resolver must return
a policy, even when the caller supplies an explicit estimate and no catalog is configured.
An unresolved connection returns `invalid` on `estimate` with `unknown connection`. A resolved
policy whose funding is neither `byok` nor `platform` returns `invalid` on `fundingSource` with
`missing from the resolved connection policy`, before comparing funding. Valid funding and
provider must match the request. Existing reservation replays do not consult the resolver or
revalidate current policy: their frozen estimate and provenance survive funding and provider
changes. New quotes and reservations still validate against the changed policy. With a catalog
but no resolver, explicit estimates follow the same validation as without either; the host must
derive funding from trusted state.

`Meter.importBilling` checks the connection provider within its namespace and verifies
permission and ownership. Its funding attribution is a trusted historical projection;
current connection funding is neither required nor compared. Authorization, ownership,
unresolved connections and provider mismatches remain `forbidden`, and write no import
records or operations. The host derives historical attribution from trusted records.

- **Match precedence.** The request must target the upstream origin and base path. Among
  matching operations the longest literal path wins (`:param` segments and a trailing `*`
  count nothing), then the most query constraints, then an exact method over `ANY`.
- **List rows.** A row must name the operation, match the connection plan (rows without a plan
  apply to any plan) and the overage state, and every option it names must equal a request
  option. Plan-specific rows beat any-plan rows, rows naming more options win, then the latest
  `validFrom` not after the catalog date. `priceVersion` is `<provider>:<validFrom>`.
- **Quantities.** A billable estimate always carries one `requests`, so request budgets never
  lack their unit; `unknown` carries only that request, so a money budget blocks it with
  `missing_estimate_unit`. A free operation estimates to nothing. Rows without `calculation`
  remain per-call prices; formula rows estimate requested depth/items. Actual charges always
  come from receipt evidence. Overrides replace only their own dimension, retaining known
  native units. Platform funding never falls back to manual, measured or list provider prices.
  Billable platform-funded calls require an explicit host customer-price estimate containing a
  quantity other than `requests`; empty or requests-only estimates are invalid. Provider
  provenance (`manual`, `measured`, `list`) is also invalid on these explicit estimates. Without one,
  `Meter.quote` and `Meter.reserve` return `invalid`, even with a manual price of zero or
  connection tracking set to `passthrough`. With a host estimate, these calls remain
  metered regardless of tracking. Catalog-declared nonbillable operations
  (`billable: false`) on a resolved connection remain
  admitted without an estimate and never create a charge: quotes contain no quantities,
  and reservations only count a passthrough request.
- **Proposed budget.** A plan with an allowance becomes a `provider_cycle` budget in the
  allowance unit ending at the probe's `resetsAt` (or one month from today), with an 80 percent
  alert. Hard plans block. Soft plans allow past the allowance with a proposed `hardLimit` at
  twice the allowance. A prepaid plan bounds the probe's `remaining` in a `since_reset` window.

## 5. First two descriptors

**Provider A (per-call cost, prepaid balance, basic auth).** Operations: live SERP advanced,
task post, tasks ready, task get, keyword ideas, keyword suggestions, related keywords, keyword
overview, ranked keywords, domain rank overview, historical rank overview, relevant pages,
backlinks summary, backlinks history, backlinks live, user data (free), labs status (free).
`costEvidence: "response"` for live, `"deferred"` for task post with resolution on task get.
Option `priority` with values `normal` and `high`. Balance probe on user data:
`money.balance` in cents, `login` as account identity, `rates.limits` for rate limits. Price
list source: endpoint `user_data` pointer `price`, mapping by `api.func_type.func_name.priority`
to `OperationId` plus option. Billing export: task-history through the same API, per-request,
matched by task id. Plan: single `prepaid`, `allowanceMode: "hard"`.

Implemented as `dataforseo` in `packages/providers/src/dataforseo/`. Operation ids follow the
path: `serp.google.organic.live.advanced`, `serp.google.organic.task_post`,
`serp.google.organic.tasks_ready`, `serp.google.organic.task_get.advanced`,
`dataforseo_labs.google.<function>.live`, `backlinks.<function>.live`, `appendix.user_data`,
`dataforseo_labs.status`. List rows are the per-task base price in cents, checked on the public
pricing pages; item formulas require an explicit or request-derived count for estimates, and actual per-result
charges come from the receipt. Receipts carry a `cents` measurement
equal to the reported cost, so money budgets settle; a task status of 40000 or more or an HTTP
error marks `failed: true` with the reported charge. Billable requests with multiple tasks are
rejected during catalog matching. `priority` is read from the single task in
the request body: numeric 1 or absent is `normal`, numeric 2 is `high`; other supplied
values are `InvalidInput` for billable operations. The task
post receipt keeps cost unknown with the task id; the billing export parser reads a task get
body into `BillingLine`s (task id, the post operation, the task's cost), which resolve the
pending post through `correct`. The price-list parser maps `price.<api>.<func_type>.<func_name>`
through a key table (for example `serp.task_post.organic`); the documentation example stops
before the price object, so the key layout follows the field schema until a recorded fixture
confirms it. The balance extractor converts `money.balance` from USD to cents and reports
`rates.limits.minute.total` per hour.

**Provider B (no per-call cost, monthly plan, query auth).** Operations: search (paid, unit
`units`, cost evidence `none`, request id from `search_metadata.id`), account (free), locations
(free). Balance probe on account: `plan_searches_left` remaining, `searches_per_month`
allowance, `this_month_usage` used, `plan_renewal_date` reset, `plan_id` plan,
`account_email` identity, `account_rate_limit_per_hour`. Plans from the public pricing page as
static rows with `allowanceMode: "hard"` inside the plan and `extra_credits` modelled as a
second `prepaid` plan row for overage; no per-call cost means settlement is `estimated: 1 unit`
and reconciliation compares `this_month_usage` deltas. Billing export: `none`.

Implemented as `serpapi` in `packages/providers/src/serpapi/`. Plans are the named tiers of
the public pricing page, checked 2026-09-25 (`free` 250, `starter` 1,000, `developer` 5,000,
`production` 15,000, `bigdata` 30,000, `searcher` 100,000, `volume` 250,000, `infrastructure`
500,000 searches per month); cloud and enterprise tiers are manual prices on the connection.
Plan ids other than `bigdata` (the account API example) are assumed until a recorded probe
confirms them. Every plan prices `search` at one unit; an `overage` row without plan prices the
extra credit drawn past the allowance, and `extra_credits` is the prepaid plan. A search
receipt is one estimated unit plus one measured request with zero estimated money: the plan
fee is not a per-call charge, so money inside a plan is never guessed per call. An errored
search consumes zero units. The balance probe uses the declared JSON pointers without an
extractor override.

## 6. Fixture recorder (local server)

`POST /providers/connections/:id/record` with `{ operation, request }` performs one real call
through the vault key, redacts secrets and account identity, stores request and response under
`<config-dir>/fixtures/<provider>/<operation>/<uuid>.json`, and returns the path. The CLI
exposes `usagekit provider record`. Recording follows the connection policy: billable metered calls reserve and settle, while free
and passthrough calls are counted without a reservation. The recorded file
is the input format the descriptor test suite expects, with an empty expectation to fill in
independently. The recorder uses the same `PricedRequest.price` boundary as the proxy.
A body-pricing descriptor parses JSON text once and canonicalizes billable bodies; untyped
recorder text defaults to JSON. A descriptor without body pricing preserves text byte for byte
and keeps the media type. Invalid billable JSON returns 400 before reservation. See
[contributing providers](CONTRIBUTING-PROVIDERS.md).

## 7. Exit gate for P5

- Types in core, `@usagekit/providers` with both descriptors, every advertised operation has a
  fixture and a passing extractor test, price list parser for provider A tested on a fixture,
  balance parsers for both tested, `proposeBudget` produces a valid `Budget` for each plan.
- Catalog tests: match precedence, unknown path, disabled provider, estimate resolution order
  on all four sources, deferred cost lifecycle in the memory store through Meter.
- Local server: connection `plan` and `tracking` fields, `provider record` command, catalog
  wired into `report reserve` so the estimate comes from the catalog when `--estimate` is
  omitted.
- Lint rule packaged and tested on a fixture project.
- Docs: `PROVIDERS.md` (this design, updated), `CONTRIBUTING-PROVIDERS.md` (how to add one:
  descriptor, fixtures, tests, price source, checked date).

## 8. Executable wrapper and local pricing

`PricedRequest.price({ meter, catalog, input, request })` matches once and reserves through
Meter, retaining the resolved estimate and admission result. Pass its result as `request` to
`executeProviderRequest({ meter, catalog, request, dispatch })`. Execution accepts only the
nominal `PricedRequest`, not a raw `ProviderRequest`. Its private constructor, frozen snapshots
and copied byte buffers prevent changes after pricing. A failed admission never dispatches.
Set `expectedOperation` during pricing to require a particular recorder operation before
reservation; `rejectUnknown` implements strict routing. Invalid request data throws
`RequestPricingError` before reservation. Hosts may map its safe `code` to their HTTP error.

Descriptors must declare `pricingInputs`; missing, duplicate or unknown entries make
`createCatalog` reject the descriptor. `catalog.match` enforces this declaration for every
caller: matching and option extractors receive a body only with `"body"` and a URL query only
with `"query"`. Method, URL origin/path and headers remain available. A query-constrained match
rule without `"query"` is invalid (`undeclared_query_input`). Declared queries reject duplicate
keys, including percent-encoded equivalents, with `InvalidInput` before admission. DataForSEO
declares `["body"]`, SerpApi declares `[]`, and the testing example declares `["query"]`.
Receipt extractors and fixtures retain the credential-free request. `matchOperation` is no longer
exported; use `catalog.match` or `PricedRequest.price`.
JSON media types are case-insensitive and include `+json`. Billable body-priced requests use
canonical JSON; other bodies preserve bytes. Pricing strips authentication headers and query
parameters and rejects cross-origin URLs or URL userinfo before matching. Use
`dispatchPricedRequest(request, fetch, signal, { secret })` inside `dispatch`; it preserves
the priced method, body and non-authentication fields, adding the descriptor's authentication
only to a transport copy. Query authentication appends its encoded pair without rewriting
other query bytes. The fourth argument is required; pass `null` only for an intentionally
unauthenticated transport. Common authentication-like fields such as `token`, `secret` and
`password` are stripped even when they are not the descriptor's auth field.
`PricedRequest` contains auth metadata, never the injected secret.
Avoid logging whole requests, which can still contain caller data. The recorder and proxy
share this transport boundary. `isJsonMediaType` is exported by `@usagekit/providers` and
re-exported by `@usagekit/proxy`.

Hosts can validate credentials before admission with `applyProviderCredentials(auth, url,
headers, { secret })` on disposable URL and Headers objects. The helper mutates those
objects and throws a sanitized `invalid_provider_credentials` error for invalid header
values. The proxy and recorder use this preflight so a locally invalid credential never
creates a reservation or a failed upstream-call record. The dispatch helper uses the same
application logic and rejects asynchronously on failure.

Unknown operations normally reach `meter.reserve` without an estimate, even if the caller
supplied one: the Meter counts BYOK as unpriced or returns invalid, leaving no reservation.
Execution never dispatches an unknown operation. Only the non-strict proxy opts into
`allowUnknownDispatch: true` to reserve one request with unknown cost and dispatch it;
applicable money budgets fail closed. The recorder and strict proxy never opt in.
The wrapper handles dispatch intent, response extraction and settlement, without rematching.
The wrapper submits the extractor's provider receipt; it does not convert a host estimate into
customer-charge evidence. For platform calls, reserve a separate customer unit such as
`customer_cents` and have the host settle that measurement. Until the host supplies it, the
operation stays pending and the customer reservation remains held. Reusing provider `cents`
for a different customer price debits the provider amount, not the host estimate. Keep the
provider spend in `receipt.cost` when adding host measurements.
Only the first grant dispatches. Replays, unknown routes and denied reservations never call
the transport. Finish reading the response before the transport callback resolves. Transport failures retain unknown cost in a pending operation. Accounting
failures are returned separately so hosts can recover them without repeating the paid call.
Deferred evidence still requires the host's later correction; a reconciliation worker is P8.

Local connections accept `manualPrices` as operation-keyed wire quantities (`value` is an
integer string, `scale` is 0..18, `unit` is the provider's billing unit), and an explicit boolean
`overage`. Omitted fields survive key rotation; an empty price map removes manual overrides.
Overage comes from a confirmed allowance state, not a guessed balance. The local server uses
an upper median of successful, uncached, measured, settled receipts from the same connection
and operation in the preceding 30 days. Five samples are required. A truncated 1,000-operation
sample falls back to list pricing. Prices are estimates across the operation's observed options;
hosts requiring option-specific forecasts should keep their own explicit estimates.

The default coverage view now combines Meter usage with persisted passthrough, unpriced,
cached and rate-limited counters. Without an external CoverageSource, select whole UTC days.
Forbidden or incomplete counter reads produce an unavailable/forbidden view, never a zero.

## 6. Formulas, subscriptions and host-local providers

These additions belong to the 0.9.0 source cohort; they are absent from published 0.8.0.
`PriceRow.perUnit` remains the base/per-call list price. Optional `PriceCalculation` is:

```ts
type PriceCalculation =
  | {
      kind: "additional_pages";
      depthOption: string;
      pageSize: number;
      additionalPageFactor: string;
    }
  | {
      kind: "option_multiplier";
      multiplierOption: { key: string; value: string; factor: string };
    }
  | {
      kind: "base_plus_items";
      itemCountOption: string;
      perItem: string;
      multiplierOption?: { key: string; value: string; factor: string };
    };
```

Calculations use exact nonnegative decimal strings, BigInt counts and quantities; they
never round a coefficient. Descriptor validation checks option keys, positive integral
page size and coefficients. An additional-pages row estimates
`base + base * additionalPageFactor * (ceil(depth / pageSize) - 1)`.
A base-plus-items row estimates `(base + perItem * itemCount) * multiplier`, where the
multiplier applies only when its declared option value matches. An option-multiplier row
applies that multiplier to the request's base charge, with no per-item component. Omitted
depth retains one base page. An omitted item count returns unknown pricing, never a base-only
estimate: `listEstimate` returns an empty array and `catalog.estimate` returns only `requests`
with source `unknown`. A bounded money unit then fails admission with `missing_estimate_unit`.
DataForSEO request extraction supplies the documented default only when `limit` is omitted.
`limit: 0` and limits above 1,000 have no documented meaning and produce an unknown estimate, never a default or
base-only reservation. These counts bound per-returned-item billing. Direct catalog/Meter callers
supply `itemCount`; they do not run request extraction or inherit its defaults. An explicit
`itemCount: "0"` is a host-supplied count and still prices the base. Item overrides without a
count return unknown pricing. Whole-call BYOK overrides remain usable without a count.

The DataForSEO list formulas, in cents, use the documented
[Labs](https://dataforseo.com/pricing/dataforseo-labs/dataforseo-google-api) and
[Backlinks](https://dataforseo.com/pricing/backlinks/backlinks) coefficients:

| Request                                                |    Estimate |
| ------------------------------------------------------ | ----------: |
| Live organic, one page                                 |         0.2 |
| Normal/high queued organic, one page                   | 0.06 / 0.12 |
| Live organic, depth 11 / depth 100                     |   0.4 / 2.0 |
| Normal/high queued organic, depth 100                  |   0.6 / 1.2 |
| Keyword overview or ranked keywords, 1,000 items       |        13.2 |
| Ranked keywords, 1,000 items with clickstream          |        26.4 |
| Ideas/suggestions/related/pages/domain rank, 100 items |         2.4 |
| Research, 100 items with clickstream                   |         4.8 |
| Backlinks rows, 100 rows                               |        2.76 |
| Backlinks summary, one row                             |      2.4036 |
| Backlinks history, three explicitly supplied rows      |      2.4108 |

All ordinary Labs rows, including ranked keywords and domain rank overview, use base 1.2
plus 0.012 per item. Historical rank overview uses base 12 plus 0.12 per item. Enabling
`include_clickstream_data` doubles the entire Labs estimate where the endpoint documents it. Backlinks rows, summary and
history use base 2.4 plus 0.0036 per row, without a clickstream multiplier. Summary extracts
`itemCount: "1"`; history has no documented request count, so its extracted estimate remains
unknown. Supply a defensible `itemCount` through the direct catalog/Meter API or a whole-call
BYOK estimate. A missing count alone does not prohibit whole-call manual or sufficiently sampled measured overrides, or an explicit host estimate on the request path. Without one, money budgets fail closed with `missing_estimate_unit`.

Request extraction reads `keywords.length` for keyword overview and `limit` for the operations
below. The defaults were checked in DataForSEO documentation on **2026-10-11** (maximum 1,000):

| Operation            | Default `limit` / `itemCount` | Source                                                                                         |
| -------------------- | ----------------------------: | ---------------------------------------------------------------------------------------------- |
| Keyword ideas        |                           700 | [DataForSEO](https://docs.dataforseo.com/v3/dataforseo_labs/google/keyword_ideas/live/)        |
| Keyword suggestions  |                           100 | [DataForSEO](https://docs.dataforseo.com/v3/dataforseo_labs/google/keyword_suggestions/live/)  |
| Related keywords     |                           100 | [DataForSEO](https://docs.dataforseo.com/v3/dataforseo_labs/google/related_keywords/live/)     |
| Ranked keywords      |                           100 | [DataForSEO](https://docs.dataforseo.com/v3/dataforseo_labs/google/ranked_keywords/live/)      |
| Domain rank overview |                           100 | [DataForSEO](https://docs.dataforseo.com/v3/dataforseo_labs/google/domain_rank_overview/live/) |
| Relevant pages       |                           100 | [DataForSEO](https://docs.dataforseo.com/v3/dataforseo_labs/google/relevant_pages/live/)       |
| Backlinks rows       |                           100 | [DataForSEO](https://docs.dataforseo.com/v3/backlinks/backlinks/live/)                         |

These estimate 9.6 cents for ideas (19.2 with clickstream), 2.4 for the other Labs defaults
(4.8 where clickstream is documented), and 2.76 for backlinks. Domain rank overview does
not list `include_clickstream_data`, so supplying it makes that request unknown. Manual/measured item coefficients use the same
count. Positive explicit limits override the defaults. Keyword ideas' keywords are seeds,
not the billed count. `include_seed_keyword` is only documented on suggestions and related
keywords; on those endpoints true remains unknown because an extra item is unconfirmed.
On any other endpoint this field is unlisted, even when false. Keyword overview without `keywords`
and [historical rank overview](https://docs.dataforseo.com/v3/dataforseo_labs/google/historical_rank_overview/live/)
without a host-supplied count remain unknown. A default date range does not establish a count.

SERP [live](https://docs.dataforseo.com/v3/serp/google/organic/live/advanced/) and
[task post](https://docs.dataforseo.com/v3/serp/google/organic/task_post/) retain the documented
default depth of 10. Explicit request depth must be a positive safe integer; direct
catalog/Meter options use its decimal string representation. Every 10-result page reserves
its full base: `base * ceil(depth / 10)`, using `additional_pages` with
`additionalPageFactor: "1"`. At depth 100, organic SERP now estimates 2.0 cents live
(0.2 flat in 0.8.0) and 0.6/1.2 cents queued normal/high. The
[pricing page](https://dataforseo.com/pricing/serp/google-organic-serp-api) multiplies for each
10 results, and the [cost formula](https://dataforseo.com/help-center/serp-api-cost-explained)
charges a full base for page 2. The conflicting
[25% later-page discount](https://dataforseo.com/help-center/above-100-results-with-serp-api)
can only lower the charge; unreturned results are refunded. Full base per page is therefore
a conservative upper bound. A production receipt check on **2026-10-11** also supported
full-base-per-page billing rather than the older discounted formula. This observation
does not replace the provider's current price terms. Settlement still uses the measured
response cost.

Every billable DataForSEO operation declares `requestPricing`: the endpoint documentation
URL, its formula, the fields that affect pricing, and an exhaustive list of documented
fields that add no separate charge within the bounded result count. The inventories were
fetched on **2026-10-11** and live in
[`request-pricing.ts`](../packages/providers/src/dataforseo/request-pricing.ts).
They cover both SERP endpoints, all eight Labs endpoints and all three Backlinks endpoints.
Unlisted fields, including new fields and alternative key spellings, make the estimate
unknown. Undefined values are omitted, matching JSON serialization. Neither manual/measured
BYOK overrides nor an explicit host or credits estimate can override this uncertainty:
`PricedRequest.price` discards caller `estimate`, `estimateSource` and `providerPriceVersion`,
then reserves `[{ unit: "requests", value: 1n, scale: 0 }]` with source `unknown`.
The Meter decides admission: money budgets fail closed with `missing_estimate_unit`
(the proxy returns **422** `cannot_estimate_bounded_usage`), BYOK passthrough still passes
through, and BYOK without money budgets reserves and dispatches with unknown estimated cost.
A response can still establish measured cost. Credits remain exclusively host-priced;
uncertain credits requests are rejected even when the caller supplies a credits estimate.
This non-overridable uncertainty applies to unlisted fields, undocumented limit values,
`url`, `offset_token` and enabled `include_seed_keyword`, not to a missing item count alone.

SERP uses `P = max(ceil(depth / 10), max_crawl_pages)` (omitted values mean one page),
with base `B` equal to 0.2 cents live, 0.06 queued normal, or 0.12 queued high priority.
`calculate_rectangles: true` and `load_async_ai_overview: true` each add 0.2 cents live or
0.06 queued according to the endpoint docs. For high priority the bound uses 0.12 cents each,
the larger one-base amount on the [pricing table](https://dataforseo.com/pricing/serp/google-organic-serp-api)
and [cost guide](https://dataforseo.com/help-center/serp-api-cost-explained).
`people_also_ask_click_depth` accepts 1 through 4 at 0.015 cents per click.
These are upper bounds, not predictions of the final invoice: to cover uncertain page and
operator interactions, reserve every add-on on every page, then apply the operator multiplier
to the entire amount: `P * (B + rectangles + async + 0.015 * clicks) * 5^N`.
When a request carries a documented surcharge (operators, rectangles, async overview,
click depth, crawl-page control, or Labs clickstream), manual and measured
BYOK prices (whole-call or item basis) reserve the **larger of the override and the full documented list upper bound**.
Explicit BYOK request estimates retain this same floor. This also preserves any native
units. Credits are never assigned a provider or BYOK price. Missing counts still permit
whole-call overrides, but an override cannot repair request uncertainty.

`N` counts distinct documented operator substrings across `keyword` and `search_param`.
Keyword decoding is lenient: valid `%XX` sequences are decoded repeatedly within the
16-pass bound, while other percent signs remain literal (`50% off shoes`, `100% cotton`).
Both the original and decoded forms are checked. `search_param` remains strict: `+` becomes
space, malformed escapes or excessive nesting are invalid input.
For each form, matching checks NFKC lowercase, NFKC uppercase then lowercase, and NFKD
with combining marks and `Default_Ignorable_Code_Point` characters removed, then lowercase.
This conservatively covers `İNURL:`, soft hyphens and combining marks. Matching uses
substrings because the endpoint docs say “contains”: `android:` includes `id:`. Distinct
operators multiply by five each; overlapping documented substrings also contribute.
The [documented `-site:` exception](https://dataforseo.com/help-center/rules-and-limitations-of-keyword-and-keywords-fields-in-dataforseo-apis)
is applied separately to every form. Operator matching inside `search_param` is a
conservative bound because a separate charge there is not confirmed.

`stop_crawl_on_match`, `find_targets_in`, and the other documented target controls add no
charge above the requested page bound: the
[stop-on-match guide](https://dataforseo.com/help-center/using-the-stop_crawl_on_match-parameter-in-serp-api)
confirms unused pages are refunded. A rank check with depth 100, `search_param: "&nfpr=1"`
and `stop_crawl_on_match` remains priced and dispatchable. `url` is documented but remains
unknown because the provider derives other request fields from it. History date ranges
yield an unknown list estimate until a defensible count or whole-call override is available. Labs `offset_token` requests
remain unknown: the [ideas](https://docs.dataforseo.com/v3/dataforseo_labs/google/keyword_ideas/live/)
and [suggestions](https://docs.dataforseo.com/v3/dataforseo_labs/google/keyword_suggestions/live/)
docs state that the token ignores every supplied parameter except `limit`, so a previous
clickstream setting cannot be bounded from the new task alone.

Pricing fields retain documented JSON types. SERP depth must be a positive safe integer,
`max_crawl_pages` must be 1–100, priority is numeric 1 or 2 on task post, paid flags are
boolean, keywords are strings, and stop targets are arrays. Unsupported fields never become
priced merely because they resemble a documented field.
The original base-price provenance dates and raw recorded price-list response are retained;
formula metadata and expected parsed rows reflect these corrections. Price-list parsing
refreshes bases and retains static calculation metadata; it does not fetch runtime pricing.

Generated regression properties cover every billable DataForSEO operation with 100 cases
per property and a replayable seed. A separate exact-arithmetic oracle transcribes the
documented charge bounds rather than importing production formulas. The suites exercise
media-type casing, duplicate and escaped JSON keys, unknown fields, Unicode operators,
surcharge combinations and numeric edges. They verify one match, unchanged priced body
bytes at transport, fail-closed unknown money/credits estimates and trusted BYOK overrides.
The list bound applies to default pricing and documented surcharge floors; it does not
silently replace an ordinary host-configured BYOK price or a trusted whole-call estimate.
Run the suites with `npm run test:unit`; failures include the replay seed and shrink path.

The catalog prices one DataForSEO task at a time. `catalog.match` throws
`InvalidInput: multiple DataForSEO tasks` for a billable body with more than one task, and
`InvalidInput` for any other present billable body that is not a JSON array holding one task
object (JSON text, bare objects, empty or nested arrays); a bodyless request keeps defaults.
On these rejections `PricedRequest.price` throws `RequestPricingError` before admission, even with an explicit estimate. The local
proxy returns 400 `invalid_provider_request`. Split a batch into single-task calls. Receipt
extraction and billing imports still use the provider's reported costs, including historical
batch receipts.

`ProviderPlan.subscription` contains the monthly fee as exact USD `Money`, source and
check date. SerpApi native allowance, monthly fee, displayed amortization and host customer
charge are separate. Search estimates remain one native unit; successful receipts retain
estimated zero marginal money. Never settle the monthly fee on each search. The default
host rank estimate may select `production`, divide fee by included searches exactly, and
multiply by `ceil(depth / 10)`; project to six decimal places only at the public host
boundary. Keep a rational numerator/denominator for non-terminating division. The marketing
calculator uses the selected monthly fee. A host may retain its supported plan-ID list
through `bigdata`; the catalog also retains `searcher`, `volume`, `infrastructure` and
`extra_credits`. Customer markup and exact-divisibility checks stay with host policy.

### Host-supplied local sequence

Supply the local module beside the host's deterministic provider, using `ProviderModule`.
It has a genuine zero cents row, a metered operation and local settlement evidence. A
minimal descriptor uses the host's operation ID and source URL:

```ts
const localSequence: ProviderModule = {
  descriptor: {
    id: "local-sequence",
    label: "Local sequence",
    upstream: "https://local-sequence.invalid", // Identity only; host runs it locally.
    auth: { kind: "bearer" },
    pricingInputs: [],
    billing: { unit: "cents", cycle: "none" },
    plans: [],
    prices: [
      {
        validFrom: "2026-07-26",
        operation: "rank_check",
        unit: "cents",
        perUnit: "0",
        source: "https://example.com/local-sequence",
        checkedAt: "2026-07-26",
      },
    ],
    priceList: { kind: "static" },
    operations: [
      {
        id: "rank_check",
        label: "Local rank check",
        billable: true,
        match: [{ method: "POST", path: "/rank-check" }],
        costEvidence: "response",
      },
    ],
    billingExport: { kind: "none", granularity: "per-request", matchKey: "providerRequestId" },
    docs: {
      pricing: "https://example.com/local-sequence",
      api: "https://example.com/local-sequence",
    },
  },
  extractors: {
    estimate: listEstimate,
    options: () => ({}),
    requestId: () => undefined,
    extract: () => ({
      measurements: [
        { unit: "cents", quantity: { unit: "cents", value: 0n, scale: 0 }, certainty: "measured" },
        requestsMeasured(),
      ],
      cost: { certainty: "measured", money: { currency: "USD", units: 0n } },
      cached: false,
      failed: false,
    }),
  },
};
const catalog = createCatalog({
  providers: [dataforseo, serpapi, localSequence],
  enabled: ["dataforseo", "serpapi", "local-sequence"],
});
const visitorProviders = catalog.providers().filter((p) => p.id !== "local-sequence");
```

Replace the example source and dates with the host's actual provenance. Keep the local
provider enabled for in-app estimates and existing public rate-card projections, while
excluding it from the visitor's selectable providers. Do not register it as a fallback:
an unknown provider must stay unknown. The generic catalog has no implicit local provider
and no legacy price table. See the tested host module in `pricing-formulas.test.ts`.

## Provider administration concurrency

The 0.9.0 credential form retains the connection revision from when its draft opened. Test and
reconnect send that CAS base; only the form's own successful test with a matching command ID and
non-null result revision advances it. Revision-only read updates preserve the entered credentials
and test result without adopting an external rotation's revision. Hosts must reject stale CAS
commands; reopening with fresh data starts a new draft after a conflict.

Allocation editors keep successful saves fenced until refreshed identity props remount them,
including success found through reconciliation. Repeated clicks or late async form validation
cannot apply the old draft again or emit a second completion callback. Hosts must deliver refreshed
revision/row identity before further editing; non-success outcomes retain normal recovery rules.

Refresh cleanup uses the latest committed `onReadRefreshChange` callback. Discarded concurrent
renders cannot redirect the final `null` notification to an uncommitted host fence. See
[provider UI contracts](PROVIDER-UI.md) for composition and refresh details.
