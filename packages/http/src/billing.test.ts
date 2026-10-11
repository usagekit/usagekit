import { expect, test, vi } from "vitest";
import type { AccessContext, BillingImportInput, ConnectionPolicy } from "@usagekit/core";
import { createManualClock, createMemoryStore } from "@usagekit/store";
import { createMeter } from "@usagekit/meter";
import type { ConnectionResolver } from "@usagekit/meter";
import { createUsageHandlers, encodeWire } from "./index.js";
import { parseWire, validResponse } from "./schemas/index.js";

const access: AccessContext = {
  namespace: "test",
  readablePrincipals: ["u"],
  readableGroups: [],
  readablePools: [],
  canReadBillingDetail: true,
  canManageBudgets: true,
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
function fixture(
  auth: AccessContext | null = access,
  commands = true,
  resolveConnection?: ConnectionResolver,
) {
  const clock = createManualClock(),
    store = createMemoryStore({ clock, budgets: [] });
  const meter = createMeter({
    store,
    clock,
    ...(resolveConnection ? { resolveConnection } : {}),
    resolveOwnership: async (scope) =>
      scope.namespace === "test" && "connection" in scope && scope.connection === "c"
        ? { kind: "principal", namespace: "test", principal: "u" }
        : null,
  });
  const importSpy = vi.spyOn(meter, "importBilling");
  const handler = createUsageHandlers({ meter, commands, authenticate: async () => auth });
  const post = (body: unknown = input) =>
    handler(
      new Request("http://local.test/v1/billing/import", {
        method: "POST",
        body: encodeWire(body),
      }),
    );
  return { handler, post, importSpy, store, meter };
}

test.each([
  ["byok", "platform"],
  ["platform", "byok"],
  ["byok", undefined],
  ["byok", null],
  ["byok", ""],
  ["byok", "legacy"],
] as const)(
  "billing HTTP imports historical %s funding independently of current %s funding",
  async (fundingSource, resolved) => {
    const f = fixture(
      access,
      true,
      () => ({ provider: input.provider, fundingSource: resolved }) as ConnectionPolicy,
    );
    const response = await f.post({
      ...input,
      attribution: { ...input.attribution, fundingSource },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ outcome: "imported", replayed: false });
    expect(
      (
        await f.store.billingImports({
          scope: { namespace: "test", principal: "u" },
          connection: "c",
          ...input.window,
        })
      ).records,
    ).toHaveLength(1);
  },
);

test.each(["byok", "platform"] as const)(
  "billing HTTP imports matching %s funding",
  async (fundingSource) => {
    const f = fixture(access, true, () => ({ provider: input.provider, fundingSource }));
    const response = await f.post({
      ...input,
      attribution: { ...input.attribution, fundingSource },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ outcome: "imported", replayed: false });
    expect(
      (
        await f.store.billingImports({
          scope: { namespace: "test", principal: "u" },
          connection: "c",
          ...input.window,
        })
      ).records,
    ).toHaveLength(1);
  },
);

test("billing imports require explicit verified write permission and read-only mounts deny before parsing", async () => {
  const { canImportBilling: _omitted, ...withoutImport } = access;
  for (const auth of [withoutImport, { ...access, canImportBilling: false }]) {
    const { post, importSpy } = fixture(auth);
    expect((await post({ ...input, canImportBilling: true })).status).toBe(403);
    expect(importSpy).not.toHaveBeenCalled();
  }
  const readonly = fixture(access, false);
  expect((await readonly.post()).status).toBe(404);
  expect(
    (
      await readonly.handler(
        new Request("http://local.test/v1/billing/import", { method: "POST", body: "{" }),
      )
    ).status,
  ).toBe(404);
  expect(readonly.importSpy).not.toHaveBeenCalled();
  expect((await fixture(null, false).post()).status).toBe(401);
});

test("billing import HTTP scope cannot cross namespace, principal or host connection ownership", async () => {
  const { post } = fixture();
  for (const scope of [
    { ...input.scope, namespace: "other" },
    { ...input.scope, principal: "other" },
    { ...input.scope, connection: "other" },
  ])
    expect((await post({ ...input, scope })).status).toBe(403);
  expect((await post()).status).toBe(200);
});

test("billing import schemas reject unknown credential fields and inexact wire quantities", () => {
  const native = JSON.parse(encodeWire(input));
  expect(parseWire("importBilling", native).success).toBe(true);
  for (const altered of [
    { ...native, apiKey: "secret" },
    { ...native, commandId: "unsupported" },
    { ...native, scope: { ...native.scope, secret: "secret" } },
    { ...native, fileHash: "A".repeat(64) },
    { ...native, lines: [{ ...native.lines[0], cost: { units: 0.0012, currency: "USD" } }] },
    { ...native, lines: [{ ...native.lines[0], cost: { units: "1.2", currency: "USD" } }] },
    { ...native, attribution: { ...native.attribution, canImportBilling: true } },
  ])
    expect(parseWire("importBilling", altered).success).toBe(false);
});

test("reconciliation wire preserves signed differences and unknown ledger totals", () => {
  const record = {
    id: "i",
    scope: input.scope,
    provider: input.provider,
    fileHash: input.fileHash,
    window: input.window,
    recordedAt: "2026-09-23T12:00:00.000Z",
    matchedOperationIds: [],
    unobservedOperationIds: [],
    alerts: [],
    reconciliations: [
      {
        id: "r",
        importId: "i",
        scope: input.scope,
        provider: "example",
        window: input.window,
        kind: "aggregate",
        operation: "search",
        ledgerTotal: { certainty: "measured", money: { units: "10", currency: "USD" } },
        evidenceTotal: { units: "5", currency: "USD" },
        differenceUnits: "-5",
        unknownOperations: "0",
        evidenceRef: "billing:i",
      },
    ],
  };
  expect(validResponse("importBilling", { outcome: "imported", replayed: false, record })).toBe(
    true,
  );
  record.reconciliations[0] = {
    ...record.reconciliations[0]!,
    ledgerTotal: { certainty: "unknown", money: null } as any,
    differenceUnits: null as any,
    unknownOperations: "1",
  };
  expect(
    validResponse("billingImports", {
      outcome: "ok",
      value: { records: [record], asOf: record.recordedAt, truncated: false },
    }),
  ).toBe(true);
  expect(
    validResponse("billingImports", {
      outcome: "ok",
      value: { records: [record], asOf: record.recordedAt, truncated: false, secret: "bad" },
    }),
  ).toBe(false);
});

test("ordinary accounting cannot forge import provenance or journal a rejected receipt", async () => {
  const f = fixture({ ...access, canImportBilling: false });
  const reserved = await f.store.reserve({
    operationId: "ordinary",
    scope: input.scope,
    fundingSource: "byok",
    costOwner: "u",
    surface: "app",
    source: "app",
    provider: "example",
    operation: "search",
    estimate: [],
  });
  if (reserved.outcome !== "reserved") throw new Error("ordinary reserve fixture");
  const ref = { namespace: "test", principal: "u", operationId: "ordinary" };
  const grant = await f.store.markDispatchIntent({
    ...ref,
    commandId: "intent",
    expectedVersion: reserved.operation.version,
    holder: "h",
    leaseTtlMs: 1000,
  });
  if (!("granted" in grant) || !grant.granted) throw new Error("ordinary intent fixture");
  const receipt = {
    id: "dispatch-receipt",
    source: "import",
    measurements: [
      {
        unit: "requests",
        certainty: "measured",
        quantity: { value: 1n, scale: 0, unit: "requests" },
      },
    ],
    cost: { certainty: "measured", money: { units: 1200n, currency: "USD" } },
    occurredAt: "2026-09-23T12:00:00.000Z",
    recordedAt: "2026-09-23T12:00:00.000Z",
    cached: false,
    failed: false,
  };
  const send = (route: string, body: unknown) =>
    f.handler(
      new Request(`http://local.test/v1/operations/${route}`, {
        method: "POST",
        body: encodeWire(body),
      }),
    );
  const settle = {
    ...ref,
    commandId: "settle-provenance",
    expectedVersion: grant.operation.version,
    authority: { kind: "lease", leaseId: grant.lease.leaseId },
    receipt,
  };
  expect(await (await send("settle", settle)).json()).toMatchObject({ outcome: "invalid" });
  expect(await f.store.getOperation(ref)).toEqual(grant.operation);
  const settled = await (
    await send("settle", { ...settle, receipt: { ...receipt, source: "dispatch" } })
  ).json();
  expect(settled).toMatchObject({ outcome: "settled", replayed: false });
  const beforeCorrection = await f.store.getOperation(ref);
  const correction = {
    ...ref,
    commandId: "correct-provenance",
    expectedVersion: settled.operation.version,
    authority: { kind: "late_evidence", source: "verified-provider" },
    replacesReceiptId: receipt.id,
    reason: "provider adjustment",
    receipt: { ...receipt, id: "probe-receipt", supersedes: receipt.id },
  };
  expect(await (await send("correct", correction)).json()).toMatchObject({ outcome: "invalid" });
  expect(await f.store.getOperation(ref)).toEqual(beforeCorrection);
  expect(
    await (
      await send("correct", { ...correction, receipt: { ...correction.receipt, source: "probe" } })
    ).json(),
  ).toMatchObject({ outcome: "settled", replayed: false });
  expect(f.importSpy).not.toHaveBeenCalled();
});
