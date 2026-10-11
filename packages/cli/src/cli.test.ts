import { afterEach, expect, test } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "@usagekit/server";
import { createRemoteMeter } from "@usagekit/client";
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const dir = () => {
  const d = mkdtempSync(join(tmpdir(), "usagekit-cli-"));
  dirs.push(d);
  return d;
};
const entry = fileURLToPath(new URL("../dist/index.js", import.meta.url));
function run(
  args: string[],
  url: string,
  token: string,
  configDir: string,
  stdin = "",
  binary = entry,
) {
  return new Promise<{ code: number | null; out: string; err: string }>((resolve, reject) => {
    const p = spawn(process.execPath, [binary, ...args, "--url", url, "--config-dir", configDir], {
      env: { ...process.env, USAGEKIT_TOKEN: token },
    });
    let out = "",
      err = "";
    p.stdout.on("data", (b) => {
      out += b;
    });
    p.stderr.on("data", (b) => {
      err += b;
    });
    p.on("error", reject);
    p.on("close", (code) => resolve({ code, out, err }));
    p.stdin.end(stdin);
  });
}
test("CLI provider, budgets, reporting, usage and rotation work over HTTP", async () => {
  const d = dir();
  let token = "";
  const server = await startServer({
    configDir: d,
    port: 0,
    passphrase: crypto.randomUUID(),
    onToken: (t) => {
      token = t;
    },
  });
  const cli = (args: string[], stdin = "") => run(args, server.url, token, d, stdin);
  const json = async (args: string[], stdin = "") => {
    const r = await cli([...args, "--json"], stdin);
    expect(r.err).toBe("");
    expect(r.code, r.out).toBe(0);
    return JSON.parse(r.out);
  };
  try {
    const secret = crypto.randomUUID();
    expect(
      await json(
        ["provider", "add", "example", "--connection", "c", "--tag", "prod", "--tag", "eu"],
        secret + "\n",
      ),
    ).toEqual({ provider: "example", connectionId: "c", tags: ["eu", "prod"] });
    expect(
      (
        await cli(
          ["provider", "add", "example", "--connection", "c2", "--tag", "Bad Tag", "--json"],
          secret,
        )
      ).code,
    ).toBe(1);
    const conflict = await cli(
      ["provider", "add", "other", "--connection", "c", "--json"],
      crypto.randomUUID(),
    );
    expect(conflict.code).toBe(1);
    expect(server.vault.get("example", "c")).toBe(secret);
    expect(await json(["report", "expire"])).toEqual({
      outcome: "expired",
      count: 0,
      hasMore: false,
    });
    expect(await json(["provider", "list"])).toHaveLength(1);
    expect(await json(["provider", "test", "--connection", "c"])).toMatchObject({
      valid: true,
      network: false,
    });
    expect(await json(["budget", "set", "--id", "b", "--limit", "1:requests"])).toMatchObject({
      id: "b",
      version: 1,
    });
    expect(await json(["budget", "list"])).toHaveLength(1);
    expect(
      await json([
        "budget",
        "set",
        "--id",
        "soft",
        "--limit",
        "10:requests",
        "--allow",
        "--hard-limit",
        "20:requests",
        "--alert",
        "50",
        "--alert",
        "12:requests",
      ]),
    ).toMatchObject({
      id: "soft",
      onExceed: "allow",
      hardLimit: { value: "20", scale: 0, unit: "requests" },
      alerts: [{ at: { percent: 50 } }, { at: { value: "12", scale: 0, unit: "requests" } }],
    });
    expect(
      await json(["budget", "set", "--id", "cli-only", "--source", "cli", "--limit", "5:requests"]),
    ).toMatchObject({ id: "cli-only", surface: "cli" });
    expect(
      await json([
        "budget",
        "set",
        "--id",
        "prod-tag",
        "--scope",
        "tag",
        "--tag",
        "prod",
        "--limit",
        "5:requests",
      ]),
    ).toMatchObject({ scope: { kind: "tag", namespace: "local", tag: "prod" } });
    for (const bad of [
      ["--id", "x", "--limit", "1:requests", "--hard-limit", "2:requests"],
      ["--id", "x", "--limit", "1:requests", "--allow", "--hard-limit", "1:requests"],
      ["--id", "x", "--limit", "1:requests", "--alert", "0"],
      ["--id", "x", "--limit", "1:requests", "--alert", "12.5"],
      ["--id", "x", "--limit", "1:requests", "--source", "web"],
      ["--id", "x", "--scope", "tag", "--tag", "Prod", "--limit", "1:requests"],
    ])
      expect((await cli(["budget", "set", ...bad, "--json"])).code, bad.join(" ")).not.toBe(0);
    expect(await json(["budget", "list"])).toHaveLength(4);
    const reserve = [
      "report",
      "reserve",
      "--provider",
      "example",
      "--connection",
      "c",
      "--estimate",
      "1:requests",
      "--command-id",
      "op1",
    ];
    expect(await json(reserve)).toMatchObject({
      granted: true,
      operation: {
        operationId: "op1",
        state: "dispatch_intended",
        scope: { tags: ["eu", "prod"] },
        budgetEpochs: [
          { budgetId: "b" },
          { budgetId: "cli-only" },
          { budgetId: "soft" },
          { budgetId: "prod-tag" },
        ],
      },
    });
    expect((await cli([...reserve, "--json"])).code).toBe(1);
    const settle = [
      "report",
      "settle",
      "--operation",
      "op1",
      "--quantity",
      "1:requests",
      "--cost",
      "0.0100",
      "--command-id",
      "receipt1",
    ];
    const first = await json(settle);
    expect(first).toMatchObject({
      outcome: "settled",
      replayed: false,
      operation: { receipts: [{ cost: { money: { units: "100", currency: "USD" } } }] },
    });
    expect(await json(settle)).toMatchObject({ outcome: "settled", replayed: true });
    expect(
      (await cli([...settle.map((x) => (x === "1:requests" ? "2:requests" : x)), "--json"])).code,
    ).toBe(2);
    const exceeded = await cli([
      "report",
      "reserve",
      "--provider",
      "example",
      "--connection",
      "c",
      "--estimate",
      "1:requests",
    ]);
    expect(exceeded.code).toBe(1);
    expect(exceeded.out).toContain("resetsAt");
    const usage = await json([
      "usage",
      "--window",
      "month",
      "--group",
      "provider,day",
      "--unit",
      "requests",
    ]);
    expect(usage).toMatchObject({
      outcome: "ok",
      value: { rows: [{ measurements: [{ quantity: { value: "1" } }] }] },
    });
    expect((await cli(["usage"])).out).toContain("example");
    expect(await json(["usage", "--group-by", "funding_source,tag"])).toMatchObject({
      value: {
        rows: [
          { dimensions: { funding_source: "byok", tag: "eu" } },
          { dimensions: { funding_source: "byok", tag: "prod" } },
        ],
      },
    });
    expect(await json(["usage", "--group", "tag"])).toMatchObject({
      value: { rows: [{ dimensions: { tag: "eu" } }, { dimensions: { tag: "prod" } }] },
    });
    expect(await json(["provider", "remove", "--connection", "c"])).toEqual({ removed: true });
    expect(await json(["token", "show-path"])).toHaveProperty("path");
    const rotated = await json(["token", "rotate"]);
    token = rotated.token;
    expect(await json(["budget", "list"])).toHaveLength(4);
  } finally {
    await server.stop();
  }
});
test("CLI release uses stable command payloads; errors have documented exit codes", async () => {
  const d = dir();
  let token = "";
  const server = await startServer({
    configDir: d,
    port: 0,
    onToken: (t) => {
      token = t;
    },
  });
  try {
    server.vault.unlock("test-passphrase");
    server.vault.put("example", "c", "test-secret");
    server.vault.lock();
    await createRemoteMeter({ baseUrl: server.url, token }).reserve({
      operationId: "unused",
      scope: { namespace: "local", principal: "local", connection: "c" },
      fundingSource: "byok",
      costOwner: "local",
      surface: "programmatic",
      source: "cli",
      provider: "example",
      operation: "search",
      estimate: [{ value: 1n, scale: 0, unit: "requests" }],
    });
    const args = [
      "report",
      "release",
      "--operation",
      "unused",
      "--command-id",
      "release1",
      "--json",
    ];
    for (const replayed of [false, true]) {
      const r = await run(args, server.url, token, d);
      expect(r.code, r.err).toBe(0);
      expect(JSON.parse(r.out)).toMatchObject({ outcome: "released", replayed });
    }
    expect((await run(["bad-command"], server.url, token, d)).code).toBe(2);
    expect((await run(["usage", "--group", "invalid"], server.url, token, d)).code).toBe(2);
    expect((await run(["usage"], "http://127.0.0.1:1", token, d)).code).toBe(3);
  } finally {
    await server.stop();
  }
});
test("CLI serve delegates startup and shuts down on SIGTERM", async () => {
  const d = dir();
  const p = spawn(process.execPath, [entry, "serve", "--port", "0", "--config-dir", d, "--json"], {
    env: { ...process.env, USAGEKIT_VAULT_PASSPHRASE: crypto.randomUUID() },
  });
  let text = "";
  const ended = new Promise<number | null>((resolve) => p.once("close", resolve));
  try {
    const url = await new Promise<string>((resolve, reject) => {
      p.on("error", reject);
      p.on("close", () => reject(new Error("serve exited before ready")));
      p.stdout.on("data", (b) => {
        text += b;
        for (const line of text.split("\n").filter(Boolean)) {
          try {
            const event = JSON.parse(line);
            if (event.url) resolve(event.url);
          } catch {
            /* incomplete line */
          }
        }
      });
    });
    expect(await (await fetch(url + "/health")).json()).toMatchObject({
      durable: true,
      vaultUnlocked: true,
    });
  } finally {
    p.kill("SIGTERM");
    await ended;
  }
});

