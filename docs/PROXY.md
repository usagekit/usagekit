# Local proxy (P6)

The local server routes authenticated requests through `@usagekit/proxy`. The package is
private, as are the server and CLI. The seven public library packages are published at 0.8.0;
the 0.9.0 source cohort awaits publication.
See the [migration guide](MIGRATING-0.5.md) when upgrading from 0.4.0.
Start from this checkout using the root README. Nothing needs to change in a production host.

```sh
usagekit serve --providers dataforseo,serpapi
# Optionally reject every path not advertised by the enabled descriptors:
usagekit serve --providers serpapi --strict-proxy
```

The default provider allowlist is the two bundled providers. `--providers ''` disables all
provider dispatch. These options apply when starting the process; restart with the desired
options to change them. The vault must be unlocked using the existing passphrase flow.
Server code can use `enabledProviders` and `strictProxy` in `startServer`.

## Requests and credentials

Use `/proxy/<connection-id>/<upstream-path>` with the local server's bearer token. The
connection selects the provider. For DataForSEO include `/v3` in the upstream path.

```sh
curl --fail-with-body \
  -H "Authorization: Bearer $USAGEKIT_TOKEN" \
  -H 'Idempotency-Key: search-job-001' \
  'http://127.0.0.1:4242/proxy/c1/search.json?q=example&engine=google'
```

The server fixes `namespace=local`, `principal=local`, `source=proxy`,
`surface=programmatic`, `fundingSource=byok` and snapshots connection tags. Headers and query
fields cannot choose billing ownership. Only Accept and Content-Type are forwarded from the
client. Client credentials, cookies and authentication query parameters are removed, then
credentials are injected from the vault only at transport, according to the descriptor. The destination origin
is pinned to the enabled descriptor; caller paths cannot set a host and redirects are not
followed. Response cookies, redirects and hop-by-hop headers are not forwarded.
Caller `Content-Length` and `Content-Encoding` are also stripped, including when a body is
canonicalized. Fetch computes the outbound length from the forwarded bytes.

Descriptors declare `pricingInputs` (`body` and/or `query`); there is no provider-name switch.
Pricing parses the body once and calls `catalog.match` once with the parsed request. Admission
produces an immutable `PricedRequest` holding the method, credential-free URL and headers,
exact outbound body bytes, matched operation and resolved reservation estimate. Proxy and
recorder dispatch accept only this value. Neither path rematches or serializes at dispatch.
Transport preserves these fields and adds authentication to a copy; credentials never reach
pricing, receipt extraction or the stored snapshot. Query authentication preserves all
non-authentication query bytes. Invalid trusted header credentials are rejected before
admission with **400** `invalid_provider_credentials`, without reserving or dispatching;
the recorder returns **400** `invalid_request` for the same condition.
The proxy snapshots connection values per request, so host-side key rotation cannot
change the credential between preflight, transport and fixture redaction.
`catalog.match` enforces declarations for all callers: body and query reach matching and
option extraction only when declared. Query-constrained match rules require `"query"`.
When query is declared, repeated keys (including equivalent percent encodings) return **400**
`invalid_provider_request` before any reservation. DataForSEO declares `["body"]`, SerpApi `[]`,
and the testing descriptor `["query"]`. Credential-free inputs remain available for receipts
and redacted fixtures. `dispatchPricedRequest` accepts the trusted secret as a separate fourth
argument (`null` explicitly omits authentication). Avoid logging whole requests, which can
still contain caller data. Common authentication-like query fields such as `token`, `secret`
and `password` are removed even when a different descriptor field supplies authentication.

Unknown operations have no reservation by default. Only the non-strict proxy uses
`allowUnknownDispatch: true` to reserve one request for an unpriced dispatch, subject to
fail-closed money budgets. Strict proxy routing and the recorder do not opt in.
Only `RequestPricingError` maps to a request 4xx; Meter and Store failures propagate.

