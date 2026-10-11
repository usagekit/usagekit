import type { ConnectionPolicy, Quantity } from "@usagekit/core";
import type { Store } from "@usagekit/store";
import type { Catalog } from "@usagekit/providers";
import type { Vault } from "./vault.js";

/** Local-server evidence is scoped to its principal. An incomplete bounded sample falls back
 * to the catalog; no price is inferred from estimated, failed or cached receipts. */
export async function resolvePricing(
  id: string,
  { vault, store, catalog, now }: { vault: Vault; store: Store; catalog: Catalog; now: () => Date },
): Promise<ConnectionPolicy | undefined> {
  const connection = vault.list().find((entry) => entry.connectionId === id);
  if (!connection) return undefined;
  const { manualPrices: encoded, ...policy } = connection;
  const manualPrices =
    encoded &&
    Object.fromEntries(
      Object.entries(encoded).map(([op, q]) => [op, { ...q, value: BigInt(q.value) }]),
    );
  const unit = catalog.providers().find((p) => p.id === connection.provider)?.billing.unit;
  const to = now(),
    from = new Date(to.getTime() - 30 * 86400000);
  const page = await store.listOperations({
    scope: { kind: "principal", namespace: "local", principal: "local" },
    connection: id,
    states: ["settled"],
    from: from.toISOString(),
    to: new Date(to.getTime() + 1).toISOString(),
    limit: 1000,
  });
  const samples = new Map<string, Quantity[]>();
  if (!page.nextCursor && unit)
    for (const op of page.operations) {
      if (op.provider !== connection.provider || op.scope.connection !== id) continue;
      const receipt = op.receipts.at(-1);
      if (!receipt || receipt.failed || receipt.cached) continue;
      const measurement = receipt.measurements.find(
        (m) => m.unit === unit && m.certainty === "measured",
      );
      if (!measurement || measurement.certainty === "unknown") continue;
      const values = samples.get(op.operation) ?? [];
      values.push(measurement.quantity);
      samples.set(op.operation, values);
    }
  return {
    ...policy,
    fundingSource: "byok",
    ...(manualPrices ? { manualPrices } : {}),
    measured(operation) {
      const values = samples.get(operation);
      if (!values?.length || !unit) return undefined;
      const scale = Math.max(...values.map((q) => q.scale));
      const normalized = values
        .map((q) => q.value * 10n ** BigInt(scale - q.scale))
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      // Upper median avoids rounding down even samples. Values never pass through Number.
      return {
        samples: values.length,
        quantity: { unit, scale, value: normalized[Math.floor(normalized.length / 2)]! },
      };
    },
  };
}
