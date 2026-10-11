import { beforeEach, afterEach, describe, expect, test } from "vitest";
import type { BudgetScope } from "@usagekit/core";
import type { StoreFactory, StoreFixture } from "./factory.js";
import { input, budget, quantity, ref } from "./helpers.js";
export function admissionTests(factory: StoreFactory) {
  describe("atomic admission", () => {
    let f: StoreFixture;
    beforeEach(async () => {
      f = await factory();
    });
    afterEach(async () => f.close());
    const scopes: BudgetScope[] = [
      { kind: "principal", namespace: "test", principal: "u1" },
      { kind: "group", namespace: "test", group: "g1" },
      { kind: "connection", namespace: "test", connection: "c1" },
      {
        kind: "access_credential",
        namespace: "test",
        accessCredential: { kind: "oauth_client", id: "k1" },
      },
      { kind: "platform_pool", namespace: "test", poolId: "p1" },
      { kind: "tag", namespace: "test", tag: "t1" },
    ];
    const candidate = () =>
      input({
        scope: {
          namespace: "test",
          principal: "u1",
          group: "g1",
          connection: "c1",
          accessCredential: { kind: "oauth_client", id: "k1" },
          tags: ["t1"],
        },
        fundingSource: "platform",
        platformPools: ["p1"],
      });
    test.each(scopes)("scope selection $kind", async (scope) => {
      f.budgets.push(budget({ scope, limit: quantity(0n) }));
      expect(await f.store.reserve(candidate())).toMatchObject({ outcome: "exceeded" });
    });
    test.each(scopes)("scope mismatch $kind", async (scope) => {
      f.budgets.push(budget({ scope: { ...scope, namespace: "other" }, limit: quantity(0n) }));
      expect(await f.store.reserve(candidate())).toMatchObject({ outcome: "reserved" });
    });
    test("missing estimate is typed and does not insert", async () => {
      f.budgets.push(budget({ unit: "tokens", limit: quantity(3n, "tokens") }));
      const i = candidate();
      expect(await f.store.reserve(i)).toEqual({
        outcome: "invalid",
        reason: "missing_estimate_unit",
        unit: "tokens",
        operation: null,
      });
      expect(await f.store.getOperation(ref(i))).toBeNull();
    });
    test("surface exact and any", async () => {
      f.budgets.push(budget({ surface: "programmatic", limit: quantity(0n) }));
      expect(await f.store.reserve(candidate())).toMatchObject({ outcome: "reserved" });
      expect(await f.store.reserve(programmatic("api"))).toMatchObject({ outcome: "exceeded" });
      f.budgets[0]!.surface = "any";
      expect(await f.store.reserve(candidate())).toMatchObject({ outcome: "exceeded" });
    });
    const programmatic = (source: "api" | "cli" | "mcp" | "sdk" | "proxy") => ({
      ...candidate(),
      surface: "programmatic" as const,
      source,
    });
    test("source budgets on one connection admit independently", async () => {
      const connection = { kind: "connection", namespace: "test", connection: "c1" } as const;
      const cli = budget({ scope: connection, surface: "cli", limit: quantity(1n) }),
        api = budget({ scope: connection, surface: "api", limit: quantity(1n) });
      f.budgets.push(cli, api);
      expect(await f.store.reserve(programmatic("cli"))).toMatchObject({ outcome: "reserved" });
      expect(await f.store.reserve(programmatic("cli"))).toMatchObject({
        outcome: "exceeded",
        exceeded: { budget: { id: cli.id } },
      });
      expect(await f.store.reserve(programmatic("api"))).toMatchObject({ outcome: "reserved" });
      expect(await f.store.reserve(programmatic("api"))).toMatchObject({
        outcome: "exceeded",
        exceeded: { budget: { id: api.id } },
      });
      expect(await f.store.reserve(programmatic("mcp"))).toMatchObject({ outcome: "reserved" });
    });
    test("surface budget covers its source group and ignores other sources", async () => {
      f.budgets.push(budget({ surface: "app", limit: quantity(0n) }));
      expect(await f.store.reserve(programmatic("api"))).toMatchObject({ outcome: "reserved" });
      expect(await f.store.reserve(candidate())).toMatchObject({ outcome: "exceeded" });
      expect(await f.store.reserve({ ...candidate(), source: "worker" })).toMatchObject({
        outcome: "exceeded",
      });
    });
    test("source and surface budgets stack; the first exceeded in default order is reported", async () => {
      const principal = budget({ surface: "programmatic", limit: quantity(1n) }),
        connection = budget({
          scope: { kind: "connection", namespace: "test", connection: "c1" },
          surface: "cli",
          limit: quantity(1n),
        });
      f.budgets.push(connection, principal);
      const first = await f.store.reserve(programmatic("cli"));
      expect(first).toMatchObject({ outcome: "reserved" });
      if (first.outcome !== "reserved") throw new Error("fixture");
      expect(first.operation.budgetEpochs.map((e) => e.budgetId).sort()).toEqual(
        [principal.id, connection.id].sort(),
      );
      expect(await f.store.reserve(programmatic("cli"))).toMatchObject({
        outcome: "exceeded",
        exceeded: { budget: { id: principal.id } },
      });
      principal.limit = quantity(5n);
      expect(await f.store.reserve(programmatic("cli"))).toMatchObject({
        outcome: "exceeded",
        exceeded: { budget: { id: connection.id } },
      });
      expect(await f.store.reserve(programmatic("sdk"))).toMatchObject({ outcome: "reserved" });
    });
    for (const scope of scopes)
      for (const n of [2, 5, 20])
        test(`${scope.kind}: ${n} concurrent admissions`, async () => {
          f.budgets.push(budget({ scope, limit: quantity(BigInt(n - 1)) }));
          const results = await Promise.all(
            Array.from({ length: n }, () => f.store.reserve(candidate())),
          );
          expect(results.filter((r) => r.outcome === "reserved")).toHaveLength(n - 1);
        });
    test("pool shares two principals; default bound order is stable", async () => {
      const pool = budget({ scope: scopes[4]!, limit: quantity(2n) });
      f.budgets.push(budget({ limit: quantity(1n) }), pool);
      await f.store.reserve(candidate());
      await f.store.reserve({ ...candidate(), scope: { ...candidate().scope, principal: "u2" } });
      expect(await f.store.reserve(candidate())).toMatchObject({
        outcome: "exceeded",
        exceeded: { budget: { id: pool.id } },
      });
    });
    test("allow admits and reports warnings at the soft limit", async () => {
      const b = budget({ onExceed: "allow", limit: quantity(0n) });
      f.budgets.push(b);
      expect(await f.store.reserve(candidate())).toMatchObject({
        outcome: "reserved",
        warnings: [{ budget: { id: b.id }, boundary: "limit", used: quantity(0n) }],
      });
    });
    test("soft budget warns past limit and blocks past hardLimit", async () => {
      const b = budget({ onExceed: "allow", limit: quantity(1n), hardLimit: quantity(2n) });
      f.budgets.push(b);
      expect(await f.store.reserve(candidate())).toMatchObject({
        outcome: "reserved",
        warnings: [],
      });
      expect(await f.store.reserve(candidate())).toMatchObject({
        outcome: "reserved",
        warnings: [{ budget: { id: b.id }, boundary: "limit", reserved: quantity(1n) }],
      });
      const blocked = await f.store.reserve(candidate());
      expect(blocked).toMatchObject({
        outcome: "exceeded",
        exceeded: { budget: { id: b.id }, boundary: "hardLimit", reserved: quantity(2n) },
      });
      expect(
        await f.store.reserve({
          ...candidate(),
          estimate: [quantity(0n), quantity(1n, "customer_cents")],
        }),
      ).toMatchObject({
        outcome: "reserved",
        warnings: [{ boundary: "limit" }],
      });
    });
    test.each([
      { name: "hardLimit below limit", onExceed: "allow", limit: 2n, hardLimit: quantity(1n) },
      { name: "hardLimit equal to limit", onExceed: "allow", limit: 2n, hardLimit: quantity(2n) },
      { name: "block with hardLimit", onExceed: "block", limit: 1n, hardLimit: quantity(2n) },
      {
        name: "hardLimit in another unit",
        onExceed: "allow",
        limit: 1n,
        hardLimit: quantity(2n, "tokens"),
      },
      { name: "hardLimit without limit", onExceed: "allow", limit: null, hardLimit: quantity(2n) },
    ] as const)("invalid budget definition is a validation failure: $name", async (c) => {
      f.budgets.push(
        budget({
          onExceed: c.onExceed,
          limit: c.limit === null ? null : quantity(c.limit),
          hardLimit: c.hardLimit,
        }),
      );
      const i = candidate();
      await expect(f.store.reserve(i)).rejects.toThrow("InvalidInput");
      expect(await f.store.getOperation(ref(i))).toBeNull();
    });
    test("current version only; epochs immutable; unbounded still snapshotted", async () => {
      const b = budget({ limit: null });
      f.budgets.push({ ...b, version: 0, limit: quantity(0n) }, b);
      const i = candidate();
      const result = await f.store.reserve(i);
      if (result.outcome !== "reserved") throw new Error("fixture");
      expect(result).toMatchObject({
        outcome: "reserved",
        operation: {
          budgetEpochs: [
            {
              budgetId: b.id,
              budgetVersion: 1,
              epoch: "2026-09",
              startsAt: "2026-09-01T00:00:00.000Z",
              endsAt: "2026-10-01T00:00:00.000Z",
            },
          ],
        },
      });
      b.version = 2;
      expect(await f.store.getOperation(ref(i))).toEqual(result.operation);
    });
    test("reset epoch excludes prior reservations", async () => {
      const b = budget({
        limit: quantity(1n),
        window: { kind: "since_reset", epoch: "e1", startsAt: "2026-09-01T00:00:00.000Z" },
      });
      f.budgets.push(b);
      await f.store.reserve(candidate());
      expect(await f.store.reserve(candidate())).toMatchObject({ outcome: "exceeded" });
      b.window = { kind: "since_reset", epoch: "e2", startsAt: f.clock.now().toISOString() };
      expect(await f.store.reserve(candidate())).toMatchObject({
        outcome: "reserved",
        operation: { budgetEpochs: [{ epoch: "e2", endsAt: null }] },
      });
    });
  });
}
