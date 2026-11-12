import { addMoney } from "@usagekit/core";
import type { Cost, Measurement, Operation, UsageQuery, UsageRow } from "@usagekit/core";
import { plus, effective, canonical } from "./util.js";
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
  const map = new Map(a.map((m) => [m.unit, structuredClone(m)]));
  for (const m of b) {
    const prev = map.get(m.unit);
    if (!prev) {
      map.set(m.unit, structuredClone(m));
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
export function rows(operations: Iterable<Operation>, q: UsageQuery): UsageRow[] {
  const map = new Map<string, UsageRow>();
  for (const op of operations) {
    if (!["pending", "settled"].includes(op.state)) continue;
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
          cost: prev ? combineCost(prev.cost, receipt.cost) : structuredClone(receipt.cost),
          unknownOperations: (prev?.unknownOperations ?? 0n) + (op.state === "pending" ? 1n : 0n),
        });
      }
  }
  return [...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, r]) => r);
}
