import type {
  BillingImportInput,
  BillingImportRecord,
  BillingImportResult,
  BillingImportsPage,
  BillingImportsQuery,
  BillingOperationChange,
  Cost,
  Money,
  Operation,
  Receipt,
  ReconciliationEntry,
  ValidationFailure,
} from "@usagekit/core";
import { normalizeTags, addMoney, subtractMoney, moneyScale } from "@usagekit/core";
import { settlementState } from "./memory/settlement.js";
import { canonical, copy, maxMoneyUnits } from "./memory/state.js";

export type StoredBillingImport = { identity: string; record: BillingImportRecord };
export type BillingSnapshot = {
  operations: readonly Operation[];
  imports: readonly StoredBillingImport[];
  latestImportId: string | null;
};
export type BillingPreparation = {
  result: BillingImportResult;
  changes: readonly BillingOperationChange[];
  stored?: StoredBillingImport;
  familyId: string;
};

const invalid = (field: string, reason: string): ValidationFailure => ({
  outcome: "invalid",
  field,
  reason,
});
const name = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= 256;
const date = (value: unknown): value is string =>
  typeof value === "string" && Number.isFinite(Date.parse(value));
const interval = (value: unknown): value is { from: string; to: string } => {
  if (!value || typeof value !== "object") return false;
  const w = value as { from?: unknown; to?: unknown };
  return date(w.from) && date(w.to) && Date.parse(w.from) < Date.parse(w.to);
};
const normalizedWindow = (w: { from: string; to: string }) => ({
  from: new Date(w.from).toISOString(),
  to: new Date(w.to).toISOString(),
});

export function validateBillingImportInput(i: BillingImportInput): ValidationFailure | null {
  if (!i || typeof i !== "object") return invalid("input", "expected billing import");
  if (!i.scope || !name(i.scope.namespace) || !name(i.scope.principal) || !name(i.scope.connection))
    return invalid("scope", "namespace, principal and connection are required");
  for (const field of ["actor", "group", "providerCredentialVersion"] as const)
    if (i.scope[field] !== undefined && !name(i.scope[field]))
      return invalid("scope." + field, "nonempty identifier required");
  if (
    i.scope.accessCredential !== undefined &&
    (!i.scope.accessCredential ||
      !name(i.scope.accessCredential.kind) ||
      !name(i.scope.accessCredential.id))
  )
    return invalid("scope.accessCredential", "credential kind and id required");
  if (i.scope.tags !== undefined && !normalizeTags(i.scope.tags))
    return invalid("scope.tags", "invalid tags");
  if (!name(i.provider)) return invalid("provider", "provider is required");
  if (typeof i.fileHash !== "string" || !/^[a-f0-9]{64}$/.test(i.fileHash))
    return invalid("fileHash", "expected lower-case SHA-256");
  if (!interval(i.window)) return invalid("window", "expected a nonempty half-open interval");
  if (
    i.expectedPreviousImportId !== null &&
    (typeof i.expectedPreviousImportId !== "string" || !i.expectedPreviousImportId)
  )
    return invalid("expectedPreviousImportId", "explicit null or current import id required");
  if (
    !i.attribution ||
    !["byok", "platform"].includes(i.attribution.fundingSource) ||
    !name(i.attribution.costOwner)
  )
    return invalid("attribution", "trusted historical funding and cost owner required");
  for (const field of ["creditAccountRef", "customerPriceVersion", "providerPriceVersion"] as const)
    if (i.attribution[field] !== undefined && !name(i.attribution[field]))
      return invalid("attribution." + field, "nonempty identifier required");
  if (
    i.attribution.platformPools !== undefined &&
    (!Array.isArray(i.attribution.platformPools) ||
      i.attribution.platformPools.some((p) => !name(p)) ||
      new Set(i.attribution.platformPools).size !== i.attribution.platformPools.length)
  )
    return invalid("attribution.platformPools", "unique pool ids required");
  if (!Array.isArray(i.lines) || i.lines.length > 1000)
    return invalid("lines", "at most 1000 export lines per atomic import");
  const requestIds = new Set<string>();
  const aggregateWindows: { from: string; to: string; operation?: string }[] = [];
  for (const [n, line] of i.lines.entries()) {
    const field = "lines." + n;
    if (
      !line ||
      !date(line.occurredAt) ||
      Date.parse(line.occurredAt) < Date.parse(i.window.from) ||
      Date.parse(line.occurredAt) >= Date.parse(i.window.to)
    )
      return invalid(field, "occurrence must belong to the import window");
    if (
      !line.cost ||
      line.cost.currency !== "USD" ||
      typeof line.cost.units !== "bigint" ||
      line.cost.units < 0n ||
      line.cost.units > maxMoneyUnits ||
      (line.cost.scale !== undefined &&
        (!Number.isInteger(line.cost.scale) || line.cost.scale < 0 || line.cost.scale > 18))
    )
      return invalid(field + ".cost", "exact nonnegative USD within storage capability required");
    if (line.operation !== undefined && !name(line.operation))
      return invalid(field + ".operation", "invalid operation");
    if (line.providerRequestId !== undefined) {
      if (!name(line.providerRequestId) || requestIds.has(line.providerRequestId))
        return invalid(field + ".providerRequestId", "unique nonempty request id required");
      if (line.window !== undefined)
        return invalid(field, "a request line cannot also be an aggregate");
      requestIds.add(line.providerRequestId);
    } else {
      if (
        !interval(line.window) ||
        Date.parse(line.window.from) < Date.parse(i.window.from) ||
        Date.parse(line.window.to) > Date.parse(i.window.to)
      )
        return invalid(field + ".window", "an aggregate line needs a contained window");
      if (
        aggregateWindows.some(
          (w) =>
            Date.parse(w.from) < Date.parse(line.window!.to) &&
            Date.parse(line.window!.from) < Date.parse(w.to) &&
            (w.operation === undefined ||
              line.operation === undefined ||
              w.operation === line.operation),
        )
      )
        return invalid(field + ".window", "overlapping aggregate lines double-count evidence");
      aggregateWindows.push({
        ...line.window,
        ...(line.operation === undefined ? {} : { operation: line.operation }),
      });
    }
  }
  if (
    i.lines.some(
      (line) =>
        line.providerRequestId !== undefined &&
        aggregateWindows.some(
          (w) =>
            Date.parse(line.occurredAt) >= Date.parse(w.from) &&
            Date.parse(line.occurredAt) < Date.parse(w.to) &&
            (w.operation === undefined ||
              line.operation === undefined ||
              w.operation === line.operation),
        ),
    )
  )
    return invalid("lines", "itemized and aggregate evidence cannot overlap");
  return null;
}

