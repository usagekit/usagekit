import type {
  AccessContext,
  AllowanceExceeded,
  BudgetAlertCrossed,
  Cost,
  Measurement,
  Meter,
  Operation,
  Quantity,
  Receipt,
  ReserveInput,
  SettleResult,
  UsageScope,
  ValidationFailure,
} from "@usagekit/core";

export type MeteredDispatchOptions = {
  /** A host-configured Meter with the intended budgets and durability. */
  meter: Meter;
  now?: () => Date;
  /** Lease holder recorded on every operation. The abandoned sweep only touches this holder. */
  holder?: string;
  /** Dispatch lease, 1..86400000 ms; defaults to two minutes. */
  leaseTtlMs?: number;
  /** Heartbeat that renews the lease while a dispatch is open; defaults to a third of the lease. 0 disables it. */
  renewEveryMs?: number;
  /**
   * The heartbeat stops this long after admission; defaults to ten minutes. A dispatch that is
   * never settled then loses its lease and is resolved as abandoned instead of holding its
   * reservation for the life of the process. Explicit `renew()` calls are not limited.
   */
  maxOpenMs?: number;
};
export type DispatchAdmission = {
  /** Caller-supplied idempotency key of the whole turn; becomes the operation id. */
  id: string;
  /** Server-trusted attribution only. Never include provider secrets or request content. */
  operation: Omit<ReserveInput, "operationId" | "estimate">;
  /** Upper bound in every budget unit that applies. `requests: 1` is added when absent. */
  estimate: readonly Quantity[];
};
export type AdmitResult =
  | {
      outcome: "admitted";
      dispatch: MeteredDispatch;
      /** Soft budgets (`onExceed: "allow"`) past their limit. */
      warnings: readonly AllowanceExceeded[];
      alerts: readonly BudgetAlertCrossed[];
    }
  | { outcome: "refused"; reason: "budget_exceeded"; exceeded: AllowanceExceeded }
  /** A budget applies whose unit the estimate does not cover: a configuration error, not a user limit. */
  | { outcome: "refused"; reason: "unsupported_budget_unit"; unit: string }
  /** The id was admitted before. Only that first admit may call the provider. */
  | { outcome: "refused"; reason: "replayed"; operation: Operation | null }
  /** The id was admitted before with different attribution or estimate. */
  | { outcome: "refused"; reason: "conflict"; operation: Operation }
  | { outcome: "refused"; reason: "invalid"; field: string; detail: string }
  | { outcome: "refused"; reason: "dispatch_denied"; detail: string };

export type DispatchSettlement = {
  /**
   * Actual amounts. Every reserved unit must be present; a missing unit is never read as zero.
   * The `requests` unit the handle added at admission is the exception: it is recorded as one
   * request unless `usage` states its own `requests` amount.
   */
  usage: readonly Quantity[];
  /** Provider cost from host-owned prices. An unknown cost keeps the operation pending. */
  cost: Cost;
  /** `measured` (default) for provider-reported totals, `estimated` when a step was interrupted. */
  certainty?: "measured" | "estimated";
  /** The turn failed, timed out or was aborted. Its amounts are charged all the same. */
  failed?: boolean;
  providerRequestId?: string;
  providerPriceVersion?: string;
};
export type SettleOutcome =
  | {
      outcome: "settled";
      replayed: boolean;
      /** lease: in time. recovery: after lease expiry. correction: after the abandoned sweep. */
      via: "lease" | "recovery" | "correction";
      operation: Operation;
      alerts: readonly BudgetAlertCrossed[];
      /** Per reserved unit, how far actual usage exceeded the estimate. Empty when none did. */
      overshoot: readonly Quantity[];
    }
  /** Recorded, but cost or a measurement is unknown: the whole reservation stays held. */
  | {
      outcome: "pending";
      replayed: boolean;
      via: "lease" | "recovery" | "correction";
      operation: Operation;
      alerts: readonly BudgetAlertCrossed[];
    }
  /** The connection is tracked as passthrough: nothing was reserved, nothing is settled. */
  | { outcome: "untracked" }
  | { outcome: "rejected"; reason: "missing_usage_unit"; unit: string }
  | { outcome: "rejected"; reason: "invalid"; detail: string; operation: Operation | null }
  /** Another holder is recovering the operation. Retry after its lease, or keep its result. */
  | { outcome: "rejected"; reason: "lease_lost"; operation: Operation | null }
  /** Different evidence is already recorded under this dispatch. */
  | { outcome: "rejected"; reason: "already_settled"; operation: Operation };
