import { afterEach, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startServer } from "./index.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const directory = () => {
  const dir = mkdtempSync(join(tmpdir(), "usagekit-ui-"));
  dirs.push(dir);
  return dir;
};

test("the built UI is served at / without a token; the API still requires one", async () => {
  const ui = directory();
  mkdirSync(join(ui, "assets"));
  writeFileSync(join(ui, "index.html"), "<!doctype html><title>usagekit</title>");
  writeFileSync(join(ui, "assets", "app.js"), "console.log(1)");
  writeFileSync(join(ui, "assets", "app.css"), "body{}");
  const s = await startServer({ configDir: directory(), port: 0, uiRoot: ui, onToken: () => {} });
  try {
    const index = await s.app.request("/");
    expect(index.status).toBe(200);
    expect(index.headers.get("content-type")).toContain("text/html");
    expect(index.headers.get("cache-control")).toBe("no-store");
    expect(await index.text()).toContain("<title>usagekit</title>");
    const script = await s.app.request("/assets/app.js");
    expect(script.status).toBe(200);
    expect(script.headers.get("content-type")).toContain("text/javascript");
    expect((await s.app.request("/assets/app.css")).headers.get("content-type")).toContain(
      "text/css",
    );
    expect((await s.app.request("/assets/missing.js")).status).toBe(401);
    expect((await s.app.request("/assets/..%2F..%2Findex.html")).status).toBe(401);
    expect((await s.app.request("/v1/usage")).status).toBe(401);
    expect((await s.app.request("/budgets")).status).toBe(401);
    expect((await s.app.request("/", { method: "POST" })).status).toBe(401);
  } finally {
    await s.stop();
  }
});

test("without a built UI the root answers 404 after authentication", async () => {
  let token = "";
  const s = await startServer({
    configDir: directory(),
    port: 0,
    uiRoot: join(directory(), "absent"),
    onToken: (t) => {
      token = t;
    },
  });
  try {
    expect((await s.app.request("/")).status).toBe(401);
    expect(
      (await s.app.request("/", { headers: { Authorization: `Bearer ${token}` } })).status,
    ).toBe(404);
  } finally {
    await s.stop();
  }
});

test("the UI uses the base registry blocks in the Vega style and base primitives unchanged", () => {
  const server = join(import.meta.dirname, "..");
  const registry = join(server, "../registry");
  const blocks = [
    "usage-table",
    "budget-card",
    "header-status",
    "coverage-summary",
    "exceptions-list",
    "usage-filters",
    "connection-list",
    "budget-editor",
    "budget-manager-panel",
    "provider-card",
    "provider-connect-form",
    "provider-rate-editor",
    "provider-rate-row",
    "provider-source-control",
    "provider-credential-controls",
    "provider-credential-state",
    "provider-feedback",
    "usage-overview-card",
    "usage-connection-row",
    "usage-cap-pill",
    "usage-progress",
    "usage-meter",
    "usage-motion",
  ];
  expect(readdirSync(join(server, "ui/components/usagekit")).sort()).toEqual(
    blocks.map((block) => `${block}.tsx`).sort(),
  );
  // The dashboard is a Base UI Vega host: the sync script bakes the Vega sheet into each base block
  // as shadcn add does and fails when a copy differs.
  execFileSync(process.execPath, [join(server, "../../scripts/sync-server-ui.mjs"), "--check"], {
    stdio: "pipe",
  });
  for (const primitive of [
    "table",
    "card",
    "badge",
    "tooltip",
    "select",
    "button",
    "input",
    "label",
  ])
    expect(readFileSync(join(server, "ui/components/ui", `${primitive}.tsx`), "utf8")).toBe(
      readFileSync(join(registry, "consumers/base/components/ui", `${primitive}.tsx`), "utf8"),
    );
});