Billable operations of body-pricing providers require JSON bodies. Their JSON media types are
recognized case-insensitively, ignoring parameters: `application/json` and media types with a
`+json` suffix. These bodies are parsed for price options, then forwarded
as `JSON.stringify` of exactly that parsed value with `Content-Type: application/json`.
The upstream therefore receives the value that was priced, including the last value of any
duplicate object key. Original bytes, formatting, charset parameters and duplicate keys are not
forwarded. JavaScript numeric re-serialization can round integers above `2^53 - 1` and turns
overflowing numbers such as `1e400` into `null`; invalid pricing-field numbers are rejected.
`Content-Encoding` is never forwarded: a compressed billable DataForSEO body fails JSON parsing.
Request bodies are limited to 2 MiB. Invalid JSON for a billable body-pricing request returns **400**
`invalid_json` before admission. A billable DataForSEO body must be a JSON array holding exactly
one task object, sent with a JSON media type. Text under any other media type, bare objects,
empty or nested arrays, multiple tasks and pricing fields of another JSON type return **400**
`invalid_provider_request` without a reservation or upstream call, including on BYOK passthrough
connections. Keys that match a pricing field only by case or Unicode compatibility form
(`Depth`, `LIMIT`) are unlisted, yielding an unknown estimate and **422** with a money budget.
Split batches into single-task calls. A bodyless call carries no task and keeps
default pricing. Every other body, including free operations, unknown paths and providers without body pricing,
is forwarded byte for byte with its original media type. Large numbers, `+json` types and even
malformed JSON remain untouched; no JSON parsing or normalization is applied to those bodies.
Fixture recording (`POST /providers/connections/<id>/record`) uses the same pricing step.
Its untyped text convention is JSON for body-pricing providers. Non-body-pricing providers
retain the original text bytes and media type, including vendor `+json` and large integers.
GET, HEAD, POST, PUT, PATCH and DELETE are supported. Provider business failures preserve their
HTTP status and body; a billed failure still receives a receipt.

## Budgets, unknown paths and passthrough

Reservation uses the same catalog and connection pricing as the embedded Meter. Blocking
budgets deny before dispatch with **429**, `allowance_exceeded` and `Retry-After`. The delay
is the budget reset time rounded up; a budget without an automatic reset returns 60 seconds
as a recheck interval, not a promise that it will admit then. Allow budgets retain their normal
warning and hard-limit semantics. Estimated prices cannot guarantee an exact monetary ceiling
when a provider bills more than the estimate; actual overruns remain in the ledger.

Unknown paths pass by default only if admission permits a one-request reservation. They have
operation `unknown`, unknown cost, pending evidence and unpriced coverage. Monetary/native-unit
bounds with no defensible estimate fail closed with **422**. `--strict-proxy` counts the path
as unpriced and returns **404** without dispatch. Known free operations and connection policies
set to `passthrough` on BYOK connections forward without a reservation; the durable
passthrough counter records them. Passthrough is a BYOK-only opt-out of spend enforcement.
Billable platform-funded operations always require a host customer-price estimate,
reserve before dispatch and require the host to supply customer-charge receipt measurements.
`executeProviderRequest` settles provider evidence only; it does not turn a host estimate into
customer-charge evidence. Use a distinct customer unit (for example `customer_cents`), which
stays reserved until the host settles it. Reusing provider `cents` for a different customer price
would debit the provider amount instead. Credits charges cannot be opted out.
Connection validation rejects `passthrough` and `unpriced` tracking for billable platform
operations; the local connection HTTP API returns a clear `invalid` result. The local
server continues to support only BYOK connections.

Every forwarded response carries `X-Usagekit-Operation-Id` and `X-Usagekit-Accounting`:
`metered`, `unpriced` or `passthrough`. Unknown operations appear on the existing exceptions
page; no request content is stored in the accounting ledger.

## Idempotency and errors

An `Idempotency-Key` is the operation ID. It must contain 1–128 ASCII letters, digits, `.`,
`_`, `:` or `-`. Without it each request gets a fresh UUID, even if its body is identical.
A repeated admitted ID returns **409**; it never returns cached provider content or dispatches
again. The same fence holds for concurrent requests, restarts, key rotation and switching a
connection between metered and passthrough modes. Use a new ID for an intentional paid retry.
The ledger stores operation semantics, not request bodies or their hashes, so a replay does
not claim that the caller supplied an identical body. A budget denial consumes no ID.

Other local errors: **401** invalid server token, **403** disabled provider, **404** missing
connection, **423** locked vault, **400** malformed input, **405** unsupported method,
**413** oversized body, **422** unestimable bounded usage, **502** failed provider transport,
**503** accounting awaiting recovery. Errors contain safe categories, never transport messages
or credentials. Once response streaming begins, a later error interrupts the stream instead
of pretending it can replace the already-sent HTTP status.

