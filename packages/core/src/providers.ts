import type {
  EstimateSource,
  FundingSource,
  Money,
  Quantity,
  ValidationFailure,
} from "./contracts.js";

/**
 * Provider descriptors: data that tells usagekit how to price, route, meter and reconcile one
 * provider. Descriptors live in `@usagekit/providers`; the core contract does not depend on
 * them. See docs/PROVIDERS.md.
 */
export type ProviderId = string;
/**
 * Operation identity is the pricing key. Manual overrides, tracking policy and budgets per
 * operation all key on OperationId, never on a raw path.
 */
export type OperationId = string;

export type ProviderAuth =
  | { kind: "query"; param: string }
  | { kind: "header"; name: string; prefix?: string }
  | { kind: "basic" }
  | { kind: "bearer" };

export type BillingUnit = "cents" | "units" | "requests";

/**
 * allowanceMode mirrors how the provider behaves past the allowance: prepaid balances and
 * no-overage plans are hard, plans that bill excess are soft.
 */
export type ProviderPlan = {
  id: string;
  label: string;
  cycle: "monthly_plan" | "prepaid" | "trial" | "none";
  allowance?: { unit: BillingUnit; value: bigint };
  allowanceMode: "hard" | "soft";
  /** Provider subscription data; never a per-receipt debit. */
  subscription?: { period: "month"; fee: Money; source: string; checkedAt: string };
};

/**
 * Overrides default to a whole-call price; item overrides replace a formula coefficient.
 */
export type PriceBasis = "call" | "item";
export type PriceCalculation =
  | {
      kind: "option_multiplier";
      multiplierOption: { key: string; value: string; factor: string };
    }
  | {
      kind: "additional_pages";
      depthOption: string;
      pageSize: number;
      additionalPageFactor: string;
    }
  | {
      kind: "base_plus_items";
      itemCountOption: string;
      perItem: string;
      multiplierOption?: { key: string; value: string; factor: string };
    };

/** One public list price, with optional request calculation metadata. */
export type PriceRow = {
  /** ISO date. */
  validFrom: string;
  operation: OperationId;
  /** Plan id; absent means any plan. */
  plan?: string;
  /** Request options that select this row. Options are request data, never guessed. */
  option?: Readonly<Record<string, string>>;
  /** Applies past the plan allowance. */
  overage?: true;
  unit: BillingUnit;
  /** Exact nonnegative decimal in that unit. */
  perUnit: string;
  calculation?: PriceCalculation;
  /** URL of the public price source. */
  source: string;
  /** ISO date of the last check against the source. */
  checkedAt: string;
};

export type RequestMatch = {
  method: "GET" | "POST" | "PUT" | "DELETE" | "ANY";
  /** Path pattern with :params (one segment) and a trailing * (any rest). */
  path: string;
  query?: Readonly<Record<string, string | RegExp>>;
};

/**
 * Free endpoints are operations too, with billable false. They are matched, counted and never
 * reserved. A descriptor may advertise an operation only when at least one fixture exists for it.
 */
export type ProviderOperation = {
  id: OperationId;
  label: string;
  billable: boolean;
  match: readonly RequestMatch[];
  /** Options that move the price; values are extracted from the request by `options`. */
  optionKeys?: readonly string[];
  /** Exhaustive documented request fields; unclassified fields cannot be safely priced. */
  requestPricing?: {
    source: string;
    formula: string;
    priceFields: Readonly<
      Record<
        string,
        {
          formula: string;
          /** A supplied opaque value can prevent any defensible upper bound. */
          unpricedWhen?: "present" | "true";
          /** Documented item count when this field is omitted. */
          defaultCount?: number;
        }
      >
    >;
    neutralFields: readonly string[];
  };
  /**
   * Cost is known from the response body, only after a later call, or never per call.
   * response: settle on stream close. deferred: settle with unknown cost, keep pending, resolve
   * through the task-get operation or billing export. none: settle with the estimate as
   * estimated, reconcile from balance deltas or export.
   */
  costEvidence: "response" | "deferred" | "none";
  /** Idempotent replay is safe for this operation when the provider returns the same result. */
  cacheable?: { keyParams: readonly string[]; defaultTtlMs: number };
};