export type LeaseRenewalOutcome =
  | { renewed: true; expiresAt: string }
  | { renewed: false; reason: string };

export interface MeteredDispatch {
  readonly id: string;
  readonly tracking: "metered" | "passthrough";
  /** The estimate as reserved, including the added `requests` unit. */
  readonly reserved: readonly Quantity[];
  /** Extends the lease by the configured TTL. The heartbeat calls this on its own. */
  renew(): Promise<LeaseRenewalOutcome>;
  /** Settles once. A repeated call keeps the first receipt and returns its stored result. */
  settle(input: DispatchSettlement): Promise<SettleOutcome>;
  /** For a turn whose usage cannot be estimated: records no amounts and keeps the reservation. */
  settleUnknown(input?: { failed?: boolean }): Promise<SettleOutcome>;
}
export type AbandonedSweep = {
  /** Verified server context that may read operations in `scope`. */
  access: AccessContext;
  scope: UsageScope;
  /** Operations created in [from, to) are examined. */
  from: string;
  to: string;
  /** Operations per call, 1..1000; defaults to 100. */
  limit?: number;
  cursor?: string;
  /** Provider cost of an operation charged at its whole reservation. Absent: unknown, pending. */
  cost?: (operation: Operation) => Cost | undefined;
};
export type AbandonedSweepResult =
  | ValidationFailure
  | { outcome: "forbidden" }
  | {
      outcome: "swept";
      examined: number;
      /** Settled at the whole reservation. */
      charged: number;
      /** Recorded without a cost: pending, reservation held. */
      pending: number;
      /** Live lease, another holder, or claimed by someone else meanwhile. */
      skipped: number;
      nextCursor?: string;
    };
export interface MeteredDispatcher {
  admit(input: DispatchAdmission): Promise<AdmitResult>;
  /** Maintenance: resolves dispatches of this holder whose lease expired without settlement. */
  settleAbandoned(input: AbandonedSweep): Promise<AbandonedSweepResult>;
}

const requestsUnit = "requests";
const unknownCost: Cost = { certainty: "unknown", money: null };
const passthrough: MeteredDispatch = {
  id: "",
  tracking: "passthrough",
  reserved: [],
  renew: async () => ({ renewed: false, reason: "untracked" }),
  settle: async () => ({ outcome: "untracked" }),
  settleUnknown: async () => ({ outcome: "untracked" }),
};
/** The latest receipt that no later receipt supersedes. */
function effectiveReceipt(operation: Operation): Receipt | undefined {
  return [...operation.receipts]
    .reverse()
    .find((receipt) => !operation.receipts.some((next) => next.supersedes === receipt.id));
}
const evidence = (receipt: Receipt): string =>
  JSON.stringify([receipt.measurements, receipt.cost, receipt.failed], (_key, value: unknown) =>
    typeof value === "bigint" ? value.toString() : value,
  );
/** How far `actual` exceeds `estimate`, or null. Both are in the same unit. */
function excess(actual: Quantity, estimate: Quantity): Quantity | null {
  const scale = Math.max(actual.scale, estimate.scale);
  const value =
    actual.value * 10n ** BigInt(scale - actual.scale) -
    estimate.value * 10n ** BigInt(scale - estimate.scale);
  return value > 0n ? { unit: actual.unit, value, scale } : null;
}

/**
 * Admits one model turn against every applicable budget and settles it with actual usage.
 * Composes the Meter's reserve, dispatch intent, lease, settle and recovery commands; it creates
 * no Store, budget or credentials. Budget refusals are returned as data; storage failures throw.
 */
