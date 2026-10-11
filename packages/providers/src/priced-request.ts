import type {
  Meter,
  MeterReserveInput,
  ProviderAuth,
  Quantity,
  ReserveResult,
} from "@usagekit/core";
import type { Catalog, CatalogMatch } from "./catalog.js";
import type { ProviderRequest } from "./types.js";

export type RequestPricingInput = {
  meter: Meter;
  catalog: Catalog;
  input: Omit<MeterReserveInput, "operation" | "options">;
  /** Uint8Array is wire data; other bodies are host-supplied JSON values or text. */
  request: ProviderRequest;
  expectedOperation?: string;
  rejectUnknown?: boolean;
  /** Only non-strict proxy dispatch may reserve an unknown, unpriced request. */
  allowUnknownDispatch?: boolean;
};
/** Trusted transport credentials are supplied separately and are never part of priced state. */
export type ProviderCredentials = { secret: string };

const credentialQuery =
  /^(api[_-]?key|access[_-]?token|token|authorization|password|secret|(?:.*[_-])?credentials?)$/i;
const credentialHeader =
  /^(authorization|proxy-authorization|cookie|set-cookie|(?:x-)?api[_-]?key|(?:x-)?access[_-]?token|(?:x-)?auth[_-]?token|(?:x-)?(?:.*[_-])?credentials?)$/i;