/** Account identity is returned to the host as data. Duplicate detection is a host decision. */
export type BalanceProbe = {
  /** The free account endpoint. */
  operation: OperationId;
  fields: {
    /** JSON pointer. */
    remaining?: string;
    remainingUnit?: BillingUnit;
    allowance?: string;
    used?: string;
    resetsAt?: string;
    plan?: string;
    /** E-mail or login, for duplicate detection. */
    accountIdentity?: string;
    rateLimitPerHour?: string;
  };
};

/**
 * A price list from an endpoint is a refresh source for prices, not a replacement: a pull
 * request updates the rows with the fetched values and the check date; runtime never fetches
 * prices to decide admission.
 */
export type PriceListSource =
  | { kind: "static" }
  | { kind: "endpoint"; operation: OperationId; pointer: string; mapping: "provider-specific" };

export type BillingExport = {
  kind: "task-history" | "daily-csv" | "none";
  /** For API-backed history. */
  operation?: OperationId;
  granularity: "per-request" | "per-day";
  matchKey: "providerRequestId" | "window";
};

export type ProviderDescriptor = {
  id: ProviderId;
  label: string;
  /** Origin and optional base path, for example "https://api.example.com". */
  upstream: string;
  auth: ProviderAuth;
  /** Pricing and matching see body/query only when declared; method and URL path are always available. */
  pricingInputs: readonly ("body" | "query")[];
  stripRequestHeaders?: readonly string[];
  billing: { unit: BillingUnit; cycle: ProviderPlan["cycle"] };
  plans: readonly ProviderPlan[];
  prices: readonly PriceRow[];
  priceList: PriceListSource;
  operations: readonly ProviderOperation[];
  balance?: BalanceProbe;
  billingExport: BillingExport;
  rateLimits?: readonly { scope: "account"; perMinute?: number; perHour?: number }[];
  docs: { pricing: string; api: string };
};

/** Parsed balance probe. Every field is optional because providers report different subsets. */
export type BalanceSnapshot = {
  remaining?: Quantity;
  allowance?: Quantity;
  used?: Quantity;
  /** UTC ISO timestamp of the next allowance reset. */
  resetsAt?: string;
  plan?: string;
  accountIdentity?: string;
  rateLimitPerHour?: number;
};

/** One matchable line of a provider billing export. */
export type BillingLine = {
  providerRequestId?: string;
  operation?: OperationId;
  occurredAt: string;
  cost: Money;
  /** Window of a per-day line, [from, to). */
  window?: { from: string; to: string };
};

/** Per-operation tracking; passthrough opts BYOK out of spend enforcement only. */
export type TrackingPolicy = "metered" | "passthrough";

/** Median of a connection's settled receipts for one operation, with its sample size. */
export type MeasuredPrice = (
  operation: OperationId,
) => { quantity: Quantity; samples: number; basis?: PriceBasis; checkedAt?: string } | undefined;

/**
 * Connection data a host resolves for the Meter: provider, selected plan, BYOK manual prices,
 * measured prices and tracking policy, all keyed by OperationId. overage is true when the host
 * knows the plan allowance is exhausted.
 */
export type ConnectionPolicy = {
  provider: ProviderId;
  /** Actual connection funding, derived by the host from trusted server state. */
  fundingSource: FundingSource;
  plan?: string;
  /** BYOK only: estimates the user's own provider cost, including genuine zero. */
  manualPrices?: Readonly<Record<OperationId, Quantity>>;
  manualPriceBasis?: Readonly<Record<OperationId, PriceBasis>>;
  measured?: MeasuredPrice;
  tracking?: Readonly<Record<OperationId, TrackingPolicy>>;
  overage?: boolean;
};

