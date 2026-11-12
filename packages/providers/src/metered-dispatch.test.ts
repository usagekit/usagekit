import { afterEach, describe, expect, it, vi } from "vitest";
import { createMeter } from "@usagekit/meter";
import { createManualClock, createMemoryStore } from "@usagekit/store";
import type { AccessContext, Budget, Cost, Quantity } from "@usagekit/core";
import { createMeteredDispatch } from "./metered-dispatch.js";
import type { DispatchAdmission, MeteredDispatch } from "./metered-dispatch.js";

const q = (unit: string, value: bigint, scale = 0): Quantity => ({ unit, value, scale });
const scope = { namespace: "app", principal: "user-1", group: "team-1", connection: "platform" };
const teamBudget = (unit: string, limit: bigint, overrides: Partial<Budget> = {}): Budget => ({
  id: `team-${unit}`,
  version: 1,
  scope: { kind: "group", namespace: "app", group: "team-1" },
  surface: "any",
  unit,
  limit: q(unit, limit),
  window: { kind: "calendar_month", timezone: "UTC" },
  onExceed: "block",
  ...overrides,
});
const access: AccessContext = {
  namespace: "app",
  readablePrincipals: "*",
  readableGroups: "*",
  readablePools: "*",
  canReadBillingDetail: true,
  canManageBudgets: true,
};
const cost = (units: bigint): Cost => ({
  certainty: "estimated",
  money: { units, currency: "USD" },
});
const month = { from: "2026-11-01T00:00:00.000Z", to: "2026-12-01T00:00:00.000Z" };
function setup(
  budgets: Budget[] = [
    teamBudget("requests", 100n),
    teamBudget("tokens", 10_000n),
    teamBudget("customer_cents", 50n),
  ],
  options: {
    holder?: string;
    renewEveryMs?: number;
    leaseTtlMs?: number;
    maxOpenMs?: number;
  } = {},
) {
  const clock = createManualClock("2026-11-10T12:00:00.000Z");
  const store = createMemoryStore({ clock, budgets });
  const meter = createMeter({ store, clock });
  const dispatcher = createMeteredDispatch({
    meter,
    now: clock.now,
    renewEveryMs: 0,
    leaseTtlMs: 60_000,
    ...options,
  });
  const admission = (id: string, tokens = 4000n, cents = 20n): DispatchAdmission => ({
    id,
    operation: {
      scope,
      fundingSource: "platform",
      costOwner: "platform",
      surface: "app",
      source: "app",
      provider: "anthropic",
      operation: "model-a",
    },
    estimate: [q("tokens", tokens), q("customer_cents", cents)],
  });
  const admit = async (id: string, tokens?: bigint, cents?: bigint): Promise<MeteredDispatch> => {
    const result = await dispatcher.admit(admission(id, tokens, cents));
    if (result.outcome !== "admitted") throw new Error(`fixture: ${JSON.stringify(result.reason)}`);
    return result.dispatch;
  };
  const figures = async (unit: string) => {
    const statuses = await store.applicableBudgets({
      scope,
      surface: "app",
      source: "app",
      units: [unit],
    });
    const status = statuses.find((s) => s.budget.unit === unit)!;
    return {
      used: status.used!.value,
      reserved: status.reserved!.value,
      scale: status.used!.scale,
    };
  };
  const operation = (id: string) =>
    store.getOperation({ namespace: "app", principal: "user-1", operationId: id });
  return { clock, store, meter, dispatcher, admission, admit, figures, operation };
}
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("metered dispatch admission", () => {
  it("reserves the estimate in every applicable budget and grants one dispatch", async () => {
    const h = setup();
    const result = await h.dispatcher.admit(h.admission("turn-1"));
    expect(result).toMatchObject({ outcome: "admitted", warnings: [], alerts: [] });
    if (result.outcome !== "admitted") throw new Error("fixture");
    expect(result.dispatch).toMatchObject({ id: "turn-1", tracking: "metered" });
    expect(result.dispatch.reserved).toEqual([
      q("requests", 1n),
      q("tokens", 4000n),
      q("customer_cents", 20n),
    ]);
    expect(await h.figures("requests")).toMatchObject({ used: 0n, reserved: 1n });
    expect(await h.figures("tokens")).toMatchObject({ used: 0n, reserved: 4000n });
    expect(await h.figures("customer_cents")).toMatchObject({ used: 0n, reserved: 20n });
    expect(await h.operation("turn-1")).toMatchObject({
      state: "dispatch_intended",
      lease: { holder: "metered-dispatch", expiresAt: "2026-11-10T12:01:00.000Z" },
    });
  });
  it("refuses with the budget that is short, for tokens and for money", async () => {
    const h = setup();
    await h.admit("turn-1", 8000n, 10n);
    expect(await h.dispatcher.admit(h.admission("turn-2", 4000n, 10n))).toMatchObject({
      outcome: "refused",
      reason: "budget_exceeded",
      exceeded: {
        code: "allowance_exceeded",
        boundary: "limit",
        budget: { id: "team-tokens", unit: "tokens", limit: { value: 10_000n } },
        used: { value: 0n },
        reserved: { value: 8000n },
        resetsAt: "2026-12-01T00:00:00.000Z",
      },
    });
    expect(await h.dispatcher.admit(h.admission("turn-3", 1000n, 45n))).toMatchObject({
      outcome: "refused",
      reason: "budget_exceeded",
      exceeded: { budget: { id: "team-customer_cents" }, reserved: { value: 10n } },
    });
    expect(await h.operation("turn-2")).toBeNull();
    expect(await h.figures("tokens")).toMatchObject({ reserved: 8000n });
  });
  it("parallel admits never pass a blocking limit together", async () => {
    const h = setup();
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, n) => h.dispatcher.admit(h.admission(`turn-${n}`, 3000n, 1n))),
    );
    expect(results.filter((r) => r.outcome === "admitted")).toHaveLength(3);
    expect(
      results.filter((r) => r.outcome === "refused" && r.reason === "budget_exceeded"),
    ).toHaveLength(9);
    expect(await h.figures("tokens")).toMatchObject({ reserved: 9000n });
  });
  it("reports a budget unit that the estimate does not cover and reserves nothing", async () => {
    const h = setup([teamBudget("tokens", 10_000n), teamBudget("images", 5n)]);
    expect(await h.dispatcher.admit(h.admission("turn-1"))).toEqual({
      outcome: "refused",
      reason: "unsupported_budget_unit",
      unit: "images",
    });
    expect(await h.operation("turn-1")).toBeNull();
    expect(await h.figures("tokens")).toMatchObject({ reserved: 0n });
  });
  it("a repeated admit never grants a second dispatch or reserves twice", async () => {
    const h = setup();
    await h.admit("turn-1");
    expect(await h.dispatcher.admit(h.admission("turn-1"))).toMatchObject({
      outcome: "refused",
      reason: "replayed",
      operation: { operationId: "turn-1", state: "dispatch_intended" },
    });
    expect(await h.dispatcher.admit(h.admission("turn-1", 5000n))).toMatchObject({
      outcome: "refused",
      reason: "conflict",
    });
    expect(await h.figures("tokens")).toMatchObject({ reserved: 4000n });
    expect(await h.figures("requests")).toMatchObject({ reserved: 1n });
  });
  it("keeps a host-supplied requests estimate instead of adding one", async () => {
    const h = setup();
    const input = h.admission("turn-1");
    const result = await h.dispatcher.admit({
      ...input,
      estimate: [...input.estimate, q("requests", 3n)],
    });
    if (result.outcome !== "admitted") throw new Error("fixture");
    expect(await h.figures("requests")).toMatchObject({ reserved: 3n });
    expect(
      await result.dispatch.settle({
        usage: [q("tokens", 1n), q("customer_cents", 1n)],
        cost: cost(1n),
      }),
    ).toEqual({ outcome: "rejected", reason: "missing_usage_unit", unit: "requests" });
  });
  it("returns invalid input as data", async () => {
    const h = setup();
    expect(
      await h.dispatcher.admit({ ...h.admission("turn-1"), estimate: [q("tokens", -1n)] }),
    ).toMatchObject({ outcome: "refused", reason: "invalid", field: "estimate" });
  });
  it("releases the reservation when dispatch intent is denied", async () => {
    const h = setup();
    vi.spyOn(h.meter, "markDispatchIntent").mockResolvedValue({
      granted: false,
      operation: null,
      reason: "version_conflict",
    });
    expect(await h.dispatcher.admit(h.admission("turn-1"))).toEqual({
      outcome: "refused",
      reason: "dispatch_denied",
      detail: "version_conflict",
    });
    expect(await h.operation("turn-1")).toMatchObject({ state: "released" });
    expect(await h.figures("tokens")).toMatchObject({ reserved: 0n });
  });
  it("releases the reservation and rethrows when marking intent fails", async () => {
    const h = setup();
    vi.spyOn(h.meter, "markDispatchIntent").mockRejectedValue(new Error("storage down"));
    await expect(h.dispatcher.admit(h.admission("turn-1"))).rejects.toThrow("storage down");
    expect(await h.operation("turn-1")).toMatchObject({ state: "released" });
  });
  it("forwards a passthrough connection without accounting", async () => {
    const h = setup();
    vi.spyOn(h.meter, "reserve").mockResolvedValue({
      outcome: "passthrough",
      replayed: false,
      operation: null,
    });
    const result = await h.dispatcher.admit(h.admission("turn-1"));
    if (result.outcome !== "admitted") throw new Error("fixture");
    expect(result.dispatch.tracking).toBe("passthrough");
    expect(await result.dispatch.renew()).toEqual({ renewed: false, reason: "untracked" });
    expect(await result.dispatch.settle({ usage: [], cost: cost(0n) })).toEqual({
      outcome: "untracked",
    });
    vi.spyOn(h.meter, "reserve").mockResolvedValue({
      outcome: "passthrough",
      replayed: true,
      operation: null,
    });
    expect(await h.dispatcher.admit(h.admission("turn-1"))).toMatchObject({
      outcome: "refused",
      reason: "replayed",
    });
  });
});

