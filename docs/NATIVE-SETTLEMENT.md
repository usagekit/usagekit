# Native usage settlement

This additive contract is an unreleased extension after 0.11.0. The seven published
packages require an owner-approved lockstep minor release before external adoption.
No package version is changed by this task.

## Freeze what must be known

Set `ReserveInput.settlementPolicy` before dispatch. It is copied into the operation
and participates in reservation identity. Reusing an operation ID with a different
policy conflicts. Omit the policy to retain the exact 0.11.0 settlement rules.

```ts
const settlementPolicy = {
  requiredUnits: ["input_tokens", "output_tokens", "cache_write_input_tokens_300s"],
  requireMoney: false,
} satisfies SettlementPolicy;
```

Every named unit must have a `measured` quantity, including an explicit measured zero
when the provider reports zero. Missing, unknown or estimated required quantities
keep the operation pending. Required units do not have to appear in the estimate.
Optional missing or unknown measurements do not keep the operation pending. If
`requireMoney` is true, cost must be measured; an estimate cannot satisfy it.

With complete native evidence and optional money, settle normally with
`cost: { certainty: "unknown", money: null }`. The lifecycle becomes settled, usage
reservations close and `unknownOperations` no longer includes that operation. Its
monetary aggregate still remains unknown. This does not authorize another dispatch:
command replay and expired leases never grant a replacement provider call.

`budget_cents` is an advisory measurement. Keep its certainty `estimated`; it is
never a required native unit and never supplies `Cost`. An applicable budget uses
that quantity in its own unit, including after settlement and correction. It is an
advisory budget valuation, not confirmed provider spend.

For a settled, non-linked operation, if the final receipt has no quantity for a
budgeted unit, the original reserved estimate for that unit counts as consumed.
This conservative fallback also applies to alerts and later corrections. A measured
zero is a real zero. Linked duplicates consume nothing. The fallback is budget
accounting only; it never manufactures a measurement or confirmed monetary cost.
For example, two calls reserving 5 `budget_cents` each exhaust a budget of 10 even
when both settle with only native token measurements. The application remains
responsible for validating provider evidence and any additional unobserved exposure.

## Close duplicate accounting

The host resolves the canonical operation from its authoritative native-request
identity. For a duplicate, submit a receipt with the same `providerRequestId`,
`canonicalOperationId` naming that operation, an empty measurements array, and
unknown/null cost. Supply normal lease, recovery or authorized late-evidence authority.

A canonical link represents a native provider request on a provider connection.
Both operations must carry the same defined `scope.connection`. If either connection
is absent, the Store refuses the link with `receipt_conflict`.

The Store verifies that the target is already settled, unlinked, and matches the
namespace, principal, connection, provider credential version, provider, operation,
funding/owner, credit attribution and policy. This verification runs in the same
transaction as settlement. PostgreSQL's connection accounting lock protects the
canonical evidence from concurrent corrections. A missing, mismatched or pending
target is a `receipt_conflict`; wait for canonical evidence and retry accounting.

The duplicate settles and releases its reservations. Aggregation omits it entirely;
its retained receipt does not invent zero usage or zero money. Corrections cannot
remove or retarget a canonical link, or change an established native request ID.
The canonical operation remains the sole correction authority for amounts. Once any
operation links to it, it cannot itself be corrected into a link; this is a typed
`receipt_conflict` and prevents chains.

This is explicit linkage, not automatic discovery. The host must supply the link
for duplicates; `providerRequestId` alone does not deduplicate unrelated operation IDs.

## Exact money precision

`Money` adds optional `scale`: cents = `units * 10^-scale`. An omitted scale remains
4, and old constructors, formatting, arithmetic and receipt shapes are unchanged.
Explicit scales are integers 0 through 18. Scale 4 is normalized to omission in
storage, replay identity and wire output. Other scales require a settlement policy
on the operation; a billing import with such a scale must match a policy operation.
No money arithmetic uses floating point.

```ts
const money = fromDecimalString("0.00000013", { scale: 8 });
// { currency: "USD", units: 13n, scale: 8 }
toDecimalString(money); // "0.00000013" cents
```

`addMoney`, `subtractMoney` and `compareMoney` align different scales exactly.
`moneyScale` returns the validated effective scale. `formatMoney` preserves declared
precision. Parsing rejects excess digits rather than rounding. Store receipt units
retain their signed-bigint storage bound; a finer scale reduces the maximum amount
that fits in one receipt. Aggregated totals can exceed that per-receipt bound.

Quantity measurements for money must use the same explicit scale. The library does
not derive `Cost` from a measurement or a budget estimate. Billing reconciliation
adds optional `differenceScale`, with omitted scale still meaning 4. `differenceUnits`
is the signed difference at that scale. PostgreSQL migration 2, SQLite migration 7
and Cloudflare migration 3 persist `cost_scale` beside `cost_units`, backfilling
legacy rows with 4 and retaining any already stored JSON scale. Readers must read
both columns. Money totals and reconciliation differences are aligned with bigint
in application code, never summed as unqualified SQL `cost_units`. Reconciliation
journals persist decimal strings in JSON/JSONB, so aligned values beyond signed
64-bit range remain exact. Bounded quantity projections refuse overflow atomically
with `InvalidInput`: SQLite/Cloudflare check their signed 64-bit quantity bound,
and PostgreSQL translates numeric storage overflow from pg and Prisma.
Each individual receipt still has a typed refusal for
units outside the signed 64-bit storage bound. See the mandatory
[reader-before-writer upgrade order](CONSUMING.md#upgrade-order-for-the-unreleased-native-settlement-extension).

Consumers must use money helpers instead of treating every `units` field as fixed
1e-4 cents. Upgrading to 0.11.0 alone provides token/money budget dispatch but does
not provide native settlement with unknown money, canonical links or finer money.