test("CLI cycle/reset reads and budget scopes round-trip exact quantities", async () => {
  const d = dir();
  let token = "";
  const s = await startServer({
    configDir: d,
    port: 0,
    onToken: (t) => {
      token = t;
    },
  });
  const cli = (args: string[]) => run([...args, "--json"], s.url, token, d);
  try {
    const start = new Date(Date.now() - 60000).toISOString(),
      end = new Date(Date.now() + 60000).toISOString();
    const scopes = [
      ["connection", "--connection", "c"],
      ["group", "--group", "g"],
      ["platform_pool", "--pool", "p"],
      ["access_credential", "--credential-kind", "oauth_client", "--credential-id", "t"],
    ];
    for (const [scope, ...flags] of scopes) {
      const r = await cli([
        "budget",
        "set",
        "--id",
        scope!,
        "--scope",
        scope!,
        ...flags,
        "--limit",
        "0.000000000000000001:units",
        "--window",
        "cycle",
        "--epoch",
        "cycle1",
        "--from",
        start,
        "--to",
        end,
      ]);
      expect(r.code, r.out + r.err).toBe(0);
      expect(JSON.parse(r.out).limit).toEqual({ value: "1", scale: 18, unit: "units" });
    }
    expect((await cli(["usage", "--window", "cycle", "--unit", "units"])).code).toBe(0);
    expect(
      (
        await cli([
          "budget",
          "set",
          "--id",
          "reset",
          "--unlimited",
          "--unit",
          "requests",
          "--window",
          "reset",
          "--epoch",
          "r1",
          "--from",
          start,
        ])
      ).code,
    ).toBe(0);
    expect((await cli(["usage", "--window", "reset"])).code).toBe(0);
    expect(
      (
        await cli([
          "report",
          "reserve",
          "--provider",
          "example",
          "--connection",
          "c",
          "--estimate",
          "1:requests",
          "--lease-ms",
          "-1",
        ])
      ).code,
    ).toBe(2);
  } finally {
    await s.stop();
  }
});

