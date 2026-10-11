import { fork } from "node:child_process";
import { createRemoteMeter } from "@usagekit/client";
import { loadCoverageView, loadExceptionsView } from "@usagekit/views";
import { localAccess } from "./auth.js";
import { afterEach, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createManualClock } from "@usagekit/store";
import { startServer } from "./index.js";
const servers: Awaited<ReturnType<typeof startServer>>[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
async function harness(
  options: { strictProxy?: boolean; enabledProviders?: readonly string[] } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "usagekit-proxy-"));
  dirs.push(dir);
  const transport = vi.fn<typeof fetch>(async () =>
    Response.json({ search_metadata: { id: "paid-1", status: "Success" } }),
  );
  const clock = createManualClock("2026-09-27T12:00:00Z");
  let token = "";
  const s = await startServer({
    ...options,
    configDir: dir,
    port: 0,
    clock,
    passphrase: "test-password",
    providerFetch: transport,
    onToken: (t) => {
      token = t;
    },
  });
  servers.push(s);
  s.vault.put("serpapi", "c", "vault-secret", undefined, { plan: "starter" });
  const send = (id: string) =>
    fetch(s.url + "/proxy/c/search.json?q=example", {
      headers: { Authorization: `Bearer ${token}`, "Idempotency-Key": id },
    });
  return { s, transport, clock, send, token, dir };
}
test("proxy denies a real HTTP request before dispatch and returns Retry-After", async () => {
  const h = await harness();
  h.s.store.putBudget({
    id: "cap",
    version: 1,
    scope: { kind: "principal", namespace: "local", principal: "local" },
    surface: "proxy",
    unit: "units",
    limit: { unit: "units", value: 0n, scale: 0 },
    window: { kind: "calendar_month", timezone: "UTC" },
    onExceed: "block",
  });
  const response = await h.send("denied");
  expect(response.status).toBe(429);
  expect(Number(response.headers.get("Retry-After"))).toBeGreaterThan(0);
  expect(h.transport).not.toHaveBeenCalled();
});
test("proxy injects vault credentials and cannot dispatch an idempotency replay", async () => {
  const h = await harness();
  const first = await h.send("once");
  expect(first.status).toBe(200);
  await first.text();
  const second = await h.send("once");
  expect(second.status).toBe(409);
  expect(h.transport).toHaveBeenCalledTimes(1);
  expect(new URL(String(h.transport.mock.calls[0]![0])).searchParams.get("api_key")).toBe(
    "vault-secret",
  );
  expect(
    await h.s.store.getOperation({ namespace: "local", principal: "local", operationId: "once" }),
  ).toMatchObject({ state: "settled", source: "proxy", surface: "programmatic" });
});

