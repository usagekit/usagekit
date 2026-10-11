import type { AccessContext, Meter, Operation, Receipt, Scope } from "@usagekit/core";
import type { Catalog, ProviderRequest, ReceiptDraft } from "@usagekit/providers";
import {
  PricedRequest,
  RequestPricingError,
  dispatchPricedRequest,
  applyProviderCredentials,
} from "@usagekit/providers";
export { isJsonMediaType } from "@usagekit/providers";

export type ProxyConnection = { provider: string; secret: string; tags?: readonly string[] };
export type ProxyOptions = {
  meter: Meter;
  catalog: Catalog;
  /** Must verify the local server token before looking up credentials or reserving. */
  authenticate(request: Request): Promise<AccessContext | null>;
  connection(id: string): ProxyConnection | undefined;
  /** Trusted local owner, never derived from caller-controlled headers. */
  owner: Pick<Scope, "namespace" | "principal">;
  strict?: boolean;
  transport?: typeof fetch;
  now?: () => Date;
  /** Only called for an explicit X-Usagekit-Record-Fixture: true request after stream EOF. */
  recordFixture?(input: {
    provider: string;
    connectionId: string;
    operation: string;
    operationId: string;
    request: ProviderRequest;
    status: number;
    body: unknown;
    secrets: readonly string[];
  }): Promise<void>;
};
const limit = 2 * 1024 * 1024;
const leaseTtlMs = 60000;
const unknownReceipt = (failed: boolean): ReceiptDraft => ({
  measurements: [
    {
      unit: "requests",
      quantity: { unit: "requests", value: 1n, scale: 0 },
      certainty: "measured",
    },
  ],
  cost: { certainty: "unknown", money: null },
  cached: false,
  failed,
});
const error = (
  status: number,
  code: string,
  operationId?: string,
  extra: Record<string, string> = {},
) =>
  Response.json(
    { error: code, ...(operationId ? { operationId } : {}) },
    { status, headers: { "Cache-Control": "no-store", ...extra } },
  );
async function requestBody(request: Request): Promise<Uint8Array<ArrayBuffer> | undefined> {
  if (!request.body) return undefined;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error("RequestTooLarge");
      chunks.push(value);
    }
    return Uint8Array.from(Buffer.concat(chunks));
  } finally {
    await reader.cancel().catch(() => {});
  }
}
/** Authenticated, origin-pinned proxy. The client supplies /proxy/<connection>/<upstream-path>.
 * Bodies are never persisted. A replay reports 409 and never repeats upstream work. */
