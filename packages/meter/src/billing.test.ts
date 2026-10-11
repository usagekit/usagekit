import { expect, test, vi } from "vitest";
import type { AccessContext, BillingImportInput, ConnectionPolicy } from "@usagekit/core";
import { createManualClock, createMemoryStore } from "@usagekit/store";
import { createMeter } from "./index.js";
import type { ConnectionResolver } from "./index.js";

const access: AccessContext = {
  namespace: "test",
  readablePrincipals: ["u"],
  readableGroups: [],
  readablePools: [],
  canReadBillingDetail: true,
  canManageBudgets: false,
  canImportBilling: true,
};
const input: BillingImportInput = {
  scope: { namespace: "test", principal: "u", connection: "c" },
  provider: "example",
  fileHash: "a".repeat(64),
  window: { from: "2026-09-01T00:00:00.000Z", to: "2026-10-01T00:00:00.000Z" },
  expectedPreviousImportId: null,
  attribution: { fundingSource: "byok", costOwner: "u" },
  lines: [
    {
      providerRequestId: "p",
      operation: "search",
      occurredAt: "2026-09-23T12:00:00.000Z",
      cost: { units: 1200n, currency: "USD" },
    },
  ],
};
const query = {
  scope: { namespace: "test", principal: "u" },
  connection: "c",
  ...input.window,
};
function fixture(resolveConnection?: ConnectionResolver, owned = true) {
  const clock = createManualClock();
  const store = createMemoryStore({ clock, budgets: [] });
  const importSpy = vi.spyOn(store, "importBilling");
  const meter = createMeter({
    store,
    clock,
    ...(resolveConnection ? { resolveConnection } : {}),
    resolveOwnership: async () =>
      owned ? { kind: "principal", namespace: "test", principal: "u" } : null,
  });
  return { meter, store, importSpy };
}
async function expectNoImport({ store, importSpy }: ReturnType<typeof fixture>) {
  expect.soft(importSpy).not.toHaveBeenCalled();
  expect.soft(await store.billingImports(query)).toMatchObject({ records: [] });
  expect(
    await store.listOperations({
      scope: { kind: "principal", ...query.scope },
      ...input.window,
    }),
  ).toMatchObject({ operations: [] });
}

test.each([
  ["byok", "platform"],
  ["platform", "byok"],
  ["byok", undefined],
] as const)(
  "billing import retains historical %s funding on a current %s connection",
  async (fundingSource, current) => {
    const f = fixture(
      () => ({ provider: input.provider, fundingSource: current }) as ConnectionPolicy,
    );
    expect(
      await f.meter.importBilling(access, {
        ...input,
        attribution: { ...input.attribution, fundingSource },
      }),
    ).toMatchObject({ outcome: "imported", replayed: false });
    expect(f.importSpy).toHaveBeenCalledTimes(1);
  },
);

test.each(["byok", "platform"] as const)(
  "billing import accepts matching %s funding",
  async (fundingSource) => {
    const f = fixture(() => ({ provider: input.provider, fundingSource }));
    expect(
      await f.meter.importBilling(access, {
        ...input,
        attribution: { ...input.attribution, fundingSource },
      }),
    ).toMatchObject({ outcome: "imported", replayed: false });
    expect(f.importSpy).toHaveBeenCalledTimes(1);
    expect((await f.store.billingImports(query)).records).toHaveLength(1);
  },
);

test.each(["byok", "platform"] as const)(
  "billing import trusts host-derived %s funding without a resolver",
  async (fundingSource) => {
    const f = fixture();
    expect(
      await f.meter.importBilling(access, {
        ...input,
        attribution: { ...input.attribution, fundingSource },
      }),
    ).toMatchObject({ outcome: "imported", replayed: false });
    expect((await f.store.billingImports(query)).records).toHaveLength(1);
  },
);

test.each([
  "permission",
  "billing detail",
  "principal",
  "namespace",
  "ownership",
  "unresolved connection",
  "provider",
] as const)("billing import keeps %s rejection forbidden and never writes", async (reason) => {
  const f = fixture(
    () =>
      reason === "unresolved connection"
        ? undefined
        : { provider: reason === "provider" ? "other" : input.provider, fundingSource: "platform" },
    reason !== "ownership",
  );
  const auth = {
    ...access,
    ...(reason === "permission" ? { canImportBilling: false } : {}),
    ...(reason === "billing detail" ? { canReadBillingDetail: false } : {}),
    ...(reason === "principal" ? { readablePrincipals: [] } : {}),
    ...(reason === "namespace" ? { namespace: "other" } : {}),
  };
  expect(await f.meter.importBilling(auth, input)).toEqual({ outcome: "forbidden" });
  await expectNoImport(f);
});