test("installed symlink executes the CLI entry point", async () => {
  const d = dir(),
    binary = join(d, "usagekit");
  symlinkSync(entry, binary);
  const r = await run(["--help", "--json"], "http://127.0.0.1:4242", "", d, "", binary);
  expect(r.code).toBe(0);
  expect(JSON.parse(r.out)).toHaveProperty("commands");
});

test("CLI catalog reserve omits estimate, records a fixture and rejects invalid policy", async () => {
  const d = dir();
  let token = "",
    calls = 0;
  const server = await startServer({
    configDir: d,
    port: 0,
    passphrase: "test-password",
    onToken: (t) => {
      token = t;
    },
    providerFetch: async () => {
      calls++;
      return Response.json({ search_metadata: { id: "recorded", status: "Success" } });
    },
  });
  const cli = (args: string[], stdin = "") => run([...args, "--json"], server.url, token, d, stdin);
  try {
    const added = await cli(
      ["provider", "add", "serpapi", "--connection", "catalog", "--plan", "starter"],
      "fixture-key",
    );
    expect(added.code, added.out).toBe(0);
    const reservation = await cli([
      "report",
      "reserve",
      "--connection",
      "catalog",
      "--provider",
      "serpapi",
      "--feature",
      "search",
    ]);
    expect(reservation.code, reservation.out).toBe(0);
    expect(JSON.parse(reservation.out)).toMatchObject({
      granted: true,
      operation: {
        estimateSource: "list",
        estimate: [
          { unit: "units", value: "1" },
          { unit: "requests", value: "1" },
        ],
      },
    });
    const manual = await cli(
      [
        "provider",
        "add",
        "serpapi",
        "--connection",
        "catalog",
        "--price",
        "search=2.5:units",
        "--overage",
        "true",
      ],
      "rotated-key",
    );
    expect(manual.code, manual.out).toBe(0);
    expect(JSON.parse(manual.out)).toMatchObject({
      overage: true,
      manualPrices: { search: { value: "25", scale: 1, unit: "units" } },
    });
    expect(
      (
        await cli(
          ["provider", "add", "serpapi", "--connection", "catalog", "--overage", "maybe"],
          "key",
        )
      ).code,
    ).toBe(2);
    const requestFile = join(d, "request.json");
    writeFileSync(requestFile, JSON.stringify({ method: "GET", url: "/search.json?q=example" }));
    const recorded = await cli([
      "provider",
      "record",
      "--connection",
      "catalog",
      "--feature",
      "search",
      "--request",
      requestFile,
    ]);
    expect(recorded.code, recorded.out).toBe(0);
    expect(calls).toBe(1);
    expect(JSON.parse(readFileSync(JSON.parse(recorded.out).path, "utf8"))).toMatchObject({
      origin: "recorded",
      operation: "search",
    });
    expect(
      (
        await cli(
          ["provider", "add", "serpapi", "--connection", "catalog", "--tracking", "search=bad"],
          "fixture-key",
        )
      ).code,
    ).toBe(1);
    expect(
      (
        await cli(
          [
            "provider",
            "add",
            "serpapi",
            "--connection",
            "catalog",
            "--tracking",
            "search=passthrough",
          ],
          "fixture-key",
        )
      ).code,
    ).toBe(0);
    const passthrough = await cli([
      "report",
      "reserve",
      "--connection",
      "catalog",
      "--provider",
      "serpapi",
      "--feature",
      "search",
    ]);
    expect(passthrough.code).toBe(1);
    expect(JSON.parse(passthrough.out)).toMatchObject({ outcome: "passthrough" });
  } finally {
    await server.stop();
  }
});
