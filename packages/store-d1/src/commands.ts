import {
  validateSettlementPolicy,
  validSettlementLink,
  settlementState,
  validateMoneyPolicy,
} from "@usagekit/store";
import type { Database } from "./database.js";
import { normalizeLegacyMoney } from "@usagekit/core";
import type { Store, Clock } from "@usagekit/store";
import { InvalidInput } from "@usagekit/store";
import type {
  ExpireReservationsInput,
  Operation,
  OperationCommand,
  Receipt,
  Authority,
  SettleInput,
  CorrectionInput,
  SettleResult,
  ReserveResult,
  DispatchGrant,
  RecoveryClaim,
  LeaseRenewal,
  ReleaseResult,
} from "@usagekit/core";
import { encode, decode } from "./serialize.js";
import {
  canonical,
  hash,
  key,
  identity,
  validateQuantity,
  validateReceipt,
  validTtl,
  withNormalizedTags,
} from "./util.js";
import { operationRow, hydrate, find, appendReceipt, event, updateOperation } from "./records.js";
import { admission, updateUsage, recordAlerts, reachedBySettlement } from "./budgets.js";
export function commands(
  db: Database,
  clock: Clock,
  hook?: () => void,
): Pick<
  Store,
  | "expireReservations"
  | "reserve"
  | "markDispatchIntent"
  | "renewLease"
  | "claimForRecovery"
  | "settle"
  | "correct"
  | "releaseUndispatched"
