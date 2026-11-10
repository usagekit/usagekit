import type { Meter, ReserveInput } from "@usagekit/core";

export type RequestMeteredFetchOptions = {
  meter: Meter;
  /** Server-trusted attribution only. Never include provider secrets or request content. */
  operation: Omit<ReserveInput, "operationId" | "estimate">;
  /** A new durable identity for each intended transport attempt; never a correlation ID. */
  createOperationId: () => string;
  fetch: typeof globalThis.fetch;
  now?: () => Date;
  holder?: string;
  leaseTtlMs?: number;
};
export class RequestMeteringError extends Error {
  constructor(
    public readonly code:
      | "admission_denied"
      | "dispatch_denied"
      | "accounting_failed"
      | "transport_failed",
  ) {
    super(code);
    this.name = "RequestMeteringError";
  }
}

/** Meters dispatched requests, not tokens or money. Does not read or buffer response bodies.
 * The injected Meter owns budget scope and durability; this wrapper creates no Store.
 * Host-owned fetch must enforce endpoint, credential, redirect and retry policies. */
export function createRequestMeteredFetch(options: RequestMeteredFetchOptions): typeof fetch {
  const { meter, now = () => new Date(), holder = "request-fetch", leaseTtlMs = 60_000 } = options;
  return async (input, init) => {
    const signal =
      init && "signal" in init ? init.signal : input instanceof Request ? input.signal : undefined;
    const aborted = () => new DOMException("Request aborted", "AbortError");
    if (signal?.aborted) throw aborted();
    const operationId = options.createOperationId();
    const operation = { ...options.operation, scope: { ...options.operation.scope } };
    const ref = {
      namespace: operation.scope.namespace,
      principal: operation.scope.principal,
      operationId,
    };
    let reserved;
    try {
      reserved = await meter.reserve({
        ...operation,
        operationId,
        estimate: [{ unit: "requests", value: 1n, scale: 0 }],
      });
    } catch {
      throw new RequestMeteringError("admission_denied");
    }
    if (reserved.outcome !== "reserved" || reserved.replayed)
      throw new RequestMeteringError("admission_denied");
    if (signal?.aborted) {
      try {
        await meter.releaseUndispatched({
          ...ref,
          commandId: `${operationId}:release`,
          expectedVersion: reserved.operation.version,
          reason: "aborted_before_dispatch",
        });
      } catch {
        // No transport occurred; retain the reservation if accounting is unavailable.
      }
      throw aborted();
    }
    let grant;
    try {
      grant = await meter.markDispatchIntent({
        ...ref,
        commandId: `${operationId}:intent`,
        expectedVersion: reserved.operation.version,
        holder,
        leaseTtlMs,
      });
    } catch {
      throw new RequestMeteringError("dispatch_denied");
    }
    if (!("granted" in grant) || !grant.granted) throw new RequestMeteringError("dispatch_denied");
    const occurredAt = now().toISOString();
    let response: Response | undefined;
    let dispatched = false;
    try {
      if (signal?.aborted) throw aborted();
      dispatched = true;
      response = await options.fetch(input, init);
    } catch {
      // Settle intended exposure below, without exposing transport errors or credentials.
    }
    try {
      const result = await meter.settle({
        ...ref,
        commandId: `${operationId}:settle`,
        expectedVersion: grant.operation.version,
        authority: { kind: "lease", leaseId: grant.lease.leaseId },
        receipt: {
          id: `${operationId}:receipt`,
          occurredAt,
          recordedAt: now().toISOString(),
          measurements: [
            dispatched
              ? {
                  unit: "requests",
                  quantity: { unit: "requests", value: 1n, scale: 0 },
                  certainty: "measured",
                }
              : { unit: "requests", quantity: null, certainty: "unknown" },
          ],
          cost: { certainty: "unknown", money: null },
          cached: false,
          failed: !response?.ok,
        },
      });
      if (result.outcome !== "settled") throw new Error("accounting_failed");
    } catch {
      try {
        void response?.body?.cancel().catch(() => {});
      } catch {
        // Keep the accounting failure sanitized even when cancellation fails.
      }
      throw new RequestMeteringError("accounting_failed");
    }
    if (!response) {
      if (signal?.aborted) throw aborted();
      throw new RequestMeteringError("transport_failed");
    }
    return response;
  };
}
