import { createHmac, timingSafeEqual } from "node:crypto";
import type Database from "better-sqlite3";
import type { Clock } from "@usagekit/store";
import { InvalidInput } from "@usagekit/store";
import type { Operation, Receipt, ReserveInput, UsageQuery, UsagePage } from "@usagekit/core";
import { decode } from "./serialize.js";
import { canonical } from "./util.js";
import { rows } from "./group.js";
export function usageReader(db: Database.Database, clock: Clock, ttl: number) {
  const secret = (
    db.prepare("SELECT value FROM store_metadata WHERE key='cursor_key'").get() as { value: string }
  ).value;
  const sign = (body: string) => createHmac("sha256", secret).update(body).digest("base64url");
  type Snapshot = {
    query: string;
    watermark: string;
    offset: number;
    asOf: string;
    expiresAt: number;
  };
  return (q: UsageQuery): UsagePage =>
    db
      .transaction(() => {
        const { cursor, ...query } = q,
          identity = canonical(query);
        let snapshot: Snapshot;
        if (cursor) {
          try {
            const parts = cursor.split(".");
            if (parts.length !== 2) throw new Error();
            const [body, signature] = parts as [string, string],
              actual = Buffer.from(signature),
              expected = Buffer.from(sign(body));
            if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
              throw new Error();
            snapshot = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Snapshot;
            if (snapshot.query !== identity || snapshot.expiresAt <= clock.now().getTime())
              throw new Error();
          } catch {
            throw new InvalidInput("cursor", "unknown cursor or query mismatch");
          }
        } else
          snapshot = {
            query: identity,
            watermark: String(
              (
                db.prepare("SELECT COALESCE(MAX(event_id),0) AS n FROM operation_events").get() as {
                  n: bigint;
                }
              ).n,
            ),
            offset: 0,
            asOf: clock.now().toISOString(),
            expiresAt: clock.now().getTime() + ttl,
          };
        const clauses = [
            "e.namespace=?",
            "e.occurred_at>=?",
            "e.occurred_at<?",
            "e.event_id=(SELECT MAX(n.event_id) FROM operation_events n WHERE n.operation_pk=e.operation_pk AND n.event_id<=?)",
            "e.state IN ('pending','settled')",
          ],
          args: (string | bigint)[] = [
            q.scope.namespace,
            new Date(q.from).toISOString(),
            new Date(q.to).toISOString(),
            BigInt(snapshot.watermark),
          ];
        if (q.scope.kind === "principal") {
          clauses.push("o.principal=?");
          args.push(q.scope.principal);
        }
        if (q.scope.kind === "group") {
          clauses.push("json_extract(o.operation_json,'$.scope.group')=?");
          args.push(q.scope.group);
        }
        if (q.scope.kind === "platform_pool") {
          clauses.push(
            "EXISTS(SELECT 1 FROM json_each(o.operation_json,'$.platformPools') p WHERE p.value=?)",
          );
          args.push(q.scope.poolId);
        }
        if (q.connection) {
          clauses.push("json_extract(o.operation_json,'$.scope.connection')=?");
          args.push(q.connection);
        }
        const result = db
          .prepare(
            `SELECT o.operation_pk,o.operation_json,e.state,r.*,m.unit,m.value,m.scale,m.certainty FROM operation_events e JOIN operations o USING(operation_pk) JOIN receipts r ON r.receipt_pk=e.receipt_pk LEFT JOIN measurements m ON m.receipt_pk=r.receipt_pk WHERE ${clauses.join(" AND ")} ORDER BY e.event_id,m.rowid`,
          )
          .iterate(...args);
        const operations = new Map<string, Operation>();
        for (const raw of result) {
          const r = raw as any;
          let op = operations.get(r.operation_pk);
          if (!op) {
            const metadata = decode<
              Omit<Receipt, "id" | "measurements" | "cost" | "occurredAt" | "recordedAt"> & {
                cost?: Receipt["cost"];
              }
            >(r.receipt_json);
            const receipt: Receipt = {
              ...metadata,
              id: r.receipt_id,
              occurredAt: r.occurred_at,
              recordedAt: r.recorded_at,
              measurements: [],
              cost:
                r.cost_certainty === "unknown"
                  ? { certainty: "unknown", money: null }
                  : {
                      certainty: r.cost_certainty,
                      money: {
                        currency: "USD",
                        units: r.cost_units,
                        ...(metadata.cost?.money?.scale === undefined
                          ? {}
                          : { scale: metadata.cost!.money!.scale }),
                      },
                    },
            };
            op = {
              ...decode<ReserveInput>(r.operation_json),
              state: r.state,
              version: 0,
              reservationExpiresAt: "",
              createdAt: "",
              updatedAt: "",
              budgetEpochs: [],
              lease: null,
              receipts: [receipt],
            };
            operations.set(r.operation_pk, op);
          }
          if (r.unit !== null)
            op.receipts[0]!.measurements = [
              ...op.receipts[0]!.measurements,
              r.certainty === "unknown"
                ? { unit: r.unit, certainty: "unknown", quantity: null }
                : {
                    unit: r.unit,
                    certainty: r.certainty,
                    quantity: { unit: r.unit, value: r.value, scale: Number(r.scale) },
                  },
            ];
        }
        const all = rows(operations.values(), q),
          end = snapshot.offset + (q.limit ?? 1000),
          page: UsagePage = {
            rows: all.slice(snapshot.offset, end),
            watermark: snapshot.watermark,
            asOf: snapshot.asOf,
          };
        if (end < all.length) {
          const body = Buffer.from(JSON.stringify({ ...snapshot, offset: end })).toString(
            "base64url",
          );
          page.nextCursor = body + "." + sign(body);
        }
        return page;
      })
      .deferred();
}
