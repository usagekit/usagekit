import { validateSettlementPolicy, validSettlementLink, settlementState } from "./settlement.js";
import { moneyScale } from "@usagekit/core";
import type { AdmissionPolicy } from "@usagekit/core";
import { admission, recordAlerts, reachedBySettlement } from "./admission.js";
import type { ReserveInput, ReserveResult, Operation } from "@usagekit/core";
import {
  copy,
  key,
  semantics,
  validateQuantity,
  withNormalizedTags,
  InvalidInput,
} from "./state.js";
import type { State } from "./state.js";
export function reserve(s: State, raw: ReserveInput, policy?: AdmissionPolicy): ReserveResult {
  validateSettlementPolicy(raw);
  validTtl(raw.reservationTtlMs ?? 300000, "reservationTtlMs");
  raw.estimate.forEach(validateQuantity);
  if (new Set(raw.estimate.map((q) => q.unit)).size !== raw.estimate.length)
    throw new InvalidInput("estimate", "duplicate unit");
  const i = withNormalizedTags(raw);
  expireReservations(s, { namespace: i.scope.namespace });
  const k = key(i.scope.namespace, i.operationId),
    existing = s.operations.get(k);
  if (existing)
    return s.identities.get(k) === semantics(i)
      ? {
          outcome: "reserved",
          replayed: true,
          warnings: copy(s.warnings.get(k) ?? []),
          alerts: copy(s.reserveAlerts.get(k) ?? []),
          operation: copy(existing),
        }
      : { outcome: "conflict", reason: "semantic_mismatch", operation: copy(existing) };
  if (s.requestCommands?.has(k))
    throw new InvalidInput("operationId", "already counted without a reservation");
  const check = admission(s, i, policy);
  if (check.invalid)
    return {
      outcome: "invalid",
      reason: "missing_estimate_unit",
      unit: check.invalid,
      operation: null,
    };
  if (check.exceeded)
    return { outcome: "exceeded", exceeded: copy(check.exceeded), operation: null };
  const now = s.clock.now().toISOString();
  const operation: Operation = {
    ...copy(i),
    reservationExpiresAt: new Date(
      s.clock.now().getTime() + (i.reservationTtlMs ?? 300000),
    ).toISOString(),
    state: "reserved",
    version: 1,
    createdAt: now,
    updatedAt: now,
    budgetEpochs: copy(check.epochs),
    receipts: [],
    lease: null,
  };
  s.operations.set(k, operation);
  s.identities.set(k, semantics(i));
  s.warnings.set(k, copy(check.warnings));
  const alerts = recordAlerts(s, i.scope.namespace, check.alerts);
  s.reserveAlerts.set(k, copy(alerts));
  return {
    outcome: "reserved",
    replayed: false,
    warnings: copy(check.warnings),
    alerts: copy(alerts),
    operation: copy(operation),
  };
}

import type {
  DispatchIntentInput,
  DispatchGrant,
  LeaseRenewalInput,
  LeaseRenewal,
} from "@usagekit/core";
import { find } from "./state.js";
export function active(s: State, op: Operation): boolean {
  return !!op.lease && Date.parse(op.lease.expiresAt) > s.clock.now().getTime();
}
export function touch(s: State, op: Operation): void {
  op.version++;
  op.updatedAt = s.clock.now().toISOString();
}
export function validTtl(ttl: number, field = "leaseTtlMs"): void {
  if (!Number.isSafeInteger(ttl) || ttl <= 0 || ttl > 86400000) throw new InvalidInput(field);
}
export function intent(s: State, i: DispatchIntentInput): DispatchGrant {
  validTtl(i.leaseTtlMs);
  const op = find(s, i);
  if (!op) return { granted: false, reason: "not_reserved", operation: null };
  if (op.state === "released") return { granted: false, reason: "released", operation: copy(op) };
  if (op.state !== "reserved")
    return { granted: false, reason: "already_dispatched", operation: copy(op) };
  if (Date.parse(op.reservationExpiresAt) <= s.clock.now().getTime()) {
    release(s, {
      ...i,
      commandId: crypto.randomUUID(),
      expectedVersion: op.version,
      reason: "reservation_expired",
    });
    return { granted: false, reason: "reservation_expired", operation: copy(op) };
  }
  if (op.version !== i.expectedVersion)
    return { granted: false, reason: "version_conflict", operation: copy(op) };
  op.lease = {
    leaseId: crypto.randomUUID(),
    holder: i.holder,
    expiresAt: new Date(s.clock.now().getTime() + i.leaseTtlMs).toISOString(),
  };
  op.state = "dispatch_intended";
  touch(s, op);
  s.leaseKinds.set(op.lease.leaseId, "lease");
  const result: DispatchGrant = { granted: true, operation: copy(op), lease: copy(op.lease) };
  s.commands.set(canonical([i.namespace, i.operationId, i.commandId]), {
    identity: canonical({ kind: "intent", input: i }),
    result: copy(result),
  });
  return result;
}
export function renew(s: State, i: LeaseRenewalInput): LeaseRenewal {
  validTtl(i.leaseTtlMs);
  const op = find(s, i);
  if (!op?.lease || !["dispatch_intended", "pending"].includes(op.state))
    return { renewed: false, reason: "not_active" };
  if (op.lease.leaseId !== i.leaseId) return { renewed: false, reason: "not_holder" };
  if (!active(s, op)) return { renewed: false, reason: "expired" };
  op.lease.expiresAt = new Date(
    Math.max(Date.parse(op.lease.expiresAt), s.clock.now().getTime() + i.leaseTtlMs),
  ).toISOString();
  return { renewed: true, lease: copy(op.lease) };
}

