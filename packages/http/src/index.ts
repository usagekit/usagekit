import type { Meter, AccessContext } from "@usagekit/core";
import { parseWire, validResponse } from "./schemas/index.js";
import type { RouteName } from "./schemas/index.js";
import { decodeWire, encodeWire, decodeQuery } from "./wire.js";
import { problem } from "./errors.js";
import { dispatchCommand } from "./routes/commands.js";
import { dispatchRead } from "./routes/reads.js";
export { encodeWire, decodeWire } from "./wire.js";
export type { WireInputs, RouteName } from "./schemas/index.js";
export { routes } from "./schemas/index.js";
export { Budget as BudgetSchema } from "./schemas/index.js";
/**
 * Web-standard handler for the Meter routes. Access comes from authenticate, never the request.
 * commands: false mounts the read side only: accounting and billing import POSTs answer 404
 * after authentication and before any authorization or body parsing, so an embedded host can
 * expose usage to an external dashboard while operations stay created in process.
 */
export function createUsageHandlers({
  meter,
  authenticate,
  commands = true,
}: {
  meter: Meter;
  authenticate: (request: Request) => Promise<AccessContext | null>;
  commands?: boolean;
}): (request: Request) => Promise<Response> {
  return async (request) => {
    try {
      const access = await authenticate(request);
      if (!access) return problem(401);
      const url = new URL(request.url);
      let name: RouteName | undefined,
        write = false;
      if (request.method === "POST" && url.pathname.startsWith("/v1/operations/")) {
        if (!commands) return problem(404);
        const route = url.pathname.slice("/v1/operations/".length);
        if (
          [
            "reserve",
            "intent",
            "renew",
            "claim",
            "settle",
            "correct",
            "release",
            "expire",
          ].includes(route)
        ) {
          name = route as RouteName;
          write = true;
        }
      }
      if (request.method === "POST" && url.pathname === "/v1/requests/count") {
        if (!commands) return problem(404);
        name = "count";
        write = true;
      }
      if (request.method === "POST" && url.pathname === "/v1/billing/import") {
        if (!commands) return problem(404);
        if (access.canImportBilling !== true) return problem(403);
        name = "importBilling";
        write = true;
      }
      if (request.method === "POST" && url.pathname === "/v1/usage/query") name = "usage";
      if (request.method === "GET") {
        if (url.pathname === "/v1/quotes") name = "quote";
        else if (url.pathname === "/v1/usage") name = "usage";
        else if (url.pathname === "/v1/operations") name = "operations";
        else if (url.pathname === "/v1/budgets/defined") name = "defined";
        else if (url.pathname === "/v1/budgets/applicable") name = "applicable";
        else if (url.pathname === "/v1/requests/counts") name = "counts";
        else if (url.pathname === "/v1/billing/imports") name = "billingImports";
        else if (/^\/v1\/operations\/[^/]+$/.test(url.pathname)) name = "operation";
      }
      if (!name) return problem(404);
      let raw: unknown;
      try {
        raw =
          request.method === "GET"
            ? decodeQuery(url.searchParams.get("q") ?? "")
            : await request.json();
      } catch {
        return problem(400);
      }
      const parsed = parseWire(name, raw);
      if (!parsed.success) return problem(400);
      const body = parsed.output as unknown as Record<string, unknown>,
        scope = (body.scope ?? body) as Record<string, unknown>;
      if (scope.namespace !== access.namespace) return problem(403);
      if (name === "expire" && !access.canManageBudgets) return problem(403);
      if (
        write &&
        typeof scope.principal === "string" &&
        access.readablePrincipals !== "*" &&
        !access.readablePrincipals.includes(scope.principal)
      )
        return problem(403);
      if (
        name === "operation" &&
        decodeURIComponent(url.pathname.split("/").at(-1)!) !== body.operationId
      )
        return problem(400);
      const native = decodeWire(JSON.stringify(body));
      const result = write
        ? await dispatchCommand(meter, access, name, native as Record<string, unknown>)
        : await dispatchRead(meter, access, name, native);
      if ("outcome" in result && result.outcome === "forbidden") return problem(403);
      const encoded = encodeWire(result);
      if (!validResponse(name, JSON.parse(encoded))) return problem(500);
      return new Response(encoded, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    } catch {
      return problem(500);
    }
  };
}

export { parseBudget } from "./schemas/budget.js";
