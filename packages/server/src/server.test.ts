import { afterEach, expect, test, vi } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createManualClock } from "@usagekit/store";
import { createRemoteMeter } from "@usagekit/client";
import { startServer } from "./index.js";
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const directory = () => {
  const dir = mkdtempSync(join(tmpdir(), "usagekit-server-"));
  dirs.push(dir);
  return dir;
};
const budget = {
  id: "b",
  version: 1,
  scope: { kind: "principal", namespace: "local", principal: "local" },
  surface: "any",
  unit: "requests",
  limit: { unit: "requests", value: "1", scale: 0 },
  window: { kind: "calendar_month", timezone: "UTC" },
  onExceed: "block",
};
const input = () => ({
  operationId: crypto.randomUUID(),
  scope: { namespace: "local", principal: "local", connection: "c" },
  fundingSource: "byok" as const,
  costOwner: "local",
  surface: "programmatic" as const,
  source: "cli" as const,
  provider: "example",
  operation: "search",
  estimate: [{ unit: "requests", value: 1n, scale: 0 }],
});
const access = {
  namespace: "local",
  readablePrincipals: "*" as const,
  readableGroups: "*" as const,
  readablePools: "*" as const,
  canReadBillingDetail: true,
  canManageBudgets: true,
};
test("loopback startup, auth, rotation and private config", async () => {
  const dir = directory();
  let token = "";
  const began = performance.now();
  const s = await startServer({
    configDir: dir,
    port: 0,
    onToken: (t) => {
      token = t;
    },
  });
  try {
    console.info(
      `Loopback startup: ${(performance.now() - began).toFixed(1)} ms (recorded, not asserted)`,
    );
    expect(await (await fetch(s.url + "/health")).json()).toMatchObject({
      ok: true,
      durable: true,
      vaultUnlocked: false,
    });
    expect((await fetch(s.url + "/budgets")).status).toBe(401);
    expect(
      (await fetch(s.url + "/budgets", { headers: { Authorization: "Bearer wrong" } })).status,
    ).toBe(401);
    expect(
      (await fetch(s.url + "/budgets", { headers: { Authorization: `Bearer ${token}` } })).status,
    ).toBe(200);
    const r = await fetch(s.url + "/token/rotate", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    const next = (await r.json()) as { token: string };
    expect(next.token).not.toBe(token);
    expect(
      (await fetch(s.url + "/budgets", { headers: { Authorization: `Bearer ${token}` } })).status,
    ).toBe(401);
    expect(
      (await fetch(s.url + "/budgets", { headers: { Authorization: `Bearer ${next.token}` } }))
        .status,
    ).toBe(200);
    expect(readFileSync(join(dir, "config.json"), "utf8")).not.toContain(next.token);
    expect(statSync(join(dir, "config.json")).mode & 0o777).toBe(0o600);
  } finally {
    await s.stop();
  }
});
test("remote binding is refused, including unsupported TLS opt-in", async () => {
  await expect(
    startServer({ configDir: directory(), host: "0.0.0.0", onToken: () => {} }),
  ).rejects.toThrow("LoopbackOnly");
  await expect(
    startServer({ configDir: directory(), host: "0.0.0.0", allowRemote: true, onToken: () => {} }),
  ).rejects.toThrow("NotSupported");
});
test("provider routes never leak plaintext to responses, logs, config or database", async () => {
  const dir = directory(),
    marker = "usagekit-marker-7f3a",
    output: string[] = [],
    bodies: string[] = [];
  const logs = vi.spyOn(console, "log").mockImplementation((...x) => {
      output.push(x.join(" "));
    }),
    errors = vi.spyOn(console, "error").mockImplementation((...x) => {
      output.push(x.join(" "));
    });
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output.push(String(chunk));
    return true;
  });
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    output.push(String(chunk));
    return true;
  });
  let token = "";
  const s = await startServer({
    configDir: dir,
    port: 0,
    passphrase: crypto.randomUUID(),
    onToken: (t) => {
      token = t;
    },
  });
  const request = async (path: string, method = "GET", body?: unknown) => {
    const res = await fetch(s.url + path, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    bodies.push(text);
    return { status: res.status, data: JSON.parse(text) };
  };
  try {
    expect(
      (
        await request("/providers/connections", "POST", {
          provider: "example",
          connectionId: "c",
          secret: marker,
        })
      ).status,
    ).toBe(200);
    expect((await request("/providers/connections")).data).toEqual([
      { provider: "example", connectionId: "c" },
    ]);
    expect(
      (
        await request("/providers/connections", "POST", {
          provider: "example",
          connectionId: "c",
          secret: marker,
          tags: ["prod", "eu"],
        })
      ).data,
    ).toEqual({ provider: "example", connectionId: "c", tags: ["eu", "prod"] });
    expect((await request("/providers/connections")).data).toEqual([
      { provider: "example", connectionId: "c", tags: ["eu", "prod"] },
    ]);
    expect((await request("/providers/connections/c/test", "POST")).data).toMatchObject({
      valid: true,
      method: "format",
      network: false,
    });
    expect((await request("/budgets", "PUT", budget)).status).toBe(200);
    await request("/health");
    await request("/budgets");
    await request("/token/path");
    await request("/v1/operations/reserve", "POST", { secret: marker });
    await request("/providers/connections/c", "DELETE");
    expect(output.join("\n") + bodies.join("\n")).not.toContain(marker);
    for (const file of readdirSync(dir, { recursive: true }) as string[]) {
      if (statSync(join(dir, file)).isDirectory()) {
        expect(statSync(join(dir, file)).mode & 0o777).toBe(0o700);
        continue;
      }
      expect(readFileSync(join(dir, file)).includes(Buffer.from(marker))).toBe(false);
      expect(statSync(join(dir, file)).mode & 0o777).toBe(0o600);
    }
  } finally {
    await s.stop();
    logs.mockRestore();
    errors.mockRestore();
    stdout.mockRestore();
    stderr.mockRestore();
  }
});
test("HTTP intent survives server restart and budget enforcement continues", async () => {
  const dir = directory(),
    clock = createManualClock();
  let token = "",
    s = await startServer({
      configDir: dir,
      port: 0,
      clock,
      onToken: (t) => {
        token = t;
      },
    });
  try {
    s.vault.unlock("test-passphrase");
    s.vault.put("example", "c", "test-secret");
    s.vault.lock();
    await fetch(s.url + "/budgets", {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(budget),
    });
    let meter = createRemoteMeter({ baseUrl: s.url, token });
    const i = input(),
      r = await meter.reserve(i);
    if (r.outcome !== "reserved") throw new Error("fixture");
    const ref = { namespace: "local", principal: "local", operationId: i.operationId };
    expect(
      await meter.markDispatchIntent({
        ...ref,
        commandId: "intent",
        expectedVersion: 1,
        holder: "script",
        leaseTtlMs: 60000,
      }),
    ).toMatchObject({ granted: true });
    await s.stop();
    clock.advance(60001);
    s = await startServer({
      configDir: dir,
      port: 0,
      clock,
      onToken: () => {
        throw new Error("token printed twice");
      },
    });
    meter = createRemoteMeter({ baseUrl: s.url, token });
    expect(await meter.getOperation(access, ref)).toMatchObject({
      outcome: "ok",
      value: { state: "dispatch_intended", lease: { holder: "script" } },
    });
    expect(await meter.reserve(input())).toMatchObject({ outcome: "exceeded" });
    expect(
      await meter.claimForRecovery({ ...ref, holder: "recovery", leaseTtlMs: 1000 }),
    ).toMatchObject({ claimed: true });
    console.info("HTTP restart: preserved operation/lease, budget still blocks, recovery succeeds");
  } finally {
    await s.stop();
  }
});

