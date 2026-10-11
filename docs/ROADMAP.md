# usagekit roadmap

Established: 2026-09-24. Owner: Michal. Repository status reviewed: 2026-10-09.
This is the bird's-eye view. [PLAN.md](PLAN.md) holds the
engineering contract, constraints and stage exit gates; this file holds purpose, model,
current position and the order of work. When they disagree, this file wins on order and scope,
PLAN.md wins on contract detail.

## 1. What usagekit is

usagekit meters what a user spends at third-party API providers through an application.
The user connects a provider key, or the application funds calls from a shared platform key.
Every paid call becomes an operation with a reservation, a dispatch grant, a receipt and a
settlement. Budgets bound the spend per user, project, connection, access token or shared pool,
per surface (app or programmatic) and per window (calendar month, provider cycle, since reset).
The local ledger is the source of truth; provider balances are reconciliation signals.

It is not a billing system for the application's own customers. That is what OpenMeter, Stripe
Meters or Metronome do. usagekit sits one level below: it counts the upstream cost the
application incurs on behalf of each user, and it can feed that into any of those systems.

## 2. Who uses it and why

- **An application developer (embedded mode).** They already wrap provider calls somewhere.
  They add `@usagekit/core`, `meter` and a store adapter, map their users and connections onto
  the scope model, and get atomic admission, budgets, replay-safe accounting, recovery after
  crashes and a queryable usage ledger. They do not rewrite provider clients. They keep their
  own authentication, routing, product billing and UI.
- **A single developer or agent operator (local server).** They run `usagekit serve`, store
  keys in the encrypted vault, set budgets, and report or proxy calls through it. A client
  that can use the proxy endpoint gets spend enforcement without a metering wrapper in its code.
- **A team building a new product on Cloudflare or similar.** They start from the Worker
  example and the Cloudflare Store instead of designing metering from scratch.

The reason to use it instead of writing it: the parts that are hard are not the counting. They
are concurrency under a shared limit, crashes between reservation and settlement, unknown costs
that are not zero, corrections that must not erase evidence, and exact money without floats.
usagekit ships those as a conformance suite that every adapter must pass.

## 3. Who is measured: the scope model

Every operation carries the full scope, so usage can be grouped by any dimension later.

| Field              | Meaning                                              | Typical host mapping                                   |
| ------------------ | ---------------------------------------------------- | ------------------------------------------------------ |
| `namespace`        | One deployment or tenant partition                   | one per environment                                    |
| `principal`        | Who is billed and who owns the budget                | the user, or the team in team-owned hosts              |
| `group`            | How the principal organizes work                     | project, workspace, site                               |
| `connection`       | One provider key the principal or platform connected | provider connection row                                |
| `accessCredential` | Which token or client called the application         | API key, personal token, OAuth client, MCP client      |
| `actor`            | Who acted inside the principal                       | team member, guest session                             |
| `fundingSource`    | Whose key paid upstream                              | `byok` for the user's key, `platform` for a shared key |
| `platformPools`    | Shared caps a platform-funded call draws from        | free-tier pool, hosted provider pool                   |

Two shapes cover the hosts seen so far:

- **User-owned.** The user connects keys, projects are folders under the user, the user pays.
  `principal` is the user, `group` is the project. "Project A used this much, project B that
  much" is a `groupBy: group` query under one principal. Project and user are different fields
  even when one user has one project.
- **Team-owned.** The team pays, members act. `principal` is the team, `actor` is the member.
  Per-member limits are today a host responsibility; a per-actor budget scope is on the list of
  additions (section 8).

Access to N providers per user is the connection list under the principal, filtered by the
provider allowlist the host configures (section 9). Each connection has its own budgets per
surface; the principal can have an overall cap on top.

