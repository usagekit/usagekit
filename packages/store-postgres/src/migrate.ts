import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { createNodePostgresDriver, type PostgresDriver } from "./driver.js";
import { schemaMigrations } from "./schema.js";
import { schemaIdentifier } from "./statement.js";

type Options = ({ pool: Pool; driver?: never } | { driver: PostgresDriver; pool?: never }) & {
  schema?: string;
  createSchema?: boolean;
};
/** Explicit, atomic and serialized. Store creation never applies migrations implicitly. */
export async function migratePostgresStore(options: Options): Promise<void> {
  const schema = options.schema ?? "public",
    identifier = schemaIdentifier(schema);
  const driver = options.driver ?? createNodePostgresDriver(options.pool);
  const migrations = schemaMigrations.map((statements, index) => ({
    version: index + 1,
    statements,
    checksum: createHash("sha256").update(statements.join("\n")).digest("hex"),
  }));
  await driver.transaction(false, async (sql) => {
    await sql.query({
      text: "SELECT 1 AS acquired FROM pg_advisory_xact_lock(hashtextextended($1,0))",
      values: [`usagekit:migrate:${schema}`],
    });
    if (options.createSchema)
      await sql.execute({ text: `CREATE SCHEMA IF NOT EXISTS ${identifier}`, values: [] });
    await sql.query({ text: "SELECT set_config('search_path',$1,true)", values: [identifier] });
    await sql.execute({
      text: "CREATE TABLE IF NOT EXISTS metering_schema_version (version integer PRIMARY KEY, checksum text NOT NULL)",
      values: [],
    });
    const rows = await sql.query<{ version: number; checksum: string }>({
      text: "SELECT version,checksum FROM metering_schema_version ORDER BY version",
      values: [],
    });
    if (
      rows.some(
        (row, index) => row.version !== index + 1 || migrations[index]?.checksum !== row.checksum,
      )
    )
      throw new Error("Unsupported or modified Postgres Store schema version");
    for (const migration of migrations.slice(rows.length)) {
      for (const text of migration.statements) await sql.execute({ text, values: [] });
      await sql.execute({
        text: "INSERT INTO metering_schema_version(version,checksum) VALUES($1,$2)",
        values: [migration.version, migration.checksum],
      });
    }
  });
}
