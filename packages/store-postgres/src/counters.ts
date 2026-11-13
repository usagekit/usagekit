import type { RequestState } from "@usagekit/core";
import type { Clock, Store } from "@usagekit/store";
import {
  bucketOf,
  countIdentity,
  validateCountRequest,
  validateRequestCountsQuery,
} from "@usagekit/store";
import { canonical, encode, hash, key } from "./codec.js";
import { integerValue, type IntegerValue } from "./numeric.js";
import { lock, SQL, type transactions } from "./sql.js";

export function requestCounters(
  tx: ReturnType<typeof transactions>,
  clock: Clock,
): Pick<Store, "countRequest" | "requestCounts"> {
  return {
    async countRequest(input) {
      validateCountRequest(input);
      const identity = hash(countIdentity(input));
      return tx.write(async (sql) => {
        await lock(sql, `metering:operation:${key(input.scope.namespace, input.commandId)}`);
        const [previous] = await sql.query<{ identity_hash: string }>(SQL.sql`
          SELECT identity_hash FROM metering_request_command
          WHERE namespace=${input.scope.namespace} AND command_id=${input.commandId}`);
        if (previous)
          return previous.identity_hash === identity
            ? { outcome: "counted" as const, replayed: true }
            : { outcome: "conflict" as const, reason: "command_mismatch" as const };
        const [operation] = await sql.query<{ operation_id: string }>(SQL.sql`
          SELECT operation_id FROM metering_operation
          WHERE namespace=${input.scope.namespace} AND operation_id=${input.commandId}`);
        if (operation) return { outcome: "conflict" as const, reason: "command_mismatch" as const };
        const bucket = bucketOf(input, clock.now());
        await sql.execute(SQL.sql`
          INSERT INTO metering_request_count(bucket_key,namespace,day,body,count)
          VALUES(${canonical(bucket)},${bucket.namespace},${new Date(`${bucket.day}T00:00:00Z`)},${encode(bucket)}::jsonb,1)
          ON CONFLICT(bucket_key) DO UPDATE SET count=metering_request_count.count+1`);
        await sql.execute(SQL.sql`
          INSERT INTO metering_request_command(namespace,command_id,identity_hash)
          VALUES(${input.scope.namespace},${input.commandId},${identity})`);
        return { outcome: "counted" as const, replayed: false };
      });
    },
    async requestCounts(query) {
      validateRequestCountsQuery(query);
      return tx.read(async (sql) => {
        const clauses = [
          SQL.sql`namespace=${query.scope.namespace}`,
          SQL.sql`day>=${new Date(query.from)}`,
          SQL.sql`day<${new Date(query.to)}`,
        ];
        if (query.scope.kind === "principal")
          clauses.push(SQL.sql`body->>'principal'=${query.scope.principal}`);
        if (query.scope.kind === "group")
          clauses.push(SQL.sql`body->>'group'=${query.scope.group}`);
        if (query.scope.kind === "platform_pool")
          clauses.push(SQL.sql`body->'pools' @> ${JSON.stringify([query.scope.poolId])}::jsonb`);
        if (query.connection) clauses.push(SQL.sql`body->>'connection'=${query.connection}`);
        const dimensions = query.groupBy.flatMap((dimension) => [
          SQL.sql`${dimension}::text`,
          SQL.sql`body->>${dimension}`,
        ]);
        const dimensionsSql = dimensions.length
          ? SQL.sql`jsonb_build_object(${SQL.join(dimensions)})`
          : SQL.sql`'{}'::jsonb`;
        const order = [
          ...query.groupBy.map((dimension) => SQL.sql`dimensions->>${dimension} COLLATE "C"`),
          SQL.sql`state COLLATE "C"`,
        ];
        const limit = query.limit ?? 1000;
        const rows = await sql.query<{
          dimensions: Record<string, string>;
          state: RequestState;
          count: IntegerValue;
        }>(
          SQL.sql`
          SELECT dimensions,state,count FROM (
            SELECT ${dimensionsSql} AS dimensions,body->>'state' AS state,sum(count)::text AS count
            FROM metering_request_count WHERE ${SQL.join(clauses, " AND ")} GROUP BY 1,2
          ) grouped ORDER BY ${SQL.join(order)} LIMIT ${limit + 1}`,
          ["count"],
        );
        return {
          rows: rows
            .slice(0, limit)
            .map((row) => ({ ...row, count: integerValue(row.count, "count") })),
          asOf: clock.now().toISOString(),
          truncated: rows.length > limit,
        };
      });
    },
  };
}