A connection is one account at one provider. Several accounts at the same provider, for a user
or for the platform, are several connections with their own budgets, plans, probes and
operations; nothing in the core limits accounts per provider. Grouping across connections is
by `groupBy` (`provider`, `connection`, `platform_pool`, and from P4 `funding_source` and
`tag`). Tags are free labels the host or user puts on a connection ("production", "eu",
"team-x"); they are snapshotted into the operation scope at reservation so later relabeling
never rewrites history. A `tag` budget scope bounds every connection carrying the tag, which
covers "all accounts at provider X", "all production accounts" or "region EU" with one
mechanism. Descriptors name the provider-side account identity (an account e-mail or login from
the balance probe) so a host can detect the same account connected twice.

## 4. Backend only, or UI too

Backend only is a complete product. A host that already has an admin panel and a settings page
needs `core`, `meter`, a store adapter and the mapping. Nothing else is required.

UI is layered so a host takes exactly as much as fits:

1. **View models.** Pure functions over `Meter`: usage table rows, budget status rows,
   exceptions, and a compact status line for a header. Amounts arrive as decimal strings with
   unit and certainty; "unavailable" is a distinct state, never zero. No React, no styling.
   This is the layer every host should use, because money formatting, certainty and pagination
   are exactly where hand-written panels go wrong.
2. **Hooks.** `@usagekit/react` over the same view models for hosts with a `Meter` on the
   client (remote Meter over HTTP). Server-rendered hosts skip this layer and call view models
   from server code.
3. **Reference components.** A shadcn registry: usage table, measurement and cost cards,
   budget cards and editors, exceptions queue, period and scope filter, header status,
   connection list. Each block exists for Radix (`new-york`) and Base UI (`base-vega`),
   styled with semantic tokens. Hosts copy blocks into their
   tree with `shadcn add`; the copied code imports the host's own `@/components/ui/*`
   primitives. A host with its own design system reads the block and rebinds primitives or
   writes its own component over the view model.
4. **Pages.** Always the host's: authentication, authorization, audit, routing, translations.

An external dashboard needs no extra layer. The host mounts the read side of `@usagekit/http`
on one route with its own authentication mapped to `AccessContext`; the dashboard uses
`createRemoteMeter` and the same view models, or the generated OpenAPI from another language.
Command routes stay off in embedded hosts, where operations are created in process. Until a
host is authoritative, such a dashboard shows the metering ledger, not the host's billing
numbers; the host's comparison page shows the difference.

Personal access, meaning one person seeing their usage across every application that uses
usagekit, is a hosted service and stays out of scope until the embedded and local modes are
proven. The scope model already keeps `principal` independent of any host user table so that
door stays open.

What the component library buys: correctness that is hard to get right (money, certainty,
unavailable states, cursors), speed for new hosts and examples, a recognizable vocabulary
across applications, and a live demo of the library. What it costs: two primitive variants to
maintain and a registry to test against both.

## 5. What the community gets

- **A provider catalog to maintain together.** One declarative descriptor per provider: auth
  scheme, operations with request matching, price table versions with source and check date,
  receipt extractors with recorded fixtures, balance probes, reset-date source. When a provider
  changes a price or a response field, the fix is a pull request to one file with a fixture.
  This is the LiteLLM model applied to usage, not to model routing.
- **A fixture recorder.** The local server can record a redacted request and response pair for
  an operation on request, so contributing a descriptor for a new provider does not require
  reading undocumented responses by hand.
- **A conformance suite.** Anyone can write a store adapter for their database and prove it
  with the same tests the built-in adapters pass, including the scaling gate and the race tests.
- **A local server** for personal use, with the proxy as the zero-code enforcement path.
- **A registry of UI blocks** for both primitive families.

## 6. Where we are