const ref = (operationId: string) => ({ namespace: "local", principal: "local", operationId });
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
test("authentication, provider allowlist and locked vault prevent dispatch", async () => {
  const h = await harness({ enabledProviders: [] });
  expect((await fetch(h.s.url + "/proxy/c/search.json")).status).toBe(401);
  expect((await h.send("disabled")).status).toBe(403);
  h.s.vault.lock();
  expect((await h.send("locked")).status).toBe(423);
  expect(h.transport).not.toHaveBeenCalled();
});
test("unknown paths are request-budgeted pending exceptions; strict paths never dispatch", async () => {
  const h = await harness();
  const unknown = await fetch(h.s.url + "/proxy/c/new-endpoint?q=private", {
    headers: { ...auth(h.token), "Idempotency-Key": "unknown" },
  });
  expect(unknown.status).toBe(200);
  expect(unknown.headers.get("X-Usagekit-Accounting")).toBe("unpriced");
  await unknown.text();
  const operation = await h.s.store.getOperation(ref("unknown"));
  expect(operation).toMatchObject({
    operation: "unknown",
    state: "pending",
    estimateSource: "unknown",
    receipts: [
      {
        cost: { certainty: "unknown", money: null },
        measurements: [{ unit: "requests", certainty: "measured" }],
      },
    ],
  });
  expect(
    JSON.stringify(operation, (_k, v) => (typeof v === "bigint" ? String(v) : v)),
  ).not.toContain("private");
  const strict = await harness({ strictProxy: true });
  expect(
    (await fetch(strict.s.url + "/proxy/c/new-endpoint", { headers: auth(strict.token) })).status,
  ).toBe(404);
  expect(strict.transport).not.toHaveBeenCalled();
});
test("unknown paths cannot bypass a request cap or a bound with no defensible estimate", async () => {
  const h = await harness();
  h.s.store.putBudget({
    id: "requests",
    version: 1,
    scope: { kind: "principal", namespace: "local", principal: "local" },
    unit: "requests",
    limit: { unit: "requests", value: 0n, scale: 0 },
    surface: "any",
    window: { kind: "calendar_month", timezone: "UTC" },
    onExceed: "block",
  });
  const response = await fetch(h.s.url + "/proxy/c/new", { headers: auth(h.token) });
  expect(response.status).toBe(429);
  h.s.store.putBudget({
    id: "money",
    version: 1,
    scope: { kind: "principal", namespace: "local", principal: "local" },
    unit: "cents",
    limit: { unit: "cents", value: 100n, scale: 0 },
    surface: "any",
    window: { kind: "calendar_month", timezone: "UTC" },
    onExceed: "block",
  });
  expect((await fetch(h.s.url + "/proxy/c/new", { headers: auth(h.token) })).status).toBe(422);
  expect(h.transport).not.toHaveBeenCalled();
});
test("passthrough and free calls are counted without reservations and survive replay after policy change", async () => {
  const h = await harness();
  h.s.vault.put("serpapi", "c", "vault-secret", undefined, { tracking: { search: "passthrough" } });
  const response = await h.send("pass");
  expect(response.headers.get("X-Usagekit-Accounting")).toBe("passthrough");
  await response.text();
  expect(await h.s.store.getOperation(ref("pass"))).toBeNull();
  h.s.vault.put("serpapi", "c", "rotated", undefined, { tracking: { search: "metered" } });
  expect((await h.send("pass")).status).toBe(409);
  const free = await fetch(h.s.url + "/proxy/c/account.json", { headers: auth(h.token) });
  await free.text();
  expect(free.headers.get("X-Usagekit-Accounting")).toBe("passthrough");
  expect(h.transport).toHaveBeenCalledTimes(2);
  expect(
    await h.s.store.requestCounts({
      scope: { kind: "principal", namespace: "local", principal: "local" },
      from: "2026-09-27T00:00:00Z",
      to: "2026-09-28T00:00:00Z",
      groupBy: [],
    }),
  ).toMatchObject({ rows: [{ state: "passthrough", count: 2n }] });
});
test("concurrent idempotency replay gets only one dispatch grant", async () => {
  const h = await harness();
  const replies = await Promise.all(Array.from({ length: 12 }, () => h.send("race")));
  await Promise.all(replies.map((r) => r.text()));
  expect(replies.filter((r) => r.status === 200)).toHaveLength(1);
  expect(replies.filter((r) => r.status === 409)).toHaveLength(11);
  expect(h.transport).toHaveBeenCalledTimes(1);
});
test("settlement waits for stream EOF and preserves response bytes", async () => {
  const h = await harness();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  h.transport.mockImplementationOnce(
    async () =>
      new Response(
        new ReadableStream({
          start(c) {
            controller = c;
            c.enqueue(new TextEncoder().encode('{"search_metadata":'));
          },
        }),
        { headers: { "Content-Type": "application/json" } },
      ),
  );
  const response = await h.send("stream");
  const reader = response.body!.getReader();
  const first = await reader.read();
  expect(new TextDecoder().decode(first.value)).toBe('{"search_metadata":');
  expect(await h.s.store.getOperation(ref("stream"))).toMatchObject({
    state: "dispatch_intended",
    receipts: [],
  });
  controller.enqueue(new TextEncoder().encode('{"id":"s","status":"Success"}}'));
  controller.close();
  while (!(await reader.read()).done) {
    /* Await proxy settlement before EOF. */
  }
  expect(await h.s.store.getOperation(ref("stream"))).toMatchObject({
    state: "settled",
    receipts: [{ providerRequestId: "s" }],
  });
});
test("broken upstream stream leaves unknown exposure and cannot be replayed", async () => {
  const h = await harness();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  h.transport.mockImplementationOnce(
    async () =>
      new Response(
        new ReadableStream({
          start(c) {
            controller = c;
            c.enqueue(new TextEncoder().encode("partial"));
          },
        }),
      ),
  );
  const response = await h.send("broken");
  const reader = response.body!.getReader();
  await reader.read();
  controller.error(new Error("vault-secret"));
  await expect(reader.read()).rejects.toThrow();
  expect(await h.s.store.getOperation(ref("broken"))).toMatchObject({
    state: "pending",
    receipts: [{ failed: true, cost: { certainty: "unknown" } }],
  });
  expect((await h.send("broken")).status).toBe(409);
  expect(h.transport).toHaveBeenCalledTimes(1);
});
test("transport errors are sanitized and never retried", async () => {
  const h = await harness();
  h.transport.mockRejectedValueOnce(new Error("vault-secret"));
  const response = await h.send("failed");
  expect(response.status).toBe(502);
  expect(await response.text()).not.toContain("vault-secret");
  expect(await h.s.store.getOperation(ref("failed"))).toMatchObject({ state: "pending" });
  expect(h.transport).toHaveBeenCalledTimes(1);
});
test("oversized responses still stream, but cannot claim an extracted price", async () => {
  const h = await harness();
  const body = "x".repeat(2 * 1024 * 1024 + 1);
  h.transport.mockResolvedValueOnce(new Response(body));
  const response = await h.send("large");
  expect(await response.text()).toBe(body);
  expect(await h.s.store.getOperation(ref("large"))).toMatchObject({
    state: "pending",
    receipts: [{ cost: { certainty: "unknown" } }],
  });
});
test("caller credentials, cookies, destinations and redirect headers never cross the boundary", async () => {
  const h = await harness();
  h.transport.mockResolvedValueOnce(
    new Response("redirect", {
      status: 302,
      headers: {
        location: "https://elsewhere.example/?key=secret",
        "set-cookie": "session=secret",
        "content-encoding": "gzip",
      },
    }),
  );
  const response = await fetch(
    h.s.url + "/proxy/c//elsewhere.example/path?api_key=attacker&token=caller&q=example",
    {
      headers: {
        ...auth(h.token),
        Cookie: "session=caller",
        "X-Api-Key": "caller",
        "Idempotency-Key": "headers",
      },
    },
  );
  await response.text();
  const [url, init] = h.transport.mock.calls[0]!;
  expect(new URL(String(url)).origin).toBe("https://serpapi.com");
  expect(new URL(String(url)).searchParams.get("api_key")).toBe("vault-secret");
  expect(new URL(String(url)).searchParams.has("token")).toBe(false);
  const headers = new Headers(init?.headers);
  expect(headers.has("Authorization")).toBe(false);
  expect(headers.has("Cookie")).toBe(false);
  expect(headers.has("X-Api-Key")).toBe(false);
  expect(init?.redirect).toBe("error");
  expect(response.status).toBe(302);
  for (const name of ["location", "set-cookie", "content-encoding"])
    expect(response.headers.has(name)).toBe(false);
});
test("body and idempotency validation happen before admission", async () => {
  const h = await harness();
  h.s.vault.put("dataforseo", "dfs", "test:password");
  for (const body of ["{broken", '"' + "x".repeat(2 * 1024 * 1024) + '"']) {
    const response = await fetch(h.s.url + "/proxy/dfs/v3/serp/google/organic/task_post", {
      method: "POST",
      headers: { ...auth(h.token), "Content-Type": "application/json" },
      body,
    });
    expect([400, 413]).toContain(response.status);
  }
  expect(
    (
      await fetch(h.s.url + "/proxy/c/search.json", {
        headers: { ...auth(h.token), "Idempotency-Key": "" },
      })
    ).status,
  ).toBe(400);
  expect(h.transport).not.toHaveBeenCalled();
});
test("restart keeps settled idempotency and recovers expired dispatch intents without upstream calls", async () => {
  const h = await harness();
  await (await h.send("finished")).text();
  const reserved = await h.s.store.reserve({
    operationId: "orphan-proxy",
    scope: { namespace: "local", principal: "local", connection: "c" },
    fundingSource: "byok",
    costOwner: "local",
    surface: "programmatic",
    source: "proxy",
    provider: "serpapi",
    operation: "unknown",
    estimate: [
      { unit: "units", value: 1n, scale: 0 },
      { unit: "requests", value: 1n, scale: 0 },
    ],
  });
  if (reserved.outcome !== "reserved") throw new Error("reserve failed");
  await h.s.store.markDispatchIntent({
    ...ref("orphan-proxy"),
    commandId: "intent",
    expectedVersion: reserved.operation.version,
    holder: "crashed",
    leaseTtlMs: 1000,
  });
  await h.s.stop();
  h.clock.advance(1001);
  const s = await startServer({
    configDir: h.dir,
    port: 0,
    clock: h.clock,
    passphrase: "test-password",
    providerFetch: h.transport,
    onToken: () => {
      throw new Error("token changed");
    },
  });
  servers.push(s);
  expect(await s.store.getOperation(ref("orphan-proxy"))).toMatchObject({
    state: "pending",
    receipts: [{ cost: { certainty: "unknown" }, measurements: [{ certainty: "unknown" }] }],
  });
  for (const id of ["finished", "orphan-proxy"])
    expect(
      (
        await fetch(s.url + "/proxy/c/search.json", {
          headers: { ...auth(h.token), "Idempotency-Key": id },
        })
      ).status,
    ).toBe(409);
  const coverage = await loadCoverageView(
    createRemoteMeter({ baseUrl: s.url, token: h.token }),
    localAccess,
    {
      scope: { kind: "principal", namespace: "local", principal: "local" },
      from: "2026-09-27T00:00:00Z",
      to: "2026-09-28T00:00:00Z",
    },
  );
  expect(coverage.total).toBeNull();
  expect(coverage.entries.find((e) => e.state === "unpriced")?.count).toBe("unavailable");
  expect(coverage.entries.find((e) => e.state === "metered")?.count).toBe("1");
  expect(h.transport).toHaveBeenCalledTimes(1);
});

