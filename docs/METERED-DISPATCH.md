# Metered dispatch

An unreleased addition to `@usagekit/providers`, after 0.10.0. It lets a host enforce
request, token and money budgets around one streaming model call: admit before the call,
settle with real usage when the stream ends. The first half of this page is the design note;
the second half shows how to use it.

## Decision

A new **dispatch handle**, `createMeteredDispatch`, sits next to `createRequestMeteredFetch`.
The fetch wrapper is not extended. It sees one HTTP attempt and never reads the body, so it
cannot know the tokens a stream used, and a model turn spans several HTTP requests while its
budget is one reservation. The fetch wrapper keeps throwing `unsupported_budget_unit` when a
token or money budget shares its scope. The handle admits that same scope, because the host
supplies an estimate in those units. The handle reports `unsupported_budget_unit` only for a
budget unit that is absent from the host's estimate.

The handle composes the existing Meter commands. It adds no Store command, table or
migration, so every shipped Store supports it.

## Public API

```ts
const dispatcher = createMeteredDispatch({ meter, holder, leaseTtlMs, renewEveryMs, now });

const admitted = await dispatcher.admit({ id, operation, estimate });
// admitted | refused: budget_exceeded (exceeded), unsupported_budget_unit (unit),
//                     replayed, conflict, invalid, dispatch_denied

const dispatch = admitted.dispatch;
await dispatch.renew(); // also runs on a timer every renewEveryMs
await dispatch.settle({ usage, cost, certainty, failed }); // settled | pending | rejected
await dispatch.settleUnknown({ failed }); // pending: the whole reservation stays held

await dispatcher.settleAbandoned({ access, scope, from, to, cost }); // maintenance sweep
```

`id` is the caller's idempotency key and becomes the operation id. `estimate` is an upper
bound in every budget unit; the handle adds `requests: 1` when the host does not. A refusal
carries the Meter's `AllowanceExceeded`, like `RequestMeteringError.exceeded`.

`@usagekit/providers/ai-sdk` adds `meterStreamText` for AI SDK 7: callbacks for `streamText`
that sum usage from finished model calls, renew the lease, settle on `onEnd` and settle
partial usage on `onAbort` or `onStepError`. `ai` is an optional peer; the root export never
imports it.

## Lifecycle

| Step              | Meter command                        | Operation state               | Budget effect                     |
| ----------------- | ------------------------------------ | ----------------------------- | --------------------------------- |
| `admit`           | `reserve`, then `markDispatchIntent` | `dispatch_intended`, leased   | estimate counted as reserved      |
| `renew`           | `renewLease`                         | unchanged                     | none                              |
| `settle`          | `settle` with the lease              | `settled`                     | actual usage counted as used      |
| `settle`, late    | `claimForRecovery` then `settle`     | `settled`                     | same                              |
| `settle`, swept   | `correct` with late evidence         | `settled`, receipt superseded | actual usage replaces the sweep's |
| `settleUnknown`   | `settle` with unknown measurements   | `pending`                     | estimate stays reserved           |
| lease expires     | none                                 | `dispatch_intended`           | estimate stays reserved           |
| `settleAbandoned` | `claimForRecovery` then `settle`     | `settled` or `pending`        | the whole estimate is charged     |

Admission is one atomic Store command over every applicable budget, so parallel admits never
pass a blocking limit together. Marking intent at once means a reservation never waits
undispatched; if intent is denied the handle releases it.

**Settlement.** Usage below the reservation returns the difference to every budget. Usage
above it is recorded in full: the budget may then exceed its limit, and the next admit is
refused until the window resets. The overshoot of one budget is bounded by the sum, over
operations in flight, of actual minus estimate; it is zero when estimates are upper bounds.
`settle` reports each overshoot. Every reserved unit must appear in `usage`, otherwise the
handle rejects the call before any command: a missing unit is never treated as zero.

**Partial settlement.** A turn that fails, times out or is aborted settles what it spent,
with `failed: true` and `certainty: "estimated"` when a model call was interrupted. A host
that cannot estimate calls `settleUnknown`, which keeps the operation pending.

**Unknown outcome.** When the process dies the lease expires and nothing is released: the
whole reservation keeps counting against every budget of its window. `settleAbandoned`
claims such operations of this holder and records each reserved unit at its full estimate,
`estimated` and `failed`. With a host `cost` the operation settles; without one it stays
pending. Either way the budgets are charged the whole reservation, never zero.

**Idempotency.** A repeated `admit` with the same `id` returns `replayed` and never grants a
second dispatch; a different estimate under the same `id` is a `conflict`. `settle` uses one
command id per operation and keeps its first receipt, so a retry replays the stored result.
A turn that outlives its lease still settles exactly once, through recovery authority or, if
the sweep ran first, through a correction that supersedes the sweep's receipt.

## Money

The library ships no provider prices. `priceTokens(counts, prices)` turns token counts into
exact `Money` from a price table the host owns (money per million tokens, rounded up to one
money unit), and `tokenQuantities` builds the estimate or the settlement in the host's token
and money units. Unknown cost keeps an operation pending, as elsewhere in usagekit.

## Stores

