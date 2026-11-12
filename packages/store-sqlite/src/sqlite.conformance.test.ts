import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createManualClock } from "@usagekit/store";
import { runStoreConformance } from "@usagekit/store/conformance";
import type { Budget } from "@usagekit/core";
import { insertBudget } from "./budgets.js";
import { encode } from "./serialize.js";
import { migrate } from "./migrate.js";
import { createSqliteStore } from "./index.js";
runStoreConformance(
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "usagekit-sqlite-")),
      path = join(dir, "usage.db"),
      clock = createManualClock(),
      budgets: Budget[] = [];
    let store = createSqliteStore({ path, clock });
    const seen = new Map<string, string>();
    const wrapped = new Proxy(store, {
      get(_target, name) {
        const value = store[name as keyof typeof store];
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          for (const b of budgets) {
            const k = b.scope.namespace + ":" + b.id + ":" + b.version,
              v = encode(b);
            if (seen.get(k) !== v) {
              store.database.transaction(() => insertBudget(store.database, b, true)).immediate();
              seen.set(k, v);
            }
          }
          return Reflect.apply(value, store, args);
        };
      },
    });
    return {
      store: wrapped,
      clock,
      budgets,
      replayMoneyMigration: async () => {
        store.database.exec(
          "UPDATE receipts SET receipt_json=json_set(receipt_json,'$.cost.money.scale',cost_scale) WHERE cost_scale<>4; ALTER TABLE receipts DROP COLUMN cost_scale; DELETE FROM migrations WHERE version=7;",
        );
        migrate(store.database);
      },
      moneyColumns: async () =>
        (
          store.database
            .prepare("SELECT cost_units,cost_scale FROM receipts ORDER BY rowid")
            .all() as { cost_units: bigint; cost_scale: bigint }[]
        ).map((r) => ({ cost_units: String(r.cost_units), cost_scale: Number(r.cost_scale) })),
      restart: async () => {
        store.close();
        store = createSqliteStore({ path, clock });
        return wrapped;
      },
      close: async () => {
        store.close();
        rmSync(dir, { recursive: true, force: true });
      },
    };
  },
  { durable: true, rollingWindows: false, maxMoneyUnits: 2n ** 63n - 1n, maxQuantityScale: 18 },
);
