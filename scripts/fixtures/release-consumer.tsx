import assert from "node:assert/strict";
import { renderToString } from "react-dom/server";
import { formatMoney, fromDecimalString } from "@usagekit/core";
import type { AccessContext, Meter } from "@usagekit/core";
import { createManualClock, createMemoryStore } from "@usagekit/store";
import { canonical as canonicalReference } from "@usagekit/store/reference";
import { createMeter } from "@usagekit/meter";
import {
  dataforseo,
  createCatalog,
  createMeteredDispatch,
  tokenQuantities,
} from "@usagekit/providers";
import { loadUsageSummary, parseProviderDecimal } from "@usagekit/views";
import type { ProviderManagementPort } from "@usagekit/views";
import {
  MeterProvider,
  useMeterBinding,
  createMeterQueryClient,
  ProviderManagementProvider,
  useProviderEditor,
} from "@usagekit/react";
import type { ProviderEditor } from "@usagekit/react";
import {
  createPostgresStore,
  createPrismaPostgresDriver,
  migratePostgresStore,
} from "@usagekit/store-postgres";
import type { PostgresStoreOptions, PrismaPostgresClient } from "@usagekit/store-postgres";
import { Pool } from "pg";

const clock = createManualClock("2026-10-07T12:00:00.000Z");
const store = createMemoryStore({ clock, budgets: [] });
const meter: Meter = createMeter({ store, clock });
const access: AccessContext = {
  namespace: "consumer",
  readablePrincipals: ["owner"],
  readableGroups: [],
  readablePools: [],
  canReadBillingDetail: true,
  canManageBudgets: false,
};
const view = await loadUsageSummary(meter, access, {
  scope: { kind: "principal", namespace: "consumer", principal: "owner" },
  from: "2026-10-01T00:00:00.000Z",
  to: "2026-11-01T00:00:00.000Z",
  units: ["requests"],
});
assert.equal(view.complete, true);
assert.equal(formatMoney(fromDecimalString("12.3456")), "12.3456");
assert.equal(typeof canonicalReference, "function");
const pricing = {
  prices: {
    input: { units: 3_000_000n, currency: "USD" },
    output: { units: 15_000_000n, currency: "USD" },
  },
  moneyUnit: "customer_cents",
} as const;
const admitted = await createMeteredDispatch({ meter, now: clock.now, renewEveryMs: 0 }).admit({
  id: "consumer-turn",
  operation: {
    scope: { namespace: "consumer", principal: "owner", connection: "platform" },
    fundingSource: "platform",
    costOwner: "platform",
    surface: "app",
    source: "app",
    provider: "example",
    operation: "generate",
  },
  estimate: tokenQuantities({ input: 1000, output: 200 }, pricing).usage,
});
assert.equal(admitted.outcome, "admitted");
if (admitted.outcome === "admitted")
  assert.equal(
    (await admitted.dispatch.settle(tokenQuantities({ input: 400, output: 80 }, pricing))).outcome,
    "settled",
  );
assert.ok(createCatalog({ providers: [dataforseo], enabled: [dataforseo.descriptor.id] }));
assert.equal(parseProviderDecimal("0.012", "cents").outcome, "valid");
function Status() {
  const binding = useMeterBinding();
  assert.equal(binding?.meter, meter);
  return <span>Shared meter ready</span>;
}
const html = renderToString(
  <MeterProvider meter={meter} access={access} queryClient={createMeterQueryClient()}>
    <Status />
  </MeterProvider>,
);
assert.match(html, /Shared meter ready/);

// Exercise the installed headless editor API without starting a read or provider action during SSR.
let providerTransportCalls = 0;
const unexpectedProviderTransport = async (): Promise<never> => {
  providerTransportCalls++;
  throw new Error("Provider transport must not run during server rendering");
};
const providerPort: ProviderManagementPort = {
  read: unexpectedProviderTransport,
  execute: unexpectedProviderTransport,
  reconcile: unexpectedProviderTransport,
};
function ProviderEditorStatus() {
  const editor: ProviderEditor<"details"> = useProviderEditor({
    kind: "details",
    connectionId: "consumer-connection",
  });
  const base = editor.editorData?.connection;
  const evidence = editor.evidence?.connection;
  assert.ok(editor.editorEpoch);
  assert.equal(typeof editor.reload, "function");
  assert.equal(typeof editor.action.run, "function");
  assert.equal(typeof editor.action.reconcile, "function");
  return (
    <section aria-label="Provider editor">
      <div key={editor.editorEpoch}>{base ? `Draft for ${base.label}` : "No draft base"}</div>
      <output>
        {evidence ? `Current rates: ${evidence.rates.length}` : "No current evidence"}
      </output>
      <button
        type="button"
        onClick={editor.reload}
        disabled={editor.refreshing || editor.action.pending || editor.action.ambiguous}
      >
        Reload rates
      </button>
      <button type="button" disabled={!editor.canEdit || !editor.action.canWrite}>
        Save rate
      </button>
      <button
        type="button"
        onClick={() => void editor.action.reconcile()}
        disabled={!editor.action.ambiguous || editor.action.pending}
      >
        Check change status
      </button>
    </section>
  );
}
const providerHtml = renderToString(
  <ProviderManagementProvider
    port={providerPort}
    binding={{
      scopeKey: "consumer:provider-editor",
      principalKey: "owner",
      authRevision: "1",
      canManage: true,
    }}
  >
    <ProviderEditorStatus />
  </ProviderManagementProvider>,
);
assert.match(providerHtml, /No draft base/);
assert.match(providerHtml, /No current evidence/);
assert.match(providerHtml, /<button\b[^>]*disabled=""[^>]*>Save rate<\/button>/);
assert.equal(providerTransportCalls, 0);
// Import the durable adapter and check its public types without opening a database connection.
const pool = new Pool({ max: 1 });
const options: PostgresStoreOptions = { pool, clock, schema: "consumer" };
assert.equal(options.pool, pool);
assert.equal(typeof createPostgresStore, "function");
assert.equal(typeof migratePostgresStore, "function");
const driverFactory: (client: PrismaPostgresClient) => unknown = createPrismaPostgresDriver;
assert.equal(typeof driverFactory, "function");
await pool.end();
console.log("Consumer declarations, exports, headless reads and React server rendering passed.");