test("explicit fixture recording covers unknown paths, strips secrets and makes only the requested dispatch", async () => {
  const h = await harness();
  h.transport.mockResolvedValueOnce(
    Response.json({ api_key: "vault-secret", account_email: "person@example.com", value: "hello" }),
  );
  const response = await fetch(h.s.url + "/proxy/c/new-operation?q=example", {
    headers: {
      ...auth(h.token),
      "Idempotency-Key": "record-unknown",
      "X-Usagekit-Record-Fixture": "true",
    },
  });
  expect(response.headers.get("X-Usagekit-Fixture-Hint")).toContain("X-Usagekit-Record-Fixture");
  await response.text();
  const dir = join(h.dir, "fixtures", "serpapi", "unknown");
  const files = readdirSync(dir);
  expect(files).toHaveLength(1);
  const text = readFileSync(join(dir, files[0]!), "utf8");
  for (const secret of ["vault-secret", "person@example.com", h.token])
    expect(text).not.toContain(secret);
  expect(JSON.parse(text)).toMatchObject({
    origin: "recorded",
    operation: "unknown",
    response: { status: 200, body: { value: "hello" } },
  });
  expect(statSync(join(dir, files[0]!)).mode & 0o777).toBe(0o600);
  expect(h.transport).toHaveBeenCalledTimes(1);
});

