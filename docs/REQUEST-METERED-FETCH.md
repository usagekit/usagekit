# Request-metered fetch

`createRequestMeteredFetch` is an additive export from `@usagekit/providers`, new in the
0.10.0 source candidate. The adapter reserves one `requests` unit before each transport
attempt and dispatches only after a first intent grant. It uses the injected Meter and
never creates its own Store, budget or credentials.

```ts
import { createRequestMeteredFetch, RequestMeteringError } from "@usagekit/providers";

const meteredFetch = createRequestMeteredFetch({
  meter, // A host-configured Meter with authorized budgets and the intended durability.
  operation: {
    scope: { namespace: "my-service", principal: verifiedUserId, connection: connectionId },
    fundingSource: "byok",
    costOwner: verifiedUserId,
    surface: "app",
    source: "app",
    provider: "my-provider",
    operation: "generate",
  },
  createOperationId: () => crypto.randomUUID(),
  fetch: guardedProviderFetch,
});
```

Pass `meteredFetch` to a provider SDK that accepts a Fetch implementation. The host
continues to own SDK retry settings, endpoint allowlists, redirect policy, credential
injection, authentication, authorization and cancellation/timeouts. This adapter does
not make an arbitrary URL or API key safe. Request bodies, headers and URLs never enter
Meter accounting. Errors are fixed codes and never retain a transport error as `cause`.

## What is counted

A request is one call to the injected transport, not a successful provider operation.
HTTP errors and rejected transport calls count as dispatched attempts. No response body
is consumed, cloned or buffered, so a streaming SDK receives the original Response.
Settlement records request count when response headers arrive (or transport rejects).
It does not claim that streaming completed or that the provider charged a known amount.
A later stream failure remains outside this request-only receipt. Monetary cost is
always unknown; the operation can therefore remain `pending` and keep its reservation.
For token or money accounting, use [metered dispatch](METERED-DISPATCH.md), which settles a
turn with its final stream usage and resolves abandoned turns. Never convert unknown cost to
zero.

No monetary ceiling is promised. Meter settlement failures stop delivery and attempt to
cancel the body; they never retry provider dispatch. Replayed reservations and denied
intent grants also never dispatch. Provider retries made by the caller are separate
attempts with separate IDs. A BYOK connection whose tracking policy is `passthrough` for
the operation is counted by the Meter, never reserved, and forwarded unchanged without
settlement; a replayed passthrough never dispatches.

## Budgets on the same scope

The adapter only knows the request count, so its estimate is `requests` alone. The
Meter requires an estimate in the unit of every budget that applies to the operation.
When a money or token budget (for example `customer_cents` or `tokens`) applies to the
same scope, surface and source, every call fails before any reservation or dispatch with
`RequestMeteringError` code `unsupported_budget_unit`, and `error.unit` names the budget
unit the adapter cannot cover. This is deliberate: admitting the call without that unit
would bypass the money or token bound. The adapter is created synchronously and cannot
read budgets, so the check happens on the first call rather than at construction.

Treat `unsupported_budget_unit` as a configuration error for operators, not a user limit.
Either keep request-only metering on a scope whose applicable budgets are all `requests`
(for example a dedicated connection or surface), or meter that traffic with
[metered dispatch](METERED-DISPATCH.md), the unreleased dispatch handle that reserves an
estimate in the money or token unit and settles the actual amount. The two are alternatives
for one turn, not layers: the handle already counts one `requests` unit per turn, so its SDK
call takes the plain provider `fetch`. See
[how the two relate](METERED-DISPATCH.md#relation-to-request-metered-fetch).

## Errors

`RequestMeteringError` has a fixed `code` and the same text as `message`:

| Code                      | Meaning                                                                       |
| ------------------------- | ----------------------------------------------------------------------------- |
| `admission_denied`        | The Meter refused the reservation: budget, replay, conflict or invalid input. |
| `unsupported_budget_unit` | A non-request budget applies to this scope; see `unit`.                       |
| `dispatch_denied`         | No dispatch intent grant, so the transport was not called.                    |
| `accounting_failed`       | Settlement failed after transport; the body was cancelled.                    |
| `transport_failed`        | The transport rejected; the attempt was settled as failed.                    |

When a budget denied admission, `error.exceeded` carries the Meter's `AllowanceExceeded`:
the budget (id, scope, unit, limit and window), the crossed `boundary` (`limit` or
`hardLimit`), `used`, `reserved` and `resetsAt`. A caller can tell the user which limit
was hit and when it resets. Request-only operations settle with unknown cost and stay
`pending`, so their requests appear in `reserved`, not `used`. Other admission denials
leave `exceeded` undefined. The detail contains budget configuration only, never request
content or credentials; it is still the host's decision what to show a given user.

## Cancellation and lifetime

An already-aborted signal performs no accounting. Cancellation after reservation but
before intent attempts release of that undispatched reservation. After intent, release
is forbidden: cancellation before transport records unknown request exposure, and
cancellation during transport records a dispatched attempt with unknown monetary cost.
The original Request/RequestInit signal is passed unchanged to the transport. The host
must keep transport duration below the configured dispatch lease or own renewal/recovery.

A request-local MemoryStore can enforce a two-attempt ceiling within one chat turn. It
cannot enforce a cross-request/monthly allowance, retain accounting after process exit,
recover unknown charges or coordinate multiple replicas. Use a durable Store such as
`@usagekit/store-postgres` for those requirements. A separate durable abuse throttle is
not a monetary budget.

## Focused verification

`packages/providers/src/request-metered-fetch.test.ts` covers admission, parallel calls,
replay, dispatch denial, exact streaming Response preservation, unknown cost, safe errors,
exceeded-budget detail, money and token budgets on the same scope, passthrough tracking,
cancellation boundaries, HTTP errors and failed settlement.
