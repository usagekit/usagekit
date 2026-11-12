import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createManualClock } from "@usagekit/store";
import type { ReserveInput, Operation, Receipt, SettleInput } from "@usagekit/core";
import { createSqliteStore } from "./index.js";
import { key, canonical, hash } from "./util.js";
import { encode } from "./serialize.js";
import { expect, test } from "vitest";
import Database from "better-sqlite3";
import { migrate } from "./migrate.js";
test("migrations are idempotent and reject downgrade/newer schema", () => {
  const db = new Database(":memory:");
  try {
    migrate(db);
    migrate(db);
    expect(db.prepare("SELECT version FROM migrations").all()).toEqual([
      { version: 1 },
      { version: 2 },
      { version: 3 },
      { version: 4 },
      { version: 5 },
      { version: 6 },
      { version: 7 },
    ]);
    for (const name of [
      "budget_alerts",
      "request_counts",
      "request_commands",
      "billing_imports",
      "billing_import_families",
    ])
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name=?").get(name)).toBeTruthy();
    expect(() => migrate(db, 0)).toThrow("Downgrade");
    db.prepare("INSERT INTO migrations(version) VALUES (99)").run();
    expect(() => migrate(db)).toThrow("Downgrade");
  } finally {
    db.close();
  }
});

test("version-one operations, receipts and command replays survive migration", async () => {
  const dir = mkdtempSync(join(tmpdir(), "usagekit-migrate-")),
    path = join(dir, "usage.db"),
    db = new Database(path),
    clock = createManualClock(),
    stamp = clock.now().toISOString();
  const input: ReserveInput = {
    operationId: "op",
    scope: { namespace: "test", principal: "u", connection: "c" },
    fundingSource: "byok",
    costOwner: "u",
    surface: "app",
    source: "app",
    provider: "example",
    operation: "search",
    estimate: [{ unit: "requests", value: 1n, scale: 0 }],
  };
  const receipt: Receipt = {
    id: "r",
    measurements: [{ unit: "requests", quantity: input.estimate[0]!, certainty: "measured" }],
    cost: { certainty: "measured", money: { units: 7n, currency: "USD" } },
    occurredAt: stamp,
    recordedAt: stamp,
    cached: false,
    failed: false,
  };
  const op: Operation = {
      ...input,
      reservationExpiresAt: new Date(clock.now().getTime() + 300000).toISOString(),
      state: "settled",
      version: 3,
      createdAt: stamp,
      updatedAt: stamp,
      budgetEpochs: [],
      receipts: [receipt],
      lease: null,
    },
    pk = key("test", "op"),
    rpk = key(pk, "r");
  const command: SettleInput = {
      namespace: "test",
      principal: "u",
      operationId: "op",
      commandId: "settle",
      expectedVersion: 2,
      authority: { kind: "lease", leaseId: "old" },
      receipt,
    },
    identity = canonical({ kind: "settle", input: command }),
    result = { outcome: "settled", replayed: false, operation: op };
  try {
    migrate(db, 1);
    db.prepare(
      "INSERT INTO operations(operation_pk,namespace,principal,operation_id,state,version,scope_json,semantic_json,estimate_json,budget_epochs_json,created_at,updated_at,operation_json,warnings_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run(
      pk,
      "test",
      "u",
      "op",
      "settled",
      3,
      encode(input.scope),
      canonical({ ...input, platformPools: [] }),
      encode(input.estimate),
      "[]",
      stamp,
      stamp,
      encode({ ...op, receipts: [] }),
      "[]",
    );
    db.prepare("INSERT INTO receipts VALUES(?,?,?,?,?,?,?,?,?,?)").run(
      rpk,
      pk,
      "r",
      null,
      encode(receipt),
      stamp,
      stamp,
      7n,
      "measured",
      0,
    );
    db.prepare("INSERT INTO measurements VALUES(?,?,?,?,?)").run(
      rpk,
      "requests",
      1n,
      0,
      "measured",
    );
    db.prepare("INSERT INTO commands VALUES(?,?,?,?,?,?)").run(
      pk,
      "settle",
      "settle",
      hash(identity),
      identity,
      encode(result),
    );
    db.close();
    const s = createSqliteStore({ path, clock });
    try {
      expect(
        await s.getOperation({ namespace: "test", principal: "u", operationId: "op" }),
      ).toEqual(op);
      expect(await s.reserve(input)).toMatchObject({ replayed: true, alerts: [] });
      expect(await s.settle(command)).toEqual({ ...result, replayed: true, alerts: [] });
      expect(
        (
          await s.aggregate({
            scope: { kind: "namespace", namespace: "test" },
            from: "2026-09-01T00:00:00Z",
            to: "2026-10-01T00:00:00Z",
            units: ["requests"],
            groupBy: ["provider"],
          })
        ).rows[0]!.cost.money?.units,
      ).toBe(7n);
    } finally {
      s.close();
    }
  } finally {
    if (db.open) db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a version-four database gains the request counter and keeps its operations", async () => {
  const dir = mkdtempSync(join(tmpdir(), "usagekit-migrate-")),
    path = join(dir, "usage.db"),
    db = new Database(path),
    clock = createManualClock();
  try {
    migrate(db, 4);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='request_counts'").get()).toBe(
      undefined,
    );
    db.close();
    const s = createSqliteStore({ path, clock });
    try {
      const count = {
        commandId: "c",
        scope: { namespace: "test", principal: "u", connection: "c" },
        surface: "programmatic" as const,
        source: "proxy" as const,
        provider: "example",
        operation: "search",
        state: "unpriced" as const,
      };
      expect(await s.countRequest(count)).toEqual({ outcome: "counted", replayed: false });
      expect(await s.countRequest(count)).toEqual({ outcome: "counted", replayed: true });
      expect(
        (
          await s.requestCounts({
            scope: { kind: "namespace", namespace: "test" },
            from: "2026-09-01T00:00:00.000Z",
            to: "2026-10-01T00:00:00.000Z",
            groupBy: [],
          })
        ).rows,
      ).toEqual([{ dimensions: {}, state: "unpriced", count: 1n }]);
    } finally {
      s.close();
    }
  } finally {
    if (db.open) db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