test("unknown operation appears once as unpriced coverage and as an exception", async () => {
  const h = await harness();
  const response = await fetch(h.s.url + "/proxy/c/not-in-catalog", {
    headers: { ...auth(h.token), "Idempotency-Key": "coverage" },
  });
  await response.text();
  const meter = createRemoteMeter({ baseUrl: h.s.url, token: h.token });
  const query = {
    scope: { kind: "principal", namespace: "local", principal: "local" } as const,
    from: "2026-09-27T00:00:00Z",
    to: "2026-09-28T00:00:00Z",
  };
  const coverage = await loadCoverageView(meter, localAccess, query);
  expect(coverage).toMatchObject({ state: "ok", total: "1", costExcludesUntracked: true });
  expect(coverage.entries.find((e) => e.state === "metered")?.count).toBe("0");
  expect(coverage.entries.find((e) => e.state === "unpriced")?.count).toBe("1");
  expect(await loadExceptionsView(meter, localAccess, query)).toMatchObject({
    state: "ok",
    rows: [{ operation: "unknown", operationId: "coverage", kind: "pending" }],
  });
});
test("DataForSEO JSON and Basic credentials survive forwarding; billed HTTP errors still settle", async () => {
  const h = await harness();
  h.s.vault.put("dataforseo", "dfs", "login:password", undefined, { plan: "prepaid" });
  const body = JSON.stringify([{ keyword: "example", tag: "forwarding" }]);
  h.transport.mockResolvedValueOnce(
    Response.json(
      {
        status_code: 50000,
        cost: 0.002,
        tasks: [{ id: "charged", status_code: 50000, cost: 0.002 }],
      },
      { status: 500 },
    ),
  );
  const response = await fetch(h.s.url + "/proxy/dfs/v3/serp/google/organic/live/advanced", {
    method: "POST",
    headers: { ...auth(h.token), "Content-Type": "application/json", "Idempotency-Key": "dfs" },
    body,
  });
  expect(response.status).toBe(500);
  await response.text();
  const [, init] = h.transport.mock.calls[0]!;
  expect(new TextDecoder().decode(init?.body as Uint8Array)).toBe(body);
  expect(new Headers(init?.headers).get("Authorization")).toBe(
    "Basic " + Buffer.from("login:password").toString("base64"),
  );
  expect(await h.s.store.getOperation(ref("dfs"))).toMatchObject({
    receipts: [{ failed: true, cost: { certainty: "measured" } }],
  });
});