describe("metered dispatch settlement", () => {
  it("settling below the estimate returns the difference to every budget", async () => {
    const h = setup();
    const dispatch = await h.admit("turn-1");
    const settled = await dispatch.settle({
      usage: [q("tokens", 1500n), q("customer_cents", 73_500n, 4)],
      cost: cost(73_500n),
    });
    expect(settled).toMatchObject({
      outcome: "settled",
      replayed: false,
      via: "lease",
      overshoot: [],
      operation: { state: "settled", lease: null },
    });
    expect(await h.figures("tokens")).toMatchObject({ used: 1500n, reserved: 0n });
    expect(await h.figures("customer_cents")).toEqual({ used: 73_500n, reserved: 0n, scale: 4 });
    expect(await h.figures("requests")).toMatchObject({ used: 1n, reserved: 0n });
    expect((await h.operation("turn-1"))!.receipts).toMatchObject([
      {
        id: "turn-1:receipt",
        failed: false,
        occurredAt: "2026-11-10T12:00:00.000Z",
        measurements: [
          { unit: "tokens", certainty: "measured" },
          { unit: "customer_cents", certainty: "measured" },
          { unit: "requests", certainty: "measured", quantity: { value: 1n } },
        ],
      },
    ]);
  });
  it("settling above the estimate is recorded in full and reported as overshoot", async () => {
    const h = setup();
    const dispatch = await h.admit("turn-1", 4000n, 20n);
    expect(
      await dispatch.settle({
        usage: [q("tokens", 9500n), q("customer_cents", 205n, 1)],
        cost: cost(205_000n),
      }),
    ).toMatchObject({
      outcome: "settled",
      overshoot: [q("tokens", 5500n), q("customer_cents", 5n, 1)],
    });
    expect(await h.figures("tokens")).toMatchObject({ used: 9500n, reserved: 0n });
    expect(await h.dispatcher.admit(h.admission("turn-2", 1000n, 1n))).toMatchObject({
      outcome: "refused",
      reason: "budget_exceeded",
      exceeded: { budget: { id: "team-tokens" }, used: { value: 9500n } },
    });
  });
  it("a failed or aborted turn settles what it spent", async () => {
    const h = setup();
    const dispatch = await h.admit("turn-1");
    expect(
      await dispatch.settle({
        usage: [q("tokens", 900n), q("customer_cents", 3n)],
        cost: cost(30_000n),
        certainty: "estimated",
        failed: true,
      }),
    ).toMatchObject({ outcome: "settled", operation: { state: "settled" } });
    expect((await h.operation("turn-1"))!.receipts[0]).toMatchObject({
      failed: true,
      measurements: [
        { unit: "tokens", certainty: "estimated", quantity: { value: 900n } },
        { unit: "customer_cents", certainty: "estimated" },
        { unit: "requests", certainty: "measured" },
      ],
    });
    expect(await h.figures("tokens")).toMatchObject({ used: 900n, reserved: 0n });
  });
  it("a turn that never called the model returns its whole token and money reservation", async () => {
    const h = setup();
    const dispatch = await h.admit("turn-1");
    expect(
      await dispatch.settle({
        usage: [q("tokens", 0n), q("customer_cents", 0n)],
        cost: { certainty: "measured", money: { units: 0n, currency: "USD" } },
        failed: true,
      }),
    ).toMatchObject({ outcome: "settled", overshoot: [] });
    expect(await h.figures("tokens")).toMatchObject({ used: 0n, reserved: 0n });
    expect(await h.figures("customer_cents")).toMatchObject({ used: 0n, reserved: 0n });
  });
  it("rejects usage that omits a reserved unit before any command", async () => {
    const h = setup();
    const dispatch = await h.admit("turn-1");
    const settle = vi.spyOn(h.meter, "settle");
    expect(await dispatch.settle({ usage: [q("tokens", 900n)], cost: cost(1n) })).toEqual({
      outcome: "rejected",
      reason: "missing_usage_unit",
      unit: "customer_cents",
    });
    expect(
      await dispatch.settle({ usage: [q("tokens", 1n), q("tokens", 2n)], cost: cost(1n) }),
    ).toMatchObject({ outcome: "rejected", reason: "invalid" });
    expect(settle).not.toHaveBeenCalled();
    expect(await h.figures("customer_cents")).toMatchObject({ used: 0n, reserved: 20n });
    expect(
      await dispatch.settle({
        usage: [q("tokens", 900n), q("customer_cents", 2n)],
        cost: cost(1n),
      }),
    ).toMatchObject({ outcome: "settled" });
  });
  it("settles explicit request usage after automatic request admission", async () => {
    const h = setup();
    const dispatch = await h.admit("turn-1");
    expect(
      await dispatch.settle({
        usage: [q("requests", 1n), q("tokens", 1500n), q("customer_cents", 7n)],
        cost: cost(70_000n),
      }),
    ).toMatchObject({ outcome: "settled", via: "lease", overshoot: [] });
    expect(await h.figures("requests")).toMatchObject({ used: 1n, reserved: 0n });
    expect(await h.figures("tokens")).toMatchObject({ used: 1500n, reserved: 0n });
    expect((await h.operation("turn-1"))!.receipts[0]!.measurements).toMatchObject([
      { unit: "requests", certainty: "measured", quantity: { value: 1n } },
      { unit: "tokens" },
      { unit: "customer_cents" },
    ]);
  });
  it("a repeated settle keeps the first receipt and never counts twice", async () => {
    const h = setup();
    const dispatch = await h.admit("turn-1");
    const usage = [q("tokens", 1500n), q("customer_cents", 7n)];
    const first = await dispatch.settle({ usage, cost: cost(70_000n) });
    h.clock.advance(5000);
    const second = await dispatch.settle({
      usage: [q("tokens", 9000n), q("customer_cents", 40n)],
      cost: cost(1n),
    });
    expect(second).toEqual({ ...first, replayed: true });
    expect(await h.figures("tokens")).toMatchObject({ used: 1500n, reserved: 0n });
    expect((await h.operation("turn-1"))!.receipts).toHaveLength(1);
  });
  it("replays the stored result when the first attempt committed but its answer was lost", async () => {
    const h = setup();
    const dispatch = await h.admit("turn-1");
    const real = h.meter.settle.bind(h.meter);
    vi.spyOn(h.meter, "settle").mockImplementationOnce(async (input) => {
      await real(input);
      throw new Error("connection reset");
    });
    const input = { usage: [q("tokens", 1500n), q("customer_cents", 7n)], cost: cost(70_000n) };
    await expect(dispatch.settle(input)).rejects.toThrow("connection reset");
    h.clock.advance(1000);
    expect(await dispatch.settle(input)).toMatchObject({ outcome: "settled", replayed: true });
    expect(await h.figures("tokens")).toMatchObject({ used: 1500n, reserved: 0n });
    expect((await h.operation("turn-1"))!.receipts).toHaveLength(1);
  });
  it("a corrected settle succeeds after the Meter rejected invalid evidence", async () => {
    vi.useFakeTimers();
    const h = setup(undefined, { renewEveryMs: 20_000 });
    const renew = vi.spyOn(h.meter, "renewLease");
    const dispatch = await h.admit("turn-1");
    expect(
      await dispatch.settle({
        usage: [q("tokens", -1n), q("customer_cents", 7n)],
        cost: cost(70_000n),
      }),
    ).toMatchObject({ outcome: "rejected", reason: "invalid" });
    expect(await h.operation("turn-1")).toMatchObject({ state: "dispatch_intended", receipts: [] });
    // Nothing was recorded, so the dispatch is still open and its lease keeps renewing.
    h.clock.advance(20_000);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(renew).toHaveBeenCalledTimes(1);
    expect(
      await dispatch.settle({
        usage: [q("tokens", 20n), q("customer_cents", 7n)],
        cost: cost(70_000n),
      }),
    ).toMatchObject({ outcome: "settled", replayed: false, via: "lease" });
    expect(await h.figures("tokens")).toMatchObject({ used: 20n, reserved: 0n });
    expect((await h.operation("turn-1"))!.receipts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(renew).toHaveBeenCalledTimes(1);
  });
  it("a retry after a failure of unknown outcome still submits the first evidence", async () => {
    vi.useFakeTimers();
    const h = setup(undefined, { renewEveryMs: 20_000 });
    const renew = vi.spyOn(h.meter, "renewLease");
    const dispatch = await h.admit("turn-1");
    const settle = vi.spyOn(h.meter, "settle").mockRejectedValueOnce(new Error("connection reset"));
    const first = { usage: [q("tokens", 1500n), q("customer_cents", 7n)], cost: cost(70_000n) };
    await expect(dispatch.settle(first)).rejects.toThrow("connection reset");
    // The command may have committed: renewal stops and the evidence is kept.
    await vi.advanceTimersByTimeAsync(40_000);
    expect(renew).not.toHaveBeenCalled();
    expect(
      await dispatch.settle({
        usage: [q("tokens", 9000n), q("customer_cents", 40n)],
        cost: cost(1n),
      }),
    ).toMatchObject({ outcome: "settled", replayed: false });
    expect(settle.mock.calls[1]![0].receipt).toEqual(settle.mock.calls[0]![0].receipt);
    expect(await h.figures("tokens")).toMatchObject({ used: 1500n, reserved: 0n });
    expect((await h.operation("turn-1"))!.receipts).toHaveLength(1);
  });
  it("an unknown cost keeps the operation pending with its whole reservation", async () => {
    const h = setup();
    const dispatch = await h.admit("turn-1");
    expect(
      await dispatch.settle({
        usage: [q("tokens", 100n), q("customer_cents", 1n)],
        cost: { certainty: "unknown", money: null },
      }),
    ).toMatchObject({ outcome: "pending", via: "lease", operation: { state: "pending" } });
    expect(await h.figures("tokens")).toMatchObject({ used: 0n, reserved: 4000n });
  });
  it("settleUnknown records no invented amounts and keeps the reservation", async () => {
    const h = setup();
    const dispatch = await h.admit("turn-1");
    expect(await dispatch.settleUnknown({ failed: true })).toMatchObject({
      outcome: "pending",
      operation: {
        state: "pending",
        receipts: [
          {
            failed: true,
            cost: { certainty: "unknown", money: null },
            measurements: [
              { unit: "requests", certainty: "measured" },
              { unit: "tokens", certainty: "unknown", quantity: null },
              { unit: "customer_cents", certainty: "unknown", quantity: null },
            ],
          },
        ],
      },
    });
    expect(await h.figures("tokens")).toMatchObject({ used: 0n, reserved: 4000n });
    expect(await h.figures("customer_cents")).toMatchObject({ used: 0n, reserved: 20n });
  });
});

describe("metered dispatch leases", () => {
  it("renew extends the lease and stops after settlement", async () => {
    const h = setup();
    const dispatch = await h.admit("turn-1");
    h.clock.advance(50_000);
    expect(await dispatch.renew()).toEqual({
      renewed: true,
      expiresAt: "2026-11-10T12:01:50.000Z",
    });
    h.clock.advance(50_000);
    expect(
      await dispatch.settle({ usage: [q("tokens", 1n), q("customer_cents", 1n)], cost: cost(1n) }),
    ).toMatchObject({ outcome: "settled", via: "lease" });
    expect(await dispatch.renew()).toEqual({ renewed: false, reason: "settled" });
  });
  it("renews on a timer while the stream runs and stops when it settles", async () => {
    vi.useFakeTimers();
    const h = setup(undefined, { renewEveryMs: 20_000 });
    const renew = vi.spyOn(h.meter, "renewLease");
    const dispatch = await h.admit("turn-1");
    h.clock.advance(20_000);
    await vi.advanceTimersByTimeAsync(20_000);
    h.clock.advance(20_000);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(renew).toHaveBeenCalledTimes(2);
    expect((await h.operation("turn-1"))!.lease!.expiresAt).toBe("2026-11-10T12:01:40.000Z");
    await dispatch.settle({ usage: [q("tokens", 1n), q("customer_cents", 1n)], cost: cost(1n) });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(renew).toHaveBeenCalledTimes(2);
  });
  it("the heartbeat stops after maxOpenMs, so a dispatch nobody settles becomes abandoned", async () => {
    vi.useFakeTimers();
    const h = setup(undefined, { renewEveryMs: 20_000, maxOpenMs: 90_000 });
    const renew = vi.spyOn(h.meter, "renewLease");
    await h.admit("turn-1");
    for (let n = 0; n < 10; n++) {
      h.clock.advance(20_000);
      await vi.advanceTimersByTimeAsync(20_000);
    }
    // Renewed at 20, 40, 60 and 80 seconds; the lease then runs out at 140 seconds.
    expect(renew).toHaveBeenCalledTimes(4);
    expect(await h.dispatcher.settleAbandoned({ access, scope: scopeAll, ...month })).toMatchObject(
      { examined: 1, pending: 1 },
    );
  });
  it("defaults the heartbeat to a third of the lease", async () => {
    vi.useFakeTimers();
    const clock = createManualClock("2026-11-10T12:00:00.000Z");
    const meter = createMeter({ store: createMemoryStore({ clock, budgets: [] }), clock });
    const renew = vi.spyOn(meter, "renewLease");
    const h = setup();
    const result = await createMeteredDispatch({ meter, now: clock.now }).admit(
      h.admission("turn-1"),
    );
    if (result.outcome !== "admitted") throw new Error("fixture");
    await vi.advanceTimersByTimeAsync(39_999);
    expect(renew).toHaveBeenCalledTimes(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(renew).toHaveBeenCalledTimes(1);
    await result.dispatch.settleUnknown();
  });
  it("a turn that outlives its lease still settles once, through recovery authority", async () => {
    const h = setup();
    const dispatch = await h.admit("turn-1");
    h.clock.advance(60_000);
    expect(await dispatch.renew()).toEqual({ renewed: false, reason: "expired" });
    expect(
      await dispatch.settle({
        usage: [q("tokens", 2500n), q("customer_cents", 9n)],
        cost: cost(90_000n),
      }),
    ).toMatchObject({ outcome: "settled", via: "recovery", operation: { state: "settled" } });
    expect(await h.figures("tokens")).toMatchObject({ used: 2500n, reserved: 0n });
    expect((await h.operation("turn-1"))!.receipts).toHaveLength(1);
  });
  it("duplicate settles racing lease expiry record one receipt and count once", async () => {
    const h = setup();
    const dispatch = await h.admit("turn-1");
    const input = { usage: [q("tokens", 1500n), q("customer_cents", 7n)], cost: cost(70_000n) };
    h.clock.advance(59_999);
    const inTime = dispatch.settle(input);
    h.clock.advance(1);
    const outcomes = await Promise.all([inTime, dispatch.settle(input), dispatch.settle(input)]);
    expect(outcomes.filter((o) => o.outcome === "settled" && !o.replayed)).toHaveLength(1);
    for (const outcome of outcomes)
      if (outcome.outcome === "rejected") expect(outcome.reason).toBe("lease_lost");
    expect(await dispatch.settle(input)).toMatchObject({ outcome: "settled", replayed: true });
    expect((await h.operation("turn-1"))!.receipts).toMatchObject([{ id: "turn-1:receipt" }]);
    expect(await h.figures("tokens")).toMatchObject({ used: 1500n, reserved: 0n });
    expect(await h.figures("requests")).toMatchObject({ used: 1n, reserved: 0n });
    // The same duplicates when every one of them starts after the lease expired.
    const late = await h.admit("turn-2");
    h.clock.advance(60_000);
    const recovered = await Promise.all([late.settle(input), late.settle(input)]);
    expect(recovered.filter((o) => o.outcome === "settled" && !o.replayed)).toHaveLength(1);
    expect(await late.settle(input)).toMatchObject({ outcome: "settled", replayed: true });
    expect((await h.operation("turn-2"))!.receipts).toHaveLength(1);
    expect(await h.figures("tokens")).toMatchObject({ used: 3000n, reserved: 0n });
  });
  it("reports lease_lost while another holder recovers and settles on a later retry", async () => {
    const h = setup();
    const dispatch = await h.admit("turn-1");
    h.clock.advance(60_000);
    const claim = await h.meter.claimForRecovery({
      namespace: "app",
      principal: "user-1",
      operationId: "turn-1",
      holder: "other-worker",
      leaseTtlMs: 30_000,
    });
    expect(claim).toMatchObject({ claimed: true });
    const input = { usage: [q("tokens", 2500n), q("customer_cents", 9n)], cost: cost(90_000n) };
    expect(await dispatch.settle(input)).toMatchObject({
      outcome: "rejected",
      reason: "lease_lost",
      operation: { state: "dispatch_intended" },
    });
    expect(await h.figures("tokens")).toMatchObject({ used: 0n, reserved: 4000n });
    h.clock.advance(30_000);
    expect(await dispatch.settle(input)).toMatchObject({ outcome: "settled", via: "recovery" });
    expect(await h.figures("tokens")).toMatchObject({ used: 2500n, reserved: 0n });
  });
});

describe("abandoned dispatches", () => {
  it("lease expiry releases nothing: the whole reservation keeps counting", async () => {
    const h = setup();
    await h.admit("turn-1", 8000n, 10n);
    h.clock.advance(24 * 3600_000);
    await h.meter.expireReservations({ namespace: "app" });
    expect(await h.operation("turn-1")).toMatchObject({ state: "dispatch_intended" });
    expect(await h.figures("tokens")).toMatchObject({ used: 0n, reserved: 8000n });
    expect(await h.dispatcher.admit(h.admission("turn-2", 4000n, 1n))).toMatchObject({
      outcome: "refused",
      reason: "budget_exceeded",
    });
  });
  it("the sweep charges the whole reservation as estimated and failed", async () => {
    const h = setup();
    await h.admit("turn-1", 3000n, 10n);
    await h.admit("turn-2", 2000n, 5n);
    const live = await h.admit("turn-3", 1000n, 1n);
    h.clock.advance(59_000);
    await live.renew();
    h.clock.advance(1000);
    const swept = await h.dispatcher.settleAbandoned({
      access,
      scope: { kind: "namespace", namespace: "app" },
      ...month,
      cost: (operation) => (operation.operationId === "turn-1" ? cost(100_000n) : undefined),
    });
    expect(swept).toEqual({
      outcome: "swept",
      examined: 3,
      charged: 1,
      pending: 1,
      skipped: 1,
    });
    expect(await h.operation("turn-1")).toMatchObject({
      state: "settled",
      lease: null,
      receipts: [
        {
          id: "turn-1:abandoned",
          failed: true,
          cost: { certainty: "estimated" },
          measurements: [
            { unit: "requests", certainty: "estimated", quantity: { value: 1n } },
            { unit: "tokens", certainty: "estimated", quantity: { value: 3000n } },
            { unit: "customer_cents", certainty: "estimated", quantity: { value: 10n } },
          ],
        },
      ],
    });
    expect(await h.operation("turn-2")).toMatchObject({ state: "pending" });
    expect(await h.operation("turn-3")).toMatchObject({ state: "dispatch_intended" });
    // Charged, pending and live: every one still counts in full.
    expect(await h.figures("tokens")).toMatchObject({ used: 3000n, reserved: 3000n });
    expect(await h.dispatcher.settleAbandoned({ access, ...month, scope: scopeAll })).toEqual({
      outcome: "swept",
      examined: 1,
      charged: 0,
      pending: 0,
      skipped: 1,
    });
  });
  it("never touches another holder's operations", async () => {
    const h = setup();
    await h.admit("turn-1");
    const other = createMeteredDispatch({
      meter: h.meter,
      now: h.clock.now,
      holder: "other-adapter",
      renewEveryMs: 0,
      leaseTtlMs: 60_000,
    });
    h.clock.advance(60_000);
    expect(await other.settleAbandoned({ access, scope: scopeAll, ...month })).toMatchObject({
      examined: 1,
      charged: 0,
      pending: 0,
      skipped: 1,
    });
    expect(await h.operation("turn-1")).toMatchObject({ state: "dispatch_intended", receipts: [] });
  });
  it("pages with a cursor and returns read refusals as data", async () => {
    const h = setup();
    for (const id of ["turn-1", "turn-2", "turn-3"]) {
      await h.admit(id, 1000n, 1n);
      h.clock.advance(1000);
    }
    h.clock.advance(60_000);
    const first = await h.dispatcher.settleAbandoned({
      access,
      scope: scopeAll,
      ...month,
      limit: 2,
    });
    expect(first).toMatchObject({ outcome: "swept", examined: 2, pending: 2 });
    if (first.outcome !== "swept" || !first.nextCursor) throw new Error("fixture");
    expect(
      await h.dispatcher.settleAbandoned({
        access,
        scope: scopeAll,
        ...month,
        limit: 2,
        cursor: first.nextCursor,
      }),
    ).toEqual({ outcome: "swept", examined: 1, charged: 0, pending: 1, skipped: 0 });
    expect(
      await h.dispatcher.settleAbandoned({
        access: { ...access, canReadBillingDetail: false },
        scope: scopeAll,
        ...month,
      }),
    ).toEqual({ outcome: "forbidden" });
  });
  it("a turn that finishes after the sweep supersedes the sweep's receipt", async () => {
    const h = setup();
    const dispatch = await h.admit("turn-1", 4000n, 20n);
    h.clock.advance(60_000);
    await h.dispatcher.settleAbandoned({
      access,
      scope: scopeAll,
      ...month,
      cost: () => cost(200_000n),
    });
    expect(await h.figures("tokens")).toMatchObject({ used: 4000n, reserved: 0n });
    expect(
      await dispatch.settle({
        usage: [q("tokens", 1200n), q("customer_cents", 4n)],
        cost: cost(40_000n),
      }),
    ).toMatchObject({ outcome: "settled", via: "correction", operation: { state: "settled" } });
    expect(await h.figures("tokens")).toMatchObject({ used: 1200n, reserved: 0n });
    expect(await h.figures("customer_cents")).toMatchObject({ used: 4n, reserved: 0n });
    expect((await h.operation("turn-1"))!.receipts).toMatchObject([
      { id: "turn-1:abandoned" },
      { id: "turn-1:receipt", supersedes: "turn-1:abandoned" },
    ]);
  });
  it("resolves a sweep that lands between the rejected settle and the recovery claim", async () => {
    const h = setup();
    const dispatch = await h.admit("turn-1", 4000n, 20n);
    h.clock.advance(60_000);
    const claim = h.meter.claimForRecovery.bind(h.meter);
    vi.spyOn(h.meter, "claimForRecovery").mockImplementationOnce(async (input) => {
      vi.mocked(h.meter.claimForRecovery).mockImplementation(claim);
      await h.dispatcher.settleAbandoned({
        access,
        scope: scopeAll,
        ...month,
        cost: () => cost(200_000n),
      });
      return claim(input);
    });
    expect(
      await dispatch.settle({
        usage: [q("tokens", 1200n), q("customer_cents", 4n)],
        cost: cost(40_000n),
      }),
    ).toMatchObject({ outcome: "settled", via: "correction" });
    expect(await h.figures("tokens")).toMatchObject({ used: 1200n, reserved: 0n });
  });
  it("a late turn also replaces a pending sweep receipt", async () => {
    const h = setup();
    const dispatch = await h.admit("turn-1", 4000n, 20n);
    h.clock.advance(60_000);
    await h.dispatcher.settleAbandoned({ access, scope: scopeAll, ...month });
    expect(await h.operation("turn-1")).toMatchObject({ state: "pending" });
    expect(
      await dispatch.settle({
        usage: [q("tokens", 1200n), q("customer_cents", 4n)],
        cost: cost(40_000n),
      }),
    ).toMatchObject({ outcome: "settled", via: "correction" });
    expect(await h.figures("tokens")).toMatchObject({ used: 1200n, reserved: 0n });
  });
});
const scopeAll = { kind: "namespace" as const, namespace: "app" };

it("native policy settles without optional estimated units or money", async () => {
  const f = setup([]);
  const request = f.admission("native");
  request.operation.settlementPolicy = { requiredUnits: ["tokens"], requireMoney: false };
  const admitted = await f.dispatcher.admit(request);
  if (admitted.outcome !== "admitted") throw new Error("native fixture");
  expect(
    await admitted.dispatch.settle({
      usage: [q("tokens", 10n)],
      cost: { certainty: "unknown", money: null },
    }),
  ).toMatchObject({
    outcome: "settled",
    operation: { state: "settled", receipts: [{ cost: { certainty: "unknown", money: null } }] },
  });
});