> {
  const now = () => clock.now().toISOString(),
    active = (op: Operation) =>
      !!op.lease && Date.parse(op.lease.expiresAt) > clock.now().getTime();
  const touch = (op: Operation) => {
    op.version++;
    op.updatedAt = now();
  };
  const write = (fn: () => unknown) => db.transaction(fn).immediate();
  const log = (i: OperationCommand & { reason?: string }, kind: string, result: unknown) => {
    const input = canonical({ kind, input: i });
    db.prepare("INSERT INTO commands VALUES(?,?,?,?,?,?)").run(
      key(i.namespace, i.operationId),
      i.commandId,
      kind,
      hash(input),
      input,
      encode(result),
    );
  };
  const replay = (i: OperationCommand) =>
    db
      .prepare("SELECT input_hash,result_json FROM commands WHERE operation_pk=? AND command_id=?")
      .get(key(i.namespace, i.operationId), i.commandId) as
      | { input_hash: string; result_json: string }
      | undefined;
  const mutate = (
    before: Operation,
    op: Operation,
    kind: "lease" | "recovery" | null,
    accounting = false,
  ) => {
    updateOperation(db, before, op, kind);
    hook?.();
    if (accounting) updateUsage(db, before, op);
    event(db, op);
  };
  const authorize = (
    op: Operation,
    a: Authority,
    kind: string | null,
    correction: boolean,
  ): "invalid_state" | "not_holder" | "lease_expired" | null => {
    if (a.kind === "late_evidence")
      return (op.state === "pending" || (correction && op.state === "settled")) && !active(op)
        ? null
        : "invalid_state";
    if (!["dispatch_intended", "pending"].includes(op.state)) return "invalid_state";
    if (op.lease?.leaseId !== a.leaseId || kind !== a.kind) return "not_holder";
    return active(op) ? null : "lease_expired";
  };
  const settle = (i: SettleInput | CorrectionInput, correction = false): SettleResult => {
    i = normalizeLegacyMoney(i);
    validateReceipt(i.receipt);
    const found = find(db, i),
      op = found?.op ?? null;
    const reject = (
      reason: Extract<SettleResult, { outcome: "rejected" }>["reason"],
    ): SettleResult => ({ outcome: "rejected", reason, operation: op });
    if (!op) return reject("invalid_state");
    validateMoneyPolicy(op, i.receipt);
    const previous = replay(i),
      kind = correction ? "correct" : "settle";
    if (previous) {
      if (previous.input_hash !== hash(canonical({ kind, input: i })))
        return reject("receipt_conflict");
      return {
        ...decode<Extract<SettleResult, { outcome: "settled" }>>(previous.result_json),
        replayed: true,
      };
    }
    if (op.version !== i.expectedVersion) return reject("version_conflict");
    const error = authorize(op, i.authority, found!.row.lease_kind, correction);
    if (error) return reject(error);
    const target = correction ? (i as CorrectionInput).replacesReceiptId : undefined;
    if (
      correction &&
      (!target ||
        !op.receipts.some((r) => r.id === target) ||
        op.receipts.some((r) => r.supersedes === target))
    )
      return reject("invalid_state");
    if (
      op.receipts.some((r) => r.id === i.receipt.id) ||
      (i.receipt.supersedes && i.receipt.supersedes !== target)
    )
      return reject("receipt_conflict");
    const canonicalOp = i.receipt.canonicalOperationId
      ? (find(db, { ...i, operationId: i.receipt.canonicalOperationId })?.op ?? null)
      : null;
    const hasDependents =
      i.receipt.canonicalOperationId !== undefined &&
      !!db
        .prepare(
          "SELECT 1 FROM receipts r JOIN operations o USING(operation_pk) WHERE o.namespace=? AND o.state='settled' AND json_extract(r.receipt_json,'$.canonicalOperationId')=? AND NOT EXISTS(SELECT 1 FROM receipts n WHERE n.operation_pk=r.operation_pk AND n.supersedes=r.receipt_id) LIMIT 1",
        )
        .get(i.namespace, i.operationId);
    if (!validSettlementLink(op, i.receipt, canonicalOp, hasDependents))
      return reject("receipt_conflict");
    const before = structuredClone(op),
      receipt: Receipt = {
        ...structuredClone(i.receipt),
        ...(target ? { supersedes: target } : {}),
      };
    op.receipts = [...op.receipts, receipt];
    op.state = settlementState(op, receipt);
    op.lease = null;
    touch(op);
    appendReceipt(db, op, receipt);
    mutate(before, op, null, true);
    const alerts = recordAlerts(db, op.scope.namespace, reachedBySettlement(db, op), clock.now());
    const result: SettleResult = { outcome: "settled", replayed: false, operation: op, alerts };
    log(i, kind, result);
    return result;
  };
  const releaseExpired = (op: Operation) => {
    const before = structuredClone(op);
    op.state = "released";
    touch(op);
    mutate(before, op, null, true);
    log(
      {
        namespace: op.scope.namespace,
        principal: op.scope.principal,
        operationId: op.operationId,
        expectedVersion: before.version,
        commandId: crypto.randomUUID(),
        reason: "reservation_expired",
      },
      "release",
      { outcome: "released", replayed: false, operation: op },
    );
  };
  const expire = (i: ExpireReservationsInput) => {
    const limit = i.limit ?? 100;
    if (!i.namespace?.trim() || !Number.isInteger(limit) || limit < 1 || limit > 1000)
      throw new InvalidInput("expiration");
    const due = db
      .prepare(
        "SELECT operation_id,principal FROM operations WHERE namespace=? AND state='reserved' AND reservation_expires_at<=? ORDER BY reservation_expires_at,operation_pk LIMIT ?",
      )
      .all(i.namespace, now(), limit + 1) as { operation_id: string; principal: string }[];
    for (const row of due.slice(0, limit)) {
      const found = find(db, {
          namespace: i.namespace,
          principal: row.principal,
          operationId: row.operation_id,
        })!,
        op = found.op;
      releaseExpired(op);
    }
    return {
      outcome: "expired" as const,
      count: Math.min(limit, due.length),
      hasMore: due.length > limit,
    };
  };
  return {
    expireReservations: async (i) =>
      write(() => expire(i)) as { outcome: "expired"; count: number; hasMore: boolean },
    reserve: async (raw, p) =>
      write(() => {
        validateSettlementPolicy(raw);
        validTtl(raw.reservationTtlMs ?? 300000, "reservationTtlMs");
        raw.estimate.forEach(validateQuantity);
        if (new Set(raw.estimate.map((q) => q.unit)).size !== raw.estimate.length)
          throw new InvalidInput("estimate", "duplicate unit");
        const i = withNormalizedTags(raw);
        expire({ namespace: i.scope.namespace });
        const existing = operationRow(db, i.scope.namespace, i.operationId);
        if (existing) {
          const op = hydrate(db, existing);
          return existing.semantic_json === identity(i)
            ? {
                outcome: "reserved",
                replayed: true,
                operation: op,
                warnings: decode(existing.warnings_json),
                alerts: decode(existing.alerts_json),
              }
            : { outcome: "conflict", reason: "semantic_mismatch", operation: op };
        }
        if (
          db
            .prepare("SELECT 1 FROM request_commands WHERE namespace=? AND command_id=?")
            .get(i.scope.namespace, i.operationId)
        )
          throw new InvalidInput("operationId", "already counted without a reservation");
        const check = admission(db, i, clock.now(), p);
        if (check.invalid)
          return {
            outcome: "invalid",
            reason: "missing_estimate_unit",
            unit: check.invalid,
            operation: null,
          };
        if (check.exceeded)
          return { outcome: "exceeded", exceeded: check.exceeded, operation: null };
        const stamp = now(),
          op: Operation = {
            ...structuredClone(i),
            reservationExpiresAt: new Date(
              clock.now().getTime() + (i.reservationTtlMs ?? 300000),
            ).toISOString(),
            state: "reserved",
            version: 1,
            createdAt: stamp,
            updatedAt: stamp,
            budgetEpochs: check.epochs,
            receipts: [],
            lease: null,
          };
        const alerts = recordAlerts(db, i.scope.namespace, check.alerts, clock.now());
        db.prepare(
          "INSERT INTO operations(operation_pk,namespace,principal,operation_id,state,version,semantic_json,budget_epochs_json,created_at,updated_at,operation_json,warnings_json,reservation_expires_at,alerts_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        ).run(
          key(i.scope.namespace, i.operationId),
          i.scope.namespace,
          i.scope.principal,
          i.operationId,
          op.state,
          1,
          identity(i),
          encode(op.budgetEpochs),
          stamp,
          stamp,
          encode(i),
          encode(check.warnings),
          op.reservationExpiresAt,
          encode(alerts),
        );
        hook?.();
        updateUsage(db, null, op);
        event(db, op);
        return {
          outcome: "reserved",
          replayed: false,
          operation: op,
          warnings: check.warnings,
          alerts,
        };
      }) as ReserveResult,
    markDispatchIntent: async (i) =>
      write(() => {
        validTtl(i.leaseTtlMs);
        const found = find(db, i),
          op = found?.op ?? null;
        if (!op) return { granted: false, reason: "not_reserved", operation: null };
        if (op.state === "released") return { granted: false, reason: "released", operation: op };
        if (op.state !== "reserved")
          return { granted: false, reason: "already_dispatched", operation: op };
        if (Date.parse(op.reservationExpiresAt) <= clock.now().getTime()) {
          releaseExpired(op);
          return { granted: false, reason: "reservation_expired", operation: op };
        }
        if (op.version !== i.expectedVersion)
          return { granted: false, reason: "version_conflict", operation: op };
        const before = structuredClone(op);
        op.lease = {
          leaseId: crypto.randomUUID(),
          holder: i.holder,
          expiresAt: new Date(clock.now().getTime() + i.leaseTtlMs).toISOString(),
        };
        op.state = "dispatch_intended";
        touch(op);
        mutate(before, op, "lease");
        const result = { granted: true, operation: op, lease: op.lease };
        log(i, "intent", result);
        return result;
      }) as DispatchGrant,
    renewLease: async (i) =>
      write(() => {
        validTtl(i.leaseTtlMs);
        const found = find(db, i),
          op = found?.op;
        if (!op?.lease || !["dispatch_intended", "pending"].includes(op.state))
          return { renewed: false, reason: "not_active" };
        if (op.lease.leaseId !== i.leaseId) return { renewed: false, reason: "not_holder" };
        if (!active(op)) return { renewed: false, reason: "expired" };
        const before = structuredClone(op);
        op.lease.expiresAt = new Date(
          Math.max(Date.parse(op.lease.expiresAt), clock.now().getTime() + i.leaseTtlMs),
        ).toISOString();
        updateOperation(db, before, op, found!.row.lease_kind);
        return { renewed: true, lease: op.lease };
      }) as LeaseRenewal,
    claimForRecovery: async (i) =>
      write(() => {
        validTtl(i.leaseTtlMs);
        const found = find(db, i),
          op = found?.op ?? null;
        if (!op) return { claimed: false, reason: "not_found", operation: null };
        if (!["dispatch_intended", "pending"].includes(op.state))
          return { claimed: false, reason: "not_recoverable", operation: op };
        if (active(op)) return { claimed: false, reason: "lease_active", operation: op };
        const before = structuredClone(op);
        op.lease = {
          leaseId: crypto.randomUUID(),
          holder: i.holder,
          expiresAt: new Date(clock.now().getTime() + i.leaseTtlMs).toISOString(),
        };
        touch(op);
        mutate(before, op, "recovery");
        return { claimed: true, operation: op, lease: op.lease };
      }) as RecoveryClaim,
    settle: async (i) => write(() => settle(i)) as SettleResult,
    correct: async (i) => write(() => settle(i, true)) as SettleResult,
    releaseUndispatched: async (i) =>
      write(() => {
        const found = find(db, i),
          op = found?.op ?? null,
          previous = op ? replay(i) : undefined;
        if (previous?.input_hash === hash(canonical({ kind: "release", input: i })))
          return {
            ...decode<Extract<ReleaseResult, { outcome: "released" }>>(previous.result_json),
            replayed: true,
          };
        if (!op || op.state !== "reserved")
          return { outcome: "rejected", reason: "not_reserved", operation: op };
        if (previous || op.version !== i.expectedVersion)
          return { outcome: "rejected", reason: "version_conflict", operation: op };
        const before = structuredClone(op);
        op.state = "released";
        touch(op);
        mutate(before, op, null, true);
        const result = { outcome: "released", replayed: false, operation: op };
        log(i, "release", result);
        return result;
      }) as ReleaseResult,
  };
}
