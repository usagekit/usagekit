import { Hono } from "hono";
import { createUsageHandlers, parseBudget, encodeWire } from "@usagekit/http";
import { normalizeTags } from "@usagekit/core";
import type { Catalog } from "@usagekit/providers";
import type { createRecorder } from "./recorder.js";
import { connectionMetadata, connectionPolicyFailure } from "./connections.js";
import type { Meter } from "@usagekit/core";
import type { SqliteStore } from "@usagekit/store-sqlite";
import type { createAuth } from "./auth.js";
import type { Vault } from "./vault.js";
import { uiFile } from "./ui.js";
import { providerManagementRoutes } from "./provider-management/routes.js";
import type { createProviderManagement } from "./provider-management/service.js";
import { reconcileBudget } from "./budget-reconciliation.js";
export function createApp({
  meter,
  store,
  auth,
  vault,
  configPath,
  uiRoot,
  catalog,
  record,
  proxy,
  providerManagement,
}: {
  providerManagement?: ReturnType<typeof createProviderManagement>;
  proxy?: (request: Request) => Promise<Response>;
  catalog?: Catalog;
  record?: ReturnType<typeof createRecorder>;
  meter: Meter;
  store: SqliteStore;
  auth: ReturnType<typeof createAuth>;
  vault: Vault;
  configPath: string;
  uiRoot?: string;
}) {
  const app = new Hono();
  // The built UI is public static code with no data; every data read still needs the token.
  if (uiRoot)
    app.get("*", async (c, next) => {
      const file = uiFile(uiRoot, c.req.path);
      return file ? c.body(file.body, 200, file.headers) : next();
    });
  app.onError((error, c) =>
    c.json(
      {
        error:
          error.message === "VaultLocked"
            ? "vault_locked"
            : error.message === "ConnectionProviderMismatch"
              ? "connection_provider_mismatch"
              : "internal_error",
      },
      error.message === "VaultLocked"
        ? 423
        : error.message === "ConnectionProviderMismatch"
          ? 409
          : 500,
    ),
  );
  app.use("*", async (c, next) => {
    if (c.req.path !== "/health" && !(await auth.authenticate(c.req.raw)))
      return c.json({ outcome: "unauthorized" }, 401);
    await next();
  });
  app.get("/health", (c) =>
    c.json({ ok: true, version: "0.0.0", durable: true, vaultUnlocked: vault.unlocked }),
  );
  if (providerManagement) providerManagementRoutes(app, providerManagement, auth);
  if (proxy) app.all("/proxy/*", (c) => proxy(c.req.raw));
  const handler = createUsageHandlers({ meter, authenticate: auth.authenticate });
  app.all("/v1/*", (c) => handler(c.req.raw));
  app.get("/providers/connections", (c) => c.json(vault.list()));
  app.post("/providers/connections", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid_request" }, 400);
    }
    if (!body || typeof body !== "object" || Array.isArray(body))
      return c.json({ error: "invalid_request" }, 400);
    const b = body as Record<string, unknown>;
    if (
      Object.keys(b).some(
        (k) =>
          ![
            "provider",
            "connectionId",
            "secret",
            "tags",
            "plan",
            "tracking",
            "fundingSource",
            "manualPrices",
            "overage",
          ].includes(k),
      ) ||
      ![b.provider, b.connectionId, b.secret].every(
        (x) => typeof x === "string" && x.trim().length > 0,
      )
    )
      return c.json({ error: "invalid_request" }, 400);
    const tags = b.tags === undefined ? undefined : normalizeTags(b.tags as readonly string[]);
    if (tags === null) return c.json({ error: "invalid_request" }, 400);
    const policyFailure = connectionPolicyFailure(b, catalog);
    if (policyFailure) return c.json({ error: "invalid_connection_policy", ...policyFailure }, 400);
    const metadata = connectionMetadata(b, catalog);
    if (!metadata) return c.json({ error: "invalid_connection_policy" }, 400);
    if (providerManagement?.mutationBlocked())
      return c.json({ error: "provider_command_unresolved" }, 409);
    vault.put(b.provider as string, b.connectionId as string, b.secret as string, tags, metadata);
    return c.json(vault.list().find((entry) => entry.connectionId === b.connectionId));
  });
  app.post("/providers/connections/:id/record", async (c) => {
    if (!record) return c.json({ error: "recorder_unavailable" }, 404);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid_request" }, 400);
    }
    const result = await record(c.req.param("id"), body);
    return new Response(encodeWire(result.body), {
      status: result.status,
      headers: { "Content-Type": "application/json" },
    });
  });
  app.delete("/providers/connections/:id", (c) => {
    if (providerManagement?.mutationBlocked())
      return c.json({ error: "provider_command_unresolved" }, 409);
    vault.remove(c.req.param("id"));
    return c.json({ removed: true });
  });
  app.post("/providers/connections/:id/test", (c) => {
    const entry = vault.list().find((e) => e.connectionId === c.req.param("id"));
    if (!entry) return c.json({ error: "connection_not_found" }, 404);
    const secret = vault.get(entry.provider, entry.connectionId);
    return c.json({
      ...entry,
      valid: secret.trim().length > 0 && !/[\r\n\0]/.test(secret),
      method: "format",
      network: false,
    });
  });
  app.get(
    "/budgets",
    () =>
      new Response(encodeWire(store.listBudgets()), {
        headers: { "Content-Type": "application/json" },
      }),
  );
  app.put("/budgets", async (c) => {
    const access = await auth.authenticate(c.req.raw);
    if (!access?.canManageBudgets) return c.json({ outcome: "forbidden" }, 403);
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: "invalid_request" }, 400);
    }
    const b = parseBudget(raw);
    if (!b) return c.json({ error: "invalid_budget" }, 400);
    if (b.scope.namespace !== access.namespace) return c.json({ outcome: "forbidden" }, 403);
    if (b.limit && (b.limit.value < 0n || b.limit.unit !== b.unit))
      return c.json({ error: "invalid_budget" }, 400);
    const saved = store.putBudget(b);
    if (saved.outcome === "invalid") return c.json({ error: "invalid_budget" }, 400);
    if (saved.outcome === "conflict") return c.json(saved, 409);
    return new Response(encodeWire(b), { headers: { "Content-Type": "application/json" } });
  });
  app.post("/budgets/reconcile", async (c) => {
    const access = await auth.authenticate(c.req.raw);
    if (!access?.canManageBudgets) return c.json({ outcome: "forbidden" }, 403);
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: "invalid_request" }, 400);
    }
    return reconcileBudget(store, access, raw);
  });
  app.get("/token/path", (c) => c.json({ path: configPath }));
  app.post("/token/rotate", (c) => c.json({ token: auth.rotate() }));
  return app;
}
