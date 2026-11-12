import type { Store } from "../src/index.js";

/** Deterministic release-0.11.0 probe shared by capture and all conformance stores. */
export async function capturePolicyFree(
  store: Pick<Store, "reserve" | "markDispatchIntent" | "settle">,
) {
  const results = [];
  for (const certainty of ["unknown", "measured"] as const) {
    const r = await store.reserve({
      operationId: `legacy-${certainty}`,
      scope: { namespace: "test", principal: "u1", connection: "c1" },
      fundingSource: "byok",
      costOwner: "u1",
      surface: "app",
      source: "app",
      provider: "search",
      operation: "search",
      estimate: [{ value: 1n, unit: "requests", scale: 0 }],
      estimateSource: "manual",
    });
    if (r.outcome !== "reserved") throw new Error("reserve fixture");
    const ref = { namespace: "test", principal: "u1", operationId: r.operation.operationId };
    const g = await store.markDispatchIntent({
      ...ref,
      commandId: "intent-" + certainty,
      expectedVersion: r.operation.version,
      holder: "native",
      leaseTtlMs: 1000,
    });
    if (!("granted" in g) || !g.granted) throw new Error("dispatch fixture");
    const result = await store.settle({
      ...ref,
      commandId: "settle-" + certainty,
      expectedVersion: g.operation.version,
      authority: { kind: "lease", leaseId: g.lease.leaseId },
      receipt: {
        id: "legacy-proof",
        measurements: [
          {
            unit: "requests",
            quantity: { value: 1n, unit: "requests", scale: 0 },
            certainty: "measured",
          },
        ],
        cost:
          certainty === "unknown"
            ? { certainty, money: null }
            : { certainty, money: { units: 1n, currency: "USD" } },
        occurredAt: "2026-09-23T12:00:00.000Z",
        recordedAt: "2026-09-23T12:00:00.000Z",
        cached: false,
        failed: false,
      },
    });
    if (result.outcome !== "settled") throw new Error("settle fixture");
    results.push(result);
  }
  return results;
}

export const serializePolicyFree = (value: unknown): string =>
  JSON.stringify(
    value,
    (_, item: unknown) => (typeof item === "bigint" ? { $bigint: item.toString() } : item),
    2,
  ) + "\n";
