import { schemaMigrations } from "./schema.js";
import { SQL, type Sql } from "./sql.js";

/** Store creation requires the exact schema, including when no native policy is used. */
export class PostgresSchemaVersionError extends Error {
  readonly requiredVersion = schemaMigrations.length;

  constructor(
    readonly actualVersion: number,
    readonly reason: "older" | "newer" | "unsupported" = actualVersion > schemaMigrations.length
      ? "newer"
      : "older",
  ) {
    const required = schemaMigrations.length;
    super(
      `Postgres Store schema version ${actualVersion}; this package requires ${required}. ` +
        (reason === "unsupported"
          ? "Unsupported database state: migration versions do not match this package's migration list. Inspect and repair the migration history; do not run migratePostgresStore blindly."
          : reason === "newer"
            ? "Use the matching upgraded package or restore a pre-upgrade snapshot; migratePostgresStore cannot downgrade."
            : "Run migratePostgresStore with the upgraded package before creating the Store."),
    );
    this.name = "PostgresSchemaVersionError";
  }
}

export async function verifySchemaVersion(sql: Sql): Promise<void> {
  const [table] = await sql.query<{ name: string | null }>(
    SQL.sql`SELECT to_regclass('metering_schema_version')::text AS name`,
  );
  if (!table?.name) throw new PostgresSchemaVersionError(0);
  const versions = await sql.query<{ version: number }>(
    SQL.sql`SELECT version FROM metering_schema_version ORDER BY version`,
  );
  if (versions.some((row, index) => row.version !== index + 1))
    throw new PostgresSchemaVersionError(versions.at(-1)?.version ?? 0, "unsupported");
  if (versions.length !== schemaMigrations.length)
    throw new PostgresSchemaVersionError(versions.at(-1)?.version ?? 0);
}
