import * as v from "valibot";
import { tagPattern } from "@usagekit/core";
const text = v.pipe(v.string(), v.minLength(1));
const integer = v.pipe(v.number(), v.integer(), v.minValue(0));
const decimal = v.pipe(v.string(), v.regex(/^-?\d+$/));
const timestamp = v.pipe(v.string(), v.isoTimestamp(), v.endsWith("Z"));
const obj = v.strictObject;
export const Money = obj({ units: decimal, currency: v.literal("USD") });
export const Quantity = obj({ value: decimal, scale: v.pipe(integer, v.maxValue(18)), unit: text });
const credential = obj({ kind: text, id: text });
export const Scope = obj({
  namespace: text,
  principal: text,
  actor: v.optional(text),
  group: v.optional(text),
  connection: text,
  accessCredential: v.optional(credential),
  providerCredentialVersion: v.optional(text),
  tags: v.optional(
    v.pipe(v.array(v.pipe(v.string(), v.regex(tagPattern))), v.minLength(1), v.maxLength(16)),
  ),
});
const surface = v.picklist(["app", "programmatic"]);
const source = v.picklist(["app", "worker", "api", "sdk", "cli", "mcp", "proxy", "import"]);
const funding = v.picklist(["byok", "platform"]);
export const BudgetScope = v.variant("kind", [
  obj({ kind: v.literal("principal"), namespace: text, principal: text }),
  obj({ kind: v.literal("group"), namespace: text, group: text }),
  obj({ kind: v.literal("connection"), namespace: text, connection: text }),
  obj({ kind: v.literal("access_credential"), namespace: text, accessCredential: credential }),
  obj({ kind: v.literal("platform_pool"), namespace: text, poolId: text }),
  obj({ kind: v.literal("tag"), namespace: text, tag: v.pipe(v.string(), v.regex(tagPattern)) }),
]);
export const UsageScope = v.variant("kind", [
  obj({ kind: v.literal("principal"), namespace: text, principal: text }),
  obj({ kind: v.literal("group"), namespace: text, group: text }),
  obj({ kind: v.literal("namespace"), namespace: text }),
  obj({ kind: v.literal("platform_pool"), namespace: text, poolId: text }),
]);
const alertAt = v.union([
  obj({ percent: v.pipe(integer, v.minValue(1), v.maxValue(100)) }),
  Quantity,
]);
const window = v.variant("kind", [
  obj({ kind: v.literal("calendar_month"), timezone: v.literal("UTC") }),
  obj({ kind: v.literal("provider_cycle"), cycleId: text, startsAt: timestamp, endsAt: timestamp }),
  obj({ kind: v.literal("rolling"), days: integer }),
  obj({ kind: v.literal("since_reset"), epoch: text, startsAt: timestamp }),
]);
export const Budget = obj({
  id: text,
  version: integer,
  scope: BudgetScope,
  surface: v.picklist(["programmatic", "any", ...source.options]),
  unit: text,
  limit: v.nullable(Quantity),
  window,
  /** warn is a deprecated wire alias of allow. */
  onExceed: v.picklist(["block", "allow", "warn"]),
  hardLimit: v.optional(Quantity),
  alerts: v.optional(v.pipe(v.array(obj({ at: alertAt })), v.maxLength(8))),
});
const AlertCrossed = obj({
  budgetId: text,
  budgetVersion: integer,
  epoch: text,
  at: alertAt,
  used: Quantity,
  reserved: Quantity,
});
const Measurement = v.variant("certainty", [
  obj({ certainty: v.literal("unknown"), unit: text, quantity: v.null() }),
  obj({ certainty: v.picklist(["measured", "estimated"]), unit: text, quantity: Quantity }),
]);
const Cost = v.variant("certainty", [
  obj({ certainty: v.literal("unknown"), money: v.null() }),
  obj({ certainty: v.picklist(["measured", "estimated"]), money: Money }),
]);
export const Receipt = obj({
  id: text,
  source: v.optional(v.picklist(["dispatch", "probe", "import"])),
  supersedes: v.optional(text),
  measurements: v.array(Measurement),
  cost: Cost,
  providerRequestId: v.optional(text),
  providerPriceVersion: v.optional(text),
  evidenceRef: v.optional(v.string()),
  occurredAt: timestamp,
  recordedAt: timestamp,
  cached: v.boolean(),
  failed: v.boolean(),
});
const reserveFields = {
  operationId: text,
  reservationTtlMs: v.optional(v.pipe(integer, v.minValue(1), v.maxValue(86400000))),
  scope: Scope,
  fundingSource: funding,
  platformPools: v.optional(v.array(text)),
  costOwner: text,
  creditAccountRef: v.optional(text),
  customerPriceVersion: v.optional(text),
  surface,
  source,
  provider: text,
  operation: text,
  estimate: v.array(Quantity),
  estimateSource: v.optional(v.picklist(["manual", "measured", "list", "unknown"])),
  providerPriceVersion: v.optional(text),
  correlationId: v.optional(text),
  parentOperationId: v.optional(text),
};
const Ref = { namespace: text, principal: text, operationId: text };
const Command = { ...Ref, commandId: text, expectedVersion: integer };
const leaseTtl = v.pipe(integer, v.minValue(1), v.maxValue(86400000));
export const Lease = obj({ leaseId: text, holder: text, expiresAt: timestamp });
const authority = v.variant("kind", [
  obj({ kind: v.literal("lease"), leaseId: text }),
  obj({ kind: v.literal("recovery"), leaseId: text }),
  obj({ kind: v.literal("late_evidence"), source: text }),
]);
export const Operation = obj({
  ...reserveFields,
  reservationExpiresAt: timestamp,
  state: v.picklist(["reserved", "dispatch_intended", "pending", "settled", "released"]),
  version: integer,
  createdAt: timestamp,
  updatedAt: timestamp,
  budgetEpochs: v.array(
    obj({
      budgetId: text,
      budgetVersion: integer,
      epoch: text,
      startsAt: timestamp,
      endsAt: v.nullable(timestamp),
    }),
  ),
  receipts: v.array(Receipt),
  lease: v.nullable(Lease),
});
const Epoch = obj({ epoch: text, startsAt: timestamp, endsAt: v.nullable(timestamp) });
const Status = obj({
  budget: Budget,
  epoch: Epoch,
  used: v.nullable(Quantity),
  reserved: v.nullable(Quantity),
  remaining: v.nullable(Quantity),
  redacted: v.optional(v.literal(true)),
});
export const UsageQuery = obj({
  scope: UsageScope,
  from: timestamp,
  to: timestamp,
  connection: v.optional(text),
  units: v.array(text),
  groupBy: v.array(
    v.picklist([
      "principal",
      "provider",
      "operation",
      "surface",
      "source",
      "connection",
      "day",
      "access_credential",
      "platform_pool",
      "funding_source",
      "tag",
    ]),
  ),
  cursor: v.optional(text),
  limit: v.optional(v.pipe(integer, v.minValue(1), v.maxValue(1000))),
});
const lifecycle = v.picklist(["reserved", "dispatch_intended", "pending", "settled", "released"]);
export const OperationsQuery = obj({
  scope: UsageScope,
  from: timestamp,
  to: timestamp,
  states: v.optional(v.pipe(v.array(lifecycle), v.minLength(1))),
  connection: v.optional(text),
  cursor: v.optional(text),
  limit: v.optional(v.pipe(integer, v.minValue(1), v.maxValue(1000))),
});
const OperationsPage = obj({
  operations: v.array(Operation),
  asOf: timestamp,
  watermark: text,
  nextCursor: v.optional(text),
});
const UsagePage = obj({
  rows: v.array(
    obj({
      dimensions: v.record(v.string(), v.string()),
      measurements: v.array(Measurement),
      cost: Cost,
      fundingSource: funding,
      costOwner: text,
      unknownOperations: decimal,
    }),
  ),
  asOf: timestamp,
  watermark: text,
  nextCursor: v.optional(text),
});
const requestState = v.picklist(["passthrough", "unpriced", "cached", "rate_limited"]);
export const RequestCountsQuery = obj({
  scope: UsageScope,
  from: timestamp,
  to: timestamp,
  connection: v.optional(text),
  groupBy: v.array(v.picklist(["provider", "operation", "connection", "source", "day"])),
  limit: v.optional(v.pipe(integer, v.minValue(1), v.maxValue(1000))),
});
const RequestCountsPage = obj({
  rows: v.array(
    obj({ dimensions: v.record(v.string(), v.string()), state: requestState, count: decimal }),
  ),
  asOf: timestamp,
  truncated: v.boolean(),
});
const importWindow = obj({ from: timestamp, to: timestamp });
const fileHash = v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/));
const BillingLine = obj({
  providerRequestId: v.optional(text),
  operation: v.optional(text),
  occurredAt: timestamp,
  cost: Money,
  window: v.optional(importWindow),
});
const ReconciliationEntry = obj({
  id: text,
  importId: text,
  scope: Scope,
  provider: text,
  window: importWindow,
  kind: v.picklist(["aggregate", "import_total"]),
  operation: v.optional(text),
  ledgerTotal: Cost,
  evidenceTotal: Money,
  differenceUnits: v.nullable(decimal),
  unknownOperations: v.pipe(v.string(), v.regex(/^\d+$/)),
  evidenceRef: text,
});
const BillingImportRecord = obj({
  id: text,
  scope: Scope,
  provider: text,
  fileHash,
  window: importWindow,
  recordedAt: timestamp,
  supersedes: v.optional(text),
  supersededBy: v.optional(text),
  matchedOperationIds: v.array(text),
  unobservedOperationIds: v.array(text),
  reconciliations: v.array(ReconciliationEntry),
  alerts: v.array(AlertCrossed),
});
const {
  operationId: _id,
  reservationTtlMs: _ttl,
  correlationId: _correlation,
  parentOperationId: _parent,
  ...quoteFields
} = reserveFields;
export const schemas = {
  quote: obj({
    ...quoteFields,
    estimate: v.optional(v.array(Quantity)),
    options: v.optional(v.record(v.string(), v.string())),
  }),
  importBilling: obj({
    scope: Scope,
    provider: text,
    fileHash,
    window: importWindow,
    expectedPreviousImportId: v.nullable(text),
    attribution: obj({
      fundingSource: funding,
      costOwner: text,
      creditAccountRef: v.optional(text),
      customerPriceVersion: v.optional(text),
      providerPriceVersion: v.optional(text),
      platformPools: v.optional(v.array(text)),
    }),
    lines: v.array(BillingLine),
  }),
  billingImports: obj({
    scope: obj({ namespace: text, principal: text }),
    connection: text,
    from: timestamp,
    to: timestamp,
    history: v.optional(v.boolean()),
    limit: v.optional(v.pipe(integer, v.minValue(1), v.maxValue(1000))),
  }),
  expire: obj({
    namespace: text,
    commandId: text,
    limit: v.optional(v.pipe(integer, v.minValue(1), v.maxValue(1000))),
  }),
  reserve: obj({
    ...reserveFields,
    estimate: v.optional(v.array(Quantity)),
    options: v.optional(v.record(v.string(), v.string())),
    commandId: text,
  }),
  intent: obj({ ...Command, holder: text, leaseTtlMs: leaseTtl }),
  renew: obj({ ...Ref, commandId: text, leaseId: text, leaseTtlMs: leaseTtl }),
  claim: obj({ ...Ref, commandId: text, holder: text, leaseTtlMs: leaseTtl }),
  settle: obj({ ...Command, authority, receipt: Receipt }),
  correct: obj({ ...Command, authority, receipt: Receipt, replacesReceiptId: text, reason: text }),
  release: obj({ ...Command, reason: text }),
  count: obj({
    commandId: text,
    scope: Scope,
    surface,
    source,
    provider: text,
    operation: text,
    state: requestState,
    platformPools: v.optional(v.array(text)),
  }),
  operation: obj(Ref),
  usage: UsageQuery,
  operations: OperationsQuery,
  defined: obj({ scope: BudgetScope }),
  counts: RequestCountsQuery,
  applicable: obj({
    scope: Scope,
    surface,
    source: v.optional(source),
    units: v.array(text),
    platformPools: v.optional(v.array(text)),
  }),
};
export type RouteName = keyof typeof schemas;
export type WireInputs = { [K in RouteName]: v.InferOutput<(typeof schemas)[K]> };
const invalid = obj({ outcome: v.literal("invalid"), field: text, reason: text });
const exceeded = obj({
  code: v.literal("allowance_exceeded"),
  budget: Budget,
  boundary: v.picklist(["limit", "hardLimit"]),
  used: Quantity,
  reserved: Quantity,
  resetsAt: v.nullable(timestamp),
});
const read = <T extends v.GenericSchema>(schema: T) =>
  v.union([
    obj({ outcome: v.literal("ok"), value: schema }),
    obj({ outcome: v.literal("forbidden") }),
    invalid,
  ]);
