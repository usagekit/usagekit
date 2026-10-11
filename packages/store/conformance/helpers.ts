import type { ReserveInput, Operation, Receipt, Budget, Quantity } from "@usagekit/core";
export const quantity = (value = 1n, unit = "requests", scale = 0): Quantity => ({
  value,
  unit,
  scale,
});
export const input = (overrides: Partial<ReserveInput> = {}): ReserveInput => ({
  operationId: crypto.randomUUID(),
  scope: { namespace: "test", principal: "u1", connection: "c1" },
  fundingSource: "byok",
  costOwner: "u1",
  surface: "app",
  source: "app",
  provider: "search",
  operation: "search",
  estimate: [
    quantity(),
    ...(overrides.fundingSource === "platform" ? [quantity(1n, "customer_cents")] : []),
  ],
  ...overrides,
});
export const ref = (op: ReserveInput) => ({
  namespace: op.scope.namespace,
  principal: op.scope.principal,
  operationId: op.operationId,
});
export const command = (op: Operation) => ({
  ...ref(op),
  commandId: crypto.randomUUID(),
  expectedVersion: op.version,
});
export const receipt = (overrides: Partial<Receipt> = {}): Receipt => ({
  id: crypto.randomUUID(),
  measurements: [{ unit: "requests", quantity: quantity(), certainty: "measured" }],
  cost: { certainty: "measured", money: { units: 1n, currency: "USD" } },
  occurredAt: "2026-09-23T12:00:00.000Z",
  recordedAt: "2026-09-23T12:00:00.000Z",
  cached: false,
  failed: false,
  ...overrides,
});
export const budget = (overrides: Partial<Budget> = {}): Budget => ({
  id: crypto.randomUUID(),
  version: 1,
  scope: { kind: "principal", namespace: "test", principal: "u1" },
  surface: "any",
  unit: "requests",
  limit: quantity(2n),
  window: { kind: "calendar_month", timezone: "UTC" },
  onExceed: "block",
  ...overrides,
});
export const unknownReceipt = (): Receipt =>
  receipt({ cost: { certainty: "unknown", money: null } });