export function createProviderProxy({
  meter,
  catalog,
  authenticate,
  connection,
  owner,
  strict = false,
  transport = fetch,
  now = () => new Date(),
  recordFixture,
}: ProxyOptions) {
  return async (request: Request): Promise<Response> => {
    if (!(await authenticate(request))) return error(401, "unauthorized");
    const url = new URL(request.url),
      route = /^\/proxy\/([^/]+)(\/.*)?$/.exec(url.pathname);
    if (!route) return error(404, "proxy_route_not_found");
    let id: string;
    try {
      id = decodeURIComponent(route[1]!);
    } catch {
      return error(400, "invalid_connection");
    }
    const suppliedId = request.headers.get("Idempotency-Key");
    if (suppliedId !== null && !/^[A-Za-z0-9._:-]{1,128}$/.test(suppliedId))
      return error(400, "invalid_idempotency_key");
    const operationId = suppliedId ?? crypto.randomUUID();
    const recording = request.headers.get("X-Usagekit-Record-Fixture");
    if (recording !== null && recording !== "true") return error(400, "invalid_fixture_recording");
    if (recording && !recordFixture) return error(503, "fixture_recorder_unavailable");
    if (!["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].includes(request.method))
      return error(405, "method_not_allowed");
    let conn: ProxyConnection | undefined;
    try {
      const entry = connection(id);
      if (entry) {
        // A host may rotate a shared connection object while this request is awaiting I/O.
        const { provider, secret, tags } = entry;
        conn = { provider, secret, ...(tags === undefined ? {} : { tags: [...tags] }) };
      }
    } catch {
      return error(423, "vault_locked");
    }
    if (!conn) return error(404, "connection_not_found");
    const descriptor = catalog.providers().find((p) => p.id === conn.provider);
    if (!descriptor) return error(403, "provider_disabled");
    try {
      applyProviderCredentials(descriptor.auth, new URL(descriptor.upstream), new Headers(), {
        secret: conn.secret,
      });
    } catch {
      return error(400, "invalid_provider_credentials");
    }
    const upstream = new URL(descriptor.upstream);
    // Set pathname rather than resolving caller text: //host, encoded slashes and backslashes
    // cannot change the descriptor's origin. No provider redirect is followed.
    upstream.pathname = route[2] ?? "/";
    upstream.search = url.search;
    const base = new URL(descriptor.upstream).pathname.replace(/\/$/, "");
    if (
      upstream.protocol !== "https:" ||
      (base && upstream.pathname !== base && !upstream.pathname.startsWith(base + "/"))
    )
      return error(400, "invalid_upstream_path");
    let body: Uint8Array<ArrayBuffer> | undefined;
    try {
      body = await requestBody(request);
    } catch {
      return error(413, "request_too_large");
    }
    const scope = { ...owner, connection: id, ...(conn.tags ? { tags: conn.tags } : {}) };
    const headers = new Headers();
    for (const name of ["accept", "content-type"]) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }
    let priced: PricedRequest;
    try {
      priced = await PricedRequest.price({
        meter,
        catalog,
        rejectUnknown: strict,
        allowUnknownDispatch: !strict,
        request: {
          method: request.method,
          url: upstream.href,
          headers: Object.fromEntries(headers),
          ...(body === undefined ? {} : { body }),
        },
        input: {
          operationId,
          scope,
          provider: conn.provider,
          fundingSource: "byok",
          costOwner: owner.principal,
          surface: "programmatic",
          source: "proxy",
        },
      });
    } catch (failure) {
      if (!(failure instanceof RequestPricingError)) throw failure;
      if (failure.code === "unknown_operation") {
        await meter.countRequest({
          commandId: `proxy-strict:${operationId}`,
          scope,
          provider: conn.provider,
          operation: "unknown",
          surface: "programmatic",
          source: "proxy",
          state: "unpriced",
        });
        return error(404, "unknown_operation", operationId);
      }
      return error(400, failure.code);
    }
    const reserved = priced.admission;
    const op = priced.matched.operation === "unknown" ? "unknown" : priced.matched.operation.id;
    const providerRequest = priced.parsed;
    if (reserved.outcome === "exceeded") {
      const reset = reserved.exceeded.resetsAt;
      return error(
        429,
        "allowance_exceeded",
        operationId,
        reset
          ? {
              "Retry-After": String(
                Math.max(1, Math.ceil((Date.parse(reset) - now().getTime()) / 1000)),
              ),
            }
          : { "Retry-After": "60" },
      );
    }
    if (reserved.outcome === "invalid")
      return "field" in reserved && reserved.field === "operationId"
        ? error(409, "idempotency_replay_or_conflict", operationId)
        : error(422, "cannot_estimate_bounded_usage", operationId);
    if (reserved.outcome === "conflict" || ("replayed" in reserved && reserved.replayed))
      return error(409, "idempotency_replay_or_conflict", operationId);
    let grant: { operation: Operation; leaseId: string } | undefined;
    const ref = { ...owner, operationId };
    if (reserved.outcome === "reserved") {
      const intent = await meter.markDispatchIntent({
        ...ref,
        commandId: `${operationId}:proxy-intent`,
        expectedVersion: reserved.operation.version,
        holder: "local-proxy",
        leaseTtlMs,
      });
      if (!("granted" in intent) || !intent.granted)
        return error(409, "dispatch_not_granted", operationId);
      grant = { operation: intent.operation, leaseId: intent.lease.leaseId };
    } else if (reserved.outcome !== "passthrough")
      return error(409, "dispatch_not_granted", operationId);
    const occurredAt = now().toISOString();
    let completion: Promise<void> | undefined;
    const settle = (receipt: ReceiptDraft) =>
      (completion ??= (async () => {
        if (!grant) return;
        const result = await meter.settle({
          ...ref,
          commandId: `${operationId}:proxy-settle`,
          expectedVersion: grant.operation.version,
          authority: { kind: "lease", leaseId: grant.leaseId },
          receipt: {
            ...receipt,
            id: `${operationId}:proxy-receipt`,
            occurredAt,
            recordedAt: now().toISOString(),
          },
        });
        if (result.outcome !== "settled") throw new Error("AccountingPendingRecovery");
      })());
    const abort = new AbortController();
    const signal = AbortSignal.any([abort.signal, request.signal, AbortSignal.timeout(30000)]);
    let response: Response;
    try {
      response = await dispatchPricedRequest(priced, transport, signal, { secret: conn.secret });
    } catch {
      try {
        await settle(unknownReceipt(true));
      } catch {
        return error(503, "accounting_pending_recovery", operationId);
      }
      return error(502, "provider_unavailable", operationId);
    }
    const saveFixture = async (body: unknown) => {
      if (recording && recordFixture)
        await recordFixture({
          provider: conn!.provider,
          connectionId: id,
          operation: op,
          operationId,
          request: providerRequest,
          status: response.status,
          body,
          secrets: [
            conn!.secret,
            ...(descriptor.auth.kind === "basic" ? conn!.secret.split(":") : []),
          ],
        });
    };
    const responseHeaders = new Headers({
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox; default-src 'none'",
      "X-Usagekit-Operation-Id": operationId,
      "X-Usagekit-Accounting": grant ? (op === "unknown" ? "unpriced" : "metered") : "passthrough",
    });
    if (op === "unknown")
      responseHeaders.set(
        "X-Usagekit-Fixture-Hint",
        "Add X-Usagekit-Record-Fixture: true to your next request",
      );
    if (recording) responseHeaders.set("X-Usagekit-Fixture-Recording", "requested");
    for (const name of ["content-type", "retry-after"]) {
      const value = response.headers.get(name);
      if (value) responseHeaders.set(name, value);
    }
    if (!response.body || request.method === "HEAD") {
      await response.body?.cancel();
      try {
        await settle(
          catalog.extract(conn.provider, op, providerRequest, { status: response.status }, null),
        );
      } catch {
        return error(503, "accounting_pending_recovery", operationId);
      }
      await saveFixture(null);
      return new Response(null, { status: response.status, headers: responseHeaders });
    }
    const reader = response.body.getReader();
    let cancelled = false;
    let chunks: Uint8Array[] = [],
      size = 0;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (cancelled) return;
          if (done) {
            let receipt = unknownReceipt(response.status >= 400);
            let captured: unknown;
            if (size <= limit) {
              const text = Buffer.concat(chunks).toString("utf8");
              let value: unknown = text;
              try {
                value = JSON.parse(text);
              } catch {
                /* Non-JSON remains valid transport data. */
              }
              captured = value;
              try {
                receipt = catalog.extract(
                  conn!.provider,
                  op,
                  providerRequest,
                  { status: response.status },
                  value,
                );
              } catch {
                /* Keep uncertainty when extraction cannot prove a receipt. */
              }
            }
            chunks = [];
            await settle(receipt);
            if (recording && size > limit) throw new Error("FixtureTooLarge");
            await saveFixture(captured);
            controller.close();
          } else {
            size += value.byteLength;
            if (size <= limit) chunks.push(value);
            else chunks = [];
            controller.enqueue(value);
          }
        } catch {
          abort.abort();
          await reader.cancel().catch(() => {});
          chunks = [];
          try {
            await settle(unknownReceipt(true));
          } catch {
            /* Durable dispatch intent is recovered after lease expiry. */
          }
          if (!cancelled) controller.error(new Error("ProviderStreamFailed"));
        }
      },
      async cancel() {
        // Cancelling the upstream resolves an outstanding read with done=true. Fence that
        // synthetic EOF before awaiting cancellation so it cannot settle a success receipt.
        cancelled = true;
        abort.abort();
        chunks = [];
        await Promise.all([reader.cancel().catch(() => {}), settle(unknownReceipt(true))]);
      },
    });
    return new Response(stream, { status: response.status, headers: responseHeaders });
  };
}