No Store code changes. The shared conformance suite gains settlement cases (multi-unit
admission, settle below and above the estimate, late and corrected settlement, abandoned
dispatch), which run against memory, SQLite, the Cloudflare Store, Postgres and the embedded
and remote Meter. The Postgres lane adds races between settle and reserve on independent pools.

## Rejected

- **Extending `createRequestMeteredFetch`.** It would have to parse provider bodies and
  could not group the steps of one turn.
- **Releasing an abandoned reservation at lease expiry.** A possible charge would become zero.
- **Durable per-step progress.** A new Store command for a small gain; the whole-reservation
  rule already bounds an abandoned turn.
- **Bundled price lists.** Prices change and belong to the host's contract.
- **Throwing for budget refusals.** A refusal is an expected outcome and is returned as data;
  only storage failures throw.

---

# Using it

## One turn with the AI SDK

```ts
import { streamText } from "ai";
import { createMeteredDispatch, tokenQuantities } from "@usagekit/providers";
import { meterStreamText } from "@usagekit/providers/ai-sdk";

// Host-owned prices: money per million tokens. One USD is 1_000_000 money units.
const pricing = {
  prices: {
    input: { units: 3_000_000n, currency: "USD" },
    output: { units: 15_000_000n, currency: "USD" },
    cacheRead: { units: 300_000n, currency: "USD" },
  },
  tokensUnit: "tokens",
  moneyUnit: "customer_cents",
} as const;

// One per process. The Meter decides durability: use a durable Store in production.
const dispatcher = createMeteredDispatch({ meter });

export async function runTurn(turn: Turn) {
  const admitted = await dispatcher.admit({
    id: turn.id, // stable for the turn; a repeat never dispatches again
    operation: {
      scope: {
        namespace: "assistant",
        principal: turn.userId,
        group: turn.teamId,
        connection: "platform-anthropic",
      },
      fundingSource: "platform",
      costOwner: "platform",
      surface: "app",
      source: "app",
      provider: "anthropic",
      operation: turn.modelId,
    },
    // Upper bound of the whole turn: the largest prompt and output it may use.
    estimate: tokenQuantities({ input: 60_000, output: 8_000 }, pricing).usage,
  });
  if (admitted.outcome === "refused") {
    if (admitted.reason === "budget_exceeded") return limitReached(admitted.exceeded);
    throw new Error(`Metering refused the turn: ${admitted.reason}`);
  }
  const metered = meterStreamText({
    dispatch: admitted.dispatch,
    measure: (counts) => tokenQuantities(counts, pricing),
    // A call cut off by an abort, timeout or broken stream never reports usage.
    estimateInterruptedCall: () => ({ input: turn.promptTokens(), output: turn.streamedTokens() }),
    onSettled: (outcome) => log.info({ turn: turn.id, settlement: outcome.outcome }),
    onSettleError: (error) => log.error({ turn: turn.id, error }),
  });
  return streamText({
    model: turn.model,
    messages: turn.messages,
    abortSignal: turn.abortSignal,
    ...metered.callbacks,
  });
}
```

`admitted.exceeded` is the Meter's `AllowanceExceeded`: the budget (id, scope, unit, limit
and window), the crossed `boundary`, `used`, `reserved` and `resetsAt`. It holds budget
configuration only; what a user sees remains the host's decision.

The budgets are ordinary usagekit budgets in the estimate's units, for example with the
Postgres Store:

```ts
await store.putBudget({
  id: `team-${teamId}-tokens`,
  version: 1,
  scope: { kind: "group", namespace: "assistant", group: teamId },
  surface: "any",
  unit: "tokens",
  limit: { unit: "tokens", value: 2_000_000n, scale: 0 },
  window: { kind: "calendar_month", timezone: "UTC" },
  onExceed: "block",
});
await store.putBudget({
  id: `team-${teamId}-money`,
  version: 1,
  scope: { kind: "group", namespace: "assistant", group: teamId },
  surface: "any",
  unit: "customer_cents",
  limit: { unit: "customer_cents", value: 2_500n, scale: 0 }, // 25 USD
  window: { kind: "calendar_month", timezone: "UTC" },
  onExceed: "block",
});
```

## What the adapter does

`meterStreamText` works at the level of model calls, which is finer than steps: a step also
contains tool execution, and a turn aborted while a tool runs has already paid for the call
that requested it.

| AI SDK event               | Effect                                                                |
| -------------------------- | --------------------------------------------------------------------- |
| `onLanguageModelCallStart` | Counts a started call.                                                |
| `onLanguageModelCallEnd`   | Adds the call's reported usage and renews the lease.                  |
| `onEnd`                    | Settles the total. `failed` when the turn ended with an error.        |
| `onAbort`, `onStepError`   | Settles what was spent, `failed`. Aborts and timeouts end in onAbort. |
| `onError`                  | Marks the turn failed; the terminal event that follows settles it.    |

The first terminal event settles; later ones are ignored. A started call without reported
usage is an interrupted call. With `estimateInterruptedCall` its estimate is added and the
turn settles as `estimated`; without it the adapter calls `settleUnknown`, so nothing is
guessed and the whole reservation stays held. `metered.settled` resolves with the outcome,
or rejects when storage failed; in that case nothing was recorded and the lease-expiry rule
applies. The callbacks never throw into the SDK.

