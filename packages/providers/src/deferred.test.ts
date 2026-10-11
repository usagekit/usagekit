import { expect, test } from "vitest";
import { createManualClock, createMemoryStore } from "@usagekit/store";
import { createMeter } from "@usagekit/meter";
import { createCatalog, dataforseo, loadFixtures } from "./index.js";
const files = import.meta.glob("./dataforseo/fixtures/**/*.json", {
  eager: true,
  import: "default",
});
test("deferred task receipt stays pending until billing evidence corrects it through Meter", async () => {
  const fixtures = loadFixtures(files),
    post = fixtures.find((f) => f.operation === "serp.google.organic.task_post")!,
    get = fixtures.find((f) => f.operation === "serp.google.organic.task_get.advanced")!;
  const clock = createManualClock("2026-09-26T12:00:00Z"),
    catalog = createCatalog({
      providers: [dataforseo],
      enabled: ["dataforseo"],
      now: () => clock.now(),
    });
  const store = createMemoryStore({ clock, budgets: [] }),
    meter = createMeter({
      store,
      clock,
      catalog,
      resolveConnection: () => ({ fundingSource: "byok", provider: "dataforseo", plan: "prepaid" }),
    });
  const ref = { namespace: "test", principal: "u", operationId: "post" },
    matched = catalog.match("dataforseo", post.request);
  if (matched.operation === "unknown") throw new Error("fixture");
  const reserve = await meter.reserve({
    operationId: "post",
    scope: { namespace: "test", principal: "u", connection: "c" },
    provider: "dataforseo",
    operation: post.operation,
    options: matched.options,
    fundingSource: "byok",
    costOwner: "u",
    source: "app",
    surface: "app",
  });
  if (reserve.outcome !== "reserved") throw new Error("fixture");
  const grant = await meter.markDispatchIntent({
    ...ref,
    commandId: "dispatch",
    expectedVersion: reserve.operation.version,
    holder: "wrapper",
    leaseTtlMs: 1000,
  });
  if (!("granted" in grant) || !grant.granted) throw new Error("fixture");
  const timestamp = clock.now().toISOString(),
    receipt = {
      ...catalog.extract(
        "dataforseo",
        post.operation,
        post.request,
        post.response,
        post.response.body,
      ),
      id: "initial",
      occurredAt: timestamp,
      recordedAt: timestamp,
    };
  const settled = await meter.settle({
    ...ref,
    commandId: "settle",
    expectedVersion: grant.operation.version,
    authority: { kind: "lease", leaseId: grant.lease.leaseId },
    receipt,
  });
  expect(settled).toMatchObject({ outcome: "settled", operation: { state: "pending" } });
  if (settled.outcome !== "settled") throw new Error("fixture");
  const line = catalog.parsers("dataforseo").billingExport!(get.response.body)[0]!;
  expect(line.providerRequestId).toBe(receipt.providerRequestId);
  const corrected = await meter.correct({
    ...ref,
    commandId: "billing",
    expectedVersion: settled.operation.version,
    authority: { kind: "late_evidence", source: "provider" },
    replacesReceiptId: receipt.id,
    reason: "Provider task billing evidence",
    receipt: {
      ...receipt,
      id: "evidence",
      measurements: [
        {
          unit: "cents",
          certainty: "measured",
          quantity: { unit: "cents", value: line.cost.units, scale: 4 },
        },
        {
          unit: "requests",
          certainty: "measured",
          quantity: { unit: "requests", value: 1n, scale: 0 },
        },
      ],
      cost: { certainty: "measured", money: line.cost },
    },
  });
  expect(corrected).toMatchObject({
    outcome: "settled",
    operation: {
      state: "settled",
      receipts: [{ id: "initial" }, { id: "evidence", supersedes: "initial" }],
    },
  });
});
