// Test-only transport: never imported by worker.ts or deployed by wrangler.jsonc.
import { DurableObject } from "cloudflare:workers";
import { createDurableObjectStore } from "../../packages/store-d1/src/index.js";
import { insertBudget } from "../../packages/store-d1/src/budgets.js";
import { encode, decode } from "../../packages/store-d1/src/serialize.js";
import { createManualClock, InvalidInput } from "@usagekit/store";
import { migrate } from "../../packages/store-d1/src/migrate.js";
import type { Budget } from "@usagekit/core";

export class TestLedger extends DurableObject {
  private clock = createManualClock();
  private failWrite = false;
  private failWriteAt = 0;
  private writes = 0;
  private store = createDurableObjectStore({
    storage: this.ctx.storage,
    clock: this.clock,
    testHooks: {
      afterOperationWrite: () => {
        if (this.failWrite || (this.failWriteAt > 0 && ++this.writes === this.failWriteAt))
          throw new Error("injected write failure");
      },
    },
  });
  async fetch(request: Request): Promise<Response> {
    const body = decode<{ method: string; args: unknown[]; now: string; budgets: Budget[] }>(
      await request.text(),
    );
    try {
      this.clock.set(body.now);
      for (const b of body.budgets)
        this.store.database
          .transaction(() => insertBudget(this.store.database, b, true))
          .immediate();
      let result: unknown;
      if (body.method === "$readOnly") this.store.database.readOnly = Boolean(body.args[0]);
      else if (body.method === "$failWrite") this.failWrite = Boolean(body.args[0]);
      else if (body.method === "$failWriteAt") {
        this.failWriteAt = Number(body.args[0]);
        this.writes = 0;
      } else if (body.method === "$billingState") {
        result = Object.fromEntries(
          [
            "operations",
            "receipts",
            "commands",
            "operation_events",
            "budget_usage",
            "budget_alerts",
            "billing_imports",
            "billing_import_families",
          ].map((table) => [
            table,
            this.store.database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
          ]),
        );
      } else if (body.method === "$replayMoneyMigration") {
        this.store.database.exec(
          "UPDATE receipts SET receipt_json=json_set(receipt_json,'$.cost.money.scale',cost_scale) WHERE cost_scale<>4; ALTER TABLE receipts DROP COLUMN cost_scale; DELETE FROM migrations WHERE version=3;",
        );
        migrate(this.store.database);
      } else if (body.method === "$moneyColumns")
        result = this.store.database
          .prepare("SELECT cost_units,cost_scale FROM receipts ORDER BY rowid")
          .all();
      else if (body.method === "$schemaVersions")
        result = this.store.database
          .prepare("SELECT version FROM migrations ORDER BY version")
          .all();
      else if (body.method === "$upgradeVersionOne") {
        this.store.database
          .transaction(() => {
            this.store.database.exec(
              "DROP TABLE billing_imports; DROP TABLE billing_import_families; DROP INDEX operations_billing_scope; ALTER TABLE receipts DROP COLUMN cost_scale; DELETE FROM migrations WHERE version>=2;",
            );
          })
          .immediate();
        migrate(this.store.database, 1);
        migrate(this.store.database);
        migrate(this.store.database);
      } else if (body.method === "$unsupportedSchema") {
        this.store.database.prepare("INSERT INTO migrations VALUES(99)").run();
        try {
          migrate(this.store.database);
        } finally {
          this.store.database.prepare("DELETE FROM migrations WHERE version=99").run();
        }
      } else if (body.method === "$seedReopen")
        this.store = createDurableObjectStore({
          storage: this.ctx.storage,
          clock: this.clock,
          budgets: body.args[0] as Budget[],
        });
      else if (body.method === "$metrics") result = this.store.database.metrics;
      else {
        const method = this.store[body.method as keyof typeof this.store];
        if (typeof method !== "function") throw new Error("Unknown test method");
        result = await Reflect.apply(method, this.store, body.args);
      }
      return new Response(encode({ result, metrics: this.store.database.metrics }));
    } catch (error) {
      return new Response(
        encode({
          error: {
            message: String(error),
            ...(error instanceof InvalidInput ? { field: error.field, reason: error.reason } : {}),
          },
          metrics: this.store.database.metrics,
        }),
      );
    }
  }
}
export default {
  fetch() {
    return new Response("Test ledger");
  },
};
