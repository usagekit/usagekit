import { addMoney } from "@usagekit/core";
import type {
  UsageQuery,
  UsagePage,
  UsageRow,
  Operation,
  Measurement,
  Cost,
  DefinedBudgetsQuery,
  ApplicableBudgetsQuery,
  OperationsQuery,
  OperationsPage,
} from "@usagekit/core";
import { copy, canonical, InvalidInput } from "./state.js";
import type { State } from "./state.js";
import { currentBudgets, applicable, effective, plus } from "./admission.js";
export const definedBudgets = (s: State, q: DefinedBudgetsQuery) =>
  copy(currentBudgets(s).filter((b) => canonical(b.scope) === canonical(q.scope)));
export const applicableBudgets = (s: State, q: ApplicableBudgetsQuery) => copy(applicable(s, q));
function inScope(op: Operation, q: Pick<UsageQuery, "scope" | "connection">): boolean {
  if (
    op.scope.namespace !== q.scope.namespace ||
    (q.connection && op.scope.connection !== q.connection)
  )
    return false;
  switch (q.scope.kind) {
    case "namespace":
      return true;
    case "principal":
      return op.scope.principal === q.scope.principal;
    case "group":
      return op.scope.group === q.scope.group;
    case "platform_pool":
      return op.platformPools?.includes(q.scope.poolId) ?? false;
  }
}
function combineCost(a: Cost, b: Cost): Cost {
  if (a.certainty === "unknown" || b.certainty === "unknown")
    return { certainty: "unknown", money: null };
  return {
    certainty:
      a.certainty === "estimated" || b.certainty === "estimated" ? "estimated" : "measured",
    money: addMoney(a.money, b.money),
  };
}
function combineMeasurements(a: readonly Measurement[], b: readonly Measurement[]): Measurement[] {
  const map = new Map(a.map((m) => [m.unit, copy(m)]));
  for (const m of b) {
    const prev = map.get(m.unit);
    if (!prev) {
      map.set(m.unit, copy(m));
      continue;
    }
    map.set(
      m.unit,
      prev.certainty === "unknown" || m.certainty === "unknown"
        ? { unit: m.unit, certainty: "unknown", quantity: null }
        : {
            unit: m.unit,
            certainty:
              prev.certainty === "estimated" || m.certainty === "estimated"
                ? "estimated"
                : "measured",
            quantity: plus(prev.quantity, m.quantity),
          },
    );
  }
  return [...map.values()].sort((a, b) => a.unit.localeCompare(b.unit));
}
function rows(s: State, q: UsageQuery): UsageRow[] {
  const map = new Map<string, UsageRow>();
  for (const op of s.operations.values()) {
    if (!inScope(op, q) || !["pending", "settled"].includes(op.state)) continue;
    const receipt = effective(op);
    if (!receipt || receipt.canonicalOperationId) continue;
    const occurred = Date.parse(receipt.occurredAt);
    if (occurred < Date.parse(q.from) || occurred >= Date.parse(q.to)) continue;
    const pools = q.groupBy.includes("platform_pool")
      ? q.scope.kind === "platform_pool"
        ? [q.scope.poolId]
        : op.platformPools?.length
          ? op.platformPools
          : [""]
      : [""];
    // Pool and tag rows explode per value; an operation without any contributes one empty row.
    const tags = q.groupBy.includes("tag") && op.scope.tags?.length ? op.scope.tags : [""];
    for (const pool of pools)
      for (const tag of tags) {
        const dimensions: Record<string, string> = {};
        for (const dimension of q.groupBy) {
          switch (dimension) {
            case "principal":
              dimensions[dimension] = op.scope.principal;
              break;
            case "connection":
              dimensions[dimension] = op.scope.connection;
              break;
            case "day":
              dimensions[dimension] = new Date(receipt.occurredAt).toISOString().slice(0, 10);
              break;
            case "access_credential":
              dimensions[dimension] = op.scope.accessCredential
                ? canonical([op.scope.accessCredential.kind, op.scope.accessCredential.id])
                : "";
              break;
            case "platform_pool":
              dimensions[dimension] = pool;
              break;
            case "funding_source":
              dimensions[dimension] = op.fundingSource;
              break;
            case "tag":
              dimensions[dimension] = tag;
              break;
            default:
              dimensions[dimension] = op[dimension];
          }
        }
        const k = canonical([dimensions, op.fundingSource, op.costOwner]),
          prev = map.get(k),
          measurements = receipt.measurements.filter((m) => q.units.includes(m.unit));
        map.set(k, {
          dimensions,
          fundingSource: op.fundingSource,
          costOwner: op.costOwner,
          measurements: combineMeasurements(prev?.measurements ?? [], measurements),
          cost: prev ? combineCost(prev.cost, receipt.cost) : copy(receipt.cost),
          unknownOperations: (prev?.unknownOperations ?? 0n) + (op.state === "pending" ? 1n : 0n),
        });
      }
  }
  return [...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, r]) => r);
}
export function aggregate(s: State, q: UsageQuery): UsagePage {
  const { cursor, ...query } = q;
  const identity = canonical(query);
  let snapshot;
  if (cursor) {
    snapshot = s.cursors.get(cursor);
    if (!snapshot || snapshot.query !== identity)
      throw new InvalidInput("cursor", "unknown cursor or query mismatch");
  } else
    snapshot = {
      query: identity,
      rows: rows(s, q),
      asOf: s.clock.now().toISOString(),
      watermark: crypto.randomUUID(),
      offset: 0,
    };
  const end = snapshot.offset + (q.limit ?? 1000),
    page: UsagePage = {
      rows: copy(snapshot.rows.slice(snapshot.offset, end)),
      asOf: snapshot.asOf,
      watermark: snapshot.watermark,
    };
  if (end < snapshot.rows.length) {
    page.nextCursor = crypto.randomUUID();
    s.cursors.set(page.nextCursor, { ...snapshot, offset: end });
  }
  return page;
}
const byCreation = (a: Operation, b: Operation) =>
  a.createdAt === b.createdAt
    ? a.operationId < b.operationId
      ? -1
      : 1
    : Date.parse(a.createdAt) - Date.parse(b.createdAt);