test.each([
  ["keyword overview missing keywords", "dataforseo_labs/google/keyword_overview/live", [{}], 422],
  [
    "historical rank overview missing item count",
    "dataforseo_labs/google/historical_rank_overview/live",
    [{ target: "example.com" }],
    422,
  ],
  [
    "keyword ideas default page exceeds budget",
    "dataforseo_labs/google/keyword_ideas/live",
    [{ keywords: ["example"] }],
    429,
  ],
  [
    "numeric clickstream",
    "dataforseo_labs/google/keyword_ideas/live",
    [{ limit: 100, include_clickstream_data: 1 }],
    400,
  ],
  ["multiple tasks", "serp/google/organic/task_post", [{ depth: 100 }, { depth: 100 }], 400],
])("DataForSEO proxy rejects %s before dispatch", async (_case, path, body, status) => {
  const h = await harness();
  h.s.vault.put("dataforseo", "dfs", "test:password", undefined, { plan: "prepaid" });
  h.s.store.putBudget({
    id: "money",
    version: 1,
    scope: { kind: "principal", namespace: "local", principal: "local" },
    unit: "cents",
    limit: { unit: "cents", value: 3n, scale: 0 },
    surface: "any",
    window: { kind: "calendar_month", timezone: "UTC" },
    onExceed: "block",
  });
  const response = await h.s.app.request(`/proxy/dfs/v3/${path}`, {
    method: "POST",
    headers: {
      ...auth(h.token),
      "Content-Type": "application/json",
      "Idempotency-Key": "dfs-denied",
    },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(status);
  await response.text();
  expect(h.transport).not.toHaveBeenCalled();
  expect(await h.s.store.getOperation(ref("dfs-denied"))).toBeNull();
});

test.each([
  [
    "mixed-case JSON multi-task",
    "Application/JSON",
    "serp/google/organic/task_post",
    '[{"depth":100},{"depth":100}]',
  ],
  ["non-JSON media type", "text/plain", "serp/google/organic/task_post", '[{"depth":100}]'],
  ["string priority", "application/json", "serp/google/organic/task_post", '[{"priority":"2"}]'],
  [
    "string limit",
    "application/json",
    "dataforseo_labs/google/keyword_ideas/live",
    '[{"limit":"1000"}]',
  ],
  ["string depth", "application/json", "serp/google/organic/task_post", '[{"depth":"700"}]'],
])(
  "parser differential: rejects %s before reservation or upstream",
  async (_case, contentType, path, body) => {
    const h = await harness();
    h.s.vault.put("dataforseo", "dfs", "test:password", undefined, { plan: "prepaid" });
    const response = await h.s.app.request(`/proxy/dfs/v3/${path}`, {
      method: "POST",
      headers: {
        ...auth(h.token),
        "Content-Type": contentType,
        "Idempotency-Key": "parser-denied",
      },
      body,
    });
    await response.text();
    expect(h.transport).not.toHaveBeenCalled();
    expect(await h.s.store.getOperation(ref("parser-denied"))).toBeNull();
    expect(response.status).toBe(400);
  },
);

test("parser differential: upstream receives canonical JSON of the priced duplicate-key value", async () => {
  const h = await harness();
  h.s.vault.put("dataforseo", "dfs", "test:password", undefined, { plan: "prepaid" });
  const body = '[ { "limit": 1000, "limit": 10 } ]';
  const response = await h.s.app.request(
    "/proxy/dfs/v3/dataforseo_labs/google/keyword_ideas/live",
    {
      method: "POST",
      headers: {
        ...auth(h.token),
        Accept: "application/json",
        "Content-Type": "application/json; charset=utf-8",
        "Content-Encoding": "gzip",
        "Content-Length": String(Buffer.byteLength(body)),
        Cookie: "session=caller-cookie",
        "X-Api-Key": "caller-key",
        "Idempotency-Key": "canonical",
      },
      body,
    },
  );
  expect(response.status).toBe(200);
  await response.text();
  expect(h.transport).toHaveBeenCalledTimes(1);
  const [, init] = h.transport.mock.calls[0]!;
  expect(new TextDecoder().decode(init?.body as Uint8Array)).toBe(JSON.stringify(JSON.parse(body)));
  expect([...new Headers(init?.headers)]).toEqual([
    ["accept", "application/json"],
    ["authorization", `Basic ${Buffer.from("test:password").toString("base64")}`],
    ["content-type", "application/json"],
  ]);
  expect(await h.s.store.getOperation(ref("canonical"))).toMatchObject({
    estimate: expect.arrayContaining([{ unit: "cents", value: 132n, scale: 2 }]),
  });
});

test.each([
  "Application/JSON; charset=UTF-8",
  "application/vnd.api+json",
  "Application/Problem+JSON; charset=utf-8",
  "text/example+json",
])("proxy parses and canonicalizes JSON media type %s", async (contentType) => {
  const h = await harness();
  h.s.vault.put("dataforseo", "dfs", "test:password", undefined, { plan: "prepaid" });
  const response = await h.s.app.request("/proxy/dfs/v3/serp/google/organic/task_post", {
    method: "POST",
    headers: { ...auth(h.token), "Content-Type": contentType },
    body: ' [ { "priority": 2, "depth": 100 } ] ',
  });
  expect(response.status).toBe(200);
  await response.text();
  const [, init] = h.transport.mock.calls[0]!;
  expect(new TextDecoder().decode(init?.body as Uint8Array)).toBe('[{"priority":2,"depth":100}]');
  expect(new Headers(init?.headers).get("Content-Type")).toBe("application/json");
});

test.each([
  ["invalid JSON", "application/json", "{"],
  ["invalid suffix JSON", "application/vnd.api+json", "{"],
  ["missing JSON media type", undefined, "[{}]"],
  ["empty body", "application/json", ""],
  ["JSON string payload", "text/plain", "[{},{}]"],
])("billable DataForSEO rejects %s even in passthrough mode", async (_case, contentType, body) => {
  const h = await harness();
  h.s.vault.put("dataforseo", "dfs", "test:password", undefined, {
    tracking: { "serp.google.organic.task_post": "passthrough" },
  });
  const response = await h.s.app.request("/proxy/dfs/v3/serp/google/organic/task_post", {
    method: "POST",
    headers: {
      ...auth(h.token),
      ...(contentType ? { "Content-Type": contentType } : {}),
      "Idempotency-Key": "invalid-json",
    },
    ...(body === undefined ? {} : { body }),
  });
  expect(response.status).toBe(400);
  await response.text();
  expect(h.transport).not.toHaveBeenCalled();
  expect(await h.s.store.getOperation(ref("invalid-json"))).toBeNull();
});

test.each([
  ["dataforseo", "serp/google/organic/tasks_ready", "GET", "passthrough"],
  ["serpapi", "search.json", "POST", "unpriced"],
])(
  "%s preserves non-JSON forwarding for compatible operations",
  async (provider, path, method, accounting) => {
    const h = await harness();
    h.s.vault.put(provider, "raw", "test:password");
    const response = await h.s.app.request(
      `/proxy/raw/${provider === "dataforseo" ? "v3/" : ""}${path}`,
      {
        method,
        headers: { ...auth(h.token), "Content-Type": "text/plain" },
        ...(method === "GET" ? {} : { body: "raw request bytes" }),
      },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("X-Usagekit-Accounting")).toBe(accounting);
    await response.text();
    const [, init] = h.transport.mock.calls[0]!;
    if (method === "GET") expect(init?.body).toBeUndefined();
    else expect(new TextDecoder().decode(init?.body as Uint8Array)).toBe("raw request bytes");
    expect(new Headers(init?.headers).get("Content-Type")).toBe("text/plain");
  },
);

test.each([
  ["serpapi", "/search.json", "application/json"],
  ["serpapi", "/search.json", "Application/Merge-Patch+JSON; charset=UTF-8"],
  ["dataforseo", "/v3/unrecognized", "application/vnd.api+json"],
])("%s preserves unpriced body bytes and media type %s %s", async (provider, path, contentType) => {
  const h = await harness();
  h.s.vault.put(provider, "raw-json", "test:password");
  // Precision, overflow, whitespace and duplicate keys must survive outside priced bodies.
  const body = ' { "id": 9007199254740993, "huge": 1e400, "x": 1, "x": 2 } ';
  const response = await h.s.app.request(`/proxy/raw-json${path}`, {
    method: "POST",
    headers: { ...auth(h.token), "Content-Type": contentType },
    body,
  });
  expect(response.status).toBe(200);
  await response.text();
  const [, init] = h.transport.mock.calls[0]!;
  expect.soft(new TextDecoder().decode(init?.body as Uint8Array)).toBe(body);
  expect(new Headers(init?.headers).get("Content-Type")).toBe(contentType);
});

test("proxy forwards malformed JSON outside priced bodies without parsing it", async () => {
  const h = await harness();
  const body = Uint8Array.from([0x7b, 0xff, 0x00]);
  const response = await h.s.app.request("/proxy/c/search.json", {
    method: "POST",
    headers: { ...auth(h.token), "Content-Type": "application/json" },
    body,
  });
  expect(response.status).toBe(200);
  await response.text();
  const [, init] = h.transport.mock.calls[0]!;
  expect(init?.body).toEqual(body);
  expect(new Headers(init?.headers).get("Content-Type")).toBe("application/json");
});

test.each([
  ["numeric-key object", '{"0":{"depth":700},"1":{"depth":700}}'],
  ["bare task object", '{"keyword":"example","depth":700}'],
  ["empty task array", "[]"],
  ["nested task array", '[[{"depth":700}]]'],
  ["JSON string payload", '"[{\\"depth\\":700}]"'],
  ["null task", "[null]"],
])(
  "parser differential: rejects a billable %s before reservation or upstream",
  async (_case, body) => {
    const h = await harness();
    h.s.vault.put("dataforseo", "dfs", "test:password", undefined, { plan: "prepaid" });
    const response = await h.s.app.request("/proxy/dfs/v3/serp/google/organic/live/advanced", {
      method: "POST",
      headers: {
        ...auth(h.token),
        "Content-Type": "application/json",
        "Idempotency-Key": "shape-denied",
      },
      body,
    });
    await response.text();
    expect(h.transport).not.toHaveBeenCalled();
    expect(await h.s.store.getOperation(ref("shape-denied"))).toBeNull();
    expect(response.status).toBe(400);
  },
);

test.each([
  ["serp/google/organic/live/advanced", '[{"Depth":700}]'],
  ["serp/google/organic/task_post", '[{"PRIORITY":2}]'],
  ["dataforseo_labs/google/keyword_ideas/live", '[{"LIMIT":1000}]'],
  ["dataforseo_labs/google/keyword_ideas/live", '[{"l\u0131m\u0131t":1000}]'],
  ["dataforseo_labs/google/keyword_ideas/live", '[{"Include_Clickstream_Data":true}]'],
  ["dataforseo_labs/google/keyword_overview/live", '[{"\u212Aeywords":["a","b"]}]'],
])(
  "parser differential: %s meters unknown cost for case-variant pricing key body %s",
  async (path, body) => {
    const h = await harness();
    h.s.vault.put("dataforseo", "dfs", "test:password", undefined, { plan: "prepaid" });
    const response = await h.s.app.request(`/proxy/dfs/v3/${path}`, {
      method: "POST",
      headers: {
        ...auth(h.token),
        "Content-Type": "application/json",
        "Idempotency-Key": "key-denied",
      },
      body,
    });
    await response.text();
    expect(h.transport).toHaveBeenCalledOnce();
    expect(await h.s.store.getOperation(ref("key-denied"))).toMatchObject({
      estimate: [{ unit: "requests", value: 1n, scale: 0 }],
      estimateSource: "unknown",
    });
    expect(response.status).toBe(200);
  },
);

test("SIGKILL during a real proxy call preserves uncertain exposure across server restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "usagekit-proxy-crash-"));
  dirs.push(dir);
  const module = new URL("./../dist/index.js", import.meta.url).href.replace(
    "/src/../dist/",
    "/dist/",
  );
  const script = `import {startServer} from ${JSON.stringify(module)};
    let token; const s=await startServer({configDir:process.env.TEST_DIR,port:0,passphrase:'crash-password',clock:{now:()=>new Date('2026-09-27T12:00:00Z')},onToken:t=>token=t,providerFetch:async()=>{process.send({kind:'dispatch'}); return new Promise(()=>{});}});
    s.vault.put('serpapi','c','test-secret',undefined,{plan:'starter'});
    process.send({kind:'ready',url:s.url,token});`;
  const child = fork("--eval", [script], {
    execArgv: ["--input-type=module"],
    env: { ...process.env, TEST_DIR: dir },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const message = (kind: string) =>
    new Promise<Record<string, string>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("child timeout")), 10000);
      const listen = (data: Record<string, string>) => {
        if (data.kind === kind) {
          clearTimeout(timer);
          child.off("message", listen);
          resolve(data);
        }
      };
      child.on("message", listen);
      child.once("error", reject);
    });
  try {
    const ready = await message("ready"),
      dispatched = message("dispatch");
    const pending = fetch(ready.url + "/proxy/c/search.json", {
      headers: { ...auth(ready.token!), "Idempotency-Key": "killed" },
    })
      .then((r) => r.text())
      .catch(() => "disconnected");
    await dispatched;
    const exit = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGKILL");
    await exit;
    await pending;
    const transport = vi.fn<typeof fetch>(async () => {
      throw new Error("must not dispatch");
    });
    const clock = createManualClock("2026-09-27T12:01:01Z");
    const s = await startServer({
      configDir: dir,
      port: 0,
      passphrase: "crash-password",
      clock,
      providerFetch: transport,
      onToken: () => {
        throw new Error("token changed");
      },
    });
    servers.push(s);
    expect(await s.store.getOperation(ref("killed"))).toMatchObject({
      state: "pending",
      receipts: [{ cost: { certainty: "unknown" } }],
    });
    expect(
      (
        await fetch(s.url + "/proxy/c/search.json", {
          headers: { ...auth(ready.token!), "Idempotency-Key": "killed" },
        })
      ).status,
    ).toBe(409);
    expect(transport).not.toHaveBeenCalled();
  } finally {
    child.kill();
  }
});

