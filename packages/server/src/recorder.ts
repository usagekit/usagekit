import { join } from "node:path";
import type { Clock } from "@usagekit/store";
import type { Meter } from "@usagekit/core";
import type { Catalog, ProviderRequest } from "@usagekit/providers";
import {
  executeProviderRequest,
  PricedRequest,
  RequestPricingError,
  dispatchPricedRequest,
  applyProviderCredentials,
} from "@usagekit/providers";
import { encodeWire } from "@usagekit/http";
import type { Vault } from "./vault.js";
import { writePrivate } from "./config.js";
import { redactFixture } from "./redaction.js";

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const limit = 2 * 1024 * 1024;
async function readBody(response: Response): Promise<unknown> {
  if (!response.body) return null;
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error("ResponseTooLarge");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
/** One explicit recording request makes at most one upstream dispatch; never retry transport. */
export function createRecorder({
  meter,
  catalog,
  vault,
  dir,
  clock,
  transport,
}: {
  meter: Meter;
  catalog: Catalog;
  vault: Vault;
  dir: string;
  clock: Clock;
  transport: typeof fetch;
}) {
  return async (
    connectionId: string,
    input: unknown,
  ): Promise<{ status: number; body: unknown }> => {
    const fail = (status: number, error: string, operationId?: string) => ({
      status,
      body: { error, ...(operationId ? { operationId } : {}) },
    });
    if (
      !object(input) ||
      Object.keys(input).some((k) => !["operation", "request"].includes(k)) ||
      typeof input.operation !== "string" ||
      !object(input.request)
    )
      return fail(400, "invalid_request");
    const raw = input.request;
    if (
      Object.keys(raw).some((k) => !["method", "url", "headers", "body"].includes(k)) ||
      typeof raw.method !== "string" ||
      typeof raw.url !== "string" ||
      (raw.headers !== undefined &&
        (!object(raw.headers) || !Object.values(raw.headers).every((v) => typeof v === "string")))
    )
      return fail(400, "invalid_request");
    let request = raw as ProviderRequest;
    if (
      !["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD"].includes(request.method) ||
      (["GET", "HEAD"].includes(request.method) && request.body !== undefined) ||
      Buffer.byteLength(JSON.stringify(request), "utf8") > limit
    )
      return fail(400, "invalid_request");
    const connection = vault.list().find((entry) => entry.connectionId === connectionId);
    if (!connection) return fail(404, "connection_not_found");
    const descriptor = catalog.providers().find((d) => d.id === connection.provider);
    if (
      !descriptor ||
      !/^[a-zA-Z0-9._-]+$/.test(descriptor.id) ||
      !/^[a-zA-Z0-9._-]+$/.test(input.operation) ||
      input.operation === "." ||
      input.operation === ".."
    )
      return fail(400, "unknown_operation");
    let upstream: URL;
    const secret = vault.get(connection.provider, connectionId);
    try {
      applyProviderCredentials(descriptor.auth, new URL(descriptor.upstream), new Headers(), {
        secret,
      });
      const url = new URL(request.url, descriptor.upstream);
      const base = new URL(descriptor.upstream);
      const prefix = base.pathname.replace(/\/$/, "");
      if (
        url.username ||
        url.password ||
        url.protocol !== "https:" ||
        url.origin !== base.origin ||
        (prefix && url.pathname !== prefix && !url.pathname.startsWith(prefix + "/"))
      )
        return fail(400, "invalid_upstream");
      upstream = url;
    } catch {
      return fail(400, "invalid_request");
    }
    const operationId = crypto.randomUUID();
    let priced: PricedRequest;
    try {
      // Text is wire data. Body-pricing descriptors default untyped recorder text to JSON.
      const headers = new Headers();
      // Only content negotiation belongs to the request; credentials stay at dispatch.
      for (const [name, value] of Object.entries(request.headers ?? {}))
        if (["accept", "content-type"].includes(name.toLowerCase())) headers.set(name, value);
      if (
        descriptor.pricingInputs.includes("body") &&
        request.body !== undefined &&
        !headers.has("Content-Type")
      )
        headers.set("Content-Type", "application/json");
      priced = await PricedRequest.price({
        meter,
        catalog,
        expectedOperation: input.operation,
        request: { ...request, url: upstream.href, headers: Object.fromEntries(headers) },
        input: {
          operationId,
          scope: {
            namespace: "local",
            principal: "local",
            connection: connectionId,
            ...(connection.tags ? { tags: connection.tags } : {}),
          },
          fundingSource: "byok",
          costOwner: "local",
          surface: "programmatic",
          source: "cli",
          provider: connection.provider,
        },
      });
    } catch (failure) {
      if (!(failure instanceof RequestPricingError)) throw failure;
      return fail(
        400,
        failure.code === "operation_mismatch" ? "operation_mismatch" : "invalid_request",
      );
    }
    request = priced.parsed;
    const execution = await executeProviderRequest({
      meter,
      catalog,
      now: () => clock.now(),
      request: priced,
      dispatch: async (request) => {
        const response = await dispatchPricedRequest(
          request,
          transport,
          AbortSignal.timeout(30000),
          { secret },
        );
        return { response: { status: response.status }, body: await readBody(response) };
      },
    });
    if (execution.outcome === "not_dispatched" || execution.outcome === "accounting_failed")
      return { status: 409, body: execution.result };
    if (execution.outcome === "transport_failed")
      return fail(502, "provider_unavailable", operationId);
    const { response, body } = execution,
      timestamp = clock.now().toISOString();
    const identity = catalog.probe(connection.provider, body).accountIdentity;
    const fixture = redactFixture(
      {
        origin: "recorded",
        provider: descriptor.id,
        operation: input.operation,
        recordedAt: timestamp,
        request: {
          ...request,
          headers: Object.fromEntries(
            Object.entries(request.headers ?? {}).filter(([name]) =>
              ["accept", "content-type"].includes(name.toLowerCase()),
            ),
          ),
        },
        response: { status: response.status, body },
        expect: {},
      },
      descriptor,
      [
        secret,
        ...(descriptor.auth.kind === "basic" ? secret.split(":") : []),
        ...(identity ? [identity] : []),
      ],
    );
    const path = join(dir, "fixtures", descriptor.id, input.operation, operationId + ".json");
    writePrivate(path, encodeWire(fixture));
    return {
      status: 200,
      body: {
        path,
        operationId,
        status: response.status,
        accounting: execution.accounting,
      },
    };
  };
}