export function validateBillingImportsQuery(q: BillingImportsQuery): ValidationFailure | null {
  if (!q || !q.scope || !name(q.scope.namespace) || !name(q.scope.principal) || !name(q.connection))
    return invalid("scope", "namespace, principal and connection required");
  if (!interval(q)) return invalid("window", "expected a nonempty interval");
  if (q.limit !== undefined && (!Number.isInteger(q.limit) || q.limit < 1 || q.limit > 1000))
    return invalid("limit", "1 to 1000 required");
  if (q.history !== undefined && typeof q.history !== "boolean")
    return invalid("history", "boolean required");
  return null;
}

export const billingFamilyId = (i: BillingImportInput): string =>
  canonical([i.scope.namespace, i.scope.connection, i.provider, normalizedWindow(i.window)]);
const currentReceipt = (op: Operation): Receipt | undefined => {
  const superseded = new Set(op.receipts.map((r) => r.supersedes));
  return [...op.receipts].reverse().find((r) => !superseded.has(r.id));
};
/** Billing comparisons retain the application's own evidence rather than echoing a prior invoice. */
const observedReceipt = (op: Operation): Receipt | undefined => {
  const receipts = op.receipts.filter((r) => r.source !== "import");
  const superseded = new Set(receipts.map((r) => r.supersedes));
  return [...receipts].reverse().find((r) => !superseded.has(r.id));
};
function ledger(
  operations: readonly Operation[],
  window: { from: string; to: string },
  operation?: string,
): { total: Cost; unknown: bigint } {
  let money: Money = { units: 0n, currency: "USD" };
  let unknown = 0n,
    estimated = false;
  for (const op of operations) {
    if (
      op.source === "import" ||
      op.state === "released" ||
      (operation !== undefined && op.operation !== operation)
    )
      continue;
    const r = observedReceipt(op);
    if (r?.canonicalOperationId) continue;
    const occurredAt = r?.occurredAt ?? op.createdAt;
    if (
      Date.parse(occurredAt) < Date.parse(window.from) ||
      Date.parse(occurredAt) >= Date.parse(window.to)
    )
      continue;
    if (!r || r.cost.certainty === "unknown") {
      unknown++;
      continue;
    }
    money = addMoney(money, r.cost.money);
    if (r.cost.certainty === "estimated") estimated = true;
  }
  return {
    total:
      unknown > 0n
        ? { certainty: "unknown", money: null }
        : { certainty: estimated ? "estimated" : "measured", money },
    unknown,
  };
}