test("client cancellation aborts the upstream stream and preserves pending exposure", async () => {
  const h = await harness();
  let cancelled = false;
  h.transport.mockImplementationOnce(
    async () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode("partial"));
          },
          cancel() {
            cancelled = true;
          },
        }),
      ),
  );
  const response = await h.s.app.request("/proxy/c/search.json", {
    headers: { ...auth(h.token), "Idempotency-Key": "cancelled" },
  });
  const reader = response.body!.getReader();
  await reader.read();
  await reader.cancel();
  expect(cancelled).toBe(true);
  expect(h.transport.mock.calls[0]![1]?.signal?.aborted).toBe(true);
  expect(await h.s.store.getOperation(ref("cancelled"))).toMatchObject({
    state: "pending",
    receipts: [{ failed: true, cost: { certainty: "unknown" } }],
  });
});
test("lost settlement lease leaves intent for maintenance recovery without redispatch", async () => {
  const h = await harness();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  h.transport.mockImplementationOnce(
    async () =>
      new Response(
        new ReadableStream({
          start(c) {
            controller = c;
            c.enqueue(new TextEncoder().encode("partial"));
          },
        }),
      ),
  );
  const response = await h.s.app.request("/proxy/c/search.json", {
    headers: { ...auth(h.token), "Idempotency-Key": "lease-lost" },
  });
  const reader = response.body!.getReader();
  await reader.read();
  h.clock.advance(60001);
  controller.close();
  await expect(reader.read()).rejects.toThrow();
  expect(await h.s.store.getOperation(ref("lease-lost"))).toMatchObject({
    state: "dispatch_intended",
  });
  await h.s.expireReservations();
  expect(await h.s.store.getOperation(ref("lease-lost"))).toMatchObject({ state: "pending" });
  expect(h.transport).toHaveBeenCalledTimes(1);
});

