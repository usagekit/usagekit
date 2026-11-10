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
   * stream): typically its prompt plus the output streamed so far. Without it such a turn is
   * not guessed at: it stays pending and keeps its whole reservation.
   */
  estimateInterruptedCall?: (info: {
    finished: readonly Required<TokenCounts>[];
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

const big = (value: number | bigint | undefined) => BigInt(value ?? 0);
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
    const interrupted = started > finished.length || unreported > 0;
    const calls = [...finished];
    let certainty: "measured" | "estimated" = "measured";
    if (interrupted) {
      const estimate = estimateInterruptedCall?.({ finished });
      if (!estimate) return dispatch.settleUnknown({ failed: true });
      calls.push({ cacheRead: 0, cacheWrite: 0, ...estimate });
      certainty = "estimated";
    }
    const total = { input: 0n, output: 0n, cacheRead: 0n, cacheWrite: 0n };
    for (const call of calls) {
      total.input += big(call.input);
      total.output += big(call.output);
      total.cacheRead += big(call.cacheRead);
      total.cacheWrite += big(call.cacheWrite);
    }
    return dispatch.settle({
      ...measure(total, { modelCalls: started }),
      certainty,
      failed: failed || interrupted,
    });
  };
  const finish = (): Promise<void> =>
    (settling ??= settle().then(
      (outcome) => {
        resolve(outcome);
        options.onSettled?.(outcome);
      },
      (error: unknown) => {
        reject(error);
        options.onSettleError?.(error);
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