import type {
  SettleInput,
  CorrectionInput,
  SettleResult,
  ReleaseInput,
  ReleaseResult,
  Authority,
  Receipt,
} from "@usagekit/core";
import { canonical, maxMoneyUnits } from "./state.js";
function authorityError(
  s: State,
  op: Operation,
  a: Authority,
  correction: boolean,
): "invalid_state" | "not_holder" | "lease_expired" | null {
  if (a.kind === "late_evidence")
    return (op.state === "pending" || (correction && op.state === "settled")) && !active(s, op)
      ? null
      : "invalid_state";
  if (!["dispatch_intended", "pending"].includes(op.state)) return "invalid_state";
  if (op.lease?.leaseId !== a.leaseId || s.leaseKinds.get(a.leaseId) !== a.kind)
    return "not_holder";
  return active(s, op) ? null : "lease_expired";
}
export function validateReceipt(r: Receipt): void {
  if (
    !r.id?.trim() ||
    !Number.isFinite(Date.parse(r.occurredAt)) ||
    !Number.isFinite(Date.parse(r.recordedAt))
  )
    throw new InvalidInput("receipt");
  if (
    r.cost.certainty === "unknown"
      ? r.cost.money !== null
      : !r.cost.money ||
        typeof r.cost.money.units !== "bigint" ||
        r.cost.money.units < 0n ||
        r.cost.money.units > maxMoneyUnits ||
        r.cost.money.currency !== "USD"
  )
    throw new InvalidInput("receipt.cost");
  if (r.cost.money) {
    try {
      moneyScale(r.cost.money);
    } catch {
      throw new InvalidInput("receipt.cost");
    }
  }
  for (const m of r.measurements) {
    if (m.certainty === "unknown") {
      if (m.quantity !== null || !m.unit) throw new InvalidInput("measurement");
    } else {
      validateQuantity(m.quantity);
      if (m.unit !== m.quantity.unit) throw new InvalidInput("measurement.unit");
    }
  }
  if (new Set(r.measurements.map((m) => m.unit)).size !== r.measurements.length)
    throw new InvalidInput("measurements", "duplicate unit");
}
export function settle(
  s: State,
  i: SettleInput | CorrectionInput,
  correction = false,
): SettleResult {
  validateReceipt(i.receipt);
  const op = find(s, i);
  const reject = (
    reason:
      | "invalid_state"
      | "not_holder"
      | "lease_expired"
      | "version_conflict"
      | "receipt_conflict",
  ): SettleResult => ({ outcome: "rejected", reason, operation: copy(op) });
  if (!op) return reject("invalid_state");
  const ck = canonical([i.namespace, i.operationId, i.commandId]),
    identity = canonical({ kind: correction ? "correct" : "settle", input: i }),
    previous = s.commands.get(ck);
  if (previous) {
    if (previous.identity !== identity) return reject("receipt_conflict");
    return {
      ...copy(previous.result as Extract<SettleResult, { outcome: "settled" }>),
      replayed: true,
    };
  }
  if (op.version !== i.expectedVersion) return reject("version_conflict");
  const denied = authorityError(s, op, i.authority, correction);
  if (denied) return reject(denied);
  const target = correction ? (i as CorrectionInput).replacesReceiptId : undefined;
  if (target && !op.receipts.some((r) => r.id === target)) return reject("invalid_state");
  if (correction && (!target || op.receipts.some((r) => r.supersedes === target)))
    return reject("invalid_state");
  if (op.receipts.some((r) => r.id === i.receipt.id)) return reject("receipt_conflict");
  if (i.receipt.supersedes && i.receipt.supersedes !== target) return reject("receipt_conflict");
  const canonicalOp = i.receipt.canonicalOperationId
    ? find(s, { ...i, operationId: i.receipt.canonicalOperationId })
    : null;
  if (!validSettlementLink(op, i.receipt, canonicalOp)) return reject("receipt_conflict");
  const receipt = copy(i.receipt);
  if (target) receipt.supersedes = target;
  op.receipts = [...op.receipts, receipt];
  op.state = settlementState(op, receipt);
  op.lease = null;
  touch(s, op);
  const alerts = recordAlerts(s, op.scope.namespace, reachedBySettlement(s, op));
  const result: SettleResult = {
    outcome: "settled",
    replayed: false,
    operation: copy(op),
    alerts: copy(alerts),
  };
  s.commands.set(ck, { identity, result: copy(result) });
  return result;
}
export function release(s: State, i: ReleaseInput): ReleaseResult {
  const op = find(s, i),
    ck = canonical([i.namespace, i.operationId, i.commandId]),
    identity = canonical({ kind: "release", input: i }),
    previous = s.commands.get(ck);
  if (previous?.identity === identity)
    return {
      ...copy(previous.result as Extract<ReleaseResult, { outcome: "released" }>),
      replayed: true,
    };
  if (!op || op.state !== "reserved")
    return { outcome: "rejected", reason: "not_reserved", operation: copy(op) };
  if (previous || op.version !== i.expectedVersion)
    return { outcome: "rejected", reason: "version_conflict", operation: copy(op) };
  op.state = "released";
  touch(s, op);
  const result: ReleaseResult = { outcome: "released", replayed: false, operation: copy(op) };
  s.commands.set(ck, { identity, result: copy(result) });
  return result;
}
import type { RecoveryClaimInput, RecoveryClaim } from "@usagekit/core";
export function claim(s: State, i: RecoveryClaimInput): RecoveryClaim {
  validTtl(i.leaseTtlMs);
  const op = find(s, i);
  if (!op) return { claimed: false, reason: "not_found", operation: null };
  if (!["dispatch_intended", "pending"].includes(op.state))
    return { claimed: false, reason: "not_recoverable", operation: copy(op) };
  if (active(s, op)) return { claimed: false, reason: "lease_active", operation: copy(op) };
  op.lease = {
    leaseId: crypto.randomUUID(),
    holder: i.holder,
    expiresAt: new Date(s.clock.now().getTime() + i.leaseTtlMs).toISOString(),
  };
  s.leaseKinds.set(op.lease.leaseId, "recovery");
  touch(s, op);
  return { claimed: true, operation: copy(op), lease: copy(op.lease) };
}

import type { ExpireReservationsInput } from "@usagekit/core";
export function expireReservations(
  s: State,
  i: ExpireReservationsInput,
): { outcome: "expired"; count: number; hasMore: boolean } {
  const limit = i.limit ?? 100;
  if (!i.namespace?.trim() || !Number.isInteger(limit) || limit < 1 || limit > 1000)
    throw new InvalidInput("expiration");
  const due = [...s.operations.values()]
    .filter(
      (op) =>
        op.scope.namespace === i.namespace &&
        op.state === "reserved" &&
        Date.parse(op.reservationExpiresAt) <= s.clock.now().getTime(),
    )
    .sort(
      (a, b) =>
        a.reservationExpiresAt.localeCompare(b.reservationExpiresAt) ||
        a.operationId.localeCompare(b.operationId),
    );
  for (const op of due.slice(0, limit))
    release(s, {
      namespace: i.namespace,
      principal: op.scope.principal,
      operationId: op.operationId,
      expectedVersion: op.version,
      commandId: crypto.randomUUID(),
      reason: "reservation_expired",
    });
  return { outcome: "expired", count: Math.min(limit, due.length), hasMore: due.length > limit };
}
