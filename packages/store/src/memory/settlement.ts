import type { Operation, Receipt, ReserveInput, Quantity } from "@usagekit/core";
import { canonical, InvalidInput } from "./state.js";

export function validateSettlementPolicy(i: ReserveInput): void {
  const p = i.settlementPolicy;
  if (p === undefined) return;
  if (
    !p ||
    typeof p.requireMoney !== "boolean" ||
    !Array.isArray(p.requiredUnits) ||
    p.requiredUnits.length === 0 ||
    p.requiredUnits.length > 64 ||
    p.requiredUnits.some((u) => typeof u !== "string" || !u.trim() || u === "budget_cents") ||
    new Set(p.requiredUnits).size !== p.requiredUnits.length
  )
    throw new InvalidInput(
      "settlementPolicy",
      "unique required native units and requireMoney required",
    );
}

/** A link is accounting evidence, never dispatch authority. No linked receipt carries amounts. */
export function validSettlementLink(
  op: Operation,
  receipt: Receipt,
  target: Operation | null,
  hasDependents = false,
): boolean {
  const previous = op.receipts.at(-1);
  if (
    op.settlementPolicy &&
    previous?.providerRequestId &&
    previous.providerRequestId !== receipt.providerRequestId
  )
    return false;
  if (
    previous?.canonicalOperationId &&
    previous.canonicalOperationId !== receipt.canonicalOperationId
  )
    return false;
  if (receipt.canonicalOperationId === undefined) return true;
  if (
    hasDependents ||
    !op.settlementPolicy ||
    !target?.settlementPolicy ||
    !op.scope.connection ||
    !target.scope.connection ||
    op.scope.connection !== target.scope.connection ||
    target.state !== "settled" ||
    target.operationId === op.operationId ||
    receipt.measurements.length !== 0 ||
    receipt.cost.certainty !== "unknown" ||
    !receipt.providerRequestId
  )
    return false;
  const canonicalReceipt = [...target.receipts]
    .reverse()
    .find((r) => !target.receipts.some((n) => n.supersedes === r.id));
  if (
    !canonicalReceipt ||
    canonicalReceipt.canonicalOperationId ||
    canonicalReceipt.providerRequestId !== receipt.providerRequestId
  )
    return false;
  const identity = (value: Operation) =>
    canonical({
      namespace: value.scope.namespace,
      principal: value.scope.principal,
      connection: value.scope.connection,
      credential: value.scope.providerCredentialVersion,
      provider: value.provider,
      operation: value.operation,
      funding: value.fundingSource,
      owner: value.costOwner,
      creditAccountRef: value.creditAccountRef,
      customerPriceVersion: value.customerPriceVersion,
      policy: {
        ...value.settlementPolicy,
        requiredUnits: [...value.settlementPolicy!.requiredUnits].sort(),
      },
    });
  return identity(op) === identity(target);
}

export function settlementState(
  op: Pick<Operation, "settlementPolicy" | "estimate">,
  r: Receipt,
): "pending" | "settled" {
  if (r.canonicalOperationId) return "settled";
  const p = op.settlementPolicy;
  if (p)
    return p.requiredUnits.some(
      (unit) => !r.measurements.some((m) => m.unit === unit && m.certainty === "measured"),
    ) ||
      (p.requireMoney && r.cost.certainty !== "measured")
      ? "pending"
      : "settled";
  return r.cost.certainty === "unknown" ||
    r.measurements.some((m) => m.certainty === "unknown") ||
    op.estimate.some((q) => !r.measurements.some((m) => m.unit === q.unit))
    ? "pending"
    : "settled";
}

/** A missing bounded unit retains its reserved estimate as consumption, never as money. */
export function settledQuantity(op: Operation, unit: string): Quantity | undefined {
  const receipt = [...op.receipts]
    .reverse()
    .find((r) => !op.receipts.some((n) => n.supersedes === r.id));
  if (receipt?.canonicalOperationId) return undefined;
  return (
    receipt?.measurements.find((m) => m.unit === unit)?.quantity ??
    op.estimate.find((q) => q.unit === unit)
  );
}

export function validateMoneyPolicy(op: Operation, receipt: Receipt): void {
  if (
    !op.settlementPolicy &&
    receipt.cost.money?.scale !== undefined &&
    receipt.cost.money.scale !== 4
  )
    throw new InvalidInput("receipt.cost", "non-legacy money scale requires settlementPolicy");
}
