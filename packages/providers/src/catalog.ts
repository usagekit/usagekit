import { compareQuantity, validateDescriptor } from "@usagekit/core";
import type {
  BalanceSnapshot,
  Budget,
  EstimateSource,
  ConnectionPolicy,
  OperationId,
  PriceRow,
  ProviderDescriptor,
  ProviderId,
  ProviderOperation,
  ProviderPlan,
  Quantity,
} from "@usagekit/core";
import type {
  Extractors,
  ProviderModule,
  ProviderRequest,
  ProviderResponse,
  ReceiptDraft,
} from "./types.js";
import { matchOperation } from "./match.js";
import { calculatePrice, selectPriceRow } from "./prices.js";
import { pointer } from "./pointer.js";
import { decimalQuantity, requestsMeasured } from "./receipts.js";
import { proposePlanBudget } from "./budget.js";
import type { BudgetTarget } from "./budget.js";

export type { EstimateSource };

/** Connection data the catalog needs; the catalog itself stays storage-free. */
export type CatalogConnection = Omit<ConnectionPolicy, "tracking"> & {
  id: string;
};
export type CatalogEstimate = {
  /** Always includes one request for a billable operation; empty for a free operation. */
  quantities: Quantity[];
  source: EstimateSource;
  /** "<provider>:<validFrom>" of the list row, when the source is list. */
  priceVersion?: string;
  checkedAt?: string;
  sampleSize?: number;
};
export type CatalogMatch =
  | { operation: ProviderOperation; options: Record<string, string> }
  | { operation: "unknown" };

export type Catalog = ReturnType<typeof createCatalog>;

const oneRequest = (): Quantity => ({ value: 1n, scale: 0, unit: "requests" });
const withRequest = (q: Quantity[]) =>
  q.some((x) => x.unit === "requests") ? q : [...q, oneRequest()];
/** Compare exact quantities at their own scales; never round a reservation down. */
function withFloor(quantities: readonly Quantity[], floor: readonly Quantity[]): Quantity[] {
  const result = [...quantities];
  for (const bound of floor) {
    const index = result.findIndex((q) => q.unit === bound.unit);
    if (index < 0) result.push(bound);
    else if (compareQuantity(result[index]!, bound) < 0) result[index] = bound;
  }
  return result;
}
function isoTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value);
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
}
function amount(value: unknown, unit: string): Quantity | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0)
    return decimalQuantity(String(value).includes("e") ? value.toFixed(18) : String(value), unit);
  if (typeof value === "string" && /^\d+(\.\d+)?$/.test(value)) return decimalQuantity(value, unit);
  return undefined;
}
/** Balance snapshot from the JSON pointers a descriptor declares. Unreadable fields are omitted. */
export function probeByPointers(descriptor: ProviderDescriptor, body: unknown): BalanceSnapshot {
  const f = descriptor.balance?.fields ?? {},
    unit = f.remainingUnit ?? descriptor.billing.unit,
    read = (p?: string) => (p === undefined ? undefined : pointer(body, p)),
    snapshot: BalanceSnapshot = {};
  const remaining = amount(read(f.remaining), unit),
    allowance = amount(read(f.allowance), unit),
    used = amount(read(f.used), unit),
    resetsAt = isoTimestamp(read(f.resetsAt)),
    plan = read(f.plan),
    identity = read(f.accountIdentity),
    rate = read(f.rateLimitPerHour);
  if (remaining) snapshot.remaining = remaining;
  if (allowance) snapshot.allowance = allowance;
  if (used) snapshot.used = used;
  if (resetsAt) snapshot.resetsAt = resetsAt;
  if (typeof plan === "string" && plan) snapshot.plan = plan;
  if (typeof identity === "string" && identity) snapshot.accountIdentity = identity;
  if (typeof rate === "number" && Number.isSafeInteger(rate)) snapshot.rateLimitPerHour = rate;
  return snapshot;
}

/**
 * The set of operations usagekit can price. Hosts pass every descriptor they ship and enable an
 * allowlist; disabled descriptors are not matched and their operations are unpriced.
 */
