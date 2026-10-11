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
the standalone migrator. No private application tables or schema mappings are shipped.

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
