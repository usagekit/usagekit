import type { OperationRef, Scope } from "@usagekit/core";
import { canonical, decode } from "./codec.js";
import { operationRow } from "./records.js";
import { lock, type Sql } from "./sql.js";

/** Serialize export snapshots with new operations and evidence in this immutable connection. */
export async function lockConnectionAccounting(
  sql: Sql,
  namespace: string,
  connection: string | undefined,
) {
  if (connection)
    await lock(sql, `metering:connection-accounting:${canonical([namespace, connection])}`);
}

export async function lockOperationAccounting(sql: Sql, ref: OperationRef) {
  const row = await operationRow(sql, ref.namespace, ref.operationId);
  if (!row) return false;
  const input = decode<{ scope: Scope }>(row.input);
  await lockConnectionAccounting(sql, ref.namespace, input.scope.connection);
  return true;
}
