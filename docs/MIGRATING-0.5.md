# Migrating from 0.4.0 to 0.5.0

0.5.0 adds atomic provider billing imports. This is a breaking contract change for custom
Stores, custom Meters, their proxies and test doubles: both interfaces gain mandatory methods.
Upgrade the public `core`, `store`, `meter` and `providers` packages together, with exact
0.5.0 dependency versions. HTTP, client, views and React workspaces follow the same source
cohort but remain private; this release publishes only the four allow-listed packages.

The four-package 0.5.0 cohort is published on registry.npmjs.org. New candidates still
require owner approval of the reviewed SHA, squash title and publication through
`npm run release` on clean main with a verified signed version tag. A local tarball, passing
dry-run or host test does not establish registry publication or production cutover.

## Validate an unpublished cohort

Build and audit the reviewed candidate, then pack the four workspaces into one local directory.
Install all four tarballs in a disposable consumer so internal exact dependencies resolve to
the same local cohort rather than a registry version:

```sh
npm install --save-exact /absolute/candidate/usagekit-core-0.5.0.tgz /absolute/candidate/usagekit-store-0.5.0.tgz /absolute/candidate/usagekit-meter-0.5.0.tgz /absolute/candidate/usagekit-providers-0.5.0.tgz
```

Use Node 22.23.4. Record the source SHA and tarball checksums with the consumer results. A
candidate may precede its preparation commit; verify its package manifests and compiled
runtime/declarations against the final reviewed cohort before publication. Temporary file
dependencies belong only in candidate validation; published consumers pin the registry cohort
as shown in [CONSUMING.md](CONSUMING.md).

## Update adapters and Meter wrappers

`Store` now requires:

```ts
importBilling(input: BillingImportInput): Promise<BillingImportResult>;
billingImports(query: BillingImportsQuery): Promise<BillingImportsPage>;
```

`Meter` adds `importBilling(access, input)` and `billingImports(access, query)`. Their results
include the existing explicit authorization outcomes. Embedded Meter and the private remote
client implement them. Every host Store, transaction-bound Store, worker bridge, custom Meter
wrapper and test double must implement or delegate the complete contract. A cast or successful
empty stub does not make a 0.4.0 adapter compatible.

The public Store entry exports `prepareBillingImport`, `billingFamilyId`, `readBillingImports`,
`validateBillingImportInput` and `validateBillingImportsQuery`, plus `StoredBillingImport`,
`BillingSnapshot` and `BillingPreparation`. These are pure preparation/read helpers, not a
database transaction coordinator. A durable adapter must:

- Validate scope and inputs, then take an atomic snapshot of candidate operations, immutable
  family records and the current import pointer under its database serialization boundary.
- Scope request identities to namespace, principal, connection and provider. Include requested
  request IDs outside operation creation windows and relevant receipt occurrences; receipt-less
  unknown operations in the window must not disappear from the ledger comparison.
- Compute the complete preparation before writes. A rejection or replay adds no evidence.
- Commit all prepared operations, receipts, budget projections, accounting events, alert
  crossings, the immutable import identity/record and family pointer together. Preserve the
  recorded alert result on replay. Concurrent first imports and revisions have one winner.
- Derive `supersededBy` from retained history before filtering current/history pages. Persist
  exact integer quantities and signed differences without converting bigint through Number.

Run `runStoreConformance` and `runStoreScalingConformance` from
`@usagekit/store/conformance`, including the new import cases against the actual factory.
Durable adapters must pass restart, revision, concurrency and rollback checks; capability
skips are not passed guarantees. Vitest 5 and fast-check 4 remain optional test peers.

## Retain evidence and funding

`Source` gains `import`; update exhaustive source maps and switches. `Receipt.source` is
optional and may be `dispatch`, `probe` or `import`; historical receipts without it remain
dispatch evidence. Import history needs a durable journal. Built-in SQLite upgrades to schema
6 and SQLite-backed Cloudflare Durable Objects to schema 2 automatically on open. A custom
host adapter owns its corresponding database migration and transactional guarantees.

Matched rows append measured upstream-cost evidence while retaining original funding,
credentials, pool, wallet, customer price, measurements and budget epochs. Unknown quantity
remains unknown. Unobserved rows use accounting-only `source: import`, unknown request quantity
and no admission budget epochs. Aggregate rows never distribute cents across operations.
Imports do not authorize provider requests, reserve customer credits or debit a host wallet.

An invoice total becoming known does not prove which historical caller or funding identity
owned an unmatched row. Supply verified historical attribution; fail closed when a host cannot
establish it. Keep the host credit ledger as its sole balance and debit authority.

## Authorize import commands

Set `AccessContext.canImportBilling: true` only for a verified trusted importer. Its absence
denies import; billing read permission and budget management do not imply write permission.
Connection ownership, provider identity and configured provider allowlists are still checked.
Read-only HTTP mounts keep the import POST disabled. The private HTTP/client workspaces add
`POST /v1/billing/import` and `GET /v1/billing/imports`; they are not additional npm releases.

Parse the original UTF-8 export with `parseBillingExport` from `@usagekit/providers`, then pass
its hash/lines with a verified scope, complete half-open window and historical attribution.
The first import supplies `expectedPreviousImportId: null`; a revision supplies the current
import ID. Identical files replay retained results. An omitted line is not a refund or zero.
Details and limits are in [BILLING-IMPORTS.md](BILLING-IMPORTS.md).

The DataforSEO task-history parser requires JSON numeric source context to retain exact USD
lexemes, including values beyond the safe integer range. Node 22.23.1 supports it. Unsupported
runtimes fail closed for charged rows; do not replace exact parsing with rounded floats.

## Keep host rollout separate

Package compatibility does not establish a host cutover. Rehearse atomic wallet coordination,
retained epoch/funding ownership, real-database crashes, delayed evidence, queue fencing and
rollback drain. Establish representative shadow parity and live per-user usage/budget views
before authoritative enablement. [PLAN.md](PLAN.md) retains the complete P8 host exit gate.
