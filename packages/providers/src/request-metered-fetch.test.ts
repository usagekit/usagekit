import { describe, expect, it, vi } from "vitest";
import { createMeter } from "@usagekit/meter";
import { createMemoryStore } from "@usagekit/store";
import type { Budget } from "@usagekit/core";
import { createRequestMeteredFetch, RequestMeteringError } from "./request-metered-fetch.js";
function setup(limit = 2n, extraBudgets: readonly Omit<Budget, "scope">[] = []) {
  const clock = { now: () => new Date() };
  const scope = { namespace: "chat-test", principal: "u1", connection: "provider-ephemeral" };
  const store = createMemoryStore({
    clock,
    budgets: [
      {
        id: "request-limit",
        version: 1,
        scope: { kind: "principal", namespace: scope.namespace, principal: scope.principal },
        surface: "app",
        unit: "requests",
        limit: { unit: "requests", value: limit, scale: 0 },
        window: { kind: "since_reset", epoch: "request-one", startsAt: clock.now().toISOString() },
        onExceed: "block",
      },
      ...extraBudgets.map((budget) => ({
        ...budget,
        scope: {
          kind: "principal" as const,
          namespace: scope.namespace,
          principal: scope.principal,
        },
      })),
    ],
  });
  const meter = createMeter({ store, clock });
  const transport = vi.fn<typeof fetch>(async () => new Response("hello"));
  let id = 0;
  const options = {
    meter,
    operation: {
      scope,
      fundingSource: "byok" as const,
      costOwner: "u1",
      surface: "app" as const,
      source: "app" as const,
      provider: "example",
      operation: "generate",
    },
    createOperationId: () => `op-${++id}`,
    fetch: transport,
    now: clock.now,
  };
  return { meter, store, transport, options, call: createRequestMeteredFetch(options) };
}
const url = "https://provider.example/generate";
describe("request-metered fetch", () => {
  it("enforces the injected request budget across concurrent dispatches", async () => {
    const h = setup();
    const outcomes = await Promise.allSettled([h.call(url), h.call(url), h.call(url)]);
    expect(outcomes.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    expect(h.transport).toHaveBeenCalledTimes(2);
    expect(outcomes.find((r) => r.status === "rejected")).toMatchObject({
      reason: { code: "admission_denied" },
    });
  });
  it("a replay never dispatches a second time", async () => {
    const h = setup();
    h.options.createOperationId = () => "same";
    const call = createRequestMeteredFetch(h.options);
    await call(url);
    await expect(call(url)).rejects.toMatchObject({ code: "admission_denied" });
    expect(h.transport).toHaveBeenCalledTimes(1);
  });
  it("denied intent never calls transport", async () => {
    const h = setup();
    vi.spyOn(h.meter, "markDispatchIntent").mockResolvedValue({
      granted: false,
      operation: null,
      reason: "not_reserved",
    });
    await expect(h.call(url)).rejects.toMatchObject({ code: "dispatch_denied" });
    expect(h.transport).not.toHaveBeenCalled();
  });
  it("returns the identical response without reading or buffering its stream", async () => {
    const h = setup();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
    });
    const response = new Response(body);
    h.transport.mockResolvedValue(response);
    const received = await h.call(url);
    expect(received).toBe(response);
    expect(body.locked).toBe(false);
    controller.enqueue(new TextEncoder().encode("late chunk"));
    controller.close();
    expect(await received.text()).toBe("late chunk");
  });
  it("keeps unknown monetary cost and measures only dispatch count", async () => {
    const h = setup();
    const settle = vi.spyOn(h.meter, "settle");
    await h.call(url);
    expect(settle.mock.calls[0]?.[0].receipt).toMatchObject({
      measurements: [{ unit: "requests", certainty: "measured", quantity: { value: 1n } }],
      cost: { certainty: "unknown", money: null },
      failed: false,
    });
    expect((await settle.mock.results[0]!.value).operation.state).toBe("pending");
  });
  it("does not release exposure or leak transport error secrets", async () => {
    const h = setup();
    const release = vi.spyOn(h.meter, "releaseUndispatched");
    const settle = vi.spyOn(h.meter, "settle");
    h.transport.mockRejectedValue(new Error("secret-key private-payload"));
    await expect(h.call(url)).rejects.toMatchObject({ message: "transport_failed" });
    expect(release).not.toHaveBeenCalled();
    expect(settle.mock.calls[0]?.[0].receipt).toMatchObject({
      failed: true,
      cost: { certainty: "unknown" },
    });
  });
  it("already-aborted Request performs no accounting or transport", async () => {
    const h = setup();
    const reserve = vi.spyOn(h.meter, "reserve");
    const c = new AbortController();
    c.abort("secret-reason");
    await expect(h.call(new Request(url, { signal: c.signal }))).rejects.toMatchObject({
      name: "AbortError",
      message: "Request aborted",
    });
    expect(reserve).not.toHaveBeenCalled();
    expect(h.transport).not.toHaveBeenCalled();
  });
  it("explicit null signal overrides an aborted Request signal", async () => {
    const h = setup();
    const c = new AbortController();
    c.abort();
    await expect(
      h.call(new Request(url, { signal: c.signal }), { signal: null }),
    ).resolves.toBeInstanceOf(Response);
    expect(h.transport).toHaveBeenCalledOnce();
  });
  it("abort after reserve releases only undispatched reservation", async () => {
    const h = setup();
    const c = new AbortController();
    const original = h.meter.reserve;
    vi.spyOn(h.meter, "reserve").mockImplementation(async (i) => {
      const r = await original(i);
      c.abort();
      return r;
    });
    const release = vi.spyOn(h.meter, "releaseUndispatched");
    await expect(h.call(url, { signal: c.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(release).toHaveBeenCalledOnce();
    expect(h.transport).not.toHaveBeenCalled();
  });
  it("abort after intent retains unknown exposure without inventing a dispatch", async () => {
    const h = setup();
    const c = new AbortController();
    const original = h.meter.markDispatchIntent;
    vi.spyOn(h.meter, "markDispatchIntent").mockImplementation(async (i) => {
      const r = await original(i);
      c.abort();
      return r;
    });
    const settle = vi.spyOn(h.meter, "settle");
    const release = vi.spyOn(h.meter, "releaseUndispatched");
    await expect(h.call(url, { signal: c.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(h.transport).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    expect(settle.mock.calls[0]?.[0].receipt.measurements).toEqual([
      { unit: "requests", quantity: null, certainty: "unknown" },
    ]);
  });
  it("passes the original signal and request to transport", async () => {
    const h = setup();
    const c = new AbortController();
    const init = { signal: c.signal, method: "POST" };
    await h.call(url, init);
    expect(h.transport).toHaveBeenCalledWith(url, init);
  });
  it("a failed settlement cancels the response body and fails closed", async () => {
    const h = setup();
    const cancel = vi.fn();
    h.transport.mockResolvedValue(new Response(new ReadableStream({ cancel })));
    vi.spyOn(h.meter, "settle").mockResolvedValue({
      outcome: "invalid",
      field: "receipt",
      reason: "private-details",
    });
    await expect(h.call(url)).rejects.toMatchObject({ message: "accounting_failed" });
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("HTTP errors remain intact while recording a failed dispatched attempt", async () => {
    const h = setup();
    const response = new Response("bad", { status: 429 });
    h.transport.mockResolvedValue(response);
    const settle = vi.spyOn(h.meter, "settle");
    expect(await h.call(url)).toBe(response);
    expect(settle.mock.calls[0]?.[0].receipt.failed).toBe(true);
  });
  it("carries the exceeded budget so a caller can name the limit", async () => {
    const h = setup(1n);
    await h.call(url);
    const failure = await h.call(url).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RequestMeteringError);
    expect(failure).toMatchObject({
      code: "admission_denied",
      exceeded: {
        code: "allowance_exceeded",
        boundary: "limit",
        budget: { id: "request-limit", unit: "requests" },
        // The first request settled with unknown cost, so it still holds its reservation.
        reserved: { unit: "requests", value: 1n },
      },
    });
    expect((failure as RequestMeteringError).message).toBe("admission_denied");
    expect(h.transport).toHaveBeenCalledOnce();
  });
  it("other admission denials carry no exceeded budget", async () => {
    const h = setup();
    h.options.createOperationId = () => "same";
    const call = createRequestMeteredFetch(h.options);
    await call(url);
    const failure = await call(url).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "admission_denied" });
    expect((failure as RequestMeteringError).exceeded).toBeUndefined();
  });
  it.each(["customer_cents", "tokens"])(
    "a %s budget on the same scope fails before dispatch with a distinct error",
    async (unit) => {
      const h = setup(2n, [
        {
          id: `${unit}-limit`,
          version: 1,
          surface: "app",
          unit,
          limit: { unit, value: 1000n, scale: 0 },
          window: { kind: "since_reset", epoch: "one", startsAt: new Date().toISOString() },
          onExceed: "block",
        },
      ]);
      const reserve = vi.spyOn(h.meter, "reserve");
      const failure = await h.call(url).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(RequestMeteringError);
      expect(failure).toMatchObject({ code: "unsupported_budget_unit", unit });
      expect((failure as RequestMeteringError).exceeded).toBeUndefined();
      expect(h.transport).not.toHaveBeenCalled();
      expect(await reserve.mock.results[0]!.value).toMatchObject({ operation: null });
    },
  );
  it("forwards a passthrough connection unchanged without settlement", async () => {
    const h = setup();
    vi.spyOn(h.meter, "reserve").mockResolvedValue({
      outcome: "passthrough",
      replayed: false,
      operation: null,
    });
    const intent = vi.spyOn(h.meter, "markDispatchIntent");
    const settle = vi.spyOn(h.meter, "settle");
    const response = new Response("free");
    h.transport.mockResolvedValue(response);
    expect(await h.call(url)).toBe(response);
    expect(h.transport).toHaveBeenCalledOnce();
    expect(intent).not.toHaveBeenCalled();
    expect(settle).not.toHaveBeenCalled();
  });
  it("a replayed passthrough never dispatches", async () => {
    const h = setup();
    vi.spyOn(h.meter, "reserve").mockResolvedValue({
      outcome: "passthrough",
      replayed: true,
      operation: null,
    });
    await expect(h.call(url)).rejects.toMatchObject({ code: "admission_denied" });
    expect(h.transport).not.toHaveBeenCalled();
  });
});