export function createMeteredDispatch(options: MeteredDispatchOptions): MeteredDispatcher {
  const { meter, now = () => new Date(), holder = "metered-dispatch" } = options;
  const leaseTtlMs = options.leaseTtlMs ?? 120_000;
  const renewEveryMs = options.renewEveryMs ?? Math.floor(leaseTtlMs / 3);
  const maxOpenMs = options.maxOpenMs ?? 600_000;

  function open(
    id: string,
    ref: { namespace: string; principal: string; operationId: string },
    admitted: Operation,
    leaseId: string,
    addedRequests: boolean,
  ): MeteredDispatch {
    let finished: Extract<SettleOutcome, { outcome: "settled" | "pending" }> | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    const stop = () => {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    };
    const renew = async (): Promise<LeaseRenewalOutcome> => {
      if (finished) return { renewed: false, reason: "settled" };
      const result = await meter.renewLease({ ...ref, leaseId, leaseTtlMs });
      if ("renewed" in result && result.renewed)
        return { renewed: true, expiresAt: result.lease.expiresAt };
      stop();
      return { renewed: false, reason: result.reason };
    };
    if (renewEveryMs > 0) {
      const openedAt = now().getTime();
      timer = setInterval(() => {
        if (now().getTime() - openedAt >= maxOpenMs) stop();
        else void renew().catch(() => {});
      }, renewEveryMs);
      (timer as { unref?: () => void }).unref?.();
    }
    const requestsMeasured: Measurement = {
      unit: requestsUnit,
      quantity: { unit: requestsUnit, value: 1n, scale: 0 },
      certainty: "measured",
    };
    const conclude = (
      result: Extract<SettleResult, { outcome: "settled" }>,
      via: "lease" | "recovery" | "correction",
      receipt: Receipt,
    ): SettleOutcome => {
      const { operation, alerts, replayed } = result;
      if (operation.state !== "settled")
        return (finished = { outcome: "pending", replayed, via, operation, alerts });
      const overshoot = admitted.estimate.flatMap((estimate) => {
        const actual = receipt.measurements.find((m) => m.unit === estimate.unit)?.quantity;
        const over = actual ? excess(actual, estimate) : null;
        return over ? [over] : [];
      });
      return (finished = { outcome: "settled", replayed, via, operation, alerts, overshoot });
    };
    const rejected = (result: { reason: string; operation?: Operation | null }): SettleOutcome => ({
      outcome: "rejected",
      reason: "invalid",
      detail: result.reason,
      operation: result.operation ?? null,
    });
    /** The receipt is already this operation's evidence: a replay, whoever asked first. */
    const recorded = (
      operation: Operation,
      receipt: Receipt,
      via: "lease" | "recovery" | "correction",
    ): SettleOutcome | null => {
      // Still a replay when a later host correction superseded it.
      const current = operation.receipts.find((stored) => stored.id === receipt.id);
      if (!current) return null;
      return evidence(current) === evidence(receipt)
        ? conclude({ outcome: "settled", replayed: true, operation, alerts: [] }, via, receipt)
        : { outcome: "rejected", reason: "already_settled", operation };
    };
    /**
     * The lease no longer authorizes settlement: recover, or correct what recovery recorded.
     * Another writer may move the operation between two commands, so each refusal that returns
     * the current operation is evaluated again, a bounded number of times.
     */
    const settleLate = async (receipt: Receipt, seen: Operation): Promise<SettleOutcome> => {
      const command = { ...ref, commandId: `${id}:settle`, receipt };
      let operation = seen;
      for (let attempt = 0; attempt < 3; attempt++) {
        const replay = recorded(operation, receipt, "lease");
        if (replay) return replay;
        if (operation.lease && Date.parse(operation.lease.expiresAt) > now().getTime()) break;
        let result: SettleResult, via: "recovery" | "correction";
        if (operation.state === "dispatch_intended") {
          const claim = await meter.claimForRecovery({ ...ref, holder, leaseTtlMs });
          if (!("claimed" in claim)) return rejected(claim);
          if (!claim.claimed) {
            if (claim.reason !== "not_recoverable" || !claim.operation) break;
            operation = claim.operation;
            continue;
          }
          via = "recovery";
          result = await meter.settle({
            ...command,
            expectedVersion: claim.operation.version,
            authority: { kind: "recovery", leaseId: claim.lease.leaseId },
          });
        } else {
          const superseded = effectiveReceipt(operation);
          if ((operation.state !== "pending" && operation.state !== "settled") || !superseded)
            return { outcome: "rejected", reason: "invalid", detail: operation.state, operation };
          via = "correction";
          result = await meter.correct({
            ...command,
            expectedVersion: operation.version,
            authority: { kind: "late_evidence", source: holder },
            replacesReceiptId: superseded.id,
            reason: "settled after lease expiry",
          });
        }
        if (result.outcome === "settled") return conclude(result, via, receipt);
        if (result.outcome === "invalid" || !result.operation) return rejected(result);
        operation = result.operation;
      }
      return { outcome: "rejected", reason: "lease_lost", operation };
    };
    /** First evidence wins: a retry resubmits the same receipt, so the Store replays it. */
    let first: Receipt | undefined;
    const submit = async (candidate: Receipt): Promise<SettleOutcome> => {
      if (finished) return { ...finished, replayed: true };
      const receipt = (first ??= candidate);
      stop();
      const result = await meter.settle({
        ...ref,
        commandId: `${id}:settle`,
        expectedVersion: admitted.version,
        authority: { kind: "lease", leaseId },
        receipt,
      });
      if (result.outcome === "settled") return conclude(result, "lease", receipt);
      if (result.outcome === "invalid" || !result.operation) return rejected(result);
      return settleLate(receipt, result.operation);
    };
    const receiptOf = (
      measurements: Measurement[],
      input: Pick<
        DispatchSettlement,
        "cost" | "failed" | "providerRequestId" | "providerPriceVersion"
      >,
    ): Receipt => ({
      id: `${id}:receipt`,
      measurements,
      cost: input.cost,
      occurredAt: admitted.createdAt,
      recordedAt: now().toISOString(),
      cached: false,
      failed: input.failed ?? false,
      ...(input.providerRequestId ? { providerRequestId: input.providerRequestId } : {}),
      ...(input.providerPriceVersion ? { providerPriceVersion: input.providerPriceVersion } : {}),
    });
    return {
      id,
      tracking: "metered",
      reserved: admitted.estimate,
      renew,
      settle: async (input) => {
        if (finished) return { ...finished, replayed: true };
        const units = new Set(input.usage.map((quantity) => quantity.unit));
        if (units.size !== input.usage.length)
          return {
            outcome: "rejected",
            reason: "invalid",
            detail: "duplicate unit",
            operation: null,
          };
        for (const estimate of admitted.estimate)
          if (!units.has(estimate.unit) && !(addedRequests && estimate.unit === requestsUnit))
            return { outcome: "rejected", reason: "missing_usage_unit", unit: estimate.unit };
        const certainty = input.certainty ?? "measured";
        const measurements: Measurement[] = input.usage.map((quantity) => ({
          unit: quantity.unit,
          quantity,
          certainty,
        }));
        if (addedRequests && !units.has(requestsUnit)) measurements.push(requestsMeasured);
        return submit(receiptOf(measurements, input));
      },
      settleUnknown: async (input = {}) =>
        submit(
          receiptOf(
            admitted.estimate.map((estimate) =>
              addedRequests && estimate.unit === requestsUnit
                ? requestsMeasured
                : { unit: estimate.unit, quantity: null, certainty: "unknown" },
            ),
            { cost: unknownCost, ...(input.failed !== undefined ? { failed: input.failed } : {}) },
          ),
        ),
    };
  }

  return {
    async admit({ id, operation, estimate }) {
      const addedRequests = !estimate.some((quantity) => quantity.unit === requestsUnit);
      const ref = {
        namespace: operation.scope.namespace,
        principal: operation.scope.principal,
        operationId: id,
      };
      const reserved = await meter.reserve({
        ...operation,
        operationId: id,
        estimate: addedRequests
          ? [{ unit: requestsUnit, value: 1n, scale: 0 }, ...estimate]
          : [...estimate],
      });
      if (reserved.outcome === "exceeded")
        return { outcome: "refused", reason: "budget_exceeded", exceeded: reserved.exceeded };
      if (reserved.outcome === "invalid")
        return "unit" in reserved
          ? { outcome: "refused", reason: "unsupported_budget_unit", unit: reserved.unit }
          : {
              outcome: "refused",
              reason: "invalid",
              field: reserved.field,
              detail: reserved.reason,
            };
      if (reserved.outcome === "conflict")
        return { outcome: "refused", reason: "conflict", operation: reserved.operation };
      if (reserved.outcome === "unpriced")
        return { outcome: "refused", reason: "invalid", field: "estimate", detail: "unpriced" };
      if (reserved.replayed)
        return { outcome: "refused", reason: "replayed", operation: reserved.operation };
      if (reserved.outcome === "passthrough")
        return { outcome: "admitted", dispatch: { ...passthrough, id }, warnings: [], alerts: [] };
      // Nothing was dispatched, so the reservation is returned. A rejected release means intent
      // was recorded after all; that operation is then resolved like any abandoned dispatch.
      const release = () =>
        meter
          .releaseUndispatched({
            ...ref,
            commandId: `${id}:release`,
            expectedVersion: reserved.operation.version,
            reason: "dispatch_denied",
          })
          .catch(() => undefined);
      let grant;
      try {
        grant = await meter.markDispatchIntent({
          ...ref,
          commandId: `${id}:intent`,
          expectedVersion: reserved.operation.version,
          holder,
          leaseTtlMs,
        });
      } catch (error) {
        await release();
        throw error;
      }
      if (!("granted" in grant) || !grant.granted) {
        await release();
        return { outcome: "refused", reason: "dispatch_denied", detail: grant.reason };
      }
      return {
        outcome: "admitted",
        dispatch: open(id, ref, grant.operation, grant.lease.leaseId, addedRequests),
        warnings: reserved.warnings,
        alerts: reserved.alerts,
      };
    },
    async settleAbandoned({ access, scope, from, to, limit = 100, cursor, cost }) {
      const page = await meter.listOperations(access, {
        scope,
        from,
        to,
        states: ["dispatch_intended"],
        limit,
        ...(cursor !== undefined ? { cursor } : {}),
      });
      if (page.outcome !== "ok") return page;
      const at = now();
      let charged = 0,
        pending = 0,
        skipped = 0;
      for (const operation of page.value.operations) {
        const ref = {
          namespace: operation.scope.namespace,
          principal: operation.scope.principal,
          operationId: operation.operationId,
        };
        if (
          operation.lease?.holder !== holder ||
          Date.parse(operation.lease.expiresAt) > at.getTime()
        ) {
          skipped++;
          continue;
        }
        const claim = await meter.claimForRecovery({ ...ref, holder, leaseTtlMs });
        if (!("claimed" in claim) || !claim.claimed) {
          skipped++;
          continue;
        }
        const result = await meter.settle({
          ...ref,
          commandId: `${operation.operationId}:abandoned`,
          expectedVersion: claim.operation.version,
          authority: { kind: "recovery", leaseId: claim.lease.leaseId },
          receipt: {
            id: `${operation.operationId}:abandoned`,
            // The conservative rule: an abandoned turn costs its whole reservation.
            measurements: operation.estimate.map((quantity) => ({
              unit: quantity.unit,
              quantity,
              certainty: "estimated",
            })),
            cost: cost?.(operation) ?? unknownCost,
            occurredAt: operation.createdAt,
            recordedAt: at.toISOString(),
            cached: false,
            failed: true,
          },
        });
        if (result.outcome !== "settled") skipped++;
        else if (result.operation.state === "settled") charged++;
        else pending++;
      }
      return {
        outcome: "swept",
        examined: page.value.operations.length,
        charged,
        pending,
        skipped,
        ...(page.value.nextCursor !== undefined ? { nextCursor: page.value.nextCursor } : {}),
      };
    },
  };
}
