import type {
  ConnectionPolicy,
  MeterReserveInput,
  MeterQuoteInput,
  Operation,
  PricingCatalog,
  ReserveInput,
  ValidationFailure,
} from "@usagekit/core";

/** Host lookup of actual funding and pricing policy within the requested namespace. */
export type ConnectionResolver = (scope: {
  namespace: string;
  connection: string;
}) => Promise<ConnectionPolicy | undefined> | ConnectionPolicy | undefined;
type EstimateResolution =
  | {
      kind: "reserve";
      input: Omit<
        ReserveInput,
        "operationId" | "reservationTtlMs" | "correlationId" | "parentOperationId"
      >;
      checkedAt?: string;
      sampleSize?: number;
    }
  | { kind: "count"; state: "passthrough" | "unpriced" }
  | { kind: "invalid"; failure: ValidationFailure };
export type ReserveResolution =
  | Exclude<EstimateResolution, { kind: "reserve" }>
  | { kind: "reserve"; input: ReserveInput };
const invalid = (
  field: string,
  reason: string,
): Extract<EstimateResolution, { kind: "invalid" }> => ({
  kind: "invalid",
  failure: { outcome: "invalid", field, reason },
});
const provenanceOf = (
  estimateSource?: MeterReserveInput["estimateSource"],
  providerPriceVersion?: string,
) => ({
  ...(estimateSource ? { estimateSource } : {}),
  ...(providerPriceVersion ? { providerPriceVersion } : {}),
});

export function validateConnectionFunding(
  policy: ConnectionPolicy,
  fundingSource: ConnectionPolicy["fundingSource"],
  field = "fundingSource",
): ValidationFailure | null {
  if (policy.fundingSource !== "byok" && policy.fundingSource !== "platform")
    return {
      outcome: "invalid",
      field: "fundingSource",
      reason: "missing from the resolved connection policy",
    };
  if (policy.fundingSource !== fundingSource)
    return { outcome: "invalid", field, reason: "differs from the connection funding source" };
  return null;
}

/** Shared estimate resolution. No Store reads, writes, expiry maintenance or provider calls. */
export async function resolveEstimate(
  requested: MeterQuoteInput,
  catalog?: PricingCatalog,
  resolveConnection?: ConnectionResolver,
): Promise<EstimateResolution> {
  const { options = {}, estimate, estimateSource, providerPriceVersion, ...rest } = requested;
  const policy = await resolveConnection?.({
    namespace: rest.scope.namespace,
    connection: rest.scope.connection,
  });
  if (resolveConnection && !policy) return invalid("estimate", "unknown connection");
  if (policy && policy.provider !== rest.provider)
    return invalid("provider", "differs from the connection provider");
  if (policy) {
    const failure = validateConnectionFunding(policy, rest.fundingSource);
    if (failure) return { kind: "invalid", failure };
  }
  if (policy && catalog) {
    const known = catalog.operationsOf(policy.provider).find((o) => o.id === rest.operation);
    if (known?.billable === false) return { kind: "count", state: "passthrough" };
    // Only catalog-declared nonbillable operations can omit platform customer pricing.
    // Platform calls with a host estimate always reserve; only BYOK can opt out via tracking.
    if (rest.fundingSource === "platform" && estimate === undefined)
      return invalid("estimate", "required from host customer-price policy for platform funding");
    if (rest.fundingSource === "byok" && policy.tracking?.[rest.operation] === "passthrough")
      return { kind: "count", state: "passthrough" };
    if (estimate === undefined) {
      if (!known) return { kind: "count", state: "unpriced" };
      const { tracking: _, ...connection } = policy;
      try {
        const resolved = catalog.estimate(
          { ...connection, id: rest.scope.connection, fundingSource: rest.fundingSource },
          rest.operation,
          options,
        );
        return {
          kind: "reserve",
          input: {
            ...rest,
            estimate: resolved.quantities,
            estimateSource: resolved.source,
            ...(resolved.priceVersion ? { providerPriceVersion: resolved.priceVersion } : {}),
          },
          ...(resolved.checkedAt ? { checkedAt: resolved.checkedAt } : {}),
          ...(resolved.sampleSize !== undefined ? { sampleSize: resolved.sampleSize } : {}),
        };
      } catch (error) {
        if (error instanceof Error && /^(InvalidInput|InvalidDecimal):/.test(error.message))
          return invalid("options", error.message);
        throw error;
      }
    }
  }
  if (estimate === undefined) {
    return invalid(
      "estimate",
      catalog && resolveConnection ? "unknown connection" : "required without a catalog",
    );
  }
  if (rest.fundingSource === "platform") {
    if (!estimate.some((quantity) => quantity.unit !== "requests"))
      return invalid("estimate", "platform funding requires a host customer price");
    if (estimateSource === "manual" || estimateSource === "list" || estimateSource === "measured")
      return invalid("estimateSource", "provider prices are BYOK-only");
  }
  return {
    kind: "reserve",
    input: {
      ...rest,
      estimate,
      ...provenanceOf(estimateSource, providerPriceVersion),
    },
  };
}

/** Replay retains the frozen estimate and provenance, even after funding or policy changes. */
export async function resolveReserve(
  requested: MeterReserveInput,
  existing: Operation | null,
  catalog?: PricingCatalog,
  resolveConnection?: ConnectionResolver,
): Promise<ReserveResolution> {
  const { options: _, estimate, estimateSource, providerPriceVersion, ...rest } = requested;
  if (existing)
    return {
      kind: "reserve",
      input: {
        ...rest,
        estimate: estimate ?? existing.estimate,
        ...(estimate === undefined
          ? provenanceOf(existing.estimateSource, existing.providerPriceVersion)
          : provenanceOf(estimateSource, providerPriceVersion)),
      },
    };
  const { operationId, reservationTtlMs, correlationId, parentOperationId, ...quote } = requested;
  const resolved = await resolveEstimate(quote, catalog, resolveConnection);
  if (resolved.kind !== "reserve") return resolved;
  return {
    ...resolved,
    input: {
      ...resolved.input,
      operationId,
      ...(reservationTtlMs !== undefined ? { reservationTtlMs: reservationTtlMs } : {}),
      ...(correlationId !== undefined ? { correlationId: correlationId } : {}),
      ...(parentOperationId !== undefined ? { parentOperationId: parentOperationId } : {}),
    },
  };
}
