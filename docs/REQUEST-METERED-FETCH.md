# Request-metered fetch

`createRequestMeteredFetch` is a proposed additive export from `@usagekit/providers`.
It is not available in the published 0.9.1 release. The adapter reserves one `requests`
unit before each transport attempt and dispatches only after a first intent grant.
It uses the injected Meter and never creates its own Store, budget or credentials.

```ts
import { createRequestMeteredFetch } from "@usagekit/providers";

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
always unknown; the operation can therefore remain `pending`. For token or money
accounting, use a separate receipt-aware adapter with final stream evidence and durable
recovery. Never convert unknown cost to zero.

Only the `requests` estimate is supplied. A money or token budget requiring another unit
therefore fails closed instead of admitting an unpriced request. No monetary ceiling is
promised. Meter settlement failures stop delivery and attempt to cancel the body; they
never retry provider dispatch. Replayed reservations and denied intent grants also never
dispatch. Provider retries made by the caller are separate attempts with separate IDs.

## Cancellation and lifetime

An already-aborted signal performs no accounting. Cancellation after reservation but
before intent attempts release of that undispatched reservation. After intent, release
is forbidden: cancellation before transport records unknown request exposure, and
cancellation during transport records a dispatched attempt with unknown monetary cost.
The original Request/RequestInit signal is passed unchanged to the transport. The host
must keep transport duration below the configured dispatch lease or own renewal/recovery.

A request-local MemoryStore can enforce a two-attempt ceiling within one chat turn. It
cannot enforce a cross-request/monthly allowance, retain accounting after process exit,
recover unknown charges or coordinate multiple replicas. Use a durable Store for those
requirements. A separate durable abuse throttle is not a monetary budget.

## Focused verification

`packages/providers/src/request-metered-fetch.test.ts` covers admission, parallel calls,
replay, dispatch denial, exact streaming Response preservation, unknown cost, safe errors,
cancellation boundaries, HTTP errors and failed settlement. Full repository checks remain
required before any upstream release. This proposal changes no version or release status.