## Streaming, shutdown and recovery

Response chunks pass through with backpressure. Only the first 2 MiB are buffered for receipt
extraction; crossing that bound discards the capture and preserves unknown cost while still
forwarding the body. Accounting settles only after upstream EOF. Interrupted streams, client
cancellation and failed transport retain uncertain exposure. The outbound request has a
30-second deadline and a 60-second dispatch lease. No transport is retried automatically.

The server owns startup and 30-second maintenance. Undispatched reservations expire using the
existing cleanup. Expired proxy dispatch intents are fenced with a recovery lease and become
pending with unknown measurements/cost. Recovery never calls providers or releases possible
charges. Active leases remain untouched, and pending evidence is not repeatedly rewritten.
Normal shutdown closes the HTTP server before closing SQLite and locking the vault. SIGKILL
is covered by durable dispatch intent and startup recovery; lost evidence requires later
verified settlement/correction, never an automatic resend. Existing reporting/embedded
operations are not claimed by the proxy recovery worker.

## Explicit fixture recording

Add `X-Usagekit-Record-Fixture: true` to the **next intended call** to save a redacted fixture
from that same response. No second provider request is made. This also works on unknown paths.
Files are written under `<config-dir>/fixtures/<provider>/<operation>/<random-id>.json`, mode
0600, after stream completion. Known secrets, authentication fields and email identities are
redacted. Review the file before sharing: recording is explicit consent to retain request and
response content outside the accounting ledger. Unknown fixtures need a descriptor operation
and extractor assertions before they can become advertised catalog coverage.

A failed/incomplete or oversized recording does not claim a complete fixture. For an oversized
response the client stream fails at completion after the accounting result is retained. The
`X-Usagekit-Fixture-Recording: requested` header acknowledges the request, not successful save.

## Verification map

| P6 requirement                                               | Evidence                                                                                 |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| Authentication, allowlist, key injection, pinned destination | HTTP tests in `packages/server/src/proxy.test.ts`                                        |
| Actual denied dispatch and Retry-After                       | Zero-cap HTTP test asserts 429 and zero transport calls                                  |
| Unknown default/strict policy and budget safety              | Unknown-path, unestimable-bound and strict tests                                         |
| Passthrough with no reservation and durable counts           | Policy-switch and free-call test                                                         |
| No duplicate billing on replay                               | Twelve concurrent requests, one dispatch; restart and policy-switch tests                |
| Receipt only after stream close; uncertain broken stream     | Controlled-stream and oversized-response tests                                           |
| Restart recovery without redispatch                          | SIGKILL of a real server during a routed request; restarted ledger and replay assertions |
| Exceptions, unpriced coverage, no double counting            | Proxy → HTTP Meter → view-model integration test                                         |
| Explicit recording with no extra charge                      | Unknown-path recording test, redaction and file-mode assertions                          |
| Priced request body equals the forwarded body                | Parser-differential proxy and recorder HTTP tests with a recording transport             |
| Canonical request excludes caller length and encoding        | Proxy HTTP test asserts exactly Accept, vault Authorization and Content-Type             |

P5 descriptor fixtures and host compatibility proofs remain in the existing provider tests and
`docs/PROVIDER-HOST-COMPATIBILITY.md`. P8 is the separate production authority cutover.

## Advisory quote API

New in the 0.9.0 source cohort, the HTTP handler exposes `GET /v1/quotes?q=<base64url-JSON>`
and permits it when mounted with `commands: false`. Encode a `MeterQuoteInput`, with exact
quantities represented as
`{ value: "123", scale: 2, unit: "cents" }`; operation IDs and command IDs are not quote
fields. Authentication derives `AccessContext` on the server. The remote client exposes
`remote.quote(access, input)` and sends only the input, using the same read encoding as
usage/budget queries. Schema failures return 400, authentication failures 401 and access
failures 403; successful responses contain the typed `ReadResult<MeterQuote>`.

