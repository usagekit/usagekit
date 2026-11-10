import { describe, expect, it, vi } from "vitest";
import { jsonSchema, simulateReadableStream, stepCountIs, streamText, tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { createMeter } from "@usagekit/meter";
import { createManualClock, createMemoryStore } from "@usagekit/store";
import type { Budget, Quantity } from "@usagekit/core";
import { meterStreamText, tokenCountsOf } from "./ai-sdk.js";
import type { MeterStreamTextOptions } from "./ai-sdk.js";
import { createMeteredDispatch } from "./metered-dispatch.js";
import { tokenQuantities } from "./token-pricing.js";

type DoStream = ConstructorParameters<typeof MockLanguageModelV4>[0] extends infer O
  ? O extends { doStream?: infer D }
    ? Extract<D, (...args: never[]) => unknown>
    : never
  : never;
type Chunk = Awaited<ReturnType<DoStream>>["stream"] extends ReadableStream<infer C> ? C : never;

const q = (unit: string, value: bigint, scale = 0): Quantity => ({ unit, value, scale });
const scope = { namespace: "app", principal: "user-1", group: "team-1", connection: "platform" };
const budget = (unit: string, limit: bigint): Budget => ({
  id: `team-${unit}`,
  version: 1,
  scope: { kind: "group", namespace: "app", group: "team-1" },
  surface: "any",
  unit,
  limit: q(unit, limit),
  window: { kind: "calendar_month", timezone: "UTC" },
  onExceed: "block",
});
/** $1 and $2 per million tokens: one and two money units per token. */
const pricing = {
  prices: {
    input: { units: 1_000_000n, currency: "USD" as const },
    output: { units: 2_000_000n, currency: "USD" as const },
  },
  moneyUnit: "customer_cents",
};
const usage = (input: number, output: number, cacheRead?: number) => ({
  inputTokens: {
    total: input,
    noCache: input - (cacheRead ?? 0),
    cacheRead,
    cacheWrite: undefined,
  },
  outputTokens: { total: output, text: output, reasoning: undefined },
});
const finish = (reason: "stop" | "tool-calls", input: number, output: number): Chunk => ({
  type: "finish",
  finishReason: { unified: reason, raw: undefined },
  usage: usage(input, output),
});
const text = (delta: string): Chunk[] => [
  { type: "text-start", id: "t" },
  { type: "text-delta", id: "t", delta },
  { type: "text-end", id: "t" },
];
const toolStep = (): ReadableStream<Chunk> =>
  simulateReadableStream<Chunk>({
    chunks: [
      { type: "tool-call", toolCallId: "c1", toolName: "lookup", input: "{}" },
      finish("tool-calls", 100, 20),
    ],
  });
const answerStep = (): ReadableStream<Chunk> =>
  simulateReadableStream<Chunk>({ chunks: [...text("done"), finish("stop", 150, 30)] });

async function turn(
  steps: (Error | (() => ReadableStream<Chunk>))[],
  overrides: Partial<MeterStreamTextOptions> = {},
  run: {
    abortSignal?: AbortSignal;
    timeout?: number;
    onDelta?: () => void;
    execute?: () => Promise<string>;
  } = {},
) {
  const clock = createManualClock("2026-11-10T12:00:00.000Z");
  const store = createMemoryStore({
    clock,
    budgets: [budget("tokens", 10_000n), budget("customer_cents", 100n)],
  });
  const meter = createMeter({ store, clock });
  const admitted = await createMeteredDispatch({ meter, now: clock.now, renewEveryMs: 0 }).admit({
    id: "turn-1",
    operation: {
      scope,
      fundingSource: "platform",
      costOwner: "platform",
      surface: "app",
      source: "app",
      provider: "anthropic",
      operation: "model-a",
    },
    estimate: [q("tokens", 4000n), q("customer_cents", 1n)],
  });
  if (admitted.outcome !== "admitted") throw new Error("fixture");
  const renew = vi.spyOn(admitted.dispatch, "renew");
  const metered = meterStreamText({
    dispatch: admitted.dispatch,
    measure: (counts) => tokenQuantities(counts, pricing),
    ...overrides,
  });
  let call = 0;
  const result = streamText({
    model: new MockLanguageModelV4({
      doStream: async () => {
        const step = steps[call++];
        if (!step || step instanceof Error) throw step ?? new Error("no step");
        return { stream: step() };
      },
    }),
    prompt: "hi",
    tools: {
      lookup: tool({
        inputSchema: jsonSchema<Record<string, never>>({ type: "object", properties: {} }),
        execute: run.execute ?? (async () => "ok"),
      }),
    },
    stopWhen: stepCountIs(4),
    maxRetries: 0,
    ...(run.abortSignal ? { abortSignal: run.abortSignal } : {}),
    ...(run.timeout ? { timeout: run.timeout } : {}),
    ...metered.callbacks,
  });
  try {
    for await (const part of result.fullStream) if (part.type === "text-delta") run.onDelta?.();
  } catch {
    // A broken provider stream rejects the iteration; accounting is asserted below.
  }
  const outcome = await metered.settled;
  const operation = (await store.getOperation({
    namespace: "app",
    principal: "user-1",
    operationId: "turn-1",
  }))!;
  const statuses = await store.applicableBudgets({
    scope,
    surface: "app",
    source: "app",
    units: ["tokens"],
  });
  const tokens = statuses.find((s) => s.budget.unit === "tokens")!;
  return {
    outcome,
    operation,
    receipt: operation.receipts.at(-1)!,
    renew,
    tokens: { used: tokens.used!.value, reserved: tokens.reserved!.value },
  };
}
const interrupted = { estimateInterruptedCall: () => ({ input: 150, output: 4 }) };

describe("AI SDK usage mapping", () => {
  it("separates cached input and reports missing totals as unknown", () => {
    expect(
      tokenCountsOf({
        inputTokens: 100,
        inputTokenDetails: { noCacheTokens: 60, cacheReadTokens: 30, cacheWriteTokens: 10 },
        outputTokens: 20,
        outputTokenDetails: { textTokens: 15, reasoningTokens: 5 },
        totalTokens: 120,
      }),
    ).toEqual({ input: 60, output: 20, cacheRead: 30, cacheWrite: 10 });
    expect(
      tokenCountsOf({
        inputTokens: undefined,
        inputTokenDetails: {
          noCacheTokens: undefined,
          cacheReadTokens: undefined,
          cacheWriteTokens: undefined,
        },
        outputTokens: undefined,
        outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
        totalTokens: undefined,
      }),
    ).toBeUndefined();
    expect(tokenCountsOf(undefined)).toBeUndefined();
  });
});

describe("metered streamText", () => {
  it("sums the usage of every finished step and settles on onEnd", async () => {
    const onSettled = vi.fn();
    const t = await turn([toolStep, answerStep], { onSettled });
    expect(t.outcome).toMatchObject({ outcome: "settled", via: "lease", replayed: false });
    expect(onSettled).toHaveBeenCalledExactlyOnceWith(t.outcome);
    // 250 input and 50 output tokens: 250 + 100 money units, 0.0350 cents.
    expect(t.receipt).toMatchObject({
      failed: false,
      cost: { certainty: "estimated", money: { units: 350n } },
      measurements: [
        { unit: "tokens", certainty: "measured", quantity: { value: 300n } },
        { unit: "customer_cents", certainty: "measured", quantity: { value: 350n, scale: 4 } },
        { unit: "requests", certainty: "measured" },
      ],
    });
    expect(t.tokens).toEqual({ used: 300n, reserved: 0n });
    expect(t.renew).toHaveBeenCalledTimes(2);
  });
  it("passes the number of model calls to measure", async () => {
    const measure = vi.fn<MeterStreamTextOptions["measure"]>((counts) =>
      tokenQuantities(counts, pricing),
    );
    await turn([toolStep, answerStep], { measure });
    expect(measure).toHaveBeenCalledExactlyOnceWith(
      { input: 250n, output: 50n, cacheRead: 0n, cacheWrite: 0n },
      { modelCalls: 2 },
    );
  });
  it("an abort mid-stream settles finished steps plus the interrupted call's estimate", async () => {
    const abort = new AbortController();
    const slow = () =>
      simulateReadableStream<Chunk>({
        chunkDelayInMs: 20,
        chunks: [...text("partial"), ...text("more"), finish("stop", 150, 30)],
      });
    const t = await turn([toolStep, slow], interrupted, {
      abortSignal: abort.signal,
      onDelta: () => abort.abort(),
    });
    expect(t.outcome).toMatchObject({ outcome: "settled" });
    expect(t.receipt).toMatchObject({
      failed: true,
      measurements: [{ unit: "tokens", certainty: "estimated", quantity: { value: 274n } }, {}, {}],
    });
    expect(t.tokens).toEqual({ used: 274n, reserved: 0n });
  });
  it("an abort during tool execution charges the finished call as measured", async () => {
    const abort = new AbortController();
    const t = await turn([toolStep, answerStep], interrupted, {
      abortSignal: abort.signal,
      execute: async () => {
        abort.abort();
        await new Promise((resolve) => setTimeout(resolve, 10));
        return "ok";
      },
    });
    expect(t.receipt).toMatchObject({
      failed: true,
      measurements: [{ unit: "tokens", certainty: "measured", quantity: { value: 120n } }, {}, {}],
    });
  });
  it("a timeout before any output settles the estimate of the interrupted call", async () => {
    const stalled = () =>
      simulateReadableStream<Chunk>({ initialDelayInMs: 300, chunks: [finish("stop", 1, 1)] });
    const t = await turn([stalled], interrupted, { timeout: 30 });
    expect(t.receipt).toMatchObject({
      failed: true,
      measurements: [{ unit: "tokens", certainty: "estimated", quantity: { value: 154n } }, {}, {}],
    });
  });
  it("a provider error chunk settles once, as failed", async () => {
    const broken = () =>
      simulateReadableStream<Chunk>({
        chunks: [
          { type: "text-start", id: "t" },
          { type: "text-delta", id: "t", delta: "par" },
          { type: "error", error: new Error("overloaded") },
        ],
      });
    const t = await turn([toolStep, broken], interrupted);
    expect(t.operation.receipts).toHaveLength(1);
    expect(t.receipt).toMatchObject({
      failed: true,
      measurements: [{ unit: "tokens", certainty: "estimated", quantity: { value: 274n } }, {}, {}],
    });
  });
  it("a rejected provider call and a stream that dies both settle through onStepError", async () => {
    const thrown = await turn([toolStep, new Error("provider down")], interrupted);
    expect(thrown.operation.receipts).toHaveLength(1);
    expect(thrown.receipt).toMatchObject({ failed: true });
    expect(thrown.tokens).toEqual({ used: 274n, reserved: 0n });
    const died = () =>
      new ReadableStream<Chunk>({
        start(controller) {
          controller.enqueue({ type: "text-start", id: "t" });
          controller.error(new Error("socket hang up"));
        },
      });
    const dead = await turn([toolStep, died], interrupted);
    expect(dead.receipt).toMatchObject({ failed: true });
    expect(dead.tokens).toEqual({ used: 274n, reserved: 0n });
  });
  it("without an estimator an interrupted turn stays pending with its whole reservation", async () => {
    const t = await turn([toolStep, new Error("provider down")]);
    expect(t.outcome).toMatchObject({ outcome: "pending" });
    expect(t.operation.state).toBe("pending");
    expect(t.receipt).toMatchObject({ failed: true, cost: { certainty: "unknown" } });
    expect(t.tokens).toEqual({ used: 0n, reserved: 4000n });
  });
  it("callbacks never reject when a host observer throws", async () => {
    const fake = (settle: () => Promise<never> | Promise<{ outcome: "untracked" }>) =>
      meterStreamText({
        dispatch: {
          id: "turn-1",
          tracking: "passthrough",
          reserved: [],
          renew: async () => ({ renewed: false, reason: "untracked" }),
          settle,
          settleUnknown: settle,
        },
        measure: () => ({ usage: [], cost: { certainty: "unknown", money: null } }),
        onSettled: () => {
          throw new Error("logger down");
        },
        onSettleError: () => {
          throw new Error("logger down");
        },
      });
    const fine = fake(async () => ({ outcome: "untracked" }));
    await expect(fine.callbacks.onEnd({ finishReason: "stop" })).resolves.toBeUndefined();
    await expect(fine.settled).resolves.toEqual({ outcome: "untracked" });
    const broken = fake(async () => {
      throw new Error("storage down");
    });
    await expect(broken.callbacks.onAbort()).resolves.toBeUndefined();
    await expect(broken.callbacks.onStepError()).resolves.toBeUndefined();
    await expect(broken.settled).rejects.toThrow("storage down");
  });
  it("reports a storage failure and leaves the reservation to lease expiry", async () => {
    const onSettleError = vi.fn();
    const failure = new Error("storage down");
    await expect(
      turn([answerStep], {
        onSettleError,
        measure: () => {
          throw failure;
        },
      }),
    ).rejects.toBe(failure);
    expect(onSettleError).toHaveBeenCalledExactlyOnceWith(failure);
  });
});