/** Mirrors aggregate: the first page fixes membership and order; pages return current records. */
export function listOperations(s: State, q: OperationsQuery): OperationsPage {
  const { cursor, ...query } = q;
  const identity = canonical(query),
    cursors: NonNullable<State["operationCursors"]> = (s.operationCursors ??= new Map());
  let snapshot;
  if (cursor) {
    snapshot = cursors.get(cursor);
    if (!snapshot || snapshot.query !== identity)
      throw new InvalidInput("cursor", "unknown cursor or query mismatch");
  } else {
    const from = Date.parse(q.from),
      to = Date.parse(q.to);
    const members = [...s.operations.values()]
      .filter((op) => {
        const created = Date.parse(op.createdAt);
        return (
          inScope(op, q) &&
          created >= from &&
          created < to &&
          (q.states === undefined || q.states.includes(op.state))
        );
      })
      .sort(byCreation);
    snapshot = {
      query: identity,
      keys: members.map((op) => canonical([op.scope.namespace, op.operationId])),
      asOf: s.clock.now().toISOString(),
      watermark: crypto.randomUUID(),
      offset: 0,
    };
  }
  const end = snapshot.offset + (q.limit ?? 1000),
    page: OperationsPage = {
      operations: snapshot.keys.slice(snapshot.offset, end).map((k) => copy(s.operations.get(k)!)),
      asOf: snapshot.asOf,
      watermark: snapshot.watermark,
    };
  if (end < snapshot.keys.length) {
    page.nextCursor = crypto.randomUUID();
    cursors.set(page.nextCursor, { ...snapshot, offset: end });
  }
  return page;
}
