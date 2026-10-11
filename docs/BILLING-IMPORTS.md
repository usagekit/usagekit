# Billing imports

Billing exports provide accounting evidence. Importing a file never dispatches a provider
request, reserves customer credits or changes a host wallet balance. A host keeps one balance
authority and supplies historical funding attribution; upstream cost and customer price are
separate values.

The P8 implementation shipped in the published 0.5.0 cohort. The new mandatory Store and Meter
methods require the [consumer migration](MIGRATING-0.5.md); published 0.4.0 does not expose this
API.

## Parse and import

`parseBillingExport(providerModule, originalUtf8Text)` uses the provider's advertised export
parser and hashes the original UTF-8 text with SHA-256 before normalization. It performs no
network request. The current DataforSEO task-history format requires every task to have a
unique request identity, a readable occurrence and an exact nonnegative USD charge. It reads
the original JSON numeric lexeme through `JSON.parse` source context, preserving amounts above
JavaScript's safe integer range. Amounts smaller than one millionth of a dollar, or greater
than `2^63 - 1` Money units, are rejected instead of rounded. Runtimes without source context
fail closed for charged task-history rows; the pinned Node version supports it. SerpApi does
not advertise an export parser.

The host calls `meter.importBilling(access, input)` with:

- Its verified namespace, accounting principal, connection and provider.
- A half-open export window `[from, to)` and the parsed file hash and lines.
- `expectedPreviousImportId: null` for the first file, or the current import ID for a revision.
- Historical funding source, cost owner and any retained wallet, pool and pricing identities
  for calls that were not observed by the application.

The command accepts at most 1000 lines in one atomic import. Larger exports need complete,
nonoverlapping windows prepared by the host; do not silently truncate or split a revision
into partial replacements. Occurrences must belong to the declared window. A matched request
may have been created earlier, since occurrence and operation creation are different dates.

`access.canImportBilling` must be explicitly true, billing detail must be readable, and the
host must resolve connection ownership. A configured connection resolver also checks provider
identity within the supplied namespace. Historical `attribution.fundingSource` is a trusted
host projection and may legitimately differ from the connection's current funding. Imports
do not validate or compare current connection funding; quote and new reservation funding
checks are unchanged. Authorization, ownership, unresolved connections and provider mismatches
return `forbidden`; a configured catalog also denies disabled or unknown providers. These
outcomes write nothing to the Store. The host must derive import attribution from trusted
historical records.
The permission belongs to a trusted host importer. Scope, pool and funding fields in the input
are historical host projections, not proof of end-user authorization. An authenticated request body cannot grant
this permission. Missing ownership fails closed.

## Matching and certainty

Request IDs match only within the namespace, principal, connection and provider. Ambiguous
IDs, two lines matching one operation's receipt history, active recovery leases and incompatible
operation states reject the complete import before any mutation.

An itemized match appends an immutable measured cost receipt that supersedes the current
receipt. Original receipts, funding source, wallet, customer price, credential version,
pool identities and budget epochs remain retained. The provider-cost `cents` measurement
follows the imported cost. Other quantity measurements, including `customer_cents`, keep
their original certainty and amount. Known cost does not settle an unknown quantity.

An unobserved request becomes an accounting-only operation with `source: import`, known
upstream cost, unknown request quantity and no admission budget epochs. It never gains a
dispatch grant. A later revision matches that retained operation rather than creating another.
Ordinary reserve/count and settle/correct cannot forge import provenance through Meter.

Aggregate lines produce reconciliation entries without allocating cost to individual
operations. Operation-specific aggregates compare only that operation; aggregate windows may
overlap only when their operation categories are disjoint. An all-operation aggregate overlaps
every category. Itemized and aggregate evidence cannot cover the same occurrence/category.

Each import also records a full-window `import_total` comparison. The ledger side uses the
application's latest non-import evidence, so a previous invoice cannot make a subsequent
comparison agree with itself. Differences are exact signed Money units. If any applicable
observed cost is unknown, the ledger total and difference remain unknown, with an explicit
unknown-operation count.

## Replay, revisions and durability

The import family is namespace, connection, provider and normalized window. Its accounting
principal cannot change through a revision. File hash identifies immutable evidence within
that family. Identical replay returns the retained result without adding receipts, alerts,
operations or charges, even after a newer revision. Reusing a hash with changed content is a
payload conflict. A distinct file replaces the family pointer only when its explicit previous
ID still matches; competing revisions have one winner.

A revised file appends corrections for its itemized lines. An omitted line preserves its
last cost evidence; absence is not proof of a zero charge or refund. Explicit provider evidence
is required to correct that cost. The revised total still exposes any discrepancy. Earlier
imports remain queryable with `history: true` and identify their successor.

SQLite and SQLite-backed Cloudflare Durable Objects commit operation changes, receipts,
budget projections, events, once-per-epoch alerts, the import journal and current pointer in
one transaction. An invalid later line or write failure rolls back the entire file. Native
adapter tests cover separate workers, restart/replay, revisions and upgrade of existing stores.
The shared conformance cases run through memory, embedded Meter, remote Meter, SQLite and
native Durable Objects. In-memory fixtures explicitly skip the durable recreation guarantee.

## HTTP

`POST /v1/billing/import` exposes the atomic command. `GET /v1/billing/imports` reads current
imports for a principal and connection, or retained history. Exact integers travel as decimal
strings, including signed differences and unknown counts. Reads require authorized billing
detail and connection ownership. A read-only mount does not expose the import command.
Funding validation failures use the existing HTTP 200 `{ outcome: "invalid", field, reason }`
response; forbidden imports return HTTP 403.

The remote client retries accounting only when the caller explicitly requests a retry. It
retains the exact original body. The loopback server grants import permission to its verified
local operator, checks the vault connection/provider and provider allowlist, and stores the
journal in its existing SQLite database.