/** Pure preparation. Adapters commit every change, projection and journal in one transaction. */
export function prepareBillingImport(
  i: BillingImportInput,
  snapshot: BillingSnapshot,
  now: Date,
): BillingPreparation {
  const error = validateBillingImportInput(i);
  if (error) return { result: error, changes: [], familyId: "" };
  const window = normalizedWindow(i.window),
    familyId = billingFamilyId(i);
  const id = canonical([familyId, i.fileHash]);
  // expectedPreviousImportId is a concurrency precondition, not imported content.
  const { expectedPreviousImportId: _, ...content } = i;
  const identity = canonical({ ...content, window });
  const reject = (
    reason: Extract<BillingImportResult, { outcome: "rejected" }>["reason"],
    line?: number,
  ): BillingPreparation => ({
    familyId,
    changes: [],
    result: {
      outcome: "rejected",
      reason,
      latestImportId: snapshot.latestImportId,
      ...(line === undefined ? {} : { line }),
    },
  });
  const previous = snapshot.imports.find((x) => x.record.id === id);
  if (previous)
    return previous.identity === identity
      ? {
          familyId,
          changes: [],
          result: { outcome: "imported", replayed: true, record: copy(previous.record) },
        }
      : reject("payload_conflict");
  if (snapshot.latestImportId !== i.expectedPreviousImportId)
    return reject("previous_import_conflict");
  // A retained export cannot change its accounting owner when a connection transfers.
  if (snapshot.imports.some((x) => x.record.scope.principal !== i.scope.principal))
    return reject("evidence_conflict");
  const scope = {
    ...copy(i.scope),
    ...(i.scope.tags ? { tags: normalizeTags(i.scope.tags)! } : {}),
  };
  const operations = snapshot.operations.filter(
    (op) =>
      op.scope.namespace === scope.namespace &&
      op.scope.principal === scope.principal &&
      op.scope.connection === scope.connection &&
      op.provider === i.provider,
  );
  const recordedAt = now.toISOString();
  const changes: BillingOperationChange[] = [],
    matched: string[] = [],
    unobserved: string[] = [];
  const reconciliation = (
    kind: ReconciliationEntry["kind"],
    entryWindow: { from: string; to: string },
    money: Money,
    suffix: string,
    operation?: string,
  ): ReconciliationEntry => {
    const { total, unknown } = ledger(operations, entryWindow, operation);
    return {
      id: id + ":" + suffix,
      importId: id,
      scope: copy(scope),
      provider: i.provider,
      ...(operation === undefined ? {} : { operation }),
      window: normalizedWindow(entryWindow),
      kind,
      ledgerTotal: total,
      evidenceTotal: copy(money),
      differenceUnits: total.money === null ? null : subtractMoney(money, total.money).units,
      ...(money.scale !== undefined || total.money?.scale !== undefined
        ? {
            differenceScale: Math.max(
              moneyScale(money),
              total.money ? moneyScale(total.money) : moneyScale(money),
            ),
          }
        : {}),
      unknownOperations: unknown,
      evidenceRef: id,
    };
  };
  const reconciliations: ReconciliationEntry[] = [];
  for (const [n, line] of i.lines.entries()) {
    if (line.providerRequestId === undefined) {
      reconciliations.push(
        reconciliation("aggregate", line.window!, line.cost, "aggregate:" + n, line.operation),
      );
      continue;
    }
    const candidates = operations.filter(
      (op) =>
        !currentReceipt(op)?.canonicalOperationId &&
        op.receipts.some((r) => r.providerRequestId === line.providerRequestId),
    );
    if (candidates.length > 1) return reject("ambiguous_request", n);
    const before = candidates[0] ?? null;
    // Historical receipts may carry different request ids for the same operation.
    // Two lines must never create competing updates from the same version.
    if (before && matched.includes(before.operationId)) return reject("ambiguous_request", n);
    if (before?.lease && Date.parse(before.lease.expiresAt) > now.getTime())
      return reject("active_operation", n);
    if (before && !["pending", "settled"].includes(before.state))
      return reject("operation_state", n);
    if (before && line.operation !== undefined && before.operation !== line.operation)
      return reject("evidence_conflict", n);
    const effective = before ? currentReceipt(before) : undefined;
    if (before?.state === "settled" && !effective) return reject("evidence_conflict", n);
    const receipt: Receipt = {
      id: id + ":receipt:" + n,
      source: "import",
      ...(effective ? { supersedes: effective.id } : {}),
      measurements: copy(
        effective?.measurements ?? [{ unit: "requests", quantity: null, certainty: "unknown" }],
      ),
      cost: { certainty: "measured", money: copy(line.cost) },
      providerRequestId: line.providerRequestId,
      evidenceRef: id,
      occurredAt: new Date(line.occurredAt).toISOString(),
      recordedAt,
      cached: effective?.cached ?? false,
      failed: effective?.failed ?? false,
      ...(effective?.providerPriceVersion
        ? { providerPriceVersion: effective.providerPriceVersion }
        : {}),
    };
    // cents is a cost measurement, never a customer credit-price measurement.
    receipt.measurements = receipt.measurements.map((m) =>
      m.unit === "cents"
        ? {
            unit: "cents",
            certainty: "measured" as const,
            quantity: { value: line.cost.units, scale: moneyScale(line.cost), unit: "cents" },
          }
        : m,
    );
    if (
      before?.estimate.some((q) => q.unit === "cents") &&
      !receipt.measurements.some((m) => m.unit === "cents")
    )
      receipt.measurements = [
        ...receipt.measurements,
        {
          unit: "cents",
          certainty: "measured",
          quantity: { value: line.cost.units, scale: moneyScale(line.cost), unit: "cents" },
        },
      ];
    const state = settlementState(before ?? { estimate: [] }, receipt);
    const after: Operation = before
      ? {
          ...copy(before),
          state,
          version: before.version + 1,
          updatedAt: recordedAt,
          lease: null,
          receipts: [...copy(before.receipts), receipt],
        }
      : {
          ...copy(i.attribution),
          operationId: id + ":unobserved:" + n,
          scope: copy(scope),
          source: "import",
          surface: "programmatic",
          provider: i.provider,
          operation: line.operation ?? "unobserved",
          estimate: [],
          budgetEpochs: [],
          state,
          version: 1,
          reservationExpiresAt: recordedAt,
          createdAt: recordedAt,
          updatedAt: recordedAt,
          lease: null,
          receipts: [receipt],
        };
    if (before) matched.push(before.operationId);
    else unobserved.push(after.operationId);
    changes.push({ before: before ? copy(before) : null, after, receipt });
  }
  reconciliations.push(
    reconciliation(
      "import_total",
      window,
      i.lines.reduce((sum, line) => addMoney(sum, line.cost), {
        units: 0n,
        currency: "USD",
      } as Money),
      "total",
    ),
  );
  const record: BillingImportRecord = {
    id,
    scope,
    provider: i.provider,
    fileHash: i.fileHash,
    window,
    recordedAt,
    ...(snapshot.latestImportId ? { supersedes: snapshot.latestImportId } : {}),
    matchedOperationIds: matched,
    unobservedOperationIds: unobserved,
    reconciliations,
    alerts: [],
  };
  return {
    familyId,
    changes,
    stored: { identity, record },
    result: { outcome: "imported", replayed: false, record },
  };
}

export function readBillingImports(
  records: readonly BillingImportRecord[],
  q: BillingImportsQuery,
  now: Date,
): BillingImportsPage {
  const successors = new Map(records.filter((r) => r.supersedes).map((r) => [r.supersedes!, r.id]));
  const scoped = records
    .filter(
      (r) =>
        r.scope.namespace === q.scope.namespace &&
        r.scope.principal === q.scope.principal &&
        r.scope.connection === q.connection &&
        Date.parse(r.window.from) < Date.parse(q.to) &&
        Date.parse(q.from) < Date.parse(r.window.to) &&
        (q.history || !successors.has(r.id)),
    )
    .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt) || a.id.localeCompare(b.id));
  const limit = q.limit ?? 1000;
  return {
    records: scoped.slice(0, limit).map((r) => ({
      ...copy(r),
      ...(successors.has(r.id) ? { supersededBy: successors.get(r.id)! } : {}),
    })),
    asOf: now.toISOString(),
    truncated: scoped.length > limit,
  };
}