const settleResult = v.union([
  obj({
    outcome: v.literal("settled"),
    replayed: v.boolean(),
    operation: Operation,
    alerts: v.array(AlertCrossed),
  }),
  obj({
    outcome: v.literal("rejected"),
    reason: v.picklist([
      "not_holder",
      "lease_expired",
      "version_conflict",
      "invalid_state",
      "receipt_conflict",
    ]),
    operation: v.nullable(Operation),
  }),
  invalid,
]);
export const responses = {
  quote: read(
    obj({
      quantities: v.array(Quantity),
      estimateSource: v.optional(v.picklist(["manual", "measured", "list", "unknown"])),
      providerPriceVersion: v.optional(text),
      checkedAt: v.optional(text),
      sampleSize: v.optional(integer),
      tracking: v.picklist(["metered", "passthrough", "unpriced"]),
      budgets: v.array(Status),
      asOf: timestamp,
    }),
  ),
  importBilling: v.union([
    obj({ outcome: v.literal("imported"), replayed: v.boolean(), record: BillingImportRecord }),
    obj({
      outcome: v.literal("rejected"),
      reason: v.picklist([
        "previous_import_conflict",
        "payload_conflict",
        "ambiguous_request",
        "active_operation",
        "operation_state",
        "evidence_conflict",
      ]),
      latestImportId: v.nullable(text),
      line: v.optional(integer),
    }),
    obj({ outcome: v.literal("forbidden") }),
    invalid,
  ]),
  billingImports: read(
    obj({ records: v.array(BillingImportRecord), asOf: timestamp, truncated: v.boolean() }),
  ),
  expire: v.union([
    obj({ outcome: v.literal("expired"), count: integer, hasMore: v.boolean() }),
    invalid,
  ]),
  reserve: v.union([
    obj({
      outcome: v.literal("reserved"),
      replayed: v.boolean(),
      operation: Operation,
      warnings: v.array(exceeded),
      alerts: v.array(AlertCrossed),
    }),
    obj({ outcome: v.literal("exceeded"), exceeded, operation: v.null() }),
    obj({
      outcome: v.picklist(["passthrough", "unpriced"]),
      replayed: v.boolean(),
      operation: v.null(),
    }),
    obj({
      outcome: v.literal("conflict"),
      reason: v.literal("semantic_mismatch"),
      operation: Operation,
    }),
    obj({
      outcome: v.literal("invalid"),
      reason: v.literal("missing_estimate_unit"),
      unit: text,
      operation: v.null(),
    }),
    invalid,
  ]),
  intent: v.union([
    obj({ granted: v.literal(true), operation: Operation, lease: Lease }),
    obj({
      granted: v.literal(false),
      operation: v.nullable(Operation),
      reason: v.picklist([
        "already_dispatched",
        "version_conflict",
        "not_reserved",
        "released",
        "reservation_expired",
      ]),
    }),
    invalid,
  ]),
  renew: v.union([
    obj({ renewed: v.literal(true), lease: Lease }),
    obj({ renewed: v.literal(false), reason: v.picklist(["expired", "not_holder", "not_active"]) }),
    invalid,
  ]),
  claim: v.union([
    obj({ claimed: v.literal(true), operation: Operation, lease: Lease }),
    obj({
      claimed: v.literal(false),
      operation: v.nullable(Operation),
      reason: v.picklist(["lease_active", "not_recoverable", "not_found"]),
    }),
    invalid,
  ]),
  settle: settleResult,
  correct: settleResult,
  release: v.union([
    obj({ outcome: v.literal("released"), replayed: v.boolean(), operation: Operation }),
    obj({
      outcome: v.literal("rejected"),
      reason: v.picklist(["not_reserved", "version_conflict"]),
      operation: v.nullable(Operation),
    }),
    invalid,
  ]),
  count: v.union([
    obj({ outcome: v.literal("counted"), replayed: v.boolean() }),
    obj({ outcome: v.literal("conflict"), reason: v.literal("command_mismatch") }),
    invalid,
  ]),
  operation: read(v.nullable(Operation)),
  usage: read(UsagePage),
  operations: read(OperationsPage),
  defined: read(v.array(Budget)),
  applicable: read(v.array(Status)),
  counts: read(RequestCountsPage),
};
/** Method and path of every route; reads take their query as base64url JSON in q. */
export const routes: Record<RouteName, { read: boolean; path: string }> = {
  quote: { read: true, path: "/v1/quotes" },
  importBilling: { read: false, path: "/v1/billing/import" },
  billingImports: { read: true, path: "/v1/billing/imports" },
  expire: { read: false, path: "/v1/operations/expire" },
  reserve: { read: false, path: "/v1/operations/reserve" },
  intent: { read: false, path: "/v1/operations/intent" },
  renew: { read: false, path: "/v1/operations/renew" },
  claim: { read: false, path: "/v1/operations/claim" },
  settle: { read: false, path: "/v1/operations/settle" },
  correct: { read: false, path: "/v1/operations/correct" },
  release: { read: false, path: "/v1/operations/release" },
  count: { read: false, path: "/v1/requests/count" },
  operation: { read: true, path: "/v1/operations/{id}" },
  usage: { read: true, path: "/v1/usage" },
  operations: { read: true, path: "/v1/operations" },
  defined: { read: true, path: "/v1/budgets/defined" },
  applicable: { read: true, path: "/v1/budgets/applicable" },
  counts: { read: true, path: "/v1/requests/counts" },
};
export function parseWire(name: RouteName, data: unknown) {
  return v.safeParse(schemas[name], data);
}
export function validResponse(name: RouteName, data: unknown): boolean {
  return v.safeParse(responses[name], data).success;
}
