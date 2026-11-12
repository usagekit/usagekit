import type Database from "better-sqlite3";
import { moneyScale } from "@usagekit/core";
import type { Operation, Receipt, OperationRef, ReserveInput } from "@usagekit/core";
import { encode, decode, integer } from "./serialize.js";
import { key, effective } from "./util.js";
export type OperationRow = {
  principal: string;
  reservation_expires_at: string;
  operation_pk: string;
  operation_json: string;
  state: Operation["state"];
  version: bigint;
  budget_epochs_json: string;
  lease_id: string | null;
  lease_holder: string | null;
  lease_expires_at: string | null;
  lease_kind: "lease" | "recovery" | null;
  created_at: string;
  updated_at: string;
  semantic_json: string;
  warnings_json: string;
  alerts_json: string;
};
export const operationRow = (db: Database.Database, namespace: string, id: string) =>
  db.prepare("SELECT * FROM operations WHERE operation_pk=?").get(key(namespace, id)) as
    | OperationRow
    | undefined;
export function receipts(db: Database.Database, pk: string): Receipt[] {
  const rows = db
    .prepare(
      "SELECT r.*,m.unit,m.value,m.scale,m.certainty FROM receipts r LEFT JOIN measurements m USING(receipt_pk) WHERE r.operation_pk=? ORDER BY r.sequence,m.rowid",
    )
    .all(pk) as any[];
  const result = new Map<string, Receipt>();
  for (const row of rows) {
    let receipt = result.get(row.receipt_pk);
    if (!receipt) {
      const metadata = decode<
        Omit<Receipt, "id" | "measurements" | "cost" | "occurredAt" | "recordedAt"> & {
          cost?: Receipt["cost"];
        }
      >(row.receipt_json);
      receipt = {
        ...metadata,
        id: row.receipt_id,
        occurredAt: row.occurred_at,
        recordedAt: row.recorded_at,
        measurements: [],
        cost:
          row.cost_certainty === "unknown"
            ? { certainty: "unknown", money: null }
            : {
                certainty: row.cost_certainty,
                money: {
                  units: row.cost_units,
                  currency: "USD",
                  ...(Number(row.cost_scale) === 4 ? {} : { scale: Number(row.cost_scale) }),
                },
              },
        ...(row.supersedes ? { supersedes: row.supersedes } : {}),
      };
      result.set(row.receipt_pk, receipt);
    }
    if (row.unit !== null)
      receipt.measurements = [
        ...receipt.measurements,
        row.certainty === "unknown"
          ? { unit: row.unit, certainty: "unknown", quantity: null }
          : {
              unit: row.unit,
              certainty: row.certainty,
              quantity: { unit: row.unit, value: row.value, scale: Number(row.scale) },
            },
      ];
  }
  return [...result.values()];
}
export function hydrate(db: Database.Database, row: OperationRow): Operation {
  return {
    ...decode<ReserveInput>(row.operation_json),
    reservationExpiresAt: row.reservation_expires_at,
    state: row.state,
    version: Number(row.version),
    budgetEpochs: decode(row.budget_epochs_json),
    receipts: receipts(db, row.operation_pk),
    lease: row.lease_id
      ? { leaseId: row.lease_id, holder: row.lease_holder!, expiresAt: row.lease_expires_at! }
      : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
export function find(
  db: Database.Database,
  ref: OperationRef,
): { op: Operation; row: OperationRow } | null {
  const row = operationRow(db, ref.namespace, ref.operationId);
  if (!row) return null;
  return row.principal === ref.principal ? { op: hydrate(db, row), row } : null;
}
export function appendReceipt(db: Database.Database, op: Operation, r: Receipt): void {
  const pk = key(op.scope.namespace, op.operationId),
    rpk = key(pk, r.id),
    {
      id: _,
      supersedes: __,
      measurements: ___,
      cost: ____,
      occurredAt: _____,
      recordedAt: ______,
      ...metadata
    } = r;
  db.prepare(
    "INSERT INTO receipts(receipt_pk,operation_pk,receipt_id,supersedes,receipt_json,occurred_at,recorded_at,cost_units,cost_certainty,sequence,cost_scale) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
  ).run(
    rpk,
    pk,
    r.id,
    r.supersedes ?? null,
    encode(metadata),
    r.occurredAt,
    r.recordedAt,
    integer(r.cost.money?.units ?? null),
    r.cost.certainty,
    op.receipts.length - 1,
    r.cost.money ? moneyScale(r.cost.money) : 4,
  );
  for (const m of r.measurements)
    db.prepare("INSERT INTO measurements VALUES(?,?,?,?,?)").run(
      rpk,
      m.unit,
      integer(m.quantity?.value ?? null),
      m.quantity?.scale ?? null,
      m.certainty,
    );
}
export function event(db: Database.Database, op: Operation): void {
  const r = effective(op),
    pk = key(op.scope.namespace, op.operationId);
  db.prepare(
    "INSERT INTO operation_events(operation_pk,namespace,state,receipt_pk,occurred_at) VALUES(?,?,?,?,?)",
  ).run(
    pk,
    op.scope.namespace,
    op.state,
    r ? key(pk, r.id) : null,
    r ? new Date(r.occurredAt).toISOString() : null,
  );
}
export function updateOperation(
  db: Database.Database,
  before: Operation,
  after: Operation,
  leaseKind: "lease" | "recovery" | null,
): void {
  const result = db
    .prepare(
      "UPDATE operations SET state=?,version=?,lease_id=?,lease_holder=?,lease_expires_at=?,lease_kind=?,updated_at=? WHERE operation_pk=? AND version=? AND state=?",
    )
    .run(
      after.state,
      after.version,
      after.lease?.leaseId ?? null,
      after.lease?.holder ?? null,
      after.lease?.expiresAt ?? null,
      leaseKind,
      after.updatedAt,
      key(after.scope.namespace, after.operationId),
      before.version,
      before.state,
    );
  if (result.changes !== 1)
    throw new Error("Operation compare-and-set failed inside exclusive command");
}