This is a repository snapshot, not a live audit of npm, Cloudflare or a host deployment.
Public source: <https://github.com/usagekit/usagekit>. Website: <https://usagekit.dev>.
The reviewed public main at `203f084` contains the React UI, Postgres adapter and P8
billing imports. The four-package 0.5.0 cohort was verified without registry credentials
on 2026-10-07. The seven-package 0.6.0 cohort is published; all seven versions were verified
without registry credentials on 2026-10-09. The seven-package 0.7.0 cohort was published on
2026-10-09 through `release.yml` from the signed `v0.7.0` tag; all seven versions were verified
without registry credentials the same day. The seven-package 0.8.0 cohort, which adds
`ProviderRate.fallback` to `@usagekit/views`, was published on 2026-10-09 from the signed `v0.8.0`
tag after the repository moved to the usagekit organization; all seven versions were verified
without registry credentials the same day. The 0.9.0 source cohort adds pricing formulas with
BYOK-only manual prices, host-priced credits calls, authorized `Meter.quote` over HTTP, host
composition and form adapter APIs for the registry blocks and React draft rebase signals; it
awaits exact-source approval and publication. See [what 0.9.0 adds](CONSUMING.md#what-090-adds).
Source promotion, npm publication and host integration have distinct receipts.

| Item                                 | State on 2026-10-11                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1 core, store, meter                | On `main`: embedded Meter, shared conformance suite and property tests.                                                                                                                                                                                                                                                                       |
| P2 SQLite, HTTP, client, server, CLI | On `main`: durable local storage, authenticated API and CLI, encrypted vault, reservation expiry and restart recovery.                                                                                                                                                                                                                        |
| P4 contract and UI                   | On `main`: source and tag budgets, soft/hard limits, view models, React hooks, Radix/Base UI registry and local server UI. Host adoption is a separate check. See [UI](UI.md).                                                                                                                                                                |
| P5 provider catalog                  | On `main`, tagged `v0.4.0`: descriptors, pricing, fixture extraction/recording and the wrapper boundary.                                                                                                                                                                                                                                      |
| P6 local proxy                       | On `main`: routed provider dispatch, budget enforcement and crash recovery. See [PROXY](PROXY.md).                                                                                                                                                                                                                                            |
| P7 Cloudflare storage                | Approved on local `main`: authoritative SQLite-backed Durable Object storage and Worker example. Direct D1Database support remains unimplemented.                                                                                                                                                                                             |
| Library release                      | The seven-package 0.8.0 cohort is published. It adds `ProviderRate.fallback` to the views package; the other six packages moved in lockstep without functional changes. The 0.9.0 source cohort changes core, meter, providers and React, moves the other three packages in lockstep and awaits publication. Other workspaces remain private. |
| Repository hosting and CI            | Public repository and GitHub Actions are configured. The first public run found a Cloudflare fixture race; its local regression fix passes. Fresh exact-head public CI remains a release gate.                                                                                                                                                |
| P3 host shadow and P8 cutover        | Current host PR, deployment, shadow observations and credit authority must be checked in the host repository before cutover. Library checks do not establish production readiness.                                                                                                                                                            |
| P8 billing import                    | Approved on local `main`: atomic imports, scoped request matching, immutable revisions, reconciliation, SQLite and Durable Object replay, HTTP and local parsing. Included in published 0.5.0. See [billing imports](BILLING-IMPORTS.md) and the [migration guide](MIGRATING-0.5.md).                                                         |

Next: verify the public style registries on usagekit.dev, then complete the host React preview
and merge. The 0.8.0 cohort adds `ProviderRate.fallback` to `@usagekit/views`; the other six
packages moved in lockstep. Registry blocks follow every shadcn style on Radix and Base UI and
request exact 0.9.0 packages once that cohort is published; the redesigned usage surfaces share
one meter, motion, connection rows and summaries.
Shared metering/provider hooks, measurement cards, connection tools and allocation editors
are implemented in every style; the redesigned local Usagekit dashboard uses shared blocks. Hosts supply authorized budget-write and provider-management adapters;
read-only dashboards stay read-only. See [provider UI](PROVIDER-UI.md) and [the site](SITE.md).
Promotion, UI package publication and website hosting are separate gates.
Host integration and shadow evidence are
being checked in the host repository, with funding identity and balance ownership retained per
execution. P8 still requires real-database crash tests, reconciled holds, a rehearsed rollback,
measured shadow observations and live end-user views. Library imports do not satisfy those host
exit gates. Retention and throughput requirements remain part of the host review.

## 7. Order of work

The order changed after P3. Shadow data accumulates in host A over weeks regardless of what
is built next, so the UI comparison and the catalog come before the proxy and the cutover.
Stage numbers below are the new sequence; the former IDs from PLAN.md are in parentheses.

| Stage | Deliverable                                                                                                                                                                                                                            | Exit gate                                                                                                                                                    |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P3    | Host A rebase, hosted path coverage, draft PR, shadow on one production project                                                                                                                                                        | Host checks green after rebase; shadow overhead recorded; zero admission changes                                                                             |
| P4    | Public repository with CI, provenance on publish, `repository` fields, docs updated for public packages; view models, hooks, shadcn registry for Radix and Base UI, header status model; local server UI on the registry (was P7)      | Host A admin page rebuilt on view models with its own primitives and compared against the hand-written one; registry `add` tested on both primitive families |
| P5    | Provider catalog: descriptor type in `core`, `providers` package with the two first providers, price sources, extractors with fixtures, host allowlist, implementer contract and lint rule, fixture recorder in the local server (new) | Contract tests on fixtures for every advertised operation; host A maps its catalog onto descriptors without behavior change                                  |
| P6    | Local proxy on the catalog: routes, key injection, receipt extraction, blocking (was P4)                                                                                                                                               | Allowlisted routes, real denied dispatch, correct errors, restart recovery                                                                                   |
| P7    | `store-d1` adapter and a Cloudflare Worker example, not a product backend (was P5)                                                                                                                                                     | Conformance with `durable: true` under Miniflare, two-Worker race on one Durable Object, example runs in `wrangler dev`                                      |
| P8    | Host A authoritative cutover with dual-ledger coordination and end-user views (was P6)                                                                                                                                                 | Single authority, crash tests on the real database, reconciled holds, rehearsed rollback, per-user usage and budget pages live                               |

Later, optional: host B adapter, AI receipts and streaming, outbox and export, wallet
extraction, hosted personal service, and two companion packages that share the wrapper and
proxy hook: a rate limiter and a response cache. Chain order is fixed now so they slot in
later without contract changes: cache lookup, then rate limit, then reservation. A cache hit or
a rate-limit rejection never creates an operation or takes headroom; both are counted in the
per-state request counter and appear in coverage. Rate limiter state is not a ledger and gets
its own port. Cache stores responses under its own retention and privacy policy, never in
accounting tables; descriptors declare cache keys, default TTLs and provider rate limits.
See PLAN.md section 7.

### P6 implementation evidence

The local proxy is implemented in `packages/proxy` and mounted by the local server.
[PROXY.md](PROXY.md) defines routes, credentials, admission, idempotency, streaming limits,
recording and crash behavior. `packages/server/src/proxy.test.ts` exercises the real HTTP
boundary, including SIGKILL during upstream dispatch and restart without redispatch.
Unknown paths consume a requests reservation and stay pending with unknown cost; coverage
classifies them as unpriced. The host authoritative cutover is still P8.

### P7 implementation evidence

`packages/store-d1` implements the plan's authoritative Durable Object storage alternative;
it is not a direct D1Database adapter. [CLOUDFLARE.md](CLOUDFLARE.md) documents ownership,
exact amounts, routing and local operation. The unchanged Store suite runs under Miniflare
with `durable: true`, including runtime disposal/recreation. Additional tests prove a
shared-pool race from two Workers, rollback, immutable budget versions, cursor restart and
constant command footprint after 5000 operations. The example smoke uses `wrangler dev`,
restarts the process, and verifies persisted settlement and budget usage. P8 remains the
production authority cutover.

The [2026-10-06 local review](validation/2026-10-06-p7-local-review.md) records the source reviewed,
current checks and remaining boundaries. The earlier cloud report is historical evidence;
it does not establish the current state of its deployed test resources.

## 8. Topics added after P3

These were missing from the plan and are now owned by a stage.

- **Funding source switch (P8).** A connection can move from the user's key to a platform key
  and back. The switch creates a new provider credential version; in-flight operations settle
  under the old funding; per-surface budgets stay; a platform pool becomes an additional bound.
  History is never rewritten.
- **Two ledgers during cutover (P8).** Own-key spend and platform-funded spend touch different
  credit authorities. Coordination rules must be written per funding source before cutover.
- **Platform pool identity (P8, earlier if a second platform account appears).** A pool is one
  platform key on one provider account. Its identity is the platform connection's id, the same
  kind of row a user key has, with the platform as owner; rotation changes the credential
  version, not the pool. Two accounts at one provider are two pools, two budgets, two probes,
  and the host routes each call to one of them before reserving. The shadow fallback
  `hosted:<provider>` is valid only while there is one platform account per provider.
- **Header status (P4).** Done: `loadHeaderStatus` and `useHeaderStatus` merge the last command's crossings. A compact view model: remaining, of what, reset time, warning
  threshold, per visible bound. Refreshed in the same request that settles an operation, not by
  polling.
- **End-user views (P4 models, P8 live).** P4 part done: usage, budgets, header, coverage, exceptions and connection view models with registry blocks. Connect a provider from the host's allowlist, see
  own usage per connection and surface, see budgets and headroom, switch funding where the host
  offers it. Today the plan only describes the operator and the machine.
- **Provider catalog with host allowlist (P5).** Local implementation complete: the descriptor design is
  [PROVIDERS.md](PROVIDERS.md). Hosts decide which descriptors are active.
  Users connect only those.
- **Implementer contract (P5).** The only allowed path for a paid call is the wrapper that
  reserves, dispatches through the descriptor and settles. Direct provider client calls are a
  lint error. Which operations exist, how their cost is estimated and how the receipt is
  extracted is descriptor data, not host code.
- **Read API for external dashboards (P4).** Done, including `GET /v1/operations` for `listOperations`; the contract: `createUsageHandlers` takes
  `commands: false` and every command route answers 404 after authentication; host A mounts it on one authenticated route; the P4
  reference dashboard consumes it through `createRemoteMeter`, which makes the host the first
  remote consumer outside the local server and the conformance suite. The mount is never
  anonymous: `authenticate` maps the host's existing sessions, API keys and personal tokens to
  `AccessContext`, instance admins get the wide context, users get their principal and groups,
  `canManageBudgets` stays false. The host requires an explicit key scope for metering reads,
  audits reads like the admin page, and applies its API rate limit to the route.
- **Many accounts per provider and grouped statistics (P4 contract and UI, P5 catalog).**
  Contract done: connection tags snapshotted into scope, `groupBy` gains `funding_source` and `tag`, a `tag`
  budget scope; still open: an account label field in every view model, and a provider-side account
  identity in descriptors for duplicate detection. Host A's one-connection-per-provider rule is
  a host decision and can be lifted without a metering migration.
- **Per-actor budgets (P4 contract note, P8 decision).** Team-owned hosts need a member limit
  under a team principal. Either an `actor` budget scope or a documented host-side rule.
- **Throughput of the event commit-order lock (before P8).** The Postgres adapter serializes
  every accounting write on one advisory lock to keep cursor watermarks exact. Measure requests
  per second before it becomes authoritative.
- **Retention (before P8).** Command journal and event tables grow per operation. Define
  pruning for replay keys and events past a horizon while keeping financial evidence.
- **Host token cleanup (P3 follow-up).** Packages are public; remove the read-only registry
  token wiring from host A's CI, deployment and developer docs after one token-free install.
- **Budgets per source, not only per surface (P4 contract, first item).** Done: `Budget.surface`
  accepts a source value on every adapter and the wire. Users need separate limits for web, API, CLI and MCP,
  as many as they want, stacked with principal, group, connection and token limits.
  `Budget.surface` widens to `Surface | Source | "any"`: a surface value matches its source
  group, a source value matches exactly that source. The host sets both surface and source at
  the authentication boundary; a client cannot choose them. Named host-defined source groups
  are deferred; two budgets express "CLI and SDK together, MCP apart". Change touches the
  core type, the reference matcher, both SQL adapters, wire schemas and conformance tests.
  No migration: adapters store the field as text.
- **Hard and soft limits (P4 contract, P5 catalog).** Contract done: one budget with `limit`, `onExceed`
  `block` or `allow`, optional `hardLimit` and `alerts` recorded once per epoch; P5 implements overage price
  rows selected by the host-confirmed allowance state; descriptor plans declare `allowanceMode`. See section 9.
- **Tracking policy per operation (P5 contract, P6 proxy, P4 coverage view).** P5 connects persistent counters to `loadCoverageView`; the `CoverageSource` port remains available. A connection
  chooses `metered` or `passthrough` per catalog operation; unknown paths are `unpriced`.
  Counts are kept in every state; cost is kept only for metered. See section 9.
- **Plan-dependent prices (P5 catalog, P4 UI).** List prices vary by provider plan and by call
  option. The descriptor carries a price table with plan and option axes and a plan list; the
  connection carries the selected plan. See section 9.
- **Billing import and reconciliation (P5 parsers, P4 view, P8 live).** A provider's own
  billing export corrects estimates after the fact and reveals calls the application never saw.
  See section 10.

## 9. Prices, methods and fixtures

Three price sources exist and host A already uses all three. usagekit adopts the same model.

| Source     | Where it lives                                                                       | Who maintains it                        | Used for                                                                             |
| ---------- | ------------------------------------------------------------------------------------ | --------------------------------------- | ------------------------------------------------------------------------------------ |
| `list`     | Descriptor price table: operation, unit price, valid from, source URL, checked date  | Community, by pull request              | Estimate before the call when nothing better exists                                  |
| `manual`   | Host or user override per connection and operation                                   | The user, in the host UI                | Estimate when the user knows their negotiated or plan price                          |
| `measured` | Median of settled receipts for that connection and operation, above a minimum sample | Derived, never stored in the descriptor | Suggested next to the list price; used for estimates when the sample is large enough |
| `unknown`  | No source                                                                            |                                         | Reserve a conservative estimate or block, per host policy                            |

Resolution order for an estimate: `manual`, then `measured` with enough samples, then `list`,
then `unknown`. The receipt after the call is always the truth for settlement; prices only feed
the estimate and the admission check.

On the three questions this raises:

- **Downloading a provider's price list.** Almost no provider exposes prices through an API.
  The list price is community-maintained data with a source URL and a check date. Drift is
  found by people and by measured receipts disagreeing with the list, not by automation.
- **Setting prices per method and API path.** Yes, as `manual` per connection and operation.
  An operation in the descriptor names its request match (method and path pattern) so the proxy
  can route it and the UI can show "this price applies to these calls". The user sets a price
  per operation, not per raw path.
- **Recording fixtures and suggesting prices per endpoint.** Fixtures serve extractor tests,
  not pricing. The local server records a redacted request and response pair on request, and
  that pair becomes the contract test for the descriptor. Price suggestions come from measured
  receipts: for providers that report cost per call, directly; for providers that only expose a
  balance, from balance probe deltas around isolated calls, marked as estimates. The UI shows
  the suggestion next to the list price and lets the user accept it as `manual`.

Operations are the unit of pricing, routing and reporting. A descriptor advertises only
operations that have fixtures. Unknown paths through the proxy are metered as `requests` with
unknown cost, never priced by guess.

### Proxy and the catalog

The catalog is the set of operations usagekit can price, not an allowlist of paths. Which
providers are enabled, and whether unknown paths pass, is a separate host or local-server
setting. The proxy and the embedded wrapper execute the same descriptor: `match` maps a request
to an operation, `estimate` feeds admission, `extract` produces the receipt. The proxy
authenticates the client with the server token, sets `source: "proxy"` and the surface itself,
strips client authentication and injects the vault key; the client never sends a provider key.

Unknown paths pass by default and are recorded as operation `unknown` in `requests` with
unknown cost, listed in the exceptions queue with a one-step fixture recording offer. A strict
mode rejects them with 404. Nothing is ever priced by guess. A client `Idempotency-Key` becomes
the `operationId`; without it every request is a new operation, because every request costs.
Body-hash deduplication stays forbidden. Receipts are extracted after the response stream
closes; a broken stream settles with unknown cost and leaves the operation `pending` for
reconciliation.

### Hard and soft limits

Marketplace plans set a precedent: an allowance per period with either a hard limit that stops
requests or a soft limit that lets requests through and bills the excess per unit. usagekit
adopts the distinction on one budget instead of two unrelated ones.

- `limit` is the allowance; `onExceed` is `block` (hard) or `allow` (soft).
- A soft budget may carry `hardLimit`, an outer cap that blocks. A soft limit without a cap is
  a known way to get an unwanted bill, so the connect flow proposes one.
- `alerts` lists thresholds, as a percent of `limit` or as a quantity. The store records each
  crossing once per budget and epoch, so hosts receive one warning per threshold without their
  own deduplication. Delivery channels stay with the host. This extends the `warnings` already
  returned by `reserve`.
- Past `limit` on a soft budget, estimates use the price row marked `overage: true` for the
  connection's plan; below it, the plan's included-unit row.
- The descriptor's plan list carries `allowanceMode: "hard" | "soft"` so the proposed budget on
  connect mirrors how the provider itself behaves: prepaid balances and no-overage plans are
  hard, plans that bill excess are soft.

Rate limits per second or minute are flow control, not spend, and stay outside budgets. Hosts
keep their own limiters.

### Tracking policy per operation

Whether usagekit can price an operation and whether the user wants it metered are independent.
Each connection carries a tracking policy over the catalog's operations, default `metered`.

| State         | Meaning                                           | Proxy and wrapper behavior                                                        |
| ------------- | ------------------------------------------------- | --------------------------------------------------------------------------------- |
| `metered`     | In the catalog and enabled                        | Reserve, admit, inject key, extract receipt, settle                               |
| `passthrough` | User or host disabled tracking for this operation | Inject key and forward; count the request only; no reservation, receipt or budget |
| `unpriced`    | Not in the catalog                                | As passthrough, flagged unknown, with a fixture recording offer                   |

Request counts per operation, connection, source and day are kept for every request, keyed by
outcome state: `metered`, `passthrough`, `unpriced`, and later `cached` and `rate_limited`.
Only `metered` creates an operation. Counts carry no content, and without them a summary cannot
say what share of traffic is outside control. A
coverage view model per connection and window reports metered, passthrough and unpriced counts
and shares, and states that cost excludes the untracked requests. A budget on a connection with
passthrough operations protects only part of the traffic; views say so next to the budget.
There is no "forward without counting" state: a user who wants that points the client at the
upstream directly. Per-operation budgets become possible on top of this and are deferred.

### Plans and options

A list price is rarely one number per operation. Three things move it:

- **The plan changes the price.** A subscription tier buys a quantity of units for a monthly
  fee, so the unit price differs per tier.
- **The plan changes the unit.** Inside the tier an operation costs one unit of the cycle
  allowance; past the allowance it costs money per call or is refused.
- **A call option changes the price.** The same operation priced by queue priority, depth,
  device or region parameters.

The descriptor therefore holds a price table with axes, not a scalar:

```ts
plans: [{ id: "developer", cycle: "monthly_plan", allowance: { unit: "units", value: 5000n } }],
prices: [
  { validFrom: "2026-09-01", operation: "search", plan: "developer", unit: "units", perUnit: "1" },
  { validFrom: "2026-09-01", operation: "search", plan: "developer", overage: true, unit: "cents", perUnit: "1.5000" },
  { validFrom: "2026-09-01", operation: "serp.task", option: { queue: "live" }, unit: "cents", perUnit: "0.2000" },
],
```

The connection carries `plan`, chosen by the user when connecting or read from the balance
probe when the provider reports it. Two accounts at one provider may sit on different plans;
each connection resolves its own price, allowance and cycle. Aggregates across connections sum
units and sum receipt costs; they never multiply grouped units by a price, because there is no
single price above the connection. A tag or provider budget in money is bounded by receipts,
while its headroom estimate depends on which connection the host routes the next call to. Estimate resolution matches operation, plan and options
against the table. A plan-priced descriptor with no plan on the connection resolves to
`unknown`, never to a default plan.

A plan allowance is a budget the provider set. On connect, usagekit proposes a `connection`
budget in the allowance unit with a `provider_cycle` window and the probe's reset date; the
user accepts or edits it. A plan change mid-cycle follows the funding-switch rule: new
credential version, in-flight operations settle on the old plan, the proposed budget gets a new
version. The descriptor never holds negotiated prices, discounts or volume tiers beyond the
public list; those are `manual` on the connection, and billing import below supplies evidence.

## 10. Billing import and reconciliation

After the fact, a provider's own billing export is the strongest evidence available. Importing
it corrects cost estimates and reveals calls the application never saw. Operations stay
`pending` while any quantity is unresolved.
The contract already supports the mechanics: `correct` appends a superseding receipt under
`late_evidence` authority, receipts carry `providerRequestId` and `evidenceRef`, and certainty
is per dimension so cost can become `measured` while quantity stays `estimated`.

The approved P8 source implements the import mechanics described in
[billing imports](BILLING-IMPORTS.md). Production host adoption remains a separate exit gate.
The responsibilities span the following stages.

- **Export format in the descriptor (P5).** A `billingExport` section: where to fetch or what
  file to accept, format, columns, granularity and matching key. Parsers are extractors with
  fixtures like any other. Exports differ by provider: per-task history with cost, a bare
  account counter, or a daily CSV per key.
- **Matching rules (P5 contract, P8 live).** One line to one operation by `providerRequestId`
  yields `correct` with a `measured` receipt. One line to many operations, such as a daily
  total for a key, does not spread cents across operations by guess: it creates a
  **reconciliation entry** for the connection and window with ledger total, evidence total,
  difference, source and import hash. Operations keep their own certainty. A line with no
  matching operation creates an operation with source `import`, flagged as unobserved by the
  application, which is a signal for the user (the key was used elsewhere) and for the operator
  (an uninstrumented paid path).
- **Idempotent import (P8).** Import identity is the file hash, window and connection. Every
  receipt or entry from an import references it through `evidenceRef`. Re-importing the same
  file replays; a different file for the same window revises and supersedes the previous
  import.

Model additions: a reconciliation entry object beside operations, an optional `reconciled`
dimension on usage aggregates so views can show "by application" next to "by invoice", and an
explicit receipt `source` of `dispatch`, `probe` or `import`.

Billing import is also the best `measured` price source for providers that do not report cost
per call: invoice total for a window divided by the operations in it, with the invoice as
evidence. The UI shows that unit price as the suggestion next to the list price.

Stage placement: P5 adds the descriptor section and parsers with fixtures for the first two
providers; P4 adds the "estimated versus billed" view model and the import entry point on the
connection view; P8 turns import into a production source of corrections with the
reconciliation entry in the contract and idempotency tests.