/** Validate raw connection settings before saving. Manual prices are BYOK-only. */
export function validateConnectionPolicy(
  policy: {
    fundingSource: FundingSource;
    tracking?: unknown;
    manualPrices?: unknown;
    manualPriceBasis?: unknown;
  },
  operations: readonly Pick<ProviderOperation, "id" | "billable">[],
): ValidationFailure | null {
  const invalid = (field: string, reason: string): ValidationFailure => ({
    outcome: "invalid",
    field,
    reason,
  });
  if (policy.fundingSource === "platform") {
    for (const field of ["manualPrices", "manualPriceBasis"] as const) {
      const value = policy[field];
      const absent =
        value == null ||
        (typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0);
      if (!absent) return invalid(field, "manual provider prices are BYOK-only");
    }
  }
  const { tracking } = policy;
  if (tracking === undefined) return null;
  if (!tracking || typeof tracking !== "object" || Array.isArray(tracking))
    return invalid("tracking", "must be an operation-to-tracking map");
  for (const [id, mode] of Object.entries(tracking)) {
    const operation = operations.find((entry) => entry.id === id);
    if (
      policy.fundingSource === "platform" &&
      operation?.billable !== false &&
      (mode === "passthrough" || mode === "unpriced")
    )
      return invalid(
        `tracking.${id}`,
        "billable platform operations must be metered; credits charges cannot be opted out",
      );
    if (!operation) return invalid(`tracking.${id}`, "unknown operation");
    if (mode !== "metered" && mode !== "passthrough")
      return invalid(`tracking.${id}`, "must be metered or passthrough");
  }
  return null;
}

/**
 * What the Meter needs from a provider catalog. `@usagekit/providers` createCatalog satisfies
 * it; the Meter does not depend on that package. operationsOf lists the operations of an
 * enabled provider and nothing for a disabled or unknown one.
 */
export type PricingCatalog = {
  estimate(
    connection: Omit<ConnectionPolicy, "tracking"> & { id: string },
    operation: OperationId,
    options: Readonly<Record<string, string>>,
  ): {
    quantities: Quantity[];
    source: EstimateSource;
    priceVersion?: string;
    checkedAt?: string;
    sampleSize?: number;
  };
  operationsOf(providerId: ProviderId): readonly ProviderOperation[];
};

export type DescriptorProblem =
  | { kind: "invalid_pricing_inputs" }
  | { kind: "undeclared_query_input"; operation: OperationId }
  | { kind: "duplicate_operation"; operation: OperationId }
  | { kind: "duplicate_plan"; plan: string }
  | { kind: "missing_match"; operation: OperationId }
  | { kind: "unknown_price_operation"; row: number; operation: OperationId }
  | { kind: "unknown_price_plan"; row: number; plan: string }
  | { kind: "unknown_price_option"; row: number; option: string }
  | {
      kind: "invalid_price";
      row: number;
      field: "perUnit" | "validFrom" | "checkedAt" | "source";
    }
  | { kind: "invalid_calculation"; row: number; field: string }
  | { kind: "invalid_subscription"; plan: string; field: string }
  | { kind: "unknown_probe_operation"; operation: OperationId }
  | { kind: "billable_probe"; operation: OperationId }
  | { kind: "unknown_price_list_operation"; operation: OperationId }
  | { kind: "unknown_export_operation"; operation: OperationId };

const isoDate = (text: string) =>
  /^\d{4}-\d{2}-\d{2}/.test(text) && Number.isFinite(Date.parse(text));

/**
 * Structural problems of a descriptor, in a stable order: operations, plans, prices, probe,
 * price list, billing export. An empty list means the catalog may load it.
 */