/** Recovery is deliberately evidence-conservative: no upstream call and no release of charges.
 * Expired proxy intents become pending with unknown cost, visible to the exceptions UI. */
export async function recoverProxyIntents(
  meter: Meter,
  access: AccessContext,
  now: Date,
): Promise<number> {
  let cursor: string | undefined,
    recovered = 0;
  do {
    const result = await meter.listOperations(access, {
      scope: { kind: "namespace", namespace: access.namespace },
      states: ["dispatch_intended"],
      from: "1970-01-01T00:00:00.000Z",
      to: new Date(now.getTime() + 1).toISOString(),
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    if (result.outcome !== "ok") throw new Error("ProxyRecoveryReadFailed");
    for (const op of result.value.operations) {
      if (op.source !== "proxy" || (op.lease && Date.parse(op.lease.expiresAt) > now.getTime()))
        continue;
      const ref = {
        namespace: op.scope.namespace,
        principal: op.scope.principal,
        operationId: op.operationId,
      };
      const claim = await meter.claimForRecovery({
        ...ref,
        holder: "local-proxy-recovery",
        leaseTtlMs,
      });
      if (!("claimed" in claim) || !claim.claimed) continue;
      const receipt: Receipt = {
        id: `${op.operationId}:proxy-recovery:${claim.operation.version}`,
        occurredAt: op.updatedAt,
        recordedAt: now.toISOString(),
        measurements: [{ unit: "requests", certainty: "unknown", quantity: null }],
        cost: { certainty: "unknown", money: null },
        cached: false,
        failed: true,
      };
      const settled = await meter.settle({
        ...ref,
        commandId: receipt.id,
        expectedVersion: claim.operation.version,
        authority: { kind: "recovery", leaseId: claim.lease.leaseId },
        receipt,
      });
      if (settled.outcome !== "settled") throw new Error("ProxyRecoverySettleFailed");
      recovered++;
    }
    cursor = result.value.nextCursor;
  } while (cursor);
  return recovered;
}
