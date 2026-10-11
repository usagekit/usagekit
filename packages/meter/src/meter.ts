import type { Meter, PricingCatalog, ReadResult, ValidationFailure } from "@usagekit/core";
import { resolveEstimate, resolveReserve } from "./catalog.js";
import type { ConnectionResolver } from "./catalog.js";
import { InvalidInput } from "@usagekit/store";
import type { Store, Clock } from "@usagekit/store";
import { defaultPolicy } from "./policy.js";
import type { MeterPolicy } from "./policy.js";
import {
  validate,
  quoteValidation,
  reserveValidation,
  usageValidation,
  operationsValidation,
  sourceValidation,
  provenanceValidation,
  requestCountsValidation,
} from "./validation.js";
import { canRead, canReadBudget, canReadShared, isShared } from "./access.js";
import { defaultBudgetOrder, normalizeTags } from "@usagekit/core";
import { validateBillingImportInput, validateBillingImportsQuery } from "@usagekit/store";
export function createMeter({
  store,
  policy = defaultPolicy,
  clock,
  resolveOwnership,
  catalog,
  resolveConnection,
}: {
  store: Store;
  policy?: MeterPolicy;
  clock: Clock;
  resolveOwnership?: import("./access.js").OwnershipResolver;
  /** With resolveConnection, lets reserve omit estimate and applies tracking policy. */
  catalog?: PricingCatalog;
  resolveConnection?: ConnectionResolver;
}): Meter {
  if (!Number.isFinite(clock.now().getTime())) throw new Error("InvalidInput: clock");
  if (
    policy.budgetOrder.length !== defaultBudgetOrder.length ||
    new Set(policy.budgetOrder).size !== defaultBudgetOrder.length ||
    policy.budgetOrder.some((k) => !defaultBudgetOrder.includes(k))
  )
    throw new Error("InvalidInput: budgetOrder");
  async function safely<T>(fn: () => Promise<T>): Promise<T | ValidationFailure> {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof InvalidInput)
        return { outcome: "invalid", field: error.field, reason: error.reason };
      if (
        error instanceof Error &&
        /^(InactiveWindow|UnsupportedWindow|InvalidInput):?/.test(error.message)
      )
        return { outcome: "invalid", field: "window", reason: error.message };
      throw error;
    }
  }
  const command = <T>(input: unknown, fn: () => Promise<T>) => {
    const invalid = validate(input);
    return invalid ? Promise.resolve(invalid) : safely(fn);
  };
  const read = async <T>(fn: () => Promise<T>): Promise<ReadResult<T>> =>
    safely(async () => ({ outcome: "ok" as const, value: await fn() }));
  const meter: Meter = {
    quote: async (access, requested) => {
      const invalid = quoteValidation(requested);
      if (invalid) return invalid;
      if (
        !access.canReadBillingDetail ||
        !canRead(access, {
          kind: "principal",
          namespace: requested.scope.namespace,
          principal: requested.scope.principal,
        }) ||
        (requested.scope.group !== undefined &&
          !canRead(access, {
            kind: "group",
            namespace: requested.scope.namespace,
            group: requested.scope.group,
          }))
      )
        return { outcome: "forbidden" };
      const owner = await resolveOwnership?.({
        kind: "connection",
        namespace: requested.scope.namespace,
        connection: requested.scope.connection,
      });
      if (
        !owner ||
        !canRead(access, owner) ||
        (owner.kind === "principal"
          ? owner.principal !== requested.scope.principal
          : owner.group !== requested.scope.group)
      )
        return { outcome: "forbidden" };
      if (
        requested.scope.accessCredential &&
        !(await canReadBudget(resolveOwnership, access, {
          kind: "access_credential",
          namespace: requested.scope.namespace,
          accessCredential: requested.scope.accessCredential,
        }))
      )
        return { outcome: "forbidden" };
      return safely(async () => {
        const resolved = await resolveEstimate(requested, catalog, resolveConnection);
        if (resolved.kind === "invalid") return resolved.failure;
        const quantities = resolved.kind === "reserve" ? resolved.input.estimate : [];
        if (resolved.kind === "reserve") {
          const invalid = reserveValidation({ ...resolved.input, operationId: "quote" });
          if (invalid) return invalid;
        }
        const statuses = await meter.applicableBudgets(access, {
          scope: requested.scope,
          surface: requested.surface,
          source: requested.source,
          units: quantities.map((q) => q.unit),
          ...(requested.platformPools ? { platformPools: requested.platformPools } : {}),
        });
        if (statuses.outcome !== "ok") return statuses;
        return {
          outcome: "ok" as const,
          value: {
            quantities,
            ...(resolved.kind === "reserve"
              ? resolved.input.estimateSource
                ? { estimateSource: resolved.input.estimateSource }
                : {}
              : { estimateSource: "unknown" as const }),
            ...(resolved.kind === "reserve" && resolved.input.providerPriceVersion
              ? { providerPriceVersion: resolved.input.providerPriceVersion }
              : {}),
            ...(resolved.kind === "reserve" && resolved.checkedAt
              ? { checkedAt: resolved.checkedAt }
              : {}),
            ...(resolved.kind === "reserve" && resolved.sampleSize !== undefined
              ? { sampleSize: resolved.sampleSize }
              : {}),
            tracking: resolved.kind === "reserve" ? ("metered" as const) : resolved.state,
            budgets: statuses.value,
            asOf: clock.now().toISOString(),
          },
        };
      });
    },
    importBilling: async (access, i) => {
      const invalid = validateBillingImportInput(i);
      if (invalid) return invalid;
      if (
        access.canImportBilling !== true ||
        !access.canReadBillingDetail ||
        !canRead(access, {
          kind: "principal",
          namespace: i.scope.namespace,
          principal: i.scope.principal,
        })
      )
        return { outcome: "forbidden" };
      const owner = await resolveOwnership?.({
        kind: "connection",
        namespace: i.scope.namespace,
        connection: i.scope.connection,
      });
      if (
        !owner ||
        (owner.kind === "principal"
          ? owner.principal !== i.scope.principal
          : owner.group !== i.scope.group) ||
        !canRead(access, owner)
      )
        return { outcome: "forbidden" };
      const connection = await resolveConnection?.({
        namespace: i.scope.namespace,
        connection: i.scope.connection,
      });
      if (resolveConnection && (!connection || connection.provider !== i.provider))
        return { outcome: "forbidden" };
      if (catalog && catalog.operationsOf(i.provider).length === 0) return { outcome: "forbidden" };
      return safely(() => store.importBilling(i));
    },
    billingImports: async (access, q) => {
      const invalid = validateBillingImportsQuery(q);
      if (invalid) return invalid;
      if (
        !access.canReadBillingDetail ||
        !canRead(access, { kind: "principal", ...q.scope }) ||
        !(await canReadBudget(resolveOwnership, access, {
          kind: "connection",
          namespace: q.scope.namespace,
          connection: q.connection,
        }))
      )
        return { outcome: "forbidden" };
      return read(() => store.billingImports(q));
    },
    expireReservations: (i) => command(i, () => store.expireReservations(i)),
    reserve: async (requested) => {
      if (requested.source === "import")
        return {
          outcome: "invalid",
          field: "source",
          reason: "import source is reserved for authorized billing evidence",
        };
      const early =
        validate({ ...requested, estimate: requested.estimate ?? [] }) ??
        sourceValidation(requested) ??
        provenanceValidation(requested);
      if (early) return early;
      return safely(async () => {
        const existing = await store.getOperation({
          namespace: requested.scope.namespace,
          principal: requested.scope.principal,
          operationId: requested.operationId,
        });
        const resolution = await resolveReserve(requested, existing, catalog, resolveConnection);
        if (resolution.kind === "invalid") return resolution.failure;
        if (resolution.kind === "count") {
          const { scope, surface, source, provider, operation, platformPools } = requested;
          const counted = await store.countRequest({
            commandId: requested.operationId,
            scope,
            surface,
            source,
            provider,
            operation,
            state: resolution.state,
            ...(platformPools ? { platformPools } : {}),
          });
          if (counted.outcome === "conflict")
            return {
              outcome: "invalid" as const,
              field: "operationId",
              reason: "reused for a different counted request",
            };
          if (counted.outcome === "invalid") return counted;
          return { outcome: resolution.state, replayed: counted.replayed, operation: null };
        }
        const raw = resolution.input,
          invalid = reserveValidation(raw);
        if (invalid) return invalid;
        // Tags are attribution: sorted here so every adapter stores one canonical order.
        const tags = raw.scope.tags === undefined ? undefined : normalizeTags(raw.scope.tags),
          i = tags ? { ...raw, scope: { ...raw.scope, tags } } : raw;
        if (existing) return store.reserve(i, { budgetOrder: policy.budgetOrder });
        const statuses = await store.applicableBudgets({
          scope: i.scope,
          surface: i.surface,
          source: i.source,
          units: i.estimate.map((q) => q.unit),
          ...(i.platformPools ? { platformPools: i.platformPools } : {}),
        });
        const missing = statuses.find((s) => !i.estimate.some((q) => q.unit === s.budget.unit));
        if (missing)
          return {
            outcome: "invalid" as const,
            reason: "missing_estimate_unit" as const,
            unit: missing.budget.unit,
            operation: null,
          };
        return store.reserve(i, { budgetOrder: policy.budgetOrder });
      });
    },
    markDispatchIntent: (i) => command(i, () => store.markDispatchIntent(i)),
    renewLease: (i) => command(i, () => store.renewLease(i)),
    claimForRecovery: (i) => command(i, () => store.claimForRecovery(i)),
    settle: (i) =>
      i.receipt.source === "import"
        ? Promise.resolve({
            outcome: "invalid" as const,
            field: "receipt.source",
            reason: "import evidence requires the atomic billing import command",
          })
        : command(i, () => store.settle(i)),
    correct: (i) =>
      i.receipt.source === "import"
        ? Promise.resolve({
            outcome: "invalid" as const,
            field: "receipt.source",
            reason: "import evidence requires the atomic billing import command",
          })
        : command(i, () => store.correct(i)),
    releaseUndispatched: (i) => command(i, () => store.releaseUndispatched(i)),
    countRequest: (i) => {
      if (i.source === "import")
        return Promise.resolve({
          outcome: "invalid" as const,
          field: "source",
          reason: "import source is reserved for authorized billing evidence",
        });
      const invalid = validate(i) ?? sourceValidation(i);
      return invalid ? Promise.resolve(invalid) : safely(() => store.countRequest(i));
    },
    requestCounts: async (access, q) => {
      const invalid = requestCountsValidation(q);
      if (invalid) return invalid;
      if (!access.canReadBillingDetail || !canRead(access, q.scope))
        return { outcome: "forbidden" };
      return read(() => store.requestCounts(q));
    },
    getOperation: async (access, i) => {
      const invalid = validate(i);
      if (invalid) return invalid;
      if (
        !access.canReadBillingDetail ||
        !canRead(access, { kind: "principal", namespace: i.namespace, principal: i.principal })
      )
        return { outcome: "forbidden" };
      return read(() => store.getOperation(i));
    },
    usage: async (access, q) => {
      const invalid = usageValidation(q);
      if (invalid) return invalid;
      if (!access.canReadBillingDetail || !canRead(access, q.scope))
        return { outcome: "forbidden" };
      return read(() => store.aggregate(q));
    },
    listOperations: async (access, q) => {
      const invalid = operationsValidation(q);
      if (invalid) return invalid;
      if (!access.canReadBillingDetail || !canRead(access, q.scope))
        return { outcome: "forbidden" };
      return read(() => store.listOperations(q));
    },
    definedBudgets: async (access, q) => {
      const invalid = validate(q);
      if (invalid) return invalid;
      if (!(await canReadBudget(resolveOwnership, access, q.scope)))
        return { outcome: "forbidden" };
      return read(() => store.definedBudgets(q));
    },
    applicableBudgets: async (access, q) => {
      const invalid = validate(q) ?? sourceValidation(q);
      if (invalid) return invalid;
      if (
        !canRead(access, {
          kind: "principal",
          namespace: q.scope.namespace,
          principal: q.scope.principal,
        })
      )
        return { outcome: "forbidden" };
      return safely(async () => {
        const rows = await store.applicableBudgets(q);
        for (const status of rows) {
          if (
            !isShared(status.budget.scope) &&
            !(await canReadBudget(resolveOwnership, access, status.budget.scope))
          )
            return { outcome: "forbidden" as const };
        }
        return {
          outcome: "ok" as const,
          value: rows.map((s) =>
            isShared(s.budget.scope) && !canReadShared(access, s.budget.scope)
              ? {
                  ...s,
                  budget: { ...s.budget, limit: null },
                  used: null,
                  reserved: null,
                  remaining: null,
                  redacted: true as const,
                }
              : s,
          ),
        };
      });
    },
  };
  return meter;
}