export class RequestPricingError extends Error {
  constructor(
    readonly code:
      | "invalid_json"
      | "invalid_provider_request"
      | "operation_mismatch"
      | "unknown_operation",
    message: string = code,
  ) {
    super(message);
  }
}
/** RFC 9110 media types are case-insensitive; structured JSON suffixes are JSON too. */
export function isJsonMediaType(value: string | null | undefined): boolean {
  const type = value?.split(";")[0]?.trim().toLowerCase() ?? "";
  return (
    type === "application/json" ||
    /^[!#$%&'*+.^_`|~0-9a-z-]+\/[!#$%&'*+.^_`|~0-9a-z-]+\+json$/.test(type)
  );
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
/** Only pricing/admission can construct this snapshot. Bytes are copied on access, and all
 * other state is deeply frozen. Neither caller mutations nor dispatch can change the price
 * inputs. Credential fields are stripped before pricing; dispatch adds trusted authentication
 * to a copy without retaining it in this snapshot. */
export class PricedRequest {
  readonly #bytes: Uint8Array<ArrayBuffer> | undefined;
  private constructor(
    readonly method: string,
    readonly url: string,
    readonly headers: Readonly<Record<string, string>>,
    readonly parsed: ProviderRequest,
    readonly matched: CatalogMatch,
    readonly input: RequestPricingInput["input"],
    readonly admission: ReserveResult,
    readonly estimate: readonly Quantity[],
    bytes: Uint8Array<ArrayBuffer> | undefined,
    readonly auth: Readonly<ProviderAuth>,
  ) {
    this.#bytes = bytes;
    Object.freeze(this);
  }
  get body(): Uint8Array<ArrayBuffer> | undefined {
    return this.#bytes?.slice();
  }

  static async price({
    meter,
    catalog,
    input,
    request,
    expectedOperation,
    rejectUnknown,
    allowUnknownDispatch = false,
  }: RequestPricingInput): Promise<PricedRequest> {
    const descriptor = catalog.providers().find((p) => p.id === input.provider);
    if (!descriptor) throw new RequestPricingError("invalid_provider_request");
    let target: URL;
    let headers: Record<string, string>;
    // Resolve and validate before catalog callbacks. Reject userinfo rather than retaining it.
    try {
      const base = new URL(descriptor.upstream);
      target = new URL(request.url, base);
      const prefix = base.pathname.replace(/\/$/, "");
      if (
        base.username ||
        base.password ||
        target.username ||
        target.password ||
        target.protocol !== "https:" ||
        target.origin !== base.origin ||
        (prefix && target.pathname !== prefix && !target.pathname.startsWith(prefix + "/"))
      )
        throw new Error("InvalidUpstream");
      const auth = descriptor.auth;
      for (const key of [...target.searchParams.keys()]) {
        if (
          credentialQuery.test(key) ||
          (auth.kind === "query" && key.toLowerCase() === auth.param.toLowerCase())
        )
          target.searchParams.delete(key);
      }
      const cleanHeaders = new Headers(request.headers);
      for (const key of [...cleanHeaders.keys()]) {
        if (
          credentialHeader.test(key) ||
          (auth.kind === "header" && key === auth.name.toLowerCase()) ||
          descriptor.stripRequestHeaders?.some((name) => key === name.toLowerCase())
        )
          cleanHeaders.delete(key);
      }
      headers = Object.fromEntries(cleanHeaders);
    } catch {
      throw new RequestPricingError("invalid_provider_request");
    }
    const url = target.href;
    const auth = freeze(structuredClone(descriptor.auth));
    const pricesBody = descriptor.pricingInputs.includes("body");
    let bytes: Uint8Array<ArrayBuffer> | undefined;
    let value: unknown;
    let invalidJson = false;
    if (request.body !== undefined) {
      const raw = request.body instanceof Uint8Array || typeof request.body === "string";
      try {
        bytes =
          request.body instanceof Uint8Array
            ? Uint8Array.from(request.body)
            : new TextEncoder().encode(
                typeof request.body === "string" ? request.body : JSON.stringify(request.body),
              );
      } catch {
        throw new RequestPricingError("invalid_provider_request");
      }
      // Host JSON objects have an implicit JSON media type; raw bytes do not.
      if (!raw && !headers["content-type"]) headers["content-type"] = "application/json";
      value = new TextDecoder().decode(bytes);
      if (pricesBody && isJsonMediaType(headers["content-type"])) {
        try {
          value = JSON.parse(value as string);
        } catch {
          invalidJson = true;
        }
      }
    }
    const parsed = {
      method: request.method,
      url,
      headers,
      ...(bytes === undefined ? {} : { body: value }),
    };
    let matched: CatalogMatch;
    try {
      matched = catalog.match(input.provider, parsed);
    } catch (error) {
      throw new RequestPricingError(
        invalidJson ? "invalid_json" : "invalid_provider_request",
        error instanceof Error ? error.message : undefined,
      );
    }
    if (matched.operation === "unknown") {
      if (rejectUnknown) throw new RequestPricingError("unknown_operation");
    } else if (pricesBody && matched.operation.billable && bytes !== undefined) {
      if (invalidJson) throw new RequestPricingError("invalid_json");
      if (!isJsonMediaType(headers["content-type"]))
        throw new RequestPricingError("invalid_provider_request");
      bytes = new TextEncoder().encode(JSON.stringify(value));
      headers["content-type"] = "application/json";
    }
    const uncertain =
      matched.operation !== "unknown" && !catalog.canEstimate(input.provider, matched.options);
    if (
      expectedOperation !== undefined &&
      (matched.operation === "unknown" || matched.operation.id !== expectedOperation)
    )
      throw new RequestPricingError("operation_mismatch");
    // Isolate even references retained by a custom matcher before the first await.
    const parsedSnapshot = freeze(structuredClone(parsed));
    const headerSnapshot = freeze({ ...headers });
    const snapshot = freeze(structuredClone(input));
    const match = freeze(structuredClone(matched));
    const {
      estimate: requestedEstimate,
      estimateSource,
      providerPriceVersion,
      ...restInput
    } = snapshot;
    // Request uncertainty replaces every caller price and its provenance. The Meter owns
    // funding, passthrough and budget admission, including requests-only unknown estimates.
    const baseInput = uncertain
      ? restInput
      : {
          ...restInput,
          ...(estimateSource === undefined ? {} : { estimateSource }),
          ...(providerPriceVersion === undefined ? {} : { providerPriceVersion }),
        };
    const boundedEstimate =
      requestedEstimate &&
      input.fundingSource === "byok" &&
      match.operation !== "unknown" &&
      !uncertain
        ? catalog.boundEstimate(
            input.provider,
            match.operation.id,
            match.options,
            requestedEstimate,
          )
        : requestedEstimate;
    const admission = await meter.reserve({
      ...baseInput,
      operation: match.operation === "unknown" ? "unknown" : match.operation.id,
      ...(uncertain
        ? {
            estimate: [{ unit: "requests", value: 1n, scale: 0 }],
            estimateSource: "unknown" as const,
          }
        : match.operation === "unknown"
          ? allowUnknownDispatch
            ? {
                estimate: [{ unit: "requests", value: 1n, scale: 0 }],
                estimateSource: "unknown" as const,
              }
            : {}
          : {
              ...(boundedEstimate === undefined ? {} : { estimate: boundedEstimate }),
              options: match.options,
            }),
    });
    const estimate = admission.outcome === "reserved" ? admission.operation.estimate : [];
    return new PricedRequest(
      parsedSnapshot.method,
      url,
      headerSnapshot,
      parsedSnapshot,
      match,
      snapshot,
      freeze(structuredClone(admission)),
      freeze(structuredClone(estimate)),
      bytes,
      auth,
    );
  }
}
/** Apply trusted credentials to disposable transport objects. Hosts validate on throwaway
 * objects before pricing; using this same helper at dispatch keeps both paths identical.
 * Invalid credentials always throw a stable error without the credential value or cause. */
export function applyProviderCredentials(
  auth: Readonly<ProviderAuth>,
  url: URL,
  headers: Headers,
  credentials: ProviderCredentials,
): void {
  try {
    const { secret } = credentials;
    if (auth.kind === "query") {
      // URLSearchParams mutation re-encodes unrelated values, bare flags and invalid bytes.
      const pair = new URLSearchParams([[auth.param, secret]]).toString();
      url.search = url.search ? `${url.search}&${pair}` : `?${pair}`;
    } else if (auth.kind === "basic") {
      const encoded = btoa(
        Array.from(new TextEncoder().encode(secret), (byte) => String.fromCharCode(byte)).join(""),
      );
      headers.set("Authorization", `Basic ${encoded}`);
    } else if (auth.kind === "bearer") headers.set("Authorization", `Bearer ${secret}`);
    else headers.set(auth.name, `${auth.prefix ?? ""}${secret}`);
  } catch {
    throw new Error("invalid_provider_credentials");
  }
}

/** The only fetch boundary used by proxy and recorder. Pass null explicitly for no auth. */
export async function dispatchPricedRequest(
  request: PricedRequest,
  transport: typeof fetch,
  signal: AbortSignal,
  credentials: ProviderCredentials | null,
): Promise<Response> {
  const url = new URL(request.url);
  const headers = new Headers(request.headers);
  if (credentials !== null) applyProviderCredentials(request.auth, url, headers, credentials);
  const body = request.body;
  return transport(url.href, {
    method: request.method,
    headers,
    redirect: "error",
    signal,
    ...(body === undefined ? {} : { body }),
  });
}
