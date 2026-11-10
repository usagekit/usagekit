# Metered dispatch

Design note for an unreleased addition to `@usagekit/providers`, after 0.10.0. It lets a host
enforce request, token and money budgets around one streaming model call: admit before the
call, settle with real usage when the stream ends.

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
that sum usage from finished steps, renew the lease, settle on `onEnd` and settle partial
usage on `onAbort` or `onStepError`. `ai` is an optional peer; the root export never imports it.

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
with `failed: true` and `certainty: "estimated"` when a step was interrupted. A host that
cannot estimate calls `settleUnknown`, which keeps the operation pending.

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
