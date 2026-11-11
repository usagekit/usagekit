import { expect, test } from "vitest";
import type { AccessContext, Budget, Cost, Quantity } from "@usagekit/core";
import { createMeter } from "@usagekit/meter";
import { createMeteredDispatch } from "@usagekit/providers";
import type { DispatchAdmission, MeteredDispatch, SettleOutcome } from "@usagekit/providers";
import { createPostgresStore } from "./index.js";
import { fixture } from "./test-fixture.js";

const q = (unit: string, value: bigint, scale = 0): Quantity => ({ unit, value, scale });
const scope = { namespace: "app", principal: "user-1", group: "team-1", connection: "platform" };
const teamBudget = (unit: string, limit: bigint): Budget => ({
  id: `team-${unit}`,
  version: 1,
  scope: { kind: "group", namespace: "app", group: "team-1" },
  surface: "any",
  unit,
  limit: q(unit, limit),
  window: { kind: "calendar_month", timezone: "UTC" },
  onExceed: "block",
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
const admission = (id: string): DispatchAdmission => ({
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
  estimate: [q("tokens", 300n), q("customer_cents", 3n)],
});
/** Two dispatchers over independent pools of one database: two application instances. */
async function instances() {
  const f = await fixture(),
    pool = f.connect();
  try {
    const other = await createPostgresStore({ pool, schema: f.schema, clock: f.clock });
    for (const budget of [teamBudget("tokens", 3000n), teamBudget("customer_cents", 100n)])
      await f.store.putBudget(budget);
    const [a, b] = [f.store, other].map((store) =>
      createMeteredDispatch({
        meter: createMeter({ store, clock: f.clock }),
        now: f.clock.now,
        renewEveryMs: 0,
        leaseTtlMs: 60_000,
      }),
    );
    const figures = async (unit: string) => {
      const statuses = await f.store.applicableBudgets({
        scope,
        surface: "app",
        source: "app",
        units: [unit],
      });
      const status = statuses.find((s) => s.budget.unit === unit)!;
      const at4 = (value: Quantity) => value.value * 10n ** BigInt(4 - value.scale);
      return { used: at4(status.used!), reserved: at4(status.reserved!) };
    };
    return {
      f,
      a: a!,
      b: b!,
      figures,
      close: async () => {
        await pool.end();
        await f.close();
      },
    };
  } catch (error) {
    await pool.end();
    await f.close();
    throw error;
  }
}
test("independent pools never admit past a token or money limit", async () => {
  const h = await instances();
  try {
    const results = await Promise.all(
      Array.from({ length: 24 }, (_, n) => (n % 2 ? h.a : h.b).admit(admission(`turn-${n}`))),
    );
    expect(results.filter((r) => r.outcome === "admitted")).toHaveLength(10);
    const refused = results.filter((r) => r.outcome === "refused");
    expect(refused).toHaveLength(14);
    for (const refusal of refused)
      expect(refusal).toMatchObject({
        reason: "budget_exceeded",
        exceeded: { budget: { id: "team-tokens" }, boundary: "limit" },
      });
    expect(await h.figures("tokens")).toEqual({ used: 0n, reserved: 30_000_000n });
    expect(await h.figures("customer_cents")).toEqual({ used: 0n, reserved: 300_000n });
  } finally {
    await h.close();
  }
});

test("the same id admitted from two pools reserves and dispatches once", async () => {
  const h = await instances();
  try {
    for (let n = 0; n < 8; n++) {
      const results = await Promise.all([
        h.a.admit(admission(`turn-${n}`)),
        h.b.admit(admission(`turn-${n}`)),
      ]);
      expect(results.map((r) => (r.outcome === "refused" ? r.reason : r.outcome)).sort()).toEqual([
        "admitted",
        "replayed",
      ]);
    }
    expect(await h.figures("tokens")).toEqual({ used: 0n, reserved: 24_000_000n });
  } finally {
    await h.close();
  }
});

test("settles and admits racing on independent pools keep every figure exact", async () => {
  const h = await instances();
  try {
    const open: MeteredDispatch[] = [];
    for (let n = 0; n < 10; n++) {
      const admitted = await (n % 2 ? h.a : h.b).admit(admission(`first-${n}`));
      if (admitted.outcome !== "admitted") throw new Error("fixture");
      open.push(admitted.dispatch);
    }
    const [settled, admitted] = await Promise.all([
      Promise.all(
        open.map((dispatch) =>
          dispatch.settle({
            usage: [q("tokens", 120n), q("customer_cents", 12n, 1)],
            cost: cost(12_000n),
          }),
        ),
      ),
      Promise.all(
        Array.from({ length: 16 }, (_, n) => (n % 2 ? h.b : h.a).admit(admission(`second-${n}`))),
      ),
    ]);
    expect(settled).toHaveLength(10);
    for (const outcome of settled)
      expect(outcome).toMatchObject({ outcome: "settled", via: "lease", overshoot: [] });
    const second = admitted.flatMap((r) => (r.outcome === "admitted" ? [r.dispatch] : []));
    // 1200 tokens are used once every settle lands, so at most six more turns of 300 fit.
    expect(second.length).toBeLessThanOrEqual(6);
    const count = BigInt(second.length);
    expect(await h.figures("tokens")).toEqual({
      used: 12_000_000n,
      reserved: count * 3_000_000n,
    });
    expect(await h.figures("customer_cents")).toEqual({
      used: 120_000n,
      reserved: count * 30_000n,
    });
    // Settling above the estimate: the documented overshoot is the sum of actual minus estimate.
    const over = await Promise.all(
      second.map((dispatch) =>
        dispatch.settle({
          usage: [q("tokens", 350n), q("customer_cents", 3n)],
          cost: cost(30_000n),
        }),
      ),
    );
    for (const outcome of over)
      expect(outcome).toMatchObject({ outcome: "settled", overshoot: [q("tokens", 50n)] });
    expect(await h.figures("tokens")).toEqual({
      used: 12_000_000n + count * 3_500_000n,
      reserved: 0n,
    });
  } finally {
    await h.close();
  }
});

test("a late settle racing the abandoned sweep on another pool counts the turn once", async () => {
  const h = await instances();
  try {
    let lost = 0;
    const paths = new Set<string>();
    for (let n = 0; n < 8; n++) {
      const admitted = await h.a.admit(admission(`turn-${n}`));
      if (admitted.outcome !== "admitted") throw new Error("fixture");
      h.f.clock.advance(60_000);
      const input = {
        usage: [q("tokens", 100n), q("customer_cents", 1n)],
        cost: cost(10_000n),
      };
      const sweep = {
        access,
        scope: { kind: "namespace" as const, namespace: "app" },
        from: "2026-09-01T00:00:00.000Z",
        to: "2026-10-01T00:00:00.000Z",
        cost: () => cost(30_000n),
      };
      let [outcome]: [SettleOutcome, unknown] = await Promise.all([
        admitted.dispatch.settle(input),
        h.b.settleAbandoned(sweep),
      ]);
      if (outcome.outcome === "rejected" && outcome.reason === "lease_lost") {
        // The sweep held the recovery lease at that instant; it has finished by now.
        lost++;
        outcome = await admitted.dispatch.settle(input);
      }
      expect(outcome).toMatchObject({ outcome: "settled", operation: { state: "settled" } });
      if (outcome.outcome === "settled") paths.add(outcome.via);
      const operation = await h.f.store.getOperation({
        namespace: "app",
        principal: "user-1",
        operationId: `turn-${n}`,
      });
      expect(operation!.receipts.at(-1)).toMatchObject({
        id: `turn-${n}:receipt`,
        measurements: [{ unit: "tokens", quantity: { value: 100n } }, {}, {}],
      });
      expect(await h.figures("tokens")).toEqual({
        used: BigInt(n + 1) * 1_000_000n,
        reserved: 0n,
      });
    }
    console.info(`late settle paths: ${[...paths].sort().join(", ")}; lease_lost retries: ${lost}`);
  } finally {
    await h.close();
  }
});