test("provider and budget input errors are safe and locked vault leaves metering available", async () => {
  let token = "";
  const s = await startServer({
    configDir: directory(),
    port: 0,
    onToken: (t) => {
      token = t;
    },
  });
  const send = (path: string, body: unknown, method = "POST") =>
    s.app.request(path, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  try {
    s.vault.unlock("test-passphrase");
    s.vault.put("example", "c", "test-secret");
    s.vault.lock();
    for (const bad of [
      null,
      [],
      { provider: "x", connectionId: "c", secret: "" },
      { provider: "x", connectionId: "c", secret: crypto.randomUUID(), extra: true },
      { provider: "x", connectionId: "c", secret: crypto.randomUUID(), tags: [] },
      { provider: "x", connectionId: "c", secret: crypto.randomUUID(), tags: ["Bad"] },
      { provider: "x", connectionId: "c", secret: crypto.randomUUID(), tags: "prod" },
    ])
      expect((await send("/providers/connections", bad)).status).toBe(400);
    expect(
      (
        await s.app.request("/providers/connections", {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
          body: "{",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await send("/providers/connections", {
          provider: "example",
          connectionId: "c",
          secret: crypto.randomUUID(),
        })
      ).status,
    ).toBe(423);
    expect((await send("/providers/connections/missing/test", {})).status).toBe(404);
    expect((await send("/budgets", {}, "PUT")).status).toBe(400);
    expect(
      (
        await s.app.request("/budgets", {
          method: "PUT",
          headers: { Authorization: `Bearer ${token}` },
          body: "{",
        })
      ).status,
    ).toBe(400);
    expect(
      (await send("/budgets", { ...budget, scope: { ...budget.scope, namespace: "other" } }, "PUT"))
        .status,
    ).toBe(403);
    expect(
      (await send("/budgets", { ...budget, limit: { ...budget.limit, value: "-1" } }, "PUT"))
        .status,
    ).toBe(400);
    expect((await send("/budgets", budget, "PUT")).status).toBe(200);
    expect((await send("/budgets", budget, "PUT")).status).toBe(409);
    expect((await send("/budgets", { ...budget, version: 2 }, "PUT")).status).toBe(200);
    expect(await createRemoteMeter({ baseUrl: s.url, token }).reserve(input())).toMatchObject({
      outcome: "reserved",
    });
    const hardLimit = { unit: "requests", value: "2", scale: 0 };
    expect(
      (await send("/budgets", { ...budget, version: 3, hardLimit }, "PUT")).status,
      "hardLimit requires allow",
    ).toBe(400);
    expect(
      (await send("/budgets", { ...budget, version: 3, onExceed: "warn", hardLimit }, "PUT"))
        .status,
      "warn is accepted as the deprecated alias of allow",
    ).toBe(200);
    expect(s.store.listBudgets()).toMatchObject([{ id: "b", version: 3, onExceed: "allow" }]);
  } finally {
    await s.stop();
    await s.stop();
  }
});

test("listen failure closes the database and vault", async () => {
  const s = await startServer({ configDir: directory(), port: 0, onToken: () => {} });
  try {
    await expect(
      startServer({ configDir: directory(), port: Number(new URL(s.url).port), onToken: () => {} }),
    ).rejects.toThrow();
  } finally {
    await s.stop();
  }
});
