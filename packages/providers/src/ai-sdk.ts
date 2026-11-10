/**
 * AI SDK 7 adapter for the metered dispatch handle. `ai` is an optional peer and is used for
 * types only: this module has no runtime dependency, and the package root never imports it.
 */
import type { FinishReason, LanguageModelUsage } from "ai";
import type { Cost, Quantity } from "@usagekit/core";
import type { MeteredDispatch, SettleOutcome } from "./metered-dispatch.js";
import type { TokenCounts } from "./token-pricing.js";

/** Token counts of one model call, or undefined when the provider reported no totals. */
export function tokenCountsOf(usage: LanguageModelUsage | undefined): TokenCounts | undefined {
  if (usage?.inputTokens === undefined || usage.outputTokens === undefined) return undefined;
  const cacheRead = usage.inputTokenDetails?.cacheReadTokens ?? 0;
  const cacheWrite = usage.inputTokenDetails?.cacheWriteTokens ?? 0;
  return {
    input: Math.max(0, usage.inputTokens - cacheRead - cacheWrite),
    output: usage.outputTokens,
    cacheRead,
    cacheWrite,
  };
}

export type MeterStreamTextOptions = {
  /** The admitted dispatch of this turn. */
  dispatch: MeteredDispatch;
  /**
   * Maps the turn's token counts to amounts in the reserved budget units and the provider cost.
   * `tokenQuantities` with host-owned prices is the usual implementation.
   */
  measure: (
    counts: Required<TokenCounts>,
    info: { modelCalls: number },
  ) => { usage: readonly Quantity[]; cost: Cost };
  /**
   * Estimate of a model call that started but never reported usage (abort, timeout, broken
   * stream, a retried stream attempt): typically its prompt plus the output streamed so far.
   * Called once per such call, `index` of `interrupted`. Without it, or when it returns
   * nothing or counts that are not non-negative integers for any of them, the turn is not
   * guessed at: it stays pending and keeps its whole reservation.
   */
  estimateInterruptedCall?: (info: {
    finished: readonly Required<TokenCounts>[];
    index: number;
    interrupted: number;
  }) => TokenCounts | undefined;
  /** Observes the settlement, for logging. Budget effects are already recorded. */
  onSettled?: (outcome: SettleOutcome) => void;
  /** A storage failure while settling. Nothing was recorded; lease expiry then applies. */
  onSettleError?: (error: unknown) => void;
};
export type MeteredStreamText = {
  /** Spread into `streamText`. A host with its own callbacks calls these from them. */
  callbacks: {
    onLanguageModelCallStart: () => void;
    onLanguageModelCallEnd: (event: {
      usage: LanguageModelUsage;
      finishReason: FinishReason;
    }) => void;
    onStepError: () => Promise<void>;
    onEnd: (event: { finishReason: FinishReason }) => Promise<void>;
    onAbort: () => Promise<void>;
    onError: () => void;
  };
  /** Resolves when the turn has settled; rejects on a storage failure. */
  settled: Promise<SettleOutcome>;
};

const isCount = (value: unknown): value is number | bigint =>
  typeof value === "bigint" ? value >= 0n : Number.isSafeInteger(value) && (value as number) >= 0;
/** A host estimate with its optional cache counts, or undefined when any count is unusable. */
function estimatedCounts(estimate: TokenCounts | undefined): Required<TokenCounts> | undefined {
  if (!estimate) return undefined;
  const counts = {
    input: estimate.input,
    output: estimate.output,
    cacheRead: estimate.cacheRead ?? 0,
    cacheWrite: estimate.cacheWrite ?? 0,
  };
  return Object.values(counts).every(isCount) ? counts : undefined;
}
/**
 * Settles one `streamText` turn. Usage is summed per finished model call, so an abort during
 * tool execution still charges the calls that completed. `onEnd` settles the total; `onAbort`
 * and `onStepError` settle what was spent, marked failed. The first terminal event wins.
 */
export function meterStreamText(options: MeterStreamTextOptions): MeteredStreamText {
  const { dispatch, measure, estimateInterruptedCall } = options;
  const finished: Required<TokenCounts>[] = [];
  let started = 0;
  let unreported = 0;
  let failed = false;
  let settling: Promise<void> | undefined;
  let resolve!: (outcome: SettleOutcome) => void;
  let reject!: (error: unknown) => void;
  const settled = new Promise<SettleOutcome>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  // A host that never awaits `settled` must not crash on an unhandled rejection.
  settled.catch(() => undefined);

  const settle = async (): Promise<SettleOutcome> => {
    // Every call without reported usage, whether its end event came or not. A retried stream
    // leaves one per failed attempt, and each of them was billed by the provider.
    const interrupted = Math.max(started - finished.length, unreported);
    const calls = [...finished];
    for (let index = 0; index < interrupted; index++) {
      const estimate = estimatedCounts(estimateInterruptedCall?.({ finished, index, interrupted }));
      if (!estimate) return dispatch.settleUnknown({ failed: true });
      calls.push(estimate);
    }
    const total = { input: 0n, output: 0n, cacheRead: 0n, cacheWrite: 0n };
    for (const call of calls) {
      total.input += BigInt(call.input);
      total.output += BigInt(call.output);
      total.cacheRead += BigInt(call.cacheRead);
      total.cacheWrite += BigInt(call.cacheWrite);
    }
    return dispatch.settle({
      ...measure(total, { modelCalls: started }),
      certainty: interrupted > 0 ? "estimated" : "measured",
      failed: failed || interrupted > 0,
    });
  };
  /** A host observer that throws must not fail the SDK callback that triggered settlement. */
  const observe = (notify: () => void) => {
    try {
      notify();
    } catch {
      // The settlement result stands; observers are for logging only.
    }
  };
  const finish = (): Promise<void> =>
    (settling ??= (async () => settle())().then(
      (outcome) => {
        resolve(outcome);
        observe(() => options.onSettled?.(outcome));
      },
      (error: unknown) => {
        reject(error);
        observe(() => options.onSettleError?.(error));
      },
    ));
  return {
    settled,
    callbacks: {
      onLanguageModelCallStart: () => {
        started++;
      },
      onLanguageModelCallEnd: (event) => {
        const counts = tokenCountsOf(event.usage);
        if (counts) finished.push({ cacheRead: 0, cacheWrite: 0, ...counts });
        else unreported++;
        if (event.finishReason === "error") failed = true;
        // The heartbeat also renews; this keeps a long multi-step turn alive without a timer.
        void dispatch.renew().catch(() => undefined);
      },
      onStepError: () => {
        failed = true;
        return finish();
      },
      onEnd: (event) => {
        if (event.finishReason === "error") failed = true;
        return finish();
      },
      onAbort: () => {
        failed = true;
        return finish();
      },
      onError: () => {
        failed = true;
      },
    },
  };
}