A quote is a read, with the [same pricing rules as reservation](PROVIDER-UI.md#request-quotes-and-byok-manual-prices).
It never dispatches a request or changes accounting, including expired reservations.
It requires `access.canReadBillingDetail`; otherwise the result is `forbidden` (HTTP 403).
Its budget headroom is advisory. The remote client validates quote responses and reports a
malformed response as `RemoteUnavailable`. The repository's handler also validates responses
and turns invalid server output into HTTP 500, which the client reports as `RemoteUnavailable`.
Explicit estimates without provenance omit `estimateSource` in the response.
Billable platform-funded calls require an explicit estimate from
the host customer-price policy; without one, quote and reserve return `invalid`, even with a
manual price of zero or connection tracking set to `passthrough`. Empty and requests-only
platform estimates are also invalid. Explicit platform estimates cannot use `manual`,
`measured` or `list` provenance. Manual, measured and list
provider prices never price credits calls. With a host estimate, billable platform calls
remain metered even when existing connection tracking says `passthrough` or `unpriced`.
On a resolved connection, catalog-declared nonbillable operations (`billable: false`) remain admitted
without a host estimate: quotes contain no quantities, and reservations only count a passthrough
request, never creating a charge.
The local proxy authenticates requests as BYOK, as described above. Host connection resolvers
receive `{ namespace, connection }` and return actual `fundingSource`; quote and new reserve
reject a mismatch. A configured resolver returning no policy yields `invalid` on `estimate` with
`unknown connection`, even with an explicit estimate. A policy without valid funding yields
`invalid` on `fundingSource` with `missing from the resolved connection policy`. Existing
reservation replays retain their frozen estimate and provenance without consulting the resolver,
even after funding or provider changes. New quotes and reservations use the current policy.
Without a resolver, the host must derive funding from trusted
server state.

DataForSEO request extraction and pricing follow the
[catalog rules](PROVIDERS.md#6-formulas-subscriptions-and-host-local-providers).
Ranked keywords and domain rank overview include per-item charges and default to 100 items.
Backlinks summary includes one row; history is unknown without a defensible host estimate.
Only omitted `limit` uses the documented default (700 for ideas, 100 for other
limit-based operations), including manual/measured item pricing. `limit: 0` and limits
above 1,000 are unknown. Missing item counts fail money budgets with `missing_estimate_unit`
(**422**), but whole-call BYOK manual/measured overrides and explicit host estimates can
replace missing counts.

SERP depth defaults to 10 (one page). Use
`P = max(ceil(depth / 10), max_crawl_pages)` with omitted values meaning one page.
The upper bound in cents is `P * (B + rectangles + async + 0.015 * clicks) * 5^N`, with
`B` equal to 0.2 live, 0.06 normal queued or 0.12 high queued. Each enabled rectangle/async
add-on contributes one base; clicks range from 1 to 4. Full base per page conservatively
covers the conflicting later-page discount documentation. At depth 100, the plain price
is 2.0 cents live and 0.6/1.2 cents queued. See the
[formulas and documentation evidence](PROVIDERS.md#6-formulas-subscriptions-and-host-local-providers).
`stop_crawl_on_match` arrays and `find_targets_in` keep this page bound; unused crawling
is refunded. Rank checks with depth 100 and `search_param: "&nfpr=1"` remain supported.

`N` counts distinct documented operator substrings across keyword and search parameters,
including `android:` matching `id:`. Original and repeatedly decoded forms are checked
using NFKC lowercase, NFKC uppercase then lowercase, and NFKD with combining marks and
Default_Ignorable_Code_Point characters removed, then lowercase. The `-site:` exemption
applies per form. Keywords decode valid `%XX` sequences leniently and preserve literal
percent signs; `50% off shoes` and `100% cotton` are ordinary keywords. `search_param`
remains strict: `+` becomes space, malformed escapes and excessive nesting produce
**400** `invalid_provider_request`.

Every billable endpoint has its own documented field allowlist. Unlisted fields or
spellings, `url`, Labs `offset_token`, enabled `include_seed_keyword`, zero limits and
limits above 1,000 yield an unknown estimate. Any caller price and its provenance are
discarded. The Meter rejects unknown money estimates with **422**
`cannot_estimate_bounded_usage`; BYOK without money budgets is dispatched with unknown
estimated cost, and BYOK passthrough tracking remains available. Uncertain credits calls
are rejected; the local proxy itself is BYOK-only. Malformed JSON, pricing types,
non-string `search_param`, non-array stop targets and multi-task bodies remain **400**.

For documented surcharges, whole-call manual/measured BYOK overrides and explicit BYOK
estimates reserve at least the list upper bound: `max(override, list formula)`.
Missing counts alone can still be overridden. Direct catalog/Meter callers supply
`itemCount`; they do not inherit request defaults. Settlement uses measured response cost.
