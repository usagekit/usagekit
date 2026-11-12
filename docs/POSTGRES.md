# Postgres Store

`@usagekit/store-postgres` is published at 0.8.0 in the seven-package cohort and moves to 0.9.0
in lockstep, without functional changes from 0.6.0. It implements
the complete Store contract, including billing imports, using normalized Postgres tables.
Install the published exact version anonymously, or use the reviewed candidate tarballs
when validating an unreleased checkout. See [consuming packages](CONSUMING.md) for the
availability check and installation commands. A checkout build does not publish the adapter.

## Native pg pool

```ts
import { Pool } from "pg";
import { createPostgresStore, migratePostgresStore } from "@usagekit/store-postgres";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
// Run explicitly with the deployment's migration role before starting the application.
await migratePostgresStore({ pool, schema: "usagekit", createSchema: true });
const store = await createPostgresStore({ pool, schema: "usagekit", clock });
```

The caller owns the pool and calls `pool.end()` at shutdown. Runtime Store creation never
applies DDL. Migrations are atomic, serialized, versioned and checksum-verified; repeated
calls are harmless. A modified or unsupported version fails configuration. Schema names
are validated before any SQL executes. The runtime role needs access to the migrated
tables and sequences; grant DDL only to the migration role.

The unreleased native settlement extension requires schema version 2 for every user,
including operations without a settlement policy. Stop writers, save a pre-upgrade
snapshot, run `migratePostgresStore` with the upgraded package, then start upgraded
writers. `createPostgresStore` and `createTransactionBoundStore` check the exact schema
version before any Store write, including cursor metadata initialization. An absent,
older or newer version throws the exported `PostgresSchemaVersionError`, with numeric
`actualVersion` (0 when absent) and `requiredVersion` properties. Its message names
`migratePostgresStore`. A newer schema needs its matching package; the migrator cannot
downgrade it. Returning to 0.11.0 requires restoring the pre-upgrade snapshot, even if
no finer-scale rows have been written. See the [upgrade order](CONSUMING.md#upgrade-order-for-the-unreleased-native-settlement-extension).

The schema check costs two queries: `to_regclass` and a scan of the small version
table. It runs once per `createPostgresStore` instance (including the pooled
constructor), and once per host transaction when using `createTransactionBoundStore`.
These are additional to cursor metadata initialization. Results are not cached
across host transactions.

A non-contiguous migration history is an unsupported database state, reported as
`PostgresSchemaVersionError` with `reason: "unsupported"`. Inspect and repair that
history before proceeding; do not run the migrator blindly. Contiguous older and
newer histories report `reason: "older"` and `reason: "newer"`, respectively.

## Prisma and existing host transactions

```ts
import { createPostgresStore, createPrismaPostgresDriver } from "@usagekit/store-postgres";

const store = await createPostgresStore({
  driver: createPrismaPostgresDriver(prisma),
  schema: "usagekit",
  clock,
});
```

The Prisma integration uses its raw-query methods with separately bound positional
values. Date parameters retain their UTC offset even when a host connection uses a non-UTC
TimeZone. It needs no generated host types or Prisma runtime in the published adapter. Hosts can
manage equivalent tables through their existing migration system instead of invoking
the standalone migrator, including the `metering_schema_version` migration records.
No private application tables or schema mappings are shipped.

For accounting that must commit with a host ledger, call `createTransactionBoundStore`
with `prismaPostgresExecutor(transaction)` or `nodePostgresExecutor(client)`. The caller
owns the transaction, its validated `search_path`, isolation level, commit and rollback.
The factory initializes cursor metadata within that transaction and never opens a nested
transaction. A host failure rolls its changes and accounting back together.

## Guarantees and boundaries

Writes atomically recheck operation versions, command identities, leases and all applicable
budget bounds. Shared bounds serialize across connections and processes. Receipts, budget
projections, alerts, retained command results and billing imports commit together. Unknown
charges retain exposure. Accounting replay never grants another provider dispatch.

If an operation becomes visible only after a command waits for its lock, the command
returns a retryable `version_conflict` without writing. Retry from the start so the
connection lock is acquired first; a transaction-bound caller must retry in a new
host transaction.

Standalone reads run in repeatable-read, read-only transactions. Cursor signatures and
watermarks survive process restarts; journal events serialize through commit to preserve
snapshot membership. That commit-order lock is shared within the database, so measure
write throughput for the intended workload. Commands load bounded operation and budget
projections, rather than copying the entire database into memory.

Money is exact within signed bigint bounds; quantities use numeric(38,0) with declared
scale support up to 18. Rolling windows are unsupported, as in the other durable adapters.
Authentication, authorization, provider credentials, host schema mappings and credit
authorities remain host responsibilities. Build the Meter's access context from verified
server identity.

## Verification

`npm run check` includes `npm run test:postgres`. With PostgreSQL installed, the command
starts its own loopback cluster, runs conformance, independent-pool races, rollback and
scaling checks, kills an owned child inside its write transaction, then restarts the
database and verifies rollback and retained dispatch identity from another Node process.
It stops and removes only that owned cluster afterward.

Set `POSTGRES_BIN` if `pg_config` cannot find the installation. CI may instead supply
`USAGEKIT_POSTGRES_TEST_URL` for a disposable local database named `usagekit_store_fixture`.
That mode tests application process restart and leaves database service management to CI.
A minimal test-only Prisma client is generated in ignored node_modules cache. The real Prisma
driver lane runs with a non-UTC connection timezone and competes with native pg on the same
budgets, also proving migration compatibility, joined host rollback and read-only enforcement.
Each test creates and removes only its own random schema. Missing Postgres is a failed
full check; unit tests alone do not establish adapter acceptance.