A host that already passes its own callbacks calls the adapter's from them:

```ts
streamText({
  ...metered.callbacks,
  onEnd: async (event) => {
    await metered.callbacks.onEnd(event);
    await saveTranscript(event);
  },
});
```

Verified against `ai` 7.0.168: its tests run real `streamText` calls with the SDK's mock
model through success, abort mid-stream, abort during a tool, timeout, a provider error
chunk, a rejected call and a broken stream.

## Without the AI SDK

```ts
const { dispatch } = admitted;
try {
  const result = await callModel(dispatch.id);
  await dispatch.settle(tokenQuantities(result.tokens, pricing));
} catch (error) {
  const spent = partialTokens(error); // the host's own estimate of what was used
  if (spent)
    await dispatch.settle({
      ...tokenQuantities(spent, pricing),
      certainty: "estimated",
      failed: true,
    });
  else await dispatch.settleUnknown({ failed: true });
  throw error;
}
```

A turn that was admitted but never called the model settles with zero usage and a measured
zero cost: the host knows nothing was spent, so its whole token and money reservation
returns. Release is not available after admission, because the handle marks dispatch intent
at once.

## Outcomes

`admit` returns `admitted` or `refused` with one of these reasons:

| Reason                    | Meaning                                                                  |
| ------------------------- | ------------------------------------------------------------------------ |
| `budget_exceeded`         | A budget denied admission; `exceeded` names it. A user limit.            |
| `unsupported_budget_unit` | A budget applies whose `unit` the estimate lacks. A configuration error. |
| `replayed`                | The id was admitted before. Only that first admit may call the provider. |
| `conflict`                | The id was admitted before with a different estimate or attribution.     |
| `invalid`                 | The Meter rejected the input; `field` and `detail` say why.              |
| `dispatch_denied`         | No dispatch grant. The reservation was released.                         |

`settle` returns:

| Outcome     | Meaning                                                                              |
| ----------- | ------------------------------------------------------------------------------------ |
| `settled`   | Recorded. `via` is `lease`, `recovery` (after lease expiry) or `correction`.         |
| `pending`   | Recorded, but cost or a measurement is unknown: the whole reservation stays held.    |
| `untracked` | The connection is tracked as passthrough: nothing was reserved or settled.           |
| `rejected`  | `missing_usage_unit`, `invalid`, `already_settled` or `lease_lost`; nothing changed. |

`lease_lost` means another holder is recovering the operation at that moment. Call `settle`
again: the handle keeps the first evidence, and once the other holder is done the turn
settles through a correction. Without a retry the sweep's whole-reservation charge stands.

## Leases and maintenance

The lease defaults to two minutes and a heartbeat renews it every third of that, on an
unreferenced timer that stops at settlement. `renewEveryMs: 0` disables the heartbeat; the
host then calls `dispatch.renew()` itself. Losing the lease does not stop the stream, since
recovery never dispatches again, and the late settlement paths keep accounting exact.

A scheduled job resolves turns whose process died:

```ts
// Every minute, per namespace. `access` is a verified server context for that scope.
await meter.expireReservations({ namespace: "assistant" });
let cursor: string | undefined;
do {
  const swept = await dispatcher.settleAbandoned({
    access,
    scope: { kind: "namespace", namespace: "assistant" },
    from: windowStart,
    to: now,
    ...(cursor ? { cursor } : {}),
    // Optional: price the reservation so the operation settles instead of staying pending.
    cost: (operation) => reservationCost(operation),
  });
  cursor = swept.outcome === "swept" ? swept.nextCursor : undefined;
} while (cursor);
```

The sweep only touches operations whose lease names this dispatcher's `holder`, so
request-metered fetch and proxy operations in the same namespace are left alone. Give two
dispatchers with different recovery rules different holders. The sweep is hygiene for
reports: from the moment a lease expires the budgets already count the whole reservation.

## Relation to request-metered fetch

`createRequestMeteredFetch` counts transport attempts and enforces `requests` budgets only.
Keep it for traffic where a request count is the whole contract. For a model turn bounded by
tokens or money, use the dispatch handle and pass the plain provider `fetch` to the SDK:
the handle already reserves and settles one `requests` unit per turn. Wrapping the same
turn's transport in the request-metered fetch as well would count requests twice, and on a
scope with a token or money budget it still fails with `unsupported_budget_unit`.

## Focused verification

- `packages/providers/src/metered-dispatch.test.ts`: admission, refusals, replay, settlement
  below and above the estimate, partial and unknown settlement, leases, late settlement and
  the abandoned sweep.
- `packages/providers/src/ai-sdk.test.ts`: the adapter against real `streamText` calls.
- `packages/providers/src/token-pricing.test.ts`: exact pricing and its rounding property.
- `packages/store/conformance/settlement.ts`: the same command sequences and a generated
  model check on every Store.
- `packages/store-postgres/src/metered-dispatch.postgres.test.ts`: the handle on real
  Postgres with two independent pools.