test.each(["money", "passthrough", "unbounded"] as const)(
  "uncertain DataForSEO proxy delegates %s to Meter",
  async (mode) => {
    const h = await harness();
    const operation = "serp.google.organic.live.advanced";
    h.s.vault.put("dataforseo", "dfs", "test:password", undefined, {
      ...(mode === "passthrough" ? { tracking: { [operation]: "passthrough" } } : {}),
    });
    if (mode === "money")
      h.s.store.putBudget({
        id: "money",
        version: 1,
        scope: { kind: "principal", namespace: "local", principal: "local" },
        unit: "cents",
        limit: { unit: "cents", value: 3n, scale: 0 },
        surface: "any",
        window: { kind: "calendar_month", timezone: "UTC" },
        onExceed: "block",
      });
    const body = JSON.stringify([{ keyword: "example", future_paid_parameter: true }]);
    const response = await h.s.app.request("/proxy/dfs/v3/serp/google/organic/live/advanced", {
      method: "POST",
      headers: {
        ...auth(h.token),
        "Content-Type": "application/json",
        "Idempotency-Key": "uncertain",
      },
      body,
    });
    expect(response.status).toBe(mode === "money" ? 422 : 200);
    if (mode === "money") {
      expect(await response.json()).toMatchObject({ error: "cannot_estimate_bounded_usage" });
      expect(h.transport).not.toHaveBeenCalled();
    } else {
      await response.text();
      expect(h.transport).toHaveBeenCalledOnce();
      expect(new TextDecoder().decode(h.transport.mock.calls[0]![1]?.body as Uint8Array)).toBe(
        body,
      );
      if (mode === "passthrough")
        expect(response.headers.get("X-Usagekit-Accounting")).toBe("passthrough");
      else
        expect(await h.s.store.getOperation(ref("uncertain"))).toMatchObject({
          estimate: [{ unit: "requests", value: 1n, scale: 0 }],
          estimateSource: "unknown",
          receipts: [{ cost: { certainty: "unknown", money: null } }],
        });
    }
  },
);