export function validateDescriptor(d: ProviderDescriptor): DescriptorProblem[] {
  const problems: DescriptorProblem[] = [];
  if (
    !Array.isArray(d.pricingInputs) ||
    d.pricingInputs.some((part) => part !== "body" && part !== "query") ||
    new Set(d.pricingInputs).size !== d.pricingInputs.length
  )
    problems.push({ kind: "invalid_pricing_inputs" });
  const operations = new Map<string, ProviderOperation>();
  for (const op of d.operations) {
    if (
      !(Array.isArray(d.pricingInputs) && d.pricingInputs.includes("query")) &&
      op.match.some((rule) => Object.keys(rule.query ?? {}).length > 0)
    )
      problems.push({ kind: "undeclared_query_input", operation: op.id });
    if (operations.has(op.id)) problems.push({ kind: "duplicate_operation", operation: op.id });
    else operations.set(op.id, op);
  }
  for (const op of d.operations)
    if (op.match.length === 0 && operations.get(op.id) === op)
      problems.push({ kind: "missing_match", operation: op.id });
  const plans = new Set<string>();
  for (const plan of d.plans) {
    if (plans.has(plan.id)) problems.push({ kind: "duplicate_plan", plan: plan.id });
    plans.add(plan.id);
    const fee = plan.subscription;
    if (fee) {
      for (const [field, valid] of Object.entries({
        period: fee.period === "month",
        fee: fee.fee.currency === "USD" && typeof fee.fee.units === "bigint" && fee.fee.units >= 0n,
        source: Boolean(fee.source.trim()),
        checkedAt: isoDate(fee.checkedAt),
      }))
        if (!valid) problems.push({ kind: "invalid_subscription", plan: plan.id, field });
    }
  }
  d.prices.forEach((row, index) => {
    const op = operations.get(row.operation);
    if (!op)
      problems.push({ kind: "unknown_price_operation", row: index, operation: row.operation });
    if (row.plan !== undefined && !plans.has(row.plan))
      problems.push({ kind: "unknown_price_plan", row: index, plan: row.plan });
    for (const key of Object.keys(row.option ?? {}))
      if (op && !(op.optionKeys ?? []).includes(key))
        problems.push({ kind: "unknown_price_option", row: index, option: key });
    if (!/^\d+(\.\d{1,18})?$/.test(row.perUnit))
      problems.push({ kind: "invalid_price", row: index, field: "perUnit" });
    const c = row.calculation;
    if (c) {
      const decimal = (x: string) => /^\d+(\.\d{1,18})?$/.test(x);
      const option = (key: string) => {
        if (op && !(op.optionKeys ?? []).includes(key))
          problems.push({ kind: "unknown_price_option", row: index, option: key });
      };
      if (c.kind === "additional_pages") {
        option(c.depthOption);
        if (!Number.isSafeInteger(c.pageSize) || c.pageSize < 1)
          problems.push({ kind: "invalid_calculation", row: index, field: "pageSize" });
        if (!decimal(c.additionalPageFactor))
          problems.push({ kind: "invalid_calculation", row: index, field: "additionalPageFactor" });
      } else if (c.kind === "base_plus_items") {
        option(c.itemCountOption);
        if (!decimal(c.perItem))
          problems.push({ kind: "invalid_calculation", row: index, field: "perItem" });
      } else if (c.kind !== "option_multiplier")
        problems.push({ kind: "invalid_calculation", row: index, field: "kind" });
      if (c.kind === "option_multiplier" && !c.multiplierOption)
        problems.push({ kind: "invalid_calculation", row: index, field: "multiplierOption" });
      if ((c.kind === "base_plus_items" || c.kind === "option_multiplier") && c.multiplierOption) {
        option(c.multiplierOption.key);
        if (!c.multiplierOption.value.trim() || !decimal(c.multiplierOption.factor))
          problems.push({ kind: "invalid_calculation", row: index, field: "multiplierOption" });
      }
    }
    if (!isoDate(row.validFrom))
      problems.push({ kind: "invalid_price", row: index, field: "validFrom" });
    if (!isoDate(row.checkedAt))
      problems.push({ kind: "invalid_price", row: index, field: "checkedAt" });
    if (!row.source.trim()) problems.push({ kind: "invalid_price", row: index, field: "source" });
  });
  if (d.balance) {
    const probe = operations.get(d.balance.operation);
    if (!probe) problems.push({ kind: "unknown_probe_operation", operation: d.balance.operation });
    else if (probe.billable) problems.push({ kind: "billable_probe", operation: probe.id });
  }
  if (d.priceList.kind === "endpoint" && !operations.has(d.priceList.operation))
    problems.push({ kind: "unknown_price_list_operation", operation: d.priceList.operation });
  if (d.billingExport.operation !== undefined && !operations.has(d.billingExport.operation))
    problems.push({ kind: "unknown_export_operation", operation: d.billingExport.operation });
  return problems;
}
