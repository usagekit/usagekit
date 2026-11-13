import { createHmac, timingSafeEqual } from "node:crypto";
import type { OperationsPage, OperationsQuery } from "@usagekit/core";
import { type Clock, InvalidInput } from "@usagekit/store";
import { canonical } from "./codec.js";
import { integerText, type IntegerValue } from "./numeric.js";
import { hydrate, type OperationRow } from "./records.js";
import { SQL, type Sql } from "./sql.js";

type Cursor = { query: string; watermark: string; offset: number; asOf: string; expiresAt: number };
export function operationsReader(clock: Clock, secret: string) {
  const sign = (body: string) =>
    createHmac("sha256", secret).update(`operations:${body}`).digest("base64url");
  const open = (cursor: string, identity: string): Cursor => {
    try {
      const parts = cursor.split(".");
      if (parts.length !== 2) throw new Error();
      const [body, signature] = parts as [string, string],
        actual = Buffer.from(signature),
        expected = Buffer.from(sign(body));
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
        throw new Error();
      const snapshot = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Cursor;
      if (snapshot.query !== identity || snapshot.expiresAt <= clock.now().getTime())
        throw new Error();
      return snapshot;
    } catch {
      throw new InvalidInput("cursor", "unknown cursor or query mismatch");
    }
  };
  return async (sql: Sql, q: OperationsQuery): Promise<OperationsPage> => {
    const { cursor, ...query } = q,
      identity = canonical(query);
    const [watermark] = cursor
      ? []
      : await sql.query<{ n: IntegerValue }>(
          SQL.sql`SELECT COALESCE(MAX(event_id),0) AS n FROM metering_event`,
          ["n"],
        );
    const snapshot: Cursor = cursor
      ? open(cursor, identity)
      : {
          query: identity,
          watermark: integerText(watermark?.n ?? "0", "n"),
          offset: 0,
          asOf: clock.now().toISOString(),
          expiresAt: clock.now().getTime() + 300000,
        };
    const previousState = SQL.sql`(SELECT e.state FROM metering_event e WHERE e.operation_pk=o.operation_pk AND e.event_id<=${BigInt(snapshot.watermark)} ORDER BY e.event_id DESC LIMIT 1)`;
    const clauses = [
      SQL.sql`o.namespace=${q.scope.namespace}`,
      SQL.sql`o.created_at>=${new Date(q.from)}`,
      SQL.sql`o.created_at<${new Date(q.to)}`,
      SQL.sql`${previousState} IS NOT NULL`,
    ];
    if (q.states)
      clauses.push(
        q.states.length ? SQL.sql`${previousState} IN (${SQL.join(q.states)})` : SQL.sql`FALSE`,
      );
    if (q.scope.kind === "principal") clauses.push(SQL.sql`o.principal=${q.scope.principal}`);
    if (q.scope.kind === "group")
      clauses.push(SQL.sql`o.input->'scope'->>'group'=${q.scope.group}`);
    if (q.scope.kind === "platform_pool")
      clauses.push(SQL.sql`o.input->'platformPools' @> ${JSON.stringify([q.scope.poolId])}::jsonb`);
    if (q.connection) clauses.push(SQL.sql`o.input->'scope'->>'connection'=${q.connection}`);
    const limit = q.limit ?? 1000;
    const rows = await sql.query<OperationRow>(
      SQL.sql`SELECT o.* FROM metering_operation o WHERE ${SQL.join(clauses, " AND ")} ORDER BY o.created_at,o.operation_id LIMIT ${limit + 1} OFFSET ${snapshot.offset}`,
    );
    // The 0.4 contract freezes membership/order at the watermark and returns current records.
    const operations = [];
    for (const row of rows.slice(0, limit)) operations.push(await hydrate(sql, row));
    const page: OperationsPage = {
      operations,
      asOf: snapshot.asOf,
      watermark: snapshot.watermark,
    };
    if (rows.length > limit) {
      const body = Buffer.from(
        JSON.stringify({ ...snapshot, offset: snapshot.offset + limit }),
      ).toString("base64url");
      page.nextCursor = `${body}.${sign(body)}`;
    }
    return page;
  };
}