export function createCatalog({
  providers,
  enabled,
  measuredMinSamples = 5,
  now = () => new Date(),
}: {
  providers: readonly ProviderModule[];
  enabled: readonly ProviderId[];
  measuredMinSamples?: number;
  now?: () => Date;
}) {
  const modules = new Map<ProviderId, ProviderModule>();
  for (const module of providers) {
    const id = module.descriptor.id;
    if (modules.has(id)) throw new Error(`DuplicateProvider: ${id}`);
    const problems = validateDescriptor(module.descriptor);
    if (problems.length)
      throw new Error(`InvalidDescriptor: ${id}: ${problems.map((p) => p.kind).join(", ")}`);
    modules.set(id, module);
  }
  for (const id of enabled) if (!modules.has(id)) throw new Error(`UnknownProvider: ${id}`);
  const active = (id: ProviderId) => (enabled.includes(id) ? modules.get(id) : undefined);
  const require = (id: ProviderId) => {
    const module = active(id);
    if (!module) throw new Error(`ProviderDisabled: ${id}`);
    return module;
  };
  const validPrices = (d: ProviderDescriptor): PriceRow[] => {
    const today = now().toISOString().slice(0, 10);
    return d.prices.filter((r) => r.validFrom.slice(0, 10) <= today);
  };
  return {
    providers: (): ProviderDescriptor[] => [...enabled].map((id) => modules.get(id)!.descriptor),
    match(providerId: ProviderId, request: ProviderRequest): CatalogMatch {
      const module = active(providerId);
      if (!module) return { operation: "unknown" };
      const url = new URL(request.url, module.descriptor.upstream);
      if (module.descriptor.pricingInputs.includes("query")) {
        const keys = new Set<string>();
        for (const key of url.searchParams.keys()) {
          if (keys.has(key)) throw new Error("InvalidInput: duplicate query key");
          keys.add(key);
        }
      } else url.search = "";
      // Pricing sees only declared inputs. Receipts and transport retain the full request.
      const { body, ...rest } = request;
      const pricingRequest: ProviderRequest = {
        ...rest,
        url: url.href,
        ...(module.descriptor.pricingInputs.includes("body") && body !== undefined ? { body } : {}),
      };
      const operation = matchOperation(module.descriptor, pricingRequest);
      if (!operation) return { operation: "unknown" };
      return { operation, options: module.extractors.options(operation, pricingRequest) };
    },
    canEstimate(providerId: ProviderId, options: Readonly<Record<string, string>>): boolean {
      return require(providerId).extractors.canEstimate?.(options) ?? true;
    },
    /** BYOK caller estimates also retain any documented surcharge floor. */
    boundEstimate(
      providerId: ProviderId,
      operationId: OperationId,
      options: Readonly<Record<string, string>>,
      quantities: readonly Quantity[],
    ): Quantity[] {
      const module = require(providerId);
      const operation = module.descriptor.operations.find((o) => o.id === operationId);
      if (!operation || !module.extractors.requiresListPriceFloor?.(options))
        return [...quantities];
      const listed = module.extractors.estimate({
        operation,
        options,
        prices: validPrices(module.descriptor),
      });
      return withFloor(quantities, listed);
    },
    /** Resolution order: request safety, manual, measured with enough samples, list row, unknown. */
    estimate(
      connection: CatalogConnection,
      operationId: OperationId,
      options: Readonly<Record<string, string>>,
    ): CatalogEstimate {
      const module = active(connection.provider),
        operation = module?.descriptor.operations.find((o) => o.id === operationId);
      if (!module || !operation) return { quantities: [oneRequest()], source: "unknown" };
      if (!operation.billable) return { quantities: [], source: "list" };
      // Provider prices estimate BYOK upstream cost only. A host must supply customer prices
      // explicitly for platform funding; neither manual nor list prices price credits.
      if (connection.fundingSource !== "byok")
        return { quantities: [oneRequest()], source: "unknown" };
      if (module.extractors.canEstimate?.(options) === false)
        return { quantities: [oneRequest()], source: "unknown" };
      const input = {
        operation,
        options,
        prices: validPrices(module.descriptor),
        ...(connection.plan !== undefined ? { plan: connection.plan } : {}),
        ...(connection.overage ? { overage: true } : {}),
      };
      const listed = module.extractors.estimate(input),
        row = selectPriceRow(input);
      const manual = connection.manualPrices?.[operationId];
      const measured = manual ? undefined : connection.measured?.(operationId);
      const override =
        manual ??
        (measured &&
        Number.isSafeInteger(measured.samples) &&
        measured.samples >= measuredMinSamples
          ? measured.quantity
          : undefined);
      if (override) {
        const basis = manual ? connection.manualPriceBasis?.[operationId] : measured?.basis;
        if (basis === "item" && (!row || row.calculation?.kind !== "base_plus_items"))
          return {
            quantities: withRequest(listed.filter((q) => q.unit !== override.unit)),
            source: "unknown",
          };
        const quantity = basis === "item" ? calculatePrice(row!, options, override) : override;
        if (!quantity)
          return {
            quantities: withRequest(listed.filter((q) => q.unit !== override.unit)),
            source: "unknown",
          };
        return {
          quantities: withRequest(
            withFloor(
              [
                quantity,
                ...listed.filter((q) => q.unit !== quantity.unit && q.unit !== "requests"),
              ],
              module.extractors.requiresListPriceFloor?.(options) ? listed : [],
            ),
          ),
          source: manual ? "manual" : "measured",
          ...(basis === "item" && row
            ? { priceVersion: `${module.descriptor.id}:${row.validFrom}`, checkedAt: row.checkedAt }
            : {}),
          ...(!manual && measured
            ? {
                sampleSize: measured.samples,
                ...(measured.checkedAt ? { checkedAt: measured.checkedAt } : {}),
              }
            : {}),
        };
      }
      if (!listed.length) return { quantities: [oneRequest()], source: "unknown" };
      return {
        quantities: withRequest(listed),
        source: "list",
        ...(row
          ? { priceVersion: `${module.descriptor.id}:${row.validFrom}`, checkedAt: row.checkedAt }
          : {}),
      };
    },
    extract(
      providerId: ProviderId,
      operationId: OperationId | "unknown",
      request: ProviderRequest,
      response: ProviderResponse,
      body: unknown,
    ): ReceiptDraft {
      const module = require(providerId),
        operation = module.descriptor.operations.find((o) => o.id === operationId);
      if (!operation)
        return {
          measurements: [requestsMeasured()],
          cost: { certainty: "unknown", money: null },
          cached: false,
          failed: response.status >= 400,
        };
      return module.extractors.extract(operation, request, response, body);
    },
    /** Price list and billing export parsers of an enabled descriptor, when it has them. */
    parsers(providerId: ProviderId): Pick<Extractors, "priceList" | "billingExport"> {
      const { priceList, billingExport } = require(providerId).extractors;
      return { ...(priceList ? { priceList } : {}), ...(billingExport ? { billingExport } : {}) };
    },
    requestId: (providerId: ProviderId, body: unknown) =>
      require(providerId).extractors.requestId(body),
    probe(providerId: ProviderId, body: unknown): BalanceSnapshot {
      const { descriptor, extractors } = require(providerId);
      if (!descriptor.balance) throw new Error(`NoBalanceProbe: ${providerId}`);
      return extractors.balance ? extractors.balance(body) : probeByPointers(descriptor, body);
    },
    operationsOf: (providerId: ProviderId): ProviderOperation[] => [
      ...(active(providerId)?.descriptor.operations ?? []),
    ],
    plansOf: (providerId: ProviderId): ProviderPlan[] => [
      ...(active(providerId)?.descriptor.plans ?? []),
    ],
    /** Connection-scope budget proposed on connect; see proposePlanBudget. */
    proposeBudget(providerId: ProviderId, planId: string, target: BudgetTarget): Budget {
      const plan = require(providerId).descriptor.plans.find((p) => p.id === planId);
      if (!plan) throw new Error(`UnknownPlan: ${planId}`);
      return proposePlanBudget(plan, target);
    },
  };
}
