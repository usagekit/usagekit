import { execFile, execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createElement, useRef, useState } from "react";
import { renderToString } from "react-dom/server";
import type { ComponentType, FormEventHandler, ReactNode } from "react";
import { createManualClock, createMemoryStore } from "@usagekit/store";
import { createMeter } from "@usagekit/meter";
import {
  MeterProvider,
  ProviderManagementProvider,
  createMeterQueryClient,
  createProviderQueryClient,
} from "@usagekit/react";
import type { BudgetWriter } from "@usagekit/react";
import { legacy, styleMap, styleSource, styles } from "../styles/styles.mjs";
import {
  createDemoProviderPort,
  demoProviders,
  initialAllocations,
  initialConnections,
} from "../consumers/radix/app/demo-providers.js";
import type {
  ProviderAllocationRow,
  ProviderActionResult,
  ProviderCommand,
  ProviderReadResult,
} from "@usagekit/views";
import type { AccessContext, Budget, ReserveInput } from "@usagekit/core";
import { blockNames, variants } from "./index.js";
import type { Variant } from "./index.js";

/** The shadcn CLI version these tests pin; the root lockfile installs exactly this one. */
const shadcnVersion = "4.21.0";
const root = resolve(import.meta.dirname, "..");
const repo = resolve(root, "../..");
const cli = join(repo, "node_modules/shadcn/dist/index.js");
// Inside the workspace root (ignored by Git and Prettier): the test module loader serves files
// under its root only. Each run removes its own directory.
mkdirSync(join(root, ".work"), { recursive: true });
const work = mkdtempSync(join(root, ".work", "run-"));
const out = join(work, "registry");
const npmLog = join(work, "npm.log");
const requests: string[] = [];
let server: Server;
let registryUrl: string;

/**
 * Loopback stand-in for the public registry: bare registryDependencies resolve to the primitive
 * files already committed in each consumer, and the base color is an empty palette. No network.
 */
function serve(): Promise<void> {
  server = createServer((req, res) => {
    const url = req.url ?? "";
    requests.push(url);
    res.setHeader("content-type", "application/json");
    if (/^\/r\/colors\/[a-z]+\.json$/.test(url)) {
      const empty = { light: {}, dark: {} };
      res.end(
        JSON.stringify({
          inlineColors: empty,
          cssVars: empty,
          cssVarsV4: empty,
          inlineColorsTemplate: "",
          cssVarsTemplate: "",
        }),
      );
      return;
    }
    const match = /^\/r\/styles\/([a-z0-9-]+)\/([a-z-]+)\.json$/.exec(url);
    const variant: Variant | null = match
      ? match[1]!.startsWith("base")
        ? "base"
        : "radix"
      : null;
    const file = match && join(root, "consumers", variant!, "components/ui", `${match[2]}.tsx`);
    if (!file || !existsSync(file)) {
      res.statusCode = 404;
      res.end("{}");
      return;
    }
    res.end(
      JSON.stringify({
        name: match![2],
        type: "registry:ui",
        files: [
          {
            path: `ui/${match![2]}.tsx`,
            type: "registry:ui",
            content: readFileSync(file, "utf8"),
          },
        ],
      }),
    );
  });
  return new Promise((done) =>
    server.listen(0, "127.0.0.1", () => {
      registryUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/r`;
      done();
    }),
  );
}

/** Copies a committed consumer, links the workspace node_modules and adds every block to it. */
async function addBlocks(variant: Variant): Promise<string> {
  const host = join(work, variant);
  cpSync(join(root, "consumers", variant), host, { recursive: true });
  symlinkSync(join(repo, "node_modules"), join(host, "node_modules"), "dir");
  const bin = join(work, "bin");
  mkdirSync(bin, { recursive: true });
  // The CLI installs pinned block dependencies with npm; this stub records them offline.
  writeFileSync(join(bin, "npm"), `#!/bin/sh\necho "$@" >> "${npmLog}"\n`);
  chmodSync(join(bin, "npm"), 0o755);
  // Asynchronous on purpose: the loopback registry answers from this same process.
  await promisify(execFile)(
    process.execPath,
    [
      cli,
      "add",
      ...blockNames.map((n) => join(out, "r", variant, `${n}.json`)),
      "--yes",
      "--overwrite",
    ],
    {
      cwd: host,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        REGISTRY_URL: registryUrl,
      },
    },
  );
  return host;
}

const hosts = {} as Record<Variant, string>;
beforeAll(async () => {
  execFileSync(process.execPath, [join(repo, "scripts/registry-build.mjs"), "--out", out]);
  await serve();
  for (const variant of variants) hosts[variant] = await addBlocks(variant);
}, 180000);
afterAll(() => {
  server?.close();
  rmSync(work, { recursive: true, force: true });
});
afterEach(cleanup);

describe("shadcn add against both consumers", () => {
  test("the pinned CLI version runs", () => {
    expect(execFileSync(process.execPath, [cli, "--version"]).toString().trim()).toBe(
      shadcnVersion,
    );
  });
  test.each(variants)("%s: every block lands unchanged and primitives stay intact", (variant) => {
    const host = hosts[variant];
    for (const name of blockNames)
      expect(readFileSync(join(host, "components/usagekit", `${name}.tsx`), "utf8")).toBe(
        styleSource(
          readFileSync(join(root, "registry", variant, name, `${name}.tsx`), "utf8"),
          styleMap(styles.find((style) => style.name === legacy[variant])!.sheet),
        ),
      );
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
      expect(readFileSync(join(host, "components/ui", `${primitive}.tsx`), "utf8")).toBe(
        readFileSync(join(root, "consumers", variant, "components/ui", `${primitive}.tsx`), "utf8"),
      );
    expect(readFileSync(join(host, "app/index.css"), "utf8")).toBe(
      readFileSync(join(root, "consumers", variant, "app/index.css"), "utf8"),
    );
  });
  test("block dependencies were requested at the pinned versions, offline", () => {
    const version = (name: string) =>
      JSON.parse(readFileSync(join(repo, "packages", name, "package.json"), "utf8")).version;
    const log = readFileSync(npmLog, "utf8");
    for (const name of ["react", "views", "core"])
      expect(log).toContain(`@usagekit/${name}@${version(name)}`);
    expect(requests.every((url) => url.startsWith("/r/"))).toBe(true);
    expect(requests.some((url) => url.startsWith("/r/styles/base-vega/"))).toBe(true);
    expect(requests.some((url) => url.startsWith("/r/styles/new-york/"))).toBe(true);
  });
  test.each(variants)("%s: the consumer typechecks with the added blocks", (variant) => {
    const host = hosts[variant];
    const paths = Object.fromEntries(
      ["core", "views", "react", "store", "meter"].map((n) => [
        `@usagekit/${n}`,
        [join(repo, "packages", n, "src/index.ts")],
      ]),
    );
    writeFileSync(
      join(host, "tsconfig.check.json"),
      JSON.stringify({
        extends: "./tsconfig.json",
        compilerOptions: { paths: { "@/*": ["./*"], ...paths } },
      }),
    );
    try {
      execFileSync(
        process.execPath,
        [join(repo, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.check.json"],
        { cwd: host, stdio: "pipe" },
      );
    } catch (error) {
      const output = error as { stdout?: Buffer; stderr?: Buffer };
      throw new Error(`${output.stdout ?? ""}${output.stderr ?? ""}`);
    }
  });
});

const access: AccessContext = {
  namespace: "test",
  readablePrincipals: ["u1"],
  readableGroups: [],
  readablePools: [],
  canReadBillingDetail: true,
  canManageBudgets: false,
};
const scope = { namespace: "test", principal: "u1", connection: "c1" };
const month = { from: "2026-09-01T00:00:00.000Z", to: "2026-10-01T00:00:00.000Z" };
const budgets: Budget[] = [
  {
    id: "cap",
    version: 1,
    scope: { kind: "principal", namespace: "test", principal: "u1" },
    surface: "any",
    unit: "requests",
    limit: { value: 10n, scale: 0, unit: "requests" },
    window: { kind: "calendar_month", timezone: "UTC" },
    onExceed: "allow",
    hardLimit: { value: 15n, scale: 0, unit: "requests" },
    alerts: [{ at: { percent: 50 } }],
  },
  {
    id: "pool",
    version: 1,
    scope: { kind: "platform_pool", namespace: "test", poolId: "p1" },
    surface: "any",
    unit: "requests",
    limit: { value: 100n, scale: 0, unit: "requests" },
    window: { kind: "calendar_month", timezone: "UTC" },
    onExceed: "block",
  },
];

async function memoryMeter() {
  const clock = createManualClock(),
    store = createMemoryStore({ clock, budgets: [...budgets] }),
    meter = createMeter({ store, clock });
  const reserve = async (overrides: Partial<ReserveInput> = {}) => {
    const r = await store.reserve({
      operationId: crypto.randomUUID(),
      scope,
      fundingSource: "byok",
      costOwner: "u1",
      surface: "app",
      source: "app",
      provider: "search",
      operation: "search",
      platformPools: ["p1"],
      estimate: [{ value: 1n, scale: 0, unit: "requests" }],
      ...overrides,
    });
    if (r.outcome !== "reserved") throw new Error("fixture");
    return r.operation;
  };
  for (const provider of ["alpha", "beta"]) {
    const op = await reserve({ provider });
    const ref = { namespace: "test", principal: "u1", operationId: op.operationId };
    const g = await store.markDispatchIntent({
      ...ref,
      commandId: crypto.randomUUID(),
      expectedVersion: op.version,
      holder: "h",
      leaseTtlMs: 60000,
    });
    if (!("granted" in g) || !g.granted) throw new Error("fixture");
    await store.settle({
      ...ref,
      commandId: crypto.randomUUID(),
      expectedVersion: g.operation.version,
      authority: { kind: "lease", leaseId: g.lease.leaseId },
      receipt: {
        id: crypto.randomUUID(),
        measurements: [
          {
            unit: "requests",
            quantity: { value: 3n, scale: 0, unit: "requests" },
            certainty: "measured",
          },
          {
            unit: "customer_cents",
            quantity: { value: 180001n, scale: 4, unit: "customer_cents" },
            certainty: "measured",
          },
        ],
        cost: { certainty: "measured", money: { units: 12345n, currency: "USD" } },
        occurredAt: "2026-09-23T12:00:00.000Z",
        recordedAt: "2026-09-23T12:00:00.000Z",
        cached: false,
        failed: false,
      },
    });
  }
  await reserve({ reservationTtlMs: 1000 });
  clock.advance(5000);
  await meter.countRequest({
    commandId: "unpriced-request",
    scope,
    provider: "search",
    operation: "unknown",
    surface: "app",
    source: "app",
    state: "unpriced",
  });
  return meter;
}

type Module = Record<string, ComponentType<Record<string, unknown>>>;
const load = async (variant: Variant, name: string): Promise<Module> =>
  (await import(
    /* @vite-ignore */ pathToFileURL(join(hosts[variant], "components/usagekit", `${name}.tsx`))
      .href
  )) as Module;

describe.each(variants)("%s a11y regression", (variant) => {
  test("filter labels identify unique controls across instances", async () => {
    const { UsageFilters } = await load(variant, "usage-filters");
    const props = {
      period: "this",
      periods: [{ value: "this", label: "This month" }],
      onPeriodChange: vi.fn(),
      scope: "me",
      scopes: [{ value: "me", label: "My usage" }],
      onScopeChange: vi.fn(),
    };
    render(
      createElement(
        "div",
        {},
        createElement(UsageFilters!, props),
        createElement(UsageFilters!, props),
      ),
    );
    const controls = screen.getAllByRole("combobox");
    expect(new Set(controls.map((control) => control.id)).size).toBe(4);
    for (const control of controls) {
      const label = control.closest("label")!;
      expect(label.htmlFor).toBe(control.id);
      expect(label.control).toBe(control);
    }
    expect(screen.getAllByRole("combobox", { name: "Period" })).toHaveLength(2);
    expect(screen.getAllByRole("combobox", { name: "Scope" })).toHaveLength(2);
  });

  test("header details have a named keyboard button that never submits a host form", async () => {
    // jsdom has no geometry observer; tooltip positioning only needs its lifecycle here.
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    try {
      const { HeaderStatusPanel } = await load(variant, "header-status");
      const onSubmit = vi.fn((event: import("react").FormEvent) => event.preventDefault());
      const meter = await memoryMeter();
      render(
        createElement(
          MeterProvider,
          { meter, access },
          createElement(
            "form",
            { onSubmit },
            createElement(HeaderStatusPanel!, {
              scope,
              surface: "app",
              units: ["requests"],
              platformPools: ["p1"],
            }),
          ),
        ),
      );
      const button = await screen.findByRole("button", {
        name: "principal u1: 3 of 10 requests left",
      });
      expect(button.getAttribute("type")).toBe("button");
      expect(button.tabIndex).toBe(0);
      await act(async () => button.focus());
      expect(document.activeElement).toBe(button);
      expect(await screen.findByText("Warning at 50%")).toBeTruthy();
      fireEvent.click(button);
      expect(onSubmit).not.toHaveBeenCalled();
    } finally {
      cleanup();
      vi.unstubAllGlobals();
    }
  });

  test("provider choices use a named native fieldset", async () => {
    const { ProviderManagerPanel } = await load(variant, "provider-manager-panel");
    const demo = createDemoProviderPort(`a11y:${crypto.randomUUID()}`);
    render(
      createElement(
        ProviderManagementProvider,
        { port: demo.port, binding: demo.binding },
        createElement(ProviderManagerPanel!),
      ),
    );
    const group = await screen.findByRole("group", { name: "Choose a provider" });
    expect(group.tagName).toBe("FIELDSET");
    expect(within(group).getByRole("button", { name: "New connection: Search" })).toBeTruthy();
    expect(demo.calls).toEqual([]);
  });

  test("funding confirmation uses a named native fieldset and preserves explicit actions", async () => {
    const { ProviderSourceSelector } = await load(variant, "provider-source-selector");
    const onSelect = vi.fn(async () => {});
    render(
      createElement(ProviderSourceSelector!, {
        mode: "controlled",
        value: "byok",
        choices: [{ source: "byok" }, { source: "platform" }],
        onSelect,
        confirmTransition: () => "Confirm this change?",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Platform funded" }));
    const group = screen.getByRole("group", { name: "Change the funding source to" });
    expect(group.tagName).toBe("FIELDSET");
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.click(within(group).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("group", { name: "Change the funding source to" })).toBeNull();
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Platform funded" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm funding change" }));
    await waitFor(() => expect(onSelect).toHaveBeenCalledExactlyOnceWith("platform"));
  });
});

describe.each(variants)("%s native usage presentation", (variant) => {
  test("unknown progress cannot display a fabricated zero", async () => {
    const { UsageOverviewCard } = await load(variant, "usage-overview-card");
    render(
      createElement(UsageOverviewCard!, {
        title: "Provider usage",
        budget: { label: "Budget used", value: "0%", percent: 0, partial: true },
        metrics: [{ id: "paid", label: "Paid to providers", value: "Unknown" }],
        labels: { unknown: "Unconfirmed usage" },
      }),
    );
    expect(screen.getByRole("region", { name: "Budget used" }).textContent).toContain(
      "Unconfirmed usage",
    );
    expect(screen.queryByRole("meter")).toBeNull();
    expect(screen.queryByText("0%")).toBeNull();
  });
  test("partial and exceeded progress preserve actual copy and valid meter geometry", async () => {
    const { UsageOverviewCard } = await load(variant, "usage-overview-card");
    render(
      createElement(UsageOverviewCard!, {
        title: "Provider usage",
        budget: {
          label: "Budget used",
          value: "At least 180%",
          meterLabel: "Partial budget usage",
          percent: 180,
          partial: true,
        },
        metrics: [{ id: "paid", label: "Paid", value: "At least $125.55" }],
        children: createElement("li", null, "Provider A"),
        notice: {
          message: "Provider A reached its limit",
          action: createElement("a", { href: "/settings" }, "Settings"),
        },
      }),
    );
    const meter = screen.getByRole("meter", { name: "Partial budget usage" });
    expect(meter.getAttribute("aria-valuenow")).toBe("100");
    expect(meter.getAttribute("aria-valuetext")).toBe("At least 180%");
    expect(meter.getAttribute("data-level")).toBe("exceeded");
    expect(meter.style.getPropertyValue("--usage-fill")).toBe("100%");
    expect(meter.getAttribute("data-kind")).toBe("partial");
    expect(meter.querySelector("[data-usage-over]")).toBeTruthy();
    expect(screen.getByRole("listitem").textContent).toBe("Provider A");
    expect(screen.getByRole("alert").textContent).toContain("Provider A reached its limit");
    expect(screen.getByText("At least $125.55")).toBeTruthy();
  });
  test("loading keeps the layout without placeholder figures", async () => {
    const { UsageOverviewCard } = await load(variant, "usage-overview-card");
    render(
      createElement(UsageOverviewCard!, {
        title: "Provider usage",
        loading: true,
        budget: { label: "Budget used", value: "0%", percent: 0, partial: false },
        metrics: [{ id: "paid", label: "Paid", value: "$0.00" }],
      }),
    );
    expect(screen.getByRole("status").textContent).toBe("Loading usage.");
    expect(screen.queryByRole("meter")).toBeNull();
    expect(screen.queryByText("0%")).toBeNull();
    expect(screen.queryByText("$0.00")).toBeNull();
  });
  test("a known figure, its status words and the warning mark render together", async () => {
    const { UsageOverviewCard } = await load(variant, "usage-overview-card");
    const { container } = render(
      createElement(UsageOverviewCard!, {
        title: "Provider usage",
        budget: {
          label: "Budget used",
          value: "86% of the tightest budget used",
          figure: "86%",
          caption: "Tightest: Search",
          percent: 86,
          partial: false,
          warningAt: 80,
        },
        metrics: [],
        labels: { warning: "Close to the limit" },
      }),
    );
    expect(screen.getByText("86%")).toBeTruthy();
    expect(screen.getByText("Close to the limit")).toBeTruthy();
    const meter = screen.getByRole("meter", { name: "Budget used" });
    expect(meter.getAttribute("aria-valuetext")).toBe("86% of the tightest budget used");
    expect(meter.getAttribute("data-level")).toBe("warning");
    expect(container.querySelector('[style*="left: 80%"]')).toBeTruthy();
  });
  test("a partial reading below the warning point does not claim to be within budget", async () => {
    const { UsageOverviewCard } = await load(variant, "usage-overview-card");
    render(
      createElement(UsageOverviewCard!, {
        title: "Provider usage",
        budget: {
          label: "Budget used",
          value: "At least 62%",
          qualifier: "At least",
          figure: "62%",
          percent: 62.75,
          partial: true,
        },
        metrics: [],
      }),
    );
    expect(screen.queryByText("Within budget")).toBeNull();
    expect(screen.getByText("Still measuring")).toBeTruthy();
    expect(screen.getByText("At least")).toBeTruthy();
    expect(screen.getByRole("meter").getAttribute("data-kind")).toBe("partial");
  });
  test("connection rows unfold their readings from a keyboard-operable disclosure", async () => {
    const { UsageOverviewCard } = await load(variant, "usage-overview-card");
    const { UsageConnectionRow } = await load(variant, "usage-connection-row");
    render(
      createElement(
        UsageOverviewCard!,
        {
          title: "Provider usage",
          budget: { label: "Budget used", value: "No budget", percent: null, partial: false },
          metrics: [],
        },
        createElement(UsageConnectionRow!, {
          name: "Search",
          tags: ["Primary"],
          status: { label: "Connected", tone: "positive" },
          summary: { value: "28%", percent: 28 },
          groups: [
            {
              id: "own",
              readings: [
                { id: "app", label: "App", value: "28 of 100 used", percent: 28 },
                { id: "api", label: "API", value: "No cap", percent: null },
                { id: "late", label: "Late", value: "Usage unknown", percent: 0, partial: true },
              ],
            },
          ],
          breakdown: [{ id: "rank", label: "Rank checks", value: "28", tags: ["Scheduled 4"] }],
        }),
      ),
    );
    const toggle = screen.getByRole("button", { name: "Search Primary Connected 28%" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    const details = document.getElementById(toggle.getAttribute("aria-controls")!)!;
    expect(details.hasAttribute("inert")).toBe(true);
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(details.hasAttribute("inert")).toBe(false);
    const meter = within(details).getByRole("meter", { name: "Search App" });
    expect(meter.getAttribute("aria-valuetext")).toBe("28 of 100 used");
    // Uncapped and unknown readings never draw a fill that could read as zero.
    expect(within(details).getAllByRole("meter")).toHaveLength(1);
    expect(details.querySelector('[data-usage-track="none"]')).toBeTruthy();
    expect(details.querySelector('[data-usage-track="unknown"]')).toBeTruthy();
    expect(within(details).getByText("Scheduled 4")).toBeTruthy();
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(details.hasAttribute("inert")).toBe(true);
  });
  test("an unknown connection summary never shows the host figure", async () => {
    const { UsageConnectionRow } = await load(variant, "usage-connection-row");
    render(
      createElement(
        "ul",
        null,
        createElement(UsageConnectionRow!, {
          name: "Search",
          summary: { value: "0%", percent: 0, partial: true },
          labels: { unknown: "Not yet measured" },
        }),
      ),
    );
    expect(screen.queryByText("0%")).toBeNull();
    expect(screen.getByRole("button", { name: "Search Not yet measured" })).toBeTruthy();
  });
  test("cap pill keeps hidden, unavailable and partial states distinct", async () => {
    const { UsageCapPill } = await load(variant, "usage-cap-pill");
    const node = (props: Record<string, unknown>) => createElement(UsageCapPill!, props);
    const view = render(node({ state: "hidden" }));
    expect(view.container.innerHTML).toBe("");
    view.rerender(
      node({ state: "unavailable", href: "/usage", labels: { unavailable: "Spend unavailable" } }),
    );
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("Spend unavailable");
    view.rerender(
      node({
        state: "ready",
        href: "/usage",
        percent: 0,
        partial: true,
        label: "0% used",
        ariaLabel: "Monthly cap 0% used",
      }),
    );
    expect(screen.getByRole("link", { name: "Usage unknown" }).textContent).toContain(
      "Usage unknown",
    );
    expect(screen.queryByText("0% used")).toBeNull();
    view.rerender(
      node({
        state: "ready",
        href: "/usage",
        percent: 62.75,
        partial: true,
        label: "At least 62% used",
      }),
    );
    expect(screen.getByRole("link", { name: "At least 62% used" }).getAttribute("href")).toBe(
      "/usage",
    );
  });
});

describe.each(variants)("%s blocks render against a memory Meter", (variant) => {
  const withMeter = async (node: ReactNode) => {
    const meter = await memoryMeter();
    return render(createElement(MeterProvider, { meter, access }, node));
  };
  test("usage table pages through the view", async () => {
    const { UsageTablePanel } = await load(variant, "usage-table");
    await withMeter(
      createElement(UsageTablePanel!, {
        scope: { kind: "principal", namespace: "test", principal: "u1" },
        ...month,
        units: ["requests", "tokens"],
        groupBy: ["provider"],
        limit: 1,
      }),
    );
    await screen.findByText("alpha");
    const table = screen.getByRole("table", { name: "Usage detail" });
    expect(table.tabIndex).toBe(0);
    table.focus();
    expect(document.activeElement).toBe(table);
    expect(screen.getByText("3 requests")).toBeTruthy();
    expect(screen.getByText("1.2345 cents")).toBeTruthy();
    expect(screen.getByText("Unavailable")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    await screen.findByText("beta");
    expect(screen.getByRole("button", { name: "First page" })).toBeTruthy();
  });
  test.each(["Meter", "access"])(
    "usage cursor resets when the %s binding changes",
    async (change) => {
      const { UsageTablePanel } = await load(variant, "usage-table");
      const first = await memoryMeter();
      const second = change === "Meter" ? await memoryMeter() : first;
      const usage = vi.fn(second.usage.bind(second));
      second.usage = usage;
      const panel = createElement(UsageTablePanel!, {
        scope: { kind: "principal", namespace: "test", principal: "u1" },
        ...month,
        units: ["requests"],
        groupBy: ["provider"],
        limit: 1,
      });
      const rendered = render(createElement(MeterProvider, { meter: first, access }, panel));
      await screen.findByText("alpha");
      fireEvent.click(screen.getByRole("button", { name: "Next page" }));
      await screen.findByText("beta");
      usage.mockClear();
      rendered.rerender(
        createElement(
          MeterProvider,
          {
            meter: second,
            access: change === "access" ? { ...access, readableGroups: ["g1"] } : access,
          },
          panel,
        ),
      );
      await waitFor(() => expect(usage).toHaveBeenCalled());
      expect(usage.mock.calls[0]![1].cursor).toBeUndefined();
      await screen.findByText("alpha");
    },
  );
  test("an invalid usage cursor keeps a first-page recovery action", async () => {
    const { UsageTablePanel } = await load(variant, "usage-table");
    const meter = await memoryMeter();
    const read = meter.usage.bind(meter);
    meter.usage = async (access, query) =>
      query.cursor
        ? { outcome: "invalid", field: "cursor", reason: "Expired cursor" }
        : read(access, query);
    render(
      createElement(
        MeterProvider,
        { meter, access },
        createElement(UsageTablePanel!, {
          scope: { kind: "principal", namespace: "test", principal: "u1" },
          ...month,
          units: ["requests"],
          groupBy: ["provider"],
          limit: 1,
        }),
      ),
    );
    await screen.findByText("alpha");
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "First page" }));
    await screen.findByText("alpha");
  });
  test("paging keeps the current page visible and busy until the next page arrives", async () => {
    const { UsageTablePanel } = await load(variant, "usage-table");
    const meter = await memoryMeter();
    const read = meter.usage.bind(meter);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    meter.usage = async (access, query) => {
      if (query.cursor) await gate;
      return read(access, query);
    };
    render(
      createElement(
        MeterProvider,
        { meter, access },
        createElement(UsageTablePanel!, {
          scope: { kind: "principal", namespace: "test", principal: "u1" },
          ...month,
          units: ["requests"],
          groupBy: ["provider"],
          limit: 1,
        }),
      ),
    );
    await screen.findByText("alpha");
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    await waitFor(() =>
      expect(screen.getByRole("table", { name: "Usage detail" }).getAttribute("aria-busy")).toBe(
        "true",
      ),
    );
    expect(screen.getByText("alpha")).toBeTruthy();
    expect(screen.queryByText("Loading usage.")).toBeNull();
    expect((screen.getByRole("button", { name: "Next page" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    await act(async () => release());
    await screen.findByText("beta");
    expect(screen.queryByText("alpha")).toBeNull();
    expect(
      screen.getByRole("table", { name: "Usage detail" }).getAttribute("aria-busy"),
    ).toBeNull();
  });
  test("a failed read drops the retained page, so a reload never shows superseded data", async () => {
    const { UsageTablePanel } = await load(variant, "usage-table");
    const meter = await memoryMeter();
    const read = meter.usage.bind(meter);
    const queryClient = createMeterQueryClient();
    let attempts = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    meter.usage = async (access, query) => {
      if (!query.cursor) return read(access, query);
      attempts += 1;
      // A malformed page fails the loader itself; that failure is the one a refetch clears.
      if (attempts === 1) return { outcome: "ok", value: null } as never;
      await gate;
      return read(access, query);
    };
    render(
      createElement(
        MeterProvider,
        { meter, access, queryClient },
        createElement(UsageTablePanel!, {
          scope: { kind: "principal", namespace: "test", principal: "u1" },
          ...month,
          units: ["requests"],
          groupBy: ["provider"],
          limit: 1,
        }),
      ),
    );
    await screen.findByText("alpha");
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    await screen.findByRole("alert");
    act(() => queryClient.invalidate());
    await screen.findByText("Loading usage.");
    expect(screen.queryByText("alpha")).toBeNull();
    await act(async () => release());
    await screen.findByText("beta");
  });
  test("budget cards show figures, markers and the redacted pool", async () => {
    const { BudgetCardsPanel } = await load(variant, "budget-card");
    const { container } = await withMeter(
      createElement(BudgetCardsPanel!, {
        scope,
        surface: "app",
        units: ["requests"],
        platformPools: ["p1"],
      }),
    );
    await screen.findByText("principal u1");
    expect(screen.getByText("6 requests")).toBeTruthy();
    expect(screen.getByText("Warning")).toBeTruthy();
    expect(screen.getByText(/figures are hidden/)).toBeTruthy();
    expect(screen.getByRole("img", { name: "Hard limit 15 requests" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "Alert 50%" })).toBeTruthy();
    const track = container.querySelector<HTMLElement>("[data-usage-track]")!;
    expect(track.style.getPropertyValue("--usage-fill")).toBe("40%");
    expect(track.style.getPropertyValue("--usage-reserved")).toBe("6.66%");
  });
  test("header status shows one pill per visible bound", async () => {
    const { HeaderStatusPanel } = await load(variant, "header-status");
    await withMeter(
      createElement(HeaderStatusPanel!, {
        scope,
        surface: "app",
        units: ["requests"],
        platformPools: ["p1"],
      }),
    );
    // Six settled plus one expired reservation that no sweep has released yet: reads never mutate.
    const pill = await screen.findByText("3 of 10 requests left");
    expect(pill.closest("[data-level]")?.getAttribute("data-level")).toBe("warning");
    expect(screen.getByText("1 hidden bounds")).toBeTruthy();
  });
  test("coverage summary states what cost excludes", async () => {
    const { CoverageSummaryPanel } = await load(variant, "coverage-summary");
    await withMeter(
      createElement(CoverageSummaryPanel!, {
        scope: { kind: "principal", namespace: "test", principal: "u1" },
        ...month,
      }),
    );
    await screen.findByText("6");
    expect(screen.queryByText("Unavailable")).toBeNull();
    expect(screen.getByText("7")).toBeTruthy();
    expect(screen.getByText(/Cost excludes untracked requests/)).toBeTruthy();
  });
  test("exceptions list shows state and age", async () => {
    const { ExceptionsListPanel } = await load(variant, "exceptions-list");
    await withMeter(
      createElement(ExceptionsListPanel!, {
        scope: { kind: "principal", namespace: "test", principal: "u1" },
        ...month,
      }),
    );
    await screen.findByText("Reservation expired");
    const table = screen.getByRole("table", { name: "Needs attention" });
    expect(table.tabIndex).toBe(0);
    table.focus();
    expect(document.activeElement).toBe(table);
    expect(screen.getByText("4 s")).toBeTruthy();
    expect(screen.getByText("reserved")).toBeTruthy();
  });
  test("exceptions panel hides the principal column when requested", async () => {
    const { ExceptionsListPanel } = await load(variant, "exceptions-list");
    await withMeter(
      createElement(ExceptionsListPanel!, {
        scope: { kind: "principal", namespace: "test", principal: "u1" },
        ...month,
        showPrincipal: false,
      }),
    );
    await screen.findByText("Reservation expired");
    const table = within(screen.getByRole("table", { name: "Needs attention" }));
    expect(table.queryByRole("columnheader", { name: "Principal" })).toBeNull();
    expect(table.queryByRole("cell", { name: "u1" })).toBeNull();
    expect(table.getAllByRole("columnheader")).toHaveLength(5);
    expect(table.getAllByRole("cell")).toHaveLength(5);
  });
  test("usage filters render the host select with the chosen values", async () => {
    const { UsageFilters } = await load(variant, "usage-filters");
    render(
      createElement(UsageFilters!, {
        period: "this",
        periods: [
          { value: "this", label: "This month" },
          { value: "last", label: "Last month" },
        ],
        onPeriodChange: () => {},
        scope: "me",
        scopes: [{ value: "me", label: "My usage" }],
        onScopeChange: () => {},
      }),
    );
    expect(screen.getByRole("combobox", { name: "Period" })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Scope" })).toBeTruthy();
    await waitFor(() => expect(screen.getByText("This month")).toBeTruthy());
    expect(screen.getByText("My usage")).toBeTruthy();
  });
  test("connection list shows funding, tags and plan", async () => {
    const { ConnectionList } = await load(variant, "connection-list");
    render(
      createElement(ConnectionList!, {
        connections: [
          { id: "c1", provider: "search", label: "Search", fundingSource: "byok", tags: ["prod"] },
          { id: "c2", provider: "maps", fundingSource: "platform", plan: "developer" },
        ],
      }),
    );
    const table = screen.getByRole("table", { name: "Connections" });
    expect(table.tabIndex).toBe(0);
    table.focus();
    expect(document.activeElement).toBe(table);
    expect(screen.getByText("Own key")).toBeTruthy();
    expect(screen.getByText("Platform")).toBeTruthy();
    expect(screen.getByText("prod")).toBeTruthy();
    expect(screen.getByText("developer")).toBeTruthy();
    expect(screen.getByText("c2")).toBeTruthy();
  });
  test("measurement card keeps unknown and unavailable separate from exact zero", async () => {
    const { MeasurementCard } = await load(variant, "measurement-card");
    const { rerender } = render(
      createElement(MeasurementCard!, {
        title: "Requests",
        value: { text: "0", unit: "requests", certainty: "measured" },
      }),
    );
    expect(screen.getByText("0")).toBeTruthy();
    rerender(
      createElement(MeasurementCard!, {
        title: "Requests",
        value: { text: "", unit: "requests", certainty: "unknown" },
      }),
    );
    expect(screen.queryByText("0")).toBeNull();
    expect(screen.getAllByText("Unknown").length).toBeGreaterThan(0);
    rerender(createElement(MeasurementCard!, { title: "Requests", value: "unavailable" }));
    expect(screen.getAllByText("Unavailable").length).toBeGreaterThan(0);
  });
  test("customer charge units have readable labels while arbitrary units stay exact", async () => {
    const { MeasurementCard } = await load(variant, "measurement-card");
    const rendered = render(
      createElement(MeasurementCard!, {
        title: "Customer charges",
        value: { text: "18.0000", unit: "customer_cents", certainty: "measured" },
      }),
    );
    expect(screen.getByText("18.0000")).toBeTruthy();
    expect(screen.getByText("cents")).toBeTruthy();
    expect(screen.queryByText("customer_cents")).toBeNull();
    rendered.unmount();
    const { UsageTablePanel } = await load(variant, "usage-table");
    await withMeter(
      createElement(UsageTablePanel!, {
        scope: budgets[0]!.scope,
        ...month,
        units: ["customer_cents", "requests"],
        groupBy: ["provider"],
        limit: 1,
      }),
    );
    await screen.findByRole("columnheader", { name: "Customer charges" });
    expect(screen.getByRole("columnheader", { name: "requests" })).toBeTruthy();
    expect(screen.getByText("18.0001 cents")).toBeTruthy();
    expect(screen.queryByText("customer_cents")).toBeNull();
  });
  test("usage and cost cards share exact summary data", async () => {
    const { UsageSummaryCardsPanel } = await load(variant, "usage-summary-cards");
    const { CostSummaryCardPanel } = await load(variant, "cost-summary-card");
    await withMeter(
      createElement(
        "div",
        null,
        createElement(UsageSummaryCardsPanel!, {
          scope: budgets[0]!.scope,
          ...month,
          units: ["requests"],
          unitLabels: { requests: "Requests" },
        }),
        createElement(CostSummaryCardPanel!, {
          scope: budgets[0]!.scope,
          ...month,
          units: ["requests"],
        }),
      ),
    );
    await screen.findByText("Requests");
    await screen.findByText("2.4690");
    expect(screen.getByText("6")).toBeTruthy();
  });
  test.each([
    "budget-card",
    "header-status",
    "usage-table",
    "coverage-summary",
    "exceptions-list",
    "usage-summary-cards",
    "cost-summary-card",
  ])("%s panel reports a missing Meter instead of loading forever", async (name) => {
    const module = await load(variant, name as (typeof blockNames)[number]);
    const panel = Object.entries(module).find(([key]) => key.endsWith("Panel"))![1];
    render(
      createElement(panel!, {
        scope,
        ...month,
        surface: "app",
        platformPools: [],
        units: ["requests"],
        groupBy: [],
      }),
    );
    await screen.findByRole("alert");
    expect(screen.queryByText(/Loading/)).toBeNull();
  });
  test("editor is read-only without a host writer", async () => {
    const { BudgetEditor } = await load(variant, "budget-editor");
    await withMeter(createElement(BudgetEditor!, { budget: budgets[0] }));
    expect(screen.getByRole("textbox", { name: "Limit (requests)" }).hasAttribute("readonly")).toBe(
      true,
    );
    expect(
      (screen.getByRole("button", { name: "Save budget" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByText(/View only/)).toBeTruthy();
  });
  const editable = async (node: ReactNode, writer: BudgetWriter) =>
    render(
      createElement(
        MeterProvider,
        {
          meter: await memoryMeter(),
          access: { ...access, canManageBudgets: true },
          budgetWriter: writer,
        },
        node,
      ),
    );
  test("editor sends exact decimal strings through host save and preserves immutable scope", async () => {
    const { BudgetEditor } = await load(variant, "budget-editor");
    const save = vi.fn<BudgetWriter["save"]>(async (budget) => ({ outcome: "saved", budget }));
    await editable(
      createElement(BudgetEditor!, { budget: { ...budgets[0], hardLimit: undefined } }),
      { save },
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Limit (requests)" }), {
      target: { value: "9007199254740993.000001" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save budget" }));
    await screen.findByText("Budget saved.");
    expect(save).toHaveBeenCalledTimes(1);
    const sent = save.mock.calls[0]![0];
    expect(sent.limit).toEqual({ value: 9007199254740993000001n, scale: 6, unit: "requests" });
    expect(sent.scope).toEqual(budgets[0]!.scope);
    expect(sent.version).toBe(2);
  });
  test.each(["Block requests", "No limit"])(
    "editor can save allow+hardLimit after choosing %s",
    async (action) => {
      const { BudgetEditor } = await load(variant, "budget-editor");
      const save = vi.fn<BudgetWriter["save"]>(async (budget) => ({ outcome: "saved", budget }));
      // No percent alerts in this fixture: unlimited requires explicit alert removal/conversion.
      await editable(createElement(BudgetEditor!, { budget: { ...budgets[0], alerts: [] } }), {
        save,
      });
      fireEvent.click(screen.getByRole("button", { name: action }));
      fireEvent.click(screen.getByRole("button", { name: "Save budget" }));
      await screen.findByText("Budget saved.");
      expect(save.mock.calls[0]![0].hardLimit).toBeUndefined();
      expect(save.mock.calls[0]![0].limit === null).toBe(action === "No limit");
    },
  );
  test("invalid exact input is visible and never invokes host writer", async () => {
    const { BudgetEditor } = await load(variant, "budget-editor");
    const save = vi.fn<BudgetWriter["save"]>();
    await editable(createElement(BudgetEditor!, { budget: budgets[0] }), { save });
    fireEvent.change(screen.getByRole("textbox", { name: "Limit (requests)" }), {
      target: { value: "1e9" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save budget" }));
    await screen.findByRole("alert");
    expect(save).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("decimal");
  });
  test("a new invalid draft replaces prior saved feedback without another write", async () => {
    const { BudgetEditor } = await load(variant, "budget-editor");
    const save = vi.fn<BudgetWriter["save"]>(async (budget) => ({ outcome: "saved", budget }));
    await editable(createElement(BudgetEditor!, { budget: budgets[0] }), { save });
    fireEvent.change(screen.getByRole("textbox", { name: "Limit (requests)" }), {
      target: { value: "12" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save budget" }));
    await screen.findByText("Budget saved.");
    fireEvent.change(screen.getByRole("textbox", { name: "Limit (requests)" }), {
      target: { value: "1e9" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save budget" }));
    expect((await screen.findByRole("alert")).textContent).toContain("decimal");
    expect(screen.queryByText("Budget saved.")).toBeNull();
    expect(save).toHaveBeenCalledTimes(1);
  });
  test("unlimited mode keeps percent alerts removable with precise validation feedback", async () => {
    const { BudgetEditor } = await load(variant, "budget-editor");
    const save = vi.fn<BudgetWriter["save"]>(async (budget) => ({ outcome: "saved", budget }));
    await editable(createElement(BudgetEditor!, { budget: budgets[0] }), { save });
    fireEvent.click(screen.getByRole("button", { name: "No limit" }));
    fireEvent.click(screen.getByRole("button", { name: "Save budget" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Alerts:.*finite/);
    expect(save).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Remove alert 1" }));
    fireEvent.click(screen.getByRole("button", { name: "Save budget" }));
    await screen.findByText("Budget saved.");
    expect(save.mock.calls[0]![0].limit).toBeNull();
    expect(save.mock.calls[0]![0].alerts).toEqual([]);
  });
  test("unknown save blocks duplicate submits until authoritative reconciliation", async () => {
    const { BudgetEditor } = await load(variant, "budget-editor");
    const save = vi.fn<BudgetWriter["save"]>(async () => ({
      outcome: "unavailable",
      message: "Timeout",
      ambiguous: true,
    }));
    const reconcile = vi.fn<NonNullable<BudgetWriter["reconcile"]>>(async () => ({
      outcome: "not_saved",
    }));
    await editable(createElement(BudgetEditor!, { budget: budgets[0] }), { save, reconcile });
    fireEvent.change(screen.getByRole("textbox", { name: "Limit (requests)" }), {
      target: { value: "12" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save budget" }));
    await screen.findByText(/save result is unknown/);
    expect(
      (screen.getByRole("button", { name: "Save budget" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Reset changes" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Save budget" }));
    expect(save).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Check save status" }));
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Save budget" }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  test("manager reloads a conflict and saves the newly read version within the same Provider", async () => {
    const { BudgetManagerPanel } = await load(variant, "budget-manager-panel");
    const meter = await memoryMeter();
    const server = [structuredClone(budgets[0]!)];
    meter.definedBudgets = async () => ({ outcome: "ok", value: structuredClone(server) });
    let conflict = true;
    const save = vi.fn<BudgetWriter["save"]>(async (budget) => {
      if (conflict) {
        conflict = false;
        server[0] = {
          ...server[0]!,
          version: 2,
          limit: { value: 11n, scale: 0, unit: "requests" },
        };
        return { outcome: "conflict", reason: "Concurrent edit" };
      }
      expect(budget.version).toBe(3);
      server[0] = budget;
      return { outcome: "saved", budget };
    });
    render(
      createElement(
        MeterProvider,
        { meter, access: { ...access, canManageBudgets: true }, budgetWriter: { save } },
        createElement(BudgetManagerPanel!, {
          scope: budgets[0]!.scope,
          budgetTitles: { cap: "Monthly requests" },
        }),
      ),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Edit Monthly requests" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Limit (requests)" }), {
      target: { value: "12" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save budget" }));
    await screen.findByText(/changed elsewhere/);
    // Automatic definition invalidation must not silently rebase/discard the conflicted draft.
    await screen.findByText("11 requests");
    expect(
      (screen.getByRole("textbox", { name: "Limit (requests)" }) as HTMLInputElement).value,
    ).toBe("12");
    expect(screen.getByText(/changed elsewhere/)).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Save budget" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Reload latest budgets" }));
    fireEvent.click(await screen.findByRole("button", { name: "Edit Monthly requests" }));
    await waitFor(() =>
      expect(
        (screen.getByRole("textbox", { name: "Limit (requests)" }) as HTMLInputElement).value,
      ).toBe("11"),
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Limit (requests)" }), {
      target: { value: "13" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save budget" }));
    await screen.findAllByText("Budget saved.");
    expect(save).toHaveBeenCalledTimes(2);
  });
  test("manager creates only from host templates with exact quantities and fixed windows", async () => {
    const { BudgetManagerPanel } = await load(variant, "budget-manager-panel");
    const meter = await memoryMeter();
    let server: Budget[] = [];
    meter.definedBudgets = async () => ({ outcome: "ok", value: structuredClone(server) });
    const save = vi.fn<BudgetWriter["save"]>(async (budget) => {
      server = [budget];
      return { outcome: "saved", budget };
    });
    render(
      createElement(
        MeterProvider,
        { meter, access: { ...access, canManageBudgets: true }, budgetWriter: { save } },
        createElement(BudgetManagerPanel!, {
          scope: budgets[0]!.scope,
          templates: [
            {
              title: "Monthly cost",
              budget: {
                id: "cost-cap",
                version: 0,
                scope: budgets[0]!.scope,
                surface: "app",
                unit: "cents",
                window: { kind: "calendar_month", timezone: "UTC" },
              },
            },
          ],
        }),
      ),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Create Monthly cost" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Limit (cents)" }), {
      target: { value: "1.2500" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save budget" }));
    await screen.findAllByText("Budget saved.");
    const sent = save.mock.calls[0]![0];
    expect(sent).toMatchObject({
      id: "cost-cap",
      version: 1,
      scope: budgets[0]!.scope,
      surface: "app",
      window: { kind: "calendar_month", timezone: "UTC" },
      limit: { value: 12500n, scale: 4, unit: "cents" },
    });
  });
});

describe.each(variants)("%s provider blocks use explicit host ports", (variant) => {
  const fixture = () => createDemoProviderPort(`acme:test:${crypto.randomUUID()}`);
  const mounted = (node: ReactNode, demo = fixture(), canManage = true) => {
    const wrap = (child: ReactNode) =>
      createElement(
        ProviderManagementProvider,
        { port: demo.port, binding: { ...demo.binding, canManage } },
        child,
      );
    return { ...render(wrap(node)), demo, wrap };
  };
  const editorFixture = () => {
    const demo = fixture();
    const client = createProviderQueryClient();
    const read = demo.port.read.bind(demo.port);
    let failure: "forbidden" | "unavailable" | null = null;
    let revision = "1";
    let removed = false;
    let extraProvider = false;
    demo.port.read = vi.fn(async (binding, query): Promise<ProviderReadResult> => {
      if (failure === "forbidden") return { outcome: "forbidden" };
      if (failure === "unavailable")
        return { outcome: "unavailable", message: "Stored evidence is unavailable." };
      const answer = await read(binding, query);
      if (answer.outcome === "ok" && answer.value.kind === "connections" && extraProvider)
        return {
          ...answer,
          value: {
            ...answer.value,
            providers: [
              ...answer.value.providers,
              { ...demoProviders[0]!, id: "new-provider", label: "New provider" },
            ],
            connections: [
              ...answer.value.connections,
              {
                ...structuredClone(initialConnections[0]!),
                id: "new-connection",
                provider: "new-provider",
                label: "New provider account",
              },
            ],
          },
        };
      if (answer.outcome === "ok" && removed) {
        if (answer.value.kind === "connections")
          return { outcome: "ok", value: { ...answer.value, state: "empty", connections: [] } };
        if (answer.value.kind === "details")
          return { outcome: "ok", value: { ...answer.value, state: "empty", connection: null } };
        if (answer.value.kind === "allocations")
          return { outcome: "ok", value: { ...answer.value, state: "empty", rows: [] } };
      }
      if (answer.outcome !== "ok" || revision === "1") return answer;
      const connection = (item: (typeof initialConnections)[number]) =>
        item.id === "search-own"
          ? {
              ...item,
              revision,
              rates: item.rates.map((rate) => ({
                ...rate,
                price: { text: "9.7500", unit: "cents", certainty: "measured" as const },
                provenance: { ...rate.provenance, version: "rate-2" },
              })),
            }
          : item;
      const value = answer.value;
      if (value.kind === "connections")
        return {
          outcome: "ok",
          value: { ...value, revision, connections: value.connections.map(connection) },
        };
      if (value.kind === "details")
        return {
          outcome: "ok",
          value: {
            ...value,
            revision,
            connection: value.connection ? connection(value.connection) : null,
          },
        };
      if (value.kind === "allocations")
        return {
          outcome: "ok",
          value: {
            ...value,
            revision,
            rows: value.rows.map((row) => ({
              ...row,
              revision,
              ...(row.id === "byok-app"
                ? {
                    limit: { text: "700", unit: "requests", certainty: "measured" as const },
                    used: { text: "25", unit: "requests", certainty: "measured" as const },
                  }
                : {}),
            })),
          },
        };
      return answer;
    });
    const wrap = (node: ReactNode) =>
      createElement(
        ProviderManagementProvider,
        { port: demo.port, binding: demo.binding, client },
        node,
      );
    return {
      demo,
      client,
      wrap,
      fail(value: typeof failure) {
        failure = value;
      },
      newer() {
        revision = "2";
      },
      remove() {
        removed = true;
      },
      revealProvider() {
        extraProvider = true;
      },
      async refresh() {
        await act(async () => client.invalidate(demo.port, demo.binding));
      },
    };
  };
  const hostFeedback = {
    own: "Klucz hosta",
    platform: "Środki hosta",
    cents: "grosze hosta",
    unknownValue: "Nieznana wartość",
    unavailableValue: "Brak wartości",
    estimated: "Szacowane",
    readOnly: "Tylko podgląd",
    unknown: "Niepotwierdzona zmiana",
    reconcile: "Sprawdź zmianę",
    loading: "Odczyt hosta",
    forbidden: "Zmiana niedozwolona",
    reload: "Ponów odczyt",
  };
  test.each([
    ["provider-card", "ProviderCard"],
    ["provider-source-selector", "ProviderSourceSelector"],
    ["provider-connect-form", "ProviderConnectForm"],
    ["provider-chain-editor", "ProviderChainEditor"],
    ["provider-allocation-editor", "ProviderAllocationEditor"],
  ])("%s uses host action, recovery and funding copy", async (name, exportName) => {
    const block = (await load(variant, name!))[exportName!];
    const demo = fixture();
    demo.setNextOutcome("unknown");
    const props = {
      feedbackLabels: hostFeedback,
      ...(exportName === "ProviderAllocationEditor"
        ? { rows: initialAllocations, revision: "1" }
        : exportName === "ProviderConnectForm"
          ? { provider: demoProviders[0] }
          : { connection: initialConnections[0] }),
      ...(exportName === "ProviderSourceSelector" ? { sources: ["byok", "platform"] } : {}),
      ...(exportName === "ProviderChainEditor" ? { connections: initialConnections } : {}),
    };
    mounted(createElement(block!, props), demo);
    if (exportName !== "ProviderChainEditor") {
      expect(screen.getAllByText(hostFeedback.own).length).toBeGreaterThan(0);
      expect(screen.queryByText("Own key")).toBeNull();
    }
    if (exportName === "ProviderCard")
      fireEvent.click(screen.getByRole("button", { name: "Disable connection" }));
    else if (exportName === "ProviderSourceSelector") {
      fireEvent.click(screen.getByRole("button", { name: hostFeedback.platform }));
      expect(
        screen.getByText("Change the funding source to " + hostFeedback.platform + "?"),
      ).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Confirm funding change" }));
    } else if (exportName === "ProviderConnectForm") {
      fireEvent.change(screen.getByLabelText("API key"), { target: { value: "ephemeral" } });
      fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    } else if (exportName === "ProviderChainEditor") {
      fireEvent.click(
        screen.getByRole("button", { name: "Remove from fallback: Language shared" }),
      );
      fireEvent.click(screen.getByRole("button", { name: "Save fallback order" }));
    } else {
      fireEvent.change(screen.getAllByLabelText("Limit (requests)")[0]!, {
        target: { value: "123" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Save allocations" }));
    }
    await screen.findByText(hostFeedback.unknown);
    expect(screen.getByRole("button", { name: hostFeedback.reconcile })).toBeTruthy();
    expect(screen.queryByText(/The result is unknown/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Check change status" })).toBeNull();
  });
  test("allocation rows use host figure, unit and helper failure copy", async () => {
    const { ProviderAllocationEditor } = await load(variant, "provider-allocation-editor");
    const rows = structuredClone(initialAllocations);
    rows[0]!.used = { text: "12", unit: "requests", certainty: "estimated" };
    rows[0]!.reserved = { text: "", unit: "requests", certainty: "unknown" };
    rows[0]!.remaining = "unavailable";
    mounted(
      createElement(ProviderAllocationEditor!, {
        rows,
        revision: "1",
        fresh: true,
        feedbackLabels: hostFeedback,
        labels: {
          invalid: "Popraw limit",
          unavailable: "Brak dostępnego salda",
          forecastUnavailable: "Brak prognozy",
        },
        projections: {
          [rows[0]!.id]: {
            used: "unavailable",
            reserved: rows[0]!.reserved,
            limit: rows[0]!.limit,
            periodStart: "bad",
            asOf: "bad",
            periodEnd: "bad",
          },
        },
      }),
    );
    const own = screen.getByRole("region", { name: hostFeedback.own + " App" });
    expect(within(own).getByText(hostFeedback.estimated + " 12 requests")).toBeTruthy();
    expect(within(own).getByText(hostFeedback.unknownValue)).toBeTruthy();
    expect(within(own).getByText(hostFeedback.unavailableValue)).toBeTruthy();
    expect(within(own).getByText("Brak dostępnego salda")).toBeTruthy();
    expect(within(own).getByText("Brak prognozy")).toBeTruthy();
    expect(screen.getAllByLabelText("Limit (" + hostFeedback.cents + ")")).toHaveLength(2);
    expect(screen.getAllByText("12 " + hostFeedback.cents)).toHaveLength(2);
    expect(
      screen.queryByText("Measured usage, reservations and availability are required."),
    ).toBeNull();
    expect(screen.queryByText("Measured values in the same unit are required.")).toBeNull();
    fireEvent.change(within(own).getByLabelText("Limit (requests)"), { target: { value: "-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Save allocations" }));
    expect(screen.getByRole("alert").textContent).toBe(rows[0]!.label + ": Popraw limit");
    expect(screen.queryByText(/Enter a nonnegative decimal amount/)).toBeNull();
  });
  test.each(["ProviderBalanceCard", "ProviderRequestQuote"])(
    "%s uses host figure copy and preserves host reasons",
    async (exportName) => {
      const block = (await load(variant, "provider-balance-card"))[exportName];
      const estimated = { text: "1.25", unit: "cents", certainty: "estimated" };
      const unknown = { text: "", unit: "customer_cents", certainty: "unknown" };
      const freshness = { observedAt: null, stale: true, source: "unknown" };
      render(
        createElement(block!, {
          feedbackLabels: hostFeedback,
          ...(exportName === "ProviderBalanceCard"
            ? {
                balance: {
                  connectionId: "c",
                  fundingSource: "byok",
                  authority: "provider",
                  balance: estimated,
                  reserved: unknown,
                  availability: { state: "unknown", reason: "Powód hosta" },
                  freshness,
                },
              }
            : {
                projection: {
                  connectionId: "c",
                  quantity: estimated,
                  providerCost: unknown,
                  customerCharge: "unavailable",
                  canProceed: "unknown",
                  reason: "Powód hosta",
                  freshness,
                },
              }),
        }),
      );
      expect(screen.getByText(hostFeedback.estimated + " 1.25 " + hostFeedback.cents)).toBeTruthy();
      expect(screen.getByText(hostFeedback.unknownValue)).toBeTruthy();
      expect(screen.getByText("Powód hosta")).toBeTruthy();
      if (exportName === "ProviderBalanceCard")
        expect(screen.getByText(hostFeedback.own)).toBeTruthy();
      else expect(screen.getByText(hostFeedback.unavailableValue)).toBeTruthy();
      expect(screen.queryByText("Estimated 1.25 cents")).toBeNull();
      expect(screen.queryByText("Own key")).toBeNull();
    },
  );
  const reloadPanels = [
    [
      "provider-allocation-editor",
      "ProviderAllocationPanel",
      { connectionIds: ["search-own"] },
      "Reload allocations",
    ],
    [
      "provider-balance-card",
      "ProviderBalancePanel",
      { connectionId: "language-platform" },
      "Reload evidence",
    ],
    [
      "provider-balance-card",
      "ProviderRequestQuotePanel",
      {
        query: {
          kind: "projection",
          connectionId: "language-platform",
          operation: "request",
          quantity: "1",
          unit: "requests",
        },
      },
      null,
    ],
    ["provider-manager-panel", "ProviderManagerPanel", {}, "Reload connections"],
  ] as const;
  test.each(reloadPanels)(
    "%s %s uses host read copy and calls the host first on recovery reload",
    async (name, exportName, props) => {
      const block = (await load(variant, name))[exportName];
      const f = editorFixture();
      f.fail("forbidden");
      const events: string[] = [];
      const read = f.demo.port.read.bind(f.demo.port);
      f.demo.port.read = vi.fn(async (binding, query) => {
        events.push("read");
        return read(binding, query);
      });
      const onReload = vi.fn(() => {
        events.push("host");
        f.fail(null);
        // A host refresh must not outrun the explicit editor reload.
        void f.client.invalidate(f.demo.port, f.demo.binding);
      });
      render(f.wrap(createElement(block!, { ...props, feedbackLabels: hostFeedback, onReload })));
      expect(screen.getByText(hostFeedback.loading)).toBeTruthy();
      await screen.findByText(hostFeedback.forbidden);
      expect(screen.queryByText("You cannot make this change.")).toBeNull();
      events.length = 0;
      fireEvent.click(screen.getByRole("button", { name: hostFeedback.reload }));
      expect(onReload).toHaveBeenCalledTimes(1);
      await waitFor(() => expect(screen.queryByText(hostFeedback.forbidden)).toBeNull());
      expect(events[0]).toBe("host");
      expect(events).toContain("read");
      if (exportName === "ProviderBalancePanel" || exportName === "ProviderRequestQuotePanel") {
        await screen.findByText(
          (exportName === "ProviderBalancePanel" ? "100.6250 " : "1.0000 ") + hostFeedback.cents,
        );
        expect(screen.queryByText(/\bcents\b/)).toBeNull();
      }
    },
  );
  test.each(reloadPanels.filter((item) => item[3] !== null))(
    "%s %s calls the host first on its loaded reload and retained-read recovery",
    async (name, exportName, props, reloadName) => {
      const block = (await load(variant, name))[exportName];
      const f = editorFixture();
      const events: string[] = [];
      const read = f.demo.port.read.bind(f.demo.port);
      f.demo.port.read = vi.fn(async (binding, query) => {
        events.push("read");
        return read(binding, query);
      });
      const onReload = vi.fn(() => {
        events.push("host");
        f.fail(null);
        void f.client.invalidate(f.demo.port, f.demo.binding);
      });
      render(f.wrap(createElement(block!, { ...props, feedbackLabels: hostFeedback, onReload })));
      await screen.findByRole("button", { name: reloadName! });
      events.length = 0;
      fireEvent.click(screen.getByRole("button", { name: reloadName! }));
      expect(onReload).toHaveBeenCalledTimes(1);
      await waitFor(() => expect(events).toContain("read"));
      expect(events[0]).toBe("host");
      await waitFor(() =>
        expect(
          (screen.getByRole("button", { name: reloadName! }) as HTMLButtonElement).disabled,
        ).toBe(false),
      );
      f.fail("forbidden");
      await f.refresh();
      await screen.findByText(hostFeedback.forbidden);
      events.length = 0;
      fireEvent.click(screen.getByRole("button", { name: hostFeedback.reload }));
      expect(onReload).toHaveBeenCalledTimes(2);
      await waitFor(() => expect(screen.queryByText(hostFeedback.forbidden)).toBeNull());
      expect(events[0]).toBe("host");
    },
  );
  test("allocation panel states a refused change once and rebases after the host reload", async () => {
    const { ProviderAllocationPanel } = await load(variant, "provider-allocation-editor");
    const f = editorFixture();
    f.demo.port.execute = vi.fn(async (_binding, command) => ({
      outcome: "forbidden" as const,
      commandId: command.commandId,
    }));
    const onReload = vi.fn(() => {
      f.newer();
      void f.client.invalidate(f.demo.port, f.demo.binding);
    });
    render(
      f.wrap(
        createElement(ProviderAllocationPanel!, {
          connectionIds: ["search-own"],
          feedbackLabels: hostFeedback,
          onReload,
        }),
      ),
    );
    const region = await screen.findByRole("region", { name: hostFeedback.own + " App" });
    fireEvent.change(within(region).getByLabelText("Limit (requests)"), {
      target: { value: "123" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save allocations" }));
    await waitFor(() => expect(screen.getAllByText(hostFeedback.forbidden)).toHaveLength(1));
    expect(screen.queryByText("You cannot make this change.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Reload allocations" }));
    expect(onReload).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(
        (
          within(screen.getByRole("region", { name: hostFeedback.own + " App" })).getByLabelText(
            "Limit (requests)",
          ) as HTMLInputElement
        ).value,
      ).toBe("700"),
    );
  });
  test("manager forwards host feedback and reload callbacks to its composed blocks", async () => {
    const { ProviderManagerPanel } = await load(variant, "provider-manager-panel");
    const f = editorFixture();
    const onReload = vi.fn();
    render(
      f.wrap(createElement(ProviderManagerPanel!, { feedbackLabels: hostFeedback, onReload })),
    );
    await screen.findByText("Search production");
    expect(screen.getByText(hostFeedback.own)).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "Manage connection" })[0]!);
    await screen.findByRole("region", { name: hostFeedback.own + " App" });
    fireEvent.click(screen.getByRole("button", { name: /Standard request/ }));
    expect(screen.getAllByText(hostFeedback.own).length).toBeGreaterThanOrEqual(4);
    expect(screen.queryByText("Own key")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Reload evidence" }));
    expect(onReload).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Reload allocations" }));
    expect(onReload).toHaveBeenCalledTimes(2);
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Reload allocations" }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole("button", { name: "Close editor" }));
    fireEvent.click(screen.getByRole("button", { name: "New connection: Search" }));
    expect(screen.getByRole("button", { name: hostFeedback.own })).toBeTruthy();
    expect(screen.getByRole("button", { name: hostFeedback.platform })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close editor" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Manage connection" })[0]!);
    await screen.findByRole("region", { name: hostFeedback.own + " App" });
    f.demo.setNextOutcome("unknown");
    fireEvent.click(screen.getByRole("button", { name: "Remove from fallback: Language shared" }));
    fireEvent.click(screen.getByRole("button", { name: "Save fallback order" }));
    // Two cards and the credentials, funding, rates, chain and allocation editors share this action.
    await waitFor(() => expect(screen.getAllByText(hostFeedback.unknown)).toHaveLength(7));
    expect(screen.getAllByRole("button", { name: hostFeedback.reconcile })).toHaveLength(7);
    expect(screen.queryByText(/The result is unknown/)).toBeNull();
  });
  test("stored reads never test or mutate providers, and writes are read-only by default", async () => {
    const { ProviderManagerPanel } = await load(variant, "provider-manager-panel");
    const demo = fixture();
    render(
      createElement(
        ProviderManagementProvider,
        {
          port: demo.port,
          binding: {
            scopeKey: demo.binding.scopeKey,
            principalKey: demo.binding.principalKey,
            authRevision: demo.binding.authRevision,
          },
        },
        createElement(ProviderManagerPanel!),
      ),
    );
    await screen.findByText("Search production");
    expect(demo.calls).toEqual([]);
    expect(
      (screen.getAllByRole("button", { name: "Test stored credentials" })[0] as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
  test("draft credential test is separate from connect and passes secrets only ephemerally", async () => {
    const { ProviderConnectForm } = await load(variant, "provider-connect-form");
    const demo = fixture();
    const execute = demo.port.execute;
    const received: { command: ProviderCommand; secrets: Record<string, string> | undefined }[] =
      [];
    demo.port.execute = vi.fn(async (binding, command, secrets) => {
      received.push({
        command: structuredClone(command),
        secrets: secrets ? { ...secrets } : undefined,
      });
      return execute(binding, command, secrets);
    });
    mounted(createElement(ProviderConnectForm!, { provider: demoProviders[0] }), demo);
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "ephemeral-test-key" } });
    fireEvent.click(screen.getByRole("button", { name: "Test credentials" }));
    await screen.findByText("Provider command completed");
    expect(received[0]!.command.kind).toBe("test");
    expect(received[0]!.secrets).toEqual({ key: "ephemeral-test-key" });
    expect(JSON.stringify(received[0]!.command)).not.toContain("ephemeral-test-key");
    expect((screen.getByLabelText("API key") as HTMLInputElement).value).toBe("ephemeral-test-key");
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(demo.calls).toHaveLength(2));
    expect(demo.calls[1]!.kind).toBe("connect");
    await waitFor(() =>
      expect((screen.getByLabelText("API key") as HTMLInputElement).value).toBe(""),
    );
  });
  test("platform connection does not require own-key credential fields", async () => {
    const { ProviderConnectForm } = await load(variant, "provider-connect-form");
    const demo = fixture();
    mounted(
      createElement(ProviderConnectForm!, {
        provider: demoProviders[0],
        fundingSource: "platform",
      }),
      demo,
    );
    expect(screen.queryByLabelText("API key")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(demo.calls).toHaveLength(1));
    expect(demo.calls[0]).toMatchObject({ kind: "connect", fundingSource: "platform" });
  });
  test.each(["binding", "port", "target"])(
    "credentials clear immediately when %s changes",
    async (change) => {
      const { ProviderConnectForm } = await load(variant, "provider-connect-form");
      const demo = fixture();
      const next = fixture();
      const node = createElement(ProviderConnectForm!, { provider: demoProviders[0] });
      const rendered = mounted(node, demo);
      fireEvent.change(screen.getByLabelText("API key"), {
        target: { value: "must-not-cross-authority" },
      });
      rendered.rerender(
        createElement(
          ProviderManagementProvider,
          {
            port: change === "port" ? next.port : demo.port,
            binding:
              change === "binding" ? { ...demo.binding, principalKey: "another" } : demo.binding,
          },
          change === "target"
            ? createElement(ProviderConnectForm!, { provider: demoProviders[1] })
            : node,
        ),
      );
      expect((screen.getByLabelText("API key") as HTMLInputElement).value).toBe("");
      expect(demo.calls).toEqual([]);
    },
  );
  test("disconnect requires confirmation; no action occurs on mount", async () => {
    const { ProviderConnectForm } = await load(variant, "provider-connect-form");
    const demo = fixture();
    mounted(
      createElement(ProviderConnectForm!, {
        provider: demoProviders[0],
        connection: initialConnections[0],
      }),
      demo,
    );
    expect(demo.calls).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(demo.calls).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Confirm disconnect" }));
    await waitFor(() => expect(demo.calls).toHaveLength(1));
    expect(demo.calls[0]).toMatchObject({ kind: "disconnect", expectedRevision: "1" });
  });
  test("unknown credential result clears local secrets and gates all new writes until reconciliation", async () => {
    const { ProviderConnectForm } = await load(variant, "provider-connect-form");
    const demo = fixture();
    demo.setNextOutcome("unknown");
    const reconcile = vi.fn(demo.port.reconcile!);
    demo.port.reconcile = reconcile;
    mounted(createElement(ProviderConnectForm!, { provider: demoProviders[0] }), demo);
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "transient" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await screen.findByText(/The result is unknown/);
    expect((screen.getByLabelText("API key") as HTMLInputElement).value).toBe("");
    expect((screen.getByRole("button", { name: "Connect" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.click(screen.getByRole("button", { name: "Check change status" }));
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Connect" }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    expect(demo.calls).toHaveLength(1);
    expect(reconcile.mock.calls[0]).toHaveLength(2);
    expect(JSON.stringify(reconcile.mock.calls[0])).not.toContain("transient");
  });
  test("funding source changes only after explicit confirmation", async () => {
    const { ProviderSourceSelector } = await load(variant, "provider-source-selector");
    const demo = fixture();
    mounted(
      createElement(ProviderSourceSelector!, {
        connection: initialConnections[0],
        sources: ["byok", "platform"],
      }),
      demo,
    );
    fireEvent.click(screen.getByRole("button", { name: "Platform funded" }));
    expect(demo.calls).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Confirm funding change" }));
    await waitFor(() => expect(demo.calls).toHaveLength(1));
    expect(demo.calls[0]).toMatchObject({
      kind: "funding",
      expectedRevision: "1",
      fundingSource: "platform",
    });
  });
  test("rates preserve exact inputs, provenance and explicit host fallback", async () => {
    const { ProviderRateEditor } = await load(variant, "provider-rate-editor");
    const demo = fixture();
    const rendered = mounted(
      createElement(ProviderRateEditor!, { connection: initialConnections[0] }),
      demo,
    );
    expect(screen.getByText("153")).toBeTruthy();
    expect(screen.getByText("rate-1")).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Price/), { target: { value: "10.001234" } });
    fireEvent.click(screen.getByRole("button", { name: "Save rate" }));
    await waitFor(() => expect(demo.calls).toHaveLength(1));
    expect(demo.calls[0]).toMatchObject({
      kind: "rates",
      rates: [{ rateId: "standard", price: "1000.1234" }],
    });
    rendered.rerender(
      rendered.wrap(
        createElement(ProviderRateEditor!, { connection: demo.snapshots().connections[0] }),
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Use measured rate" }));
    await waitFor(() => expect(demo.calls).toHaveLength(2));
    expect(demo.calls[1]).toMatchObject({ rates: [{ rateId: "standard", price: null }] });
  });
  test("unknown rate save retains its exact submitted value after editor remount", async () => {
    const { ProviderRateEditor } = await load(variant, "provider-rate-editor");
    const demo = fixture();
    demo.setNextOutcome("unknown");
    const rendered = mounted(
      createElement(ProviderRateEditor!, { connection: initialConnections[0] }),
      demo,
    );
    fireEvent.change(screen.getByLabelText(/Price/), { target: { value: "12.5000" } });
    fireEvent.click(screen.getByRole("button", { name: "Save rate" }));
    await screen.findByText(/The result is unknown/);
    rendered.rerender(
      rendered.wrap(
        createElement(ProviderRateEditor!, {
          key: "fresh-editor",
          connection: initialConnections[0],
        }),
      ),
    );
    expect((screen.getByLabelText(/Price/) as HTMLInputElement).value).toBe("12.5000");
    expect((screen.getByRole("button", { name: "Save rate" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(demo.calls).toHaveLength(1);
  });
  test("unknown rate uses the host price unit without guessing money", async () => {
    const { ProviderRateEditor } = await load(variant, "provider-rate-editor");
    const demo = fixture();
    const connection = structuredClone(initialConnections[0]!);
    connection.rates[0]!.price = "unavailable";
    connection.rates[0]!.priceUnit = "tokens";
    mounted(createElement(ProviderRateEditor!, { connection }), demo);
    fireEvent.change(screen.getByLabelText(/Price/), { target: { value: "9007199254740993.125" } });
    fireEvent.click(screen.getByRole("button", { name: "Save rate" }));
    await waitFor(() => expect(demo.calls).toHaveLength(1));
    expect(demo.calls[0]).toMatchObject({
      rates: [{ price: "9007199254740993.125", rateId: "standard" }],
    });
  });
  test("rates read and edit as exact dollars, and only a manual rate offers its fallback", async () => {
    const { ProviderRateEditor } = await load(variant, "provider-rate-editor");
    const demo = fixture();
    const rendered = mounted(
      createElement(ProviderRateEditor!, { connection: initialConnections[0] }),
      demo,
    );
    const row = screen.getByRole("button", { name: /Standard request/ });
    expect(row.getAttribute("aria-expanded")).toBe("false");
    expect(row.textContent).toContain("$0.00625 per request");
    expect(row.textContent).toContain("Measured");
    fireEvent.click(row);
    expect(row.getAttribute("aria-expanded")).toBe("true");
    expect((screen.getByLabelText(/Price/) as HTMLInputElement).value).toBe("0.006250");
    expect(screen.getByText("(USD)")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Use measured rate|Use list price/ })).toBeNull();
    fireEvent.change(screen.getByLabelText(/Price/), { target: { value: "0.0000001" } });
    fireEvent.click(screen.getByRole("button", { name: "Save rate" }));
    expect(screen.getByRole("alert").textContent).toBe("Enter an exact nonnegative price.");
    expect(demo.calls).toEqual([]);
    fireEvent.change(screen.getByLabelText(/Price/), { target: { value: "0.02" } });
    fireEvent.click(screen.getByRole("button", { name: "Save rate" }));
    await waitFor(() => expect(demo.calls).toHaveLength(1));
    expect(demo.calls[0]).toMatchObject({ rates: [{ rateId: "standard", price: "2" }] });
    rendered.rerender(
      rendered.wrap(
        createElement(ProviderRateEditor!, { connection: demo.snapshots().connections[0] }),
      ),
    );
    const saved = screen.getByRole("button", { name: /Standard request/ });
    expect(saved.textContent).toContain("$0.02 per request");
    expect(saved.textContent).toContain("Your rate");
    fireEvent.click(saved);
    expect(screen.getByText("Without your rate").nextElementSibling?.textContent).toContain(
      "$0.00625",
    );
    fireEvent.click(screen.getByRole("button", { name: "Use measured rate" }));
    await waitFor(() => expect(demo.calls).toHaveLength(2));
    expect(demo.calls[1]).toMatchObject({ rates: [{ rateId: "standard", price: null }] });
  });
  test("a manual rate names what clearing it restores", async () => {
    const { ProviderRateEditor } = await load(variant, "provider-rate-editor");
    const connection = structuredClone(initialConnections[0]!);
    const rate = connection.rates[0]!;
    const manual = { ...rate.provenance, source: "manual" as const, origin: "host" as const };
    connection.rates = [
      {
        ...rate,
        id: "listed",
        label: "Listed",
        provenance: manual,
        fallback: {
          price: rate.price,
          provenance: { ...rate.provenance, source: "list", origin: "catalog", sampleSize: null },
        },
      },
      { ...rate, id: "bare", label: "Bare", provenance: manual },
    ];
    mounted(createElement(ProviderRateEditor!, { connection }));
    for (const name of [/Listed/, /Bare/]) fireEvent.click(screen.getByRole("button", { name }));
    expect(screen.getByRole("button", { name: "Use list price" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Clear your rate" })).toBeTruthy();
  });
  test("rate feedback, funding and recovery copy come from the host", async () => {
    const { ProviderRateEditor } = await load(variant, "provider-rate-editor");
    const demo = fixture();
    demo.setNextOutcome("unknown");
    mounted(
      createElement(ProviderRateEditor!, {
        connection: initialConnections[0],
        feedbackLabels: {
          unknown: "Unconfirmed save.",
          reconcile: "Check save status",
          own: "Own API key",
        },
      }),
      demo,
    );
    fireEvent.click(screen.getByRole("button", { name: /Standard request/ }));
    expect(screen.getByText("Own API key")).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Price/), { target: { value: "0.02" } });
    fireEvent.click(screen.getByRole("button", { name: "Save rate" }));
    await screen.findByText("Unconfirmed save.");
    expect(screen.getByRole("button", { name: "Check save status" })).toBeTruthy();
    expect(screen.queryByText(/The result is unknown/)).toBeNull();
  });
  test("dollar text and input move the decimal point exactly", async () => {
    const money = (await load(variant, "provider-feedback")) as unknown as Record<
      "usdText" | "usdInput" | "centsFromUsd",
      (text: string) => string | null
    >;
    expect(money.usdText("0.6250")).toBe("$0.00625");
    expect(money.usdText("123456789.5")).toBe("$1,234,567.895");
    expect(money.usdText("100")).toBe("$1.00");
    expect(money.usdText("-5")).toBe("−$0.05");
    expect(money.usdText("1e3")).toBeNull();
    expect(money.usdInput("1250.00")).toBe("12.5000");
    expect(money.usdInput("0.6250")).toBe("0.006250");
    expect(money.centsFromUsd("12.5000")).toBe("1250.00");
    expect(money.centsFromUsd("0.000001")).toBe("0.0001");
    expect(money.centsFromUsd("5")).toBe("500");
    expect(money.centsFromUsd("9007199254740993.125")).toBe("900719925474099312.5");
    expect(money.centsFromUsd("0.0000001")).toBeNull();
    expect(money.centsFromUsd("-1")).toBeNull();
  });
  test("fallback order is one atomic CAS command and excludes its own connection", async () => {
    const { ProviderChainEditor } = await load(variant, "provider-chain-editor");
    const demo = fixture();
    const connection = {
      ...initialConnections[0]!,
      fallbackChain: ["backup", "language-platform"],
    };
    const backup = { ...initialConnections[1]!, id: "backup", label: "Backup" };
    mounted(
      createElement(ProviderChainEditor!, {
        connection,
        connections: [connection, initialConnections[1], backup],
      }),
      demo,
    );
    expect(screen.queryByRole("button", { name: "Add to fallback: Search production" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Move up: Language shared" }));
    expect(demo.calls).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Save fallback order" }));
    await waitFor(() => expect(demo.calls).toHaveLength(1));
    expect(demo.calls[0]).toMatchObject({
      kind: "settings",
      expectedRevision: "1",
      changes: { fallbackChain: ["language-platform", "backup"] },
    });
  });
  test("allocation matrix keeps all four units and submits only one changed row exactly", async () => {
    const { ProviderAllocationEditor } = await load(variant, "provider-allocation-editor");
    const demo = fixture();
    mounted(
      createElement(ProviderAllocationEditor!, {
        rows: initialAllocations,
        revision: "1",
        fresh: true,
      }),
      demo,
    );
    const ownApp = screen.getByRole("region", { name: "Own key App" });
    const platformApp = screen.getByRole("region", { name: "Platform funded App" });
    expect(within(platformApp).getByLabelText("Limit (cents)")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Own key Programmatic" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Platform funded Programmatic" })).toBeTruthy();
    fireEvent.click(within(ownApp).getByRole("button", { name: "Use available balance" }));
    expect((within(ownApp).getByLabelText("Limit (requests)") as HTMLInputElement).value).toBe(
      "9007199254741008.125",
    );
    fireEvent.click(screen.getByRole("button", { name: "Save allocations" }));
    await waitFor(() => expect(demo.calls).toHaveLength(1));
    expect(demo.calls[0]).toMatchObject({
      kind: "allocations",
      changes: [{ rowId: "byok-app", expectedRevision: "1", limit: "9007199254741008.125" }],
    });
  });
  test("settled usage refresh keeps an unsaved allocation draft in the same revision", async () => {
    const { ProviderAllocationEditor } = await load(variant, "provider-allocation-editor");
    const demo = fixture();
    const rendered = mounted(
      createElement(ProviderAllocationEditor!, { rows: initialAllocations, revision: "1" }),
      demo,
    );
    fireEvent.change(screen.getAllByLabelText("Limit (requests)")[0]!, {
      target: { value: "123" },
    });
    const rows = structuredClone(initialAllocations);
    rows[0]!.used = { text: "25", unit: "requests", certainty: "measured" };
    rendered.rerender(
      rendered.wrap(createElement(ProviderAllocationEditor!, { rows, revision: "1" })),
    );
    expect((screen.getAllByLabelText("Limit (requests)")[0] as HTMLInputElement).value).toBe("123");
    fireEvent.click(screen.getByRole("button", { name: "Save allocations" }));
    await waitFor(() => expect(demo.calls).toHaveLength(1));
    expect(demo.calls[0]).toMatchObject({
      changes: [{ rowId: "byok-app", expectedRevision: "1", limit: "123" }],
    });
  });
  test("balances and request quotes keep unknown cost independent of known customer charge", async () => {
    const { ProviderBalanceCard, ProviderRequestQuote } = await load(
      variant,
      "provider-balance-card",
    );
    render(
      createElement(ProviderBalanceCard!, {
        balance: {
          connectionId: "c",
          fundingSource: "byok",
          authority: "provider",
          balance: { text: "9007199254740993.125", unit: "tokens", certainty: "measured" },
          reserved: { text: "", unit: "tokens", certainty: "unknown" },
          availability: { state: "unknown" },
          freshness: { observedAt: null, stale: true, source: "unknown" },
        },
      }),
    );
    expect(screen.getByText("9007199254740993.125 tokens")).toBeTruthy();
    expect(screen.getByText("Unknown")).toBeTruthy();
    expect(screen.getByText("Stale evidence")).toBeTruthy();
    cleanup();
    render(
      createElement(ProviderRequestQuote!, {
        projection: {
          connectionId: "c",
          quantity: { text: "1", unit: "requests", certainty: "measured" },
          providerCost: { text: "", unit: "cents", certainty: "unknown" },
          customerCharge: { text: "1.0000", unit: "customer_cents", certainty: "measured" },
          canProceed: "unknown",
          freshness: { observedAt: null, stale: true, source: "unknown" },
        },
      }),
    );
    expect(screen.getByText("1.0000 cents")).toBeTruthy();
    expect(screen.getAllByText("Unknown")).toHaveLength(2);
    expect(screen.queryByText("0 cents")).toBeNull();
  });
  test("allocation drafts reset on a new host revision and cannot overwrite untouched rows", async () => {
    const { ProviderAllocationEditor } = await load(variant, "provider-allocation-editor");
    const demo = fixture();
    const rendered = mounted(
      createElement(ProviderAllocationEditor!, { rows: initialAllocations, revision: "1" }),
      demo,
    );
    fireEvent.change(screen.getAllByLabelText("Limit (requests)")[0]!, {
      target: { value: "123" },
    });
    const rows = structuredClone(initialAllocations);
    rows[0]!.revision = "2";
    rows[0]!.limit = { text: "500", unit: "requests", certainty: "measured" };
    rendered.rerender(
      rendered.wrap(createElement(ProviderAllocationEditor!, { rows, revision: "2" })),
    );
    expect((screen.getAllByLabelText("Limit (requests)")[0] as HTMLInputElement).value).toBe("500");
    expect(
      (screen.getByRole("button", { name: "Save allocations" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(demo.calls).toEqual([]);
  });
  test.each(["stale", "unit", "unknown"])("use available refuses %s evidence", async (reason) => {
    const { ProviderAllocationEditor } = await load(variant, "provider-allocation-editor");
    const demo = fixture();
    const rows = structuredClone(initialAllocations);
    if (reason === "unit")
      rows[0]!.available = { text: "1", unit: "tokens", certainty: "measured" };
    if (reason === "unknown")
      rows[0]!.available = { text: "", unit: "requests", certainty: "unknown" };
    mounted(
      createElement(ProviderAllocationEditor!, { rows, revision: "1", fresh: reason !== "stale" }),
      demo,
    );
    expect(
      (
        within(screen.getByRole("region", { name: "Own key App" })).getByRole("button", {
          name: "Use available balance",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });
  test("manager conflict retains its editor until explicit reload and can then save latest revision", async () => {
    const { ProviderManagerPanel } = await load(variant, "provider-manager-panel");
    const demo = fixture();
    demo.setNextOutcome("conflict");
    mounted(createElement(ProviderManagerPanel!), demo);
    await screen.findByText("Search production");
    fireEvent.click(screen.getAllByRole("button", { name: "Manage connection" })[0]!);
    fireEvent.change(screen.getByLabelText(/Price/), { target: { value: "12.5000" } });
    fireEvent.click(screen.getByRole("button", { name: "Save rate" }));
    await screen.findAllByText(/changed elsewhere/);
    await waitFor(() => expect(demo.snapshots().connections[0]!.revision).toBe("2"));
    expect((screen.getByLabelText(/Price/) as HTMLInputElement).value).toBe("12.5000");
    expect((screen.getByRole("button", { name: "Save rate" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.click(screen.getByRole("button", { name: "Reload connections" }));
    await waitFor(() => expect(screen.queryByLabelText(/Price/)).toBeNull());
    fireEvent.click(screen.getAllByRole("button", { name: "Manage connection" })[0]!);
    fireEvent.change(screen.getByLabelText(/Price/), { target: { value: "14.5000" } });
    fireEvent.click(screen.getByRole("button", { name: "Save rate" }));
    await waitFor(() => expect(demo.calls).toHaveLength(2));
    expect(demo.calls[1]).toMatchObject({ kind: "rates", expectedRevision: "2" });
  });
  test.each(["forbidden", "unavailable"] as const)(
    "allocation %s read keeps the draft fenced and hides old financial evidence until a fresh read",
    async (failure) => {
      const { ProviderAllocationPanel } = await load(variant, "provider-allocation-editor");
      const f = editorFixture();
      render(
        f.wrap(
          createElement(ProviderAllocationPanel!, { connectionIds: ["search-own"], fresh: true }),
        ),
      );
      const region = await screen.findByRole("region", { name: "Own key App" });
      fireEvent.change(within(region).getByLabelText("Limit (requests)"), {
        target: { value: "123" },
      });
      expect(within(region).getByText("12 requests")).toBeTruthy();
      f.fail(failure);
      await f.refresh();
      await screen.findByText(
        failure === "forbidden"
          ? "You cannot make this change."
          : "Stored evidence is unavailable.",
      );

      const draft = within(screen.getByRole("region", { name: "Own key App" })).getByLabelText(
        "Limit (requests)",
      ) as HTMLInputElement;
      expect(draft.value).toBe("123");
      expect(draft.readOnly || draft.disabled).toBe(true);
      expect(
        (screen.getByRole("button", { name: "Save allocations" }) as HTMLButtonElement).disabled,
      ).toBe(true);
      for (const value of [
        "12 requests",
        "3 requests",
        "985 requests",
        "9007199254740993.125 requests",
      ])
        expect(screen.queryByText(value)).toBeNull();
      expect(
        (
          within(screen.getByRole("region", { name: "Own key App" })).getByRole("button", {
            name: "Use available balance",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(true);
      expect(f.demo.calls).toEqual([]);

      f.newer();
      f.fail(null);
      await f.refresh();
      await screen.findByText("25 requests");
      expect(
        (
          within(screen.getByRole("region", { name: "Own key App" })).getByLabelText(
            "Limit (requests)",
          ) as HTMLInputElement
        ).value,
      ).toBe("123");
      fireEvent.click(screen.getByRole("button", { name: "Reload allocations" }));
      await waitFor(() =>
        expect(
          (
            within(screen.getByRole("region", { name: "Own key App" })).getByLabelText(
              "Limit (requests)",
            ) as HTMLInputElement
          ).value,
        ).toBe("700"),
      );
      expect(f.demo.calls).toEqual([]);
    },
  );
  test.each(["forbidden", "unavailable"] as const)(
    "manager %s read retains the disabled rate draft without old price, provenance or balance",
    async (failure) => {
      const { ProviderManagerPanel } = await load(variant, "provider-manager-panel");
      const f = editorFixture();
      render(f.wrap(createElement(ProviderManagerPanel!)));
      await screen.findByText("Search production");
      fireEvent.click(screen.getAllByRole("button", { name: "Manage connection" })[0]!);
      const price = await screen.findByLabelText(/Price/);
      fireEvent.change(price, { target: { value: "12.5000" } });
      expect(screen.getByText("rate-1")).toBeTruthy();
      f.fail(failure);
      await f.refresh();
      await screen.findAllByText(
        failure === "forbidden"
          ? "You cannot make this change."
          : "Stored evidence is unavailable.",
      );

      const draft = screen.getByLabelText(/Price/) as HTMLInputElement;
      expect(draft.value).toBe("12.5000");
      expect(draft.readOnly || draft.disabled).toBe(true);
      expect(
        (screen.getByRole("button", { name: "Save rate" }) as HTMLButtonElement).disabled,
      ).toBe(true);
      for (const value of [
        "rate-1",
        "153",
        "9007199254740993.125 requests",
        "12 requests",
        "985 requests",
      ])
        expect(screen.queryByText(value)).toBeNull();
      expect(screen.queryByText(/\$0\.00625/)).toBeNull();
      expect(f.demo.calls).toEqual([]);

      f.newer();
      f.fail(null);
      await f.refresh();
      await screen.findByText("rate-2");
      expect((screen.getByLabelText(/Price/) as HTMLInputElement).value).toBe("12.5000");
      fireEvent.click(screen.getByRole("button", { name: "Reload connections" }));
      await waitFor(() => expect(screen.queryByLabelText(/Price/)).toBeNull());
      fireEvent.click(screen.getAllByRole("button", { name: "Manage connection" })[0]!);
      await waitFor(() =>
        expect((screen.getByLabelText(/Price/) as HTMLInputElement).value).toBe("0.097500"),
      );
      expect(f.demo.calls).toEqual([]);
    },
  );
  test("panel reports explicit Reload separately from background reads", async () => {
    const { ProviderAllocationPanel } = await load(variant, "provider-allocation-editor");
    const f = editorFixture();
    const readRefresh = vi.fn();
    render(
      f.wrap(
        createElement(ProviderAllocationPanel!, {
          connectionIds: ["search-own"],
          onReadRefreshChange: readRefresh,
        }),
      ),
    );
    await screen.findAllByRole("textbox");
    expect(readRefresh).toHaveBeenLastCalledWith(null);
    const original = f.demo.port.read.bind(f.demo.port);
    const hold = () => {
      let resolve!: () => void;
      const pending = new Promise<void>((done) => {
        resolve = done;
      });
      f.demo.port.read = async (...args) => {
        await pending;
        return original(...args);
      };
      return resolve;
    };
    let finish = hold();
    await f.refresh();
    expect(readRefresh).toHaveBeenLastCalledWith("revalidate");
    await act(async () => finish());
    await waitFor(() => expect(readRefresh).toHaveBeenLastCalledWith(null));
    finish = hold();
    fireEvent.click(screen.getByRole("button", { name: "Reload allocations" }));
    expect(readRefresh).toHaveBeenLastCalledWith("reload");
    await act(async () => finish());
    await waitFor(() => expect(readRefresh).toHaveBeenLastCalledWith(null));
  });

  test("confirmed reload rebases adapter display values; background and failed reads retain them", async () => {
    const { ProviderAllocationPanel } = await load(variant, "provider-allocation-editor");
    const f = editorFixture();
    const rebased = vi.fn();
    function HostForm() {
      const [values, setValues] = useState<Record<string, string>>({});
      return createElement(ProviderAllocationPanel!, {
        connectionIds: ["search-own"],
        formAdapter: {
          field: (row: ProviderAllocationRow) => ({
            value: values[row.id] ?? "123",
            setValue: (value: string) => setValues((old) => ({ ...old, [row.id]: value })),
          }),
          handleSubmit: (save: () => Promise<void>) => (event: React.FormEvent) => {
            event.preventDefault();
            void save();
          },
          rebase: (drafts: Readonly<Record<string, string>>) => {
            rebased(drafts);
            setValues({ ...drafts });
          },
        },
      });
    }
    render(f.wrap(createElement(HostForm)));
    await screen.findAllByRole("textbox");
    expect(rebased).not.toHaveBeenCalled();
    f.newer();
    await f.refresh();
    expect((screen.getAllByRole("textbox")[0] as HTMLInputElement).value).toBe("123");
    expect(rebased).not.toHaveBeenCalled();
    f.fail("unavailable");
    fireEvent.click(screen.getByRole("button", { name: "Reload allocations" }));
    await screen.findByText("Stored evidence is unavailable.");
    f.fail(null);
    await f.refresh();
    await waitFor(() =>
      expect((screen.getAllByRole("textbox")[0] as HTMLInputElement).disabled).toBe(false),
    );
    expect(rebased).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Reload allocations" }));
    await waitFor(() =>
      expect(rebased).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ "byok-app": "700" }),
      ),
    );
    expect((screen.getAllByRole("textbox")[0] as HTMLInputElement).value).toBe("700");
  });

  test("failed explicit allocation reload does not discard a dirty draft on later background recovery", async () => {
    const { ProviderAllocationPanel } = await load(variant, "provider-allocation-editor");
    const f = editorFixture();
    render(f.wrap(createElement(ProviderAllocationPanel!, { connectionIds: ["search-own"] })));
    const region = await screen.findByRole("region", { name: "Own key App" });
    fireEvent.change(within(region).getByLabelText("Limit (requests)"), {
      target: { value: "123" },
    });
    f.fail("unavailable");
    fireEvent.click(screen.getByRole("button", { name: "Reload allocations" }));
    await screen.findByText("Stored evidence is unavailable.");
    expect((screen.getAllByLabelText("Limit (requests)")[0] as HTMLInputElement).value).toBe("123");
    f.newer();
    f.fail(null);
    await f.refresh();
    await screen.findByText("25 requests");
    expect((screen.getAllByLabelText("Limit (requests)")[0] as HTMLInputElement).value).toBe("123");
    expect(f.demo.calls).toEqual([]);
  });
  test("changing the manager query removes the old selected rate draft before the new read finishes", async () => {
    const { ProviderManagerPanel } = await load(variant, "provider-manager-panel");
    const f = editorFixture();
    const rendered = render(f.wrap(createElement(ProviderManagerPanel!, { provider: "search" })));
    await screen.findByText("Search production");
    fireEvent.click(screen.getByRole("button", { name: "Manage connection" }));
    fireEvent.change(await screen.findByLabelText(/Price/), { target: { value: "12.5000" } });
    rendered.rerender(f.wrap(createElement(ProviderManagerPanel!, { provider: "language" })));
    expect(screen.queryByLabelText(/Price/)).toBeNull();
    expect(screen.queryByText("rate-1")).toBeNull();
    await screen.findByText("Language shared");
    expect(screen.queryByLabelText(/Price/)).toBeNull();
    expect(f.demo.calls).toEqual([]);
  });
  test("removed allocation targets keep a disabled draft without retained totals or a writable Save", async () => {
    const { ProviderAllocationPanel } = await load(variant, "provider-allocation-editor");
    const f = editorFixture();
    render(
      f.wrap(
        createElement(ProviderAllocationPanel!, { connectionIds: ["search-own"], fresh: true }),
      ),
    );
    const region = await screen.findByRole("region", { name: "Own key App" });
    fireEvent.change(within(region).getByLabelText("Limit (requests)"), {
      target: { value: "123" },
    });
    f.remove();
    await f.refresh();
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Save allocations" }) as HTMLButtonElement).disabled,
      ).toBe(true),
    );
    expect((screen.getAllByLabelText("Limit (requests)")[0] as HTMLInputElement).value).toBe("123");
    expect(screen.queryByText("12 requests")).toBeNull();
    expect(screen.queryByText("985 requests")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save allocations" }));
    expect(f.demo.calls).toEqual([]);
  });
  test("removed manager target hides rate evidence and fences its retained draft while new connections remain available", async () => {
    const { ProviderManagerPanel } = await load(variant, "provider-manager-panel");
    const f = editorFixture();
    render(f.wrap(createElement(ProviderManagerPanel!)));
    await screen.findByText("Search production");
    fireEvent.click(screen.getAllByRole("button", { name: "Manage connection" })[0]!);
    fireEvent.change(await screen.findByLabelText(/Price/), { target: { value: "12.5000" } });
    f.remove();
    await f.refresh();
    await screen.findByText("No provider connections yet.");
    expect((screen.getByLabelText(/Price/) as HTMLInputElement).value).toBe("12.5000");
    expect((screen.getByRole("button", { name: "Save rate" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(screen.queryByText("rate-1")).toBeNull();
    expect(screen.queryByText(/\$0\.00625/)).toBeNull();
    expect(
      (screen.getByRole("button", { name: "New connection: Search" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Save rate" }));
    expect(f.demo.calls).toEqual([]);
  });
  test("rate panel states a refused change once and reloads with the host", async () => {
    const { ProviderRatePanel } = await load(variant, "provider-rate-editor");
    const f = editorFixture();
    const onReload = vi.fn();
    f.demo.port.execute = vi.fn(async (_binding, command) => ({
      outcome: "forbidden" as const,
      commandId: command.commandId,
    }));
    render(f.wrap(createElement(ProviderRatePanel!, { connectionId: "search-own", onReload })));
    fireEvent.change(await screen.findByLabelText(/Price/), { target: { value: "0.02" } });
    fireEvent.click(screen.getByRole("button", { name: "Save rate" }));
    expect(await screen.findAllByText("You cannot make this change.")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Reload rates" }));
    expect(onReload).toHaveBeenCalledTimes(1);
  });
  test.each(["forbidden", "unavailable"] as const)(
    "rate panel hides an untouched price after a %s read and saves only recovered evidence",
    async (failure) => {
      const { ProviderRatePanel } = await load(variant, "provider-rate-editor");
      const f = editorFixture();
      render(f.wrap(createElement(ProviderRatePanel!, { connectionId: "search-own" })));
      const price = (await screen.findByLabelText(/Price/)) as HTMLInputElement;
      expect(price.value).not.toBe("");
      f.fail(failure);
      await f.refresh();
      await screen.findByText(
        failure === "forbidden"
          ? "You cannot make this change."
          : "Stored evidence is unavailable.",
      );
      expect(price.value).toBe("");
      expect(price.readOnly || price.disabled).toBe(true);
      expect(f.demo.calls).toEqual([]);

      f.newer();
      f.fail(null);
      await f.refresh();
      await waitFor(() => expect(price.value).toBe("0.097500"));
      fireEvent.click(screen.getByRole("button", { name: "Save rate" }));
      await waitFor(() => expect(f.demo.calls).toHaveLength(1));
      expect(f.demo.calls[0]).toMatchObject({
        kind: "rates",
        rates: [{ price: "9.7500" }],
      });
    },
  );
  test("hook-backed rate panel preserves a dirty draft on failed read and rebases only on successful Reload", async () => {
    const { ProviderRatePanel } = await load(variant, "provider-rate-editor");
    const f = editorFixture();
    render(f.wrap(createElement(ProviderRatePanel!, { connectionId: "search-own" })));
    fireEvent.change(await screen.findByLabelText(/Price/), { target: { value: "12.5000" } });
    f.fail("unavailable");
    await f.refresh();
    await screen.findByText("Stored evidence is unavailable.");
    expect((screen.getByLabelText(/Price/) as HTMLInputElement).value).toBe("12.5000");
    expect((screen.getByRole("button", { name: "Save rate" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(screen.queryByText("rate-1")).toBeNull();
    expect(screen.queryByText(/\$0\.00625/)).toBeNull();
    f.newer();
    f.fail(null);
    await f.refresh();
    await screen.findByText("rate-2");
    expect((screen.getByLabelText(/Price/) as HTMLInputElement).value).toBe("12.5000");
    fireEvent.click(screen.getByRole("button", { name: "Reload rates" }));
    await waitFor(() =>
      expect((screen.getByLabelText(/Price/) as HTMLInputElement).value).toBe("0.097500"),
    );
    expect(f.demo.calls).toEqual([]);
  });
  test("manager opens a newly observed provider from fresh evidence", async () => {
    const { ProviderManagerPanel } = await load(variant, "provider-manager-panel");
    const f = editorFixture();
    render(f.wrap(createElement(ProviderManagerPanel!)));
    await screen.findByText("Search production");
    f.revealProvider();
    await f.refresh();
    fireEvent.click(await screen.findByRole("button", { name: "New connection: New provider" }));
    expect(screen.getByRole("form", { name: "New provider credentials" })).toBeTruthy();
    expect(screen.getByLabelText("API key")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close editor" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Manage connection" })[2]!);
    fireEvent.change(await screen.findByLabelText(/Price/), { target: { value: "12.5000" } });
    f.fail("unavailable");
    await f.refresh();
    await screen.findAllByText("Stored evidence is unavailable.");
    expect((screen.getByLabelText(/Price/) as HTMLInputElement).value).toBe("12.5000");
    expect((screen.getByRole("button", { name: "Save rate" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(screen.queryByText("rate-1")).toBeNull();
    expect(screen.queryByText(/\$0\.00625/)).toBeNull();
    expect(f.demo.calls).toEqual([]);
  });
  test.each(["forbidden", "unavailable", "empty"])(
    "manager distinguishes %s from loading",
    async (state) => {
      const { ProviderManagerPanel } = await load(variant, "provider-manager-panel");
      const demo = fixture();
      demo.port.read = vi.fn(async () =>
        state === "forbidden"
          ? { outcome: "forbidden" as const }
          : state === "unavailable"
            ? { outcome: "unavailable" as const, message: "Host offline" }
            : {
                outcome: "ok" as const,
                value: {
                  kind: "connections" as const,
                  state: "empty" as const,
                  problem: null,
                  asOf: null,
                  revision: "1",
                  providers: [],
                  connections: [],
                },
              },
      );
      mounted(createElement(ProviderManagerPanel!), demo);
      await screen.findByText(
        state === "forbidden"
          ? "You cannot make this change."
          : state === "unavailable"
            ? "Host offline"
            : "No provider connections yet.",
      );
      expect(screen.queryByText("Loading connection evidence…")).toBeNull();
      expect(demo.calls).toEqual([]);
    },
  );
});

describe.each(variants)("%s shared host regression parity", (variant) => {
  const known = (text: string, unit = "requests") => ({
    text,
    unit,
    certainty: "measured" as const,
  });
  const mount = (node: ReactNode) => {
    const demo = createDemoProviderPort(`parity:${crypto.randomUUID()}`);
    const wrap = (child: ReactNode) =>
      createElement(ProviderManagementProvider, { port: demo.port, binding: demo.binding }, child);
    return { ...render(wrap(node)), demo, wrap };
  };
  const snapshot = () => ({
    identity: crypto.randomUUID(),
    revision: "v1",
    entries: [
      { id: "a", label: "Alpha", enabled: true, revision: "a1" },
      { id: "b", label: "Beta", enabled: true, revision: "b1" },
      { id: "c", label: "Gamma", enabled: false, revision: "c1" },
    ],
  });
  test.each(["permission", "unknown"])(
    "an allocation draft cannot silently omit a changed row after losing %s",
    async (loss) => {
      const { ProviderAllocationEditor } = await load(variant, "provider-allocation-editor");
      const rows = initialAllocations.slice(0, 2).map((row) => ({
        ...row,
        unlimited: false,
        limit: known("1000", row.unit),
      }));
      const props = { rows, revision: "1", inputPolicy: { blank: "unlimited" } };
      const r = mount(createElement(ProviderAllocationEditor!, props));
      for (const input of screen.getAllByRole("textbox"))
        fireEvent.change(input, { target: { value: "1500" } });
      r.rerender(
        r.wrap(
          createElement(ProviderAllocationEditor!, {
            ...props,
            evidenceRows: rows.map((row, i) =>
              i
                ? row
                : {
                    ...row,
                    ...(loss === "permission" ? { editable: false } : { limit: "unavailable" }),
                  },
            ),
          }),
        ),
      );
      expect(
        (screen.getByRole("button", { name: "Save allocations" }) as HTMLButtonElement).disabled,
      ).toBe(true);
      expect(screen.getByRole("alert").textContent).toContain("changed elsewhere");
      expect(r.demo.calls).toEqual([]);
    },
  );
  test("dollar allocation accepts surrounding whitespace without rounding", async () => {
    const policy = await import(
      /* @vite-ignore */ pathToFileURL(
        join(hosts[variant], "components/usagekit/provider-allocation-policy.tsx"),
      ).href
    );
    expect(
      policy.allocationInput(
        " 12.50 ",
        {
          ...initialAllocations[0],
          unit: "cents",
        },
        { denomination: "dollars" },
      ),
    ).toEqual({ native: "1250" });
  });
  test("project refresh preserves an unsaved order until explicit reload", async () => {
    const { ProviderChainEditor } = await load(variant, "provider-chain-editor");
    const initial = snapshot();
    const fresh = { ...initial, revision: "v2" };
    const props = {
      mode: "project",
      snapshot: initial,
      evidence: initial,
      canEdit: true,
      onCommit: vi.fn(),
      onReload: async () => fresh,
    };
    const r = render(createElement(ProviderChainEditor!, props));
    fireEvent.click(screen.getByRole("button", { name: "Move up: Beta" }));
    r.rerender(createElement(ProviderChainEditor!, { ...props, snapshot: fresh, evidence: fresh }));
    expect(screen.getAllByRole("listitem")[0]!.textContent).toContain("Beta");
    fireEvent.click(screen.getByRole("button", { name: "Reload order" }));
    await waitFor(() => expect(screen.getAllByRole("listitem")[0]!.textContent).toContain("Alpha"));
  });
  test("project reordering cannot cross the enabled boundary and keeps keyboard focus", async () => {
    const { ProviderChainEditor } = await load(variant, "provider-chain-editor");
    const initial = snapshot();
    render(
      createElement(ProviderChainEditor!, {
        mode: "project",
        snapshot: initial,
        evidence: initial,
        canEdit: true,
        onCommit: vi.fn(),
      }),
    );
    expect(
      (screen.getByRole("button", { name: "Move down: Beta" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Move up: Gamma" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    const button = screen.getByRole("button", { name: "Move up: Beta" });
    button.focus();
    fireEvent.click(button);
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Move down: Beta" })),
    );
  });
  test("rate input errors are associated with the edited field", async () => {
    const { ProviderRateEditor } = await load(variant, "provider-rate-editor");
    const connection = structuredClone(initialConnections[0]!);
    connection.rates = [connection.rates[0]!];
    mount(createElement(ProviderRateEditor!, { connection }));
    fireEvent.click(screen.getByRole("button", { name: new RegExp(connection.rates[0]!.label) }));
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "invalid" } });
    fireEvent.click(screen.getByRole("button", { name: "Save rate" }));
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(document.getElementById(input.getAttribute("aria-describedby")!)?.textContent).toBe(
      screen.getByRole("alert").textContent,
    );
  });
  test("successful project state follows the exact normalized submitted order", async () => {
    const module = await import(
      /* @vite-ignore */ pathToFileURL(
        join(hosts[variant], "components/usagekit/provider-project-controller.tsx"),
      ).href
    );
    const initial = snapshot();
    const commit = vi.fn(async (command: { commandId: string }) => ({
      commandId: command.commandId,
      outcome: "success",
    }));
    function Probe() {
      const state = module.useProjectChainController({
        snapshot: initial,
        evidence: initial,
        canEdit: true,
        onCommit: commit,
      });
      return createElement(
        "div",
        {},
        createElement("output", {}, state.draft.map((row: { id: string }) => row.id).join(",")),
        createElement(
          "button",
          {
            onClick: () =>
              state.change([initial.entries[2], initial.entries[0], initial.entries[1]]),
          },
          "Change draft",
        ),
        createElement("button", { onClick: () => void state.save() }, "Save draft"),
      );
    }
    render(createElement(Probe));
    fireEvent.click(screen.getByRole("button", { name: "Change draft" }));
    expect(screen.getByRole("status").textContent).toBe("c,a,b");
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("a,b,c"));
    expect(commit.mock.calls[0]![0]).toMatchObject({
      entries: [
        { id: "a", enabled: true },
        { id: "b", enabled: true },
        { id: "c", enabled: false },
      ],
    });
  });
  test("budget percentages remain finite and bounded for very large exact usage", async () => {
    const module = await import(
      /* @vite-ignore */ pathToFileURL(
        join(hosts[variant], "components/usagekit/usage-cap-pill.tsx"),
      ).href
    );
    const result = module.usageCapFromBudget({
      kind: "principal",
      target: "owner",
      unit: "requests",
      level: "exceeded",
      used: known("1" + "0".repeat(400)),
      reserved: known("0"),
      limit: known("1"),
      boundary: { onExceed: "block" },
    });
    expect(Number.isFinite(result.percent)).toBe(true);
    expect(result.percent).toBeGreaterThan(100);
  });
  test("ordinary cents use the host localized unit", async () => {
    const { MeasurementCard } = await load(variant, "measurement-card");
    render(
      createElement(MeasurementCard!, {
        title: "Cost",
        value: known("1.2500", "cents"),
        labels: { cents: "localized cents" },
      }),
    );
    expect(screen.getByText("localized cents")).toBeTruthy();
    expect(screen.queryByText("cents")).toBeNull();
  });
  test.each(["conflict", "forbidden"])(
    "review recovery: fresh props recover a terminal %s without an optional reload callback",
    async (outcome) => {
      const { ProviderChainEditor } = await load(variant, "provider-chain-editor");
      const initial = snapshot();
      const props = {
        mode: "project",
        snapshot: initial,
        evidence: initial,
        canEdit: true,
        onCommit: async (command: { commandId: string }) => ({
          commandId: command.commandId,
          outcome,
        }),
      };
      const r = render(createElement(ProviderChainEditor!, props));
      fireEvent.click(screen.getByRole("button", { name: "Move up: Beta" }));
      fireEvent.click(screen.getByRole("button", { name: "Save fallback order" }));
      await waitFor(() =>
        expect(
          (screen.getByRole("button", { name: "Move down: Beta" }) as HTMLButtonElement).disabled,
        ).toBe(true),
      );
      const fresh = { ...initial, revision: "v2" };
      r.rerender(
        createElement(ProviderChainEditor!, { ...props, snapshot: fresh, evidence: fresh }),
      );
      expect(screen.getAllByRole("listitem")[0]!.textContent).toContain("Alpha");
      expect(
        (screen.getByRole("button", { name: "Move up: Beta" }) as HTMLButtonElement).disabled,
      ).toBe(false);
    },
  );
  test.each(["add", "remove"])(
    "review membership: dirty drafts recover when hosts %s a connection",
    async (kind) => {
      const { ProviderChainEditor } = await load(variant, "provider-chain-editor");
      const initial = snapshot();
      const props = {
        mode: "project",
        snapshot: initial,
        evidence: initial,
        canEdit: true,
        onCommit: vi.fn(),
      };
      const r = render(createElement(ProviderChainEditor!, props));
      fireEvent.click(screen.getByRole("button", { name: "Move up: Beta" }));
      const fresh = {
        ...initial,
        revision: "v2",
        entries:
          kind === "add"
            ? [...initial.entries, { id: "d", label: "Delta", enabled: true, revision: "d1" }]
            : initial.entries.filter((row) => row.id !== "c"),
      };
      r.rerender(
        createElement(ProviderChainEditor!, { ...props, snapshot: fresh, evidence: fresh }),
      );
      expect(screen.getAllByRole("listitem")).toHaveLength(fresh.entries.length);
      expect(screen.getAllByRole("listitem")[0]!.textContent).toContain("Alpha");
      expect(
        (screen.getByRole("button", { name: "Move up: Beta" }) as HTMLButtonElement).disabled,
      ).toBe(false);
    },
  );
  test("review feedback: a deferred refresh does not silently discard a rejected change", async () => {
    const { ProviderChainEditor } = await load(variant, "provider-chain-editor");
    const initial = snapshot();
    const commit = vi.fn(async (command: { commandId: string }) => ({
      commandId: command.commandId,
      outcome: "conflict",
    }));
    const props = {
      mode: "project",
      snapshot: initial,
      evidence: initial,
      canEdit: true,
      onCommit: commit,
    };
    const r = render(createElement(ProviderChainEditor!, props));
    fireEvent.click(screen.getByRole("button", { name: "Move up: Beta" }));
    const fresh = { ...initial, revision: "v2" };
    r.rerender(createElement(ProviderChainEditor!, { ...props, snapshot: fresh, evidence: fresh }));
    fireEvent.click(screen.getByRole("button", { name: "Save fallback order" }));
    await waitFor(() => expect(commit).toHaveBeenCalledTimes(1));
    await screen.findByText("The previous change was not applied.");
    expect(screen.getAllByRole("listitem")[0]!.textContent).toContain("Alpha");
    const move = screen.getByRole("button", { name: "Move up: Beta" });
    expect((move as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(move);
    expect(screen.queryByText("The previous change was not applied.")).toBeNull();
  });
  test("review recovery: an explicit reload retains control of a conflicting dirty draft", async () => {
    const { ProviderChainEditor } = await load(variant, "provider-chain-editor");
    const initial = snapshot();
    const fresh = { ...initial, revision: "v2" };
    const props = {
      mode: "project",
      snapshot: initial,
      evidence: initial,
      canEdit: true,
      onCommit: async (command: { commandId: string }) => ({
        commandId: command.commandId,
        outcome: "conflict",
      }),
      onReload: async () => fresh,
    };
    const r = render(createElement(ProviderChainEditor!, props));
    fireEvent.click(screen.getByRole("button", { name: "Move up: Beta" }));
    fireEvent.click(screen.getByRole("button", { name: "Save fallback order" }));
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Reload order" }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    r.rerender(createElement(ProviderChainEditor!, { ...props, snapshot: fresh, evidence: fresh }));
    expect(screen.getAllByRole("listitem")[0]!.textContent).toContain("Beta");
    fireEvent.click(screen.getByRole("button", { name: "Reload order" }));
    await waitFor(() => expect(screen.getAllByRole("listitem")[0]!.textContent).toContain("Alpha"));
  });
  test("review recovery: undoing a dirty draft accepts the deferred snapshot", async () => {
    const { ProviderChainEditor } = await load(variant, "provider-chain-editor");
    const initial = snapshot();
    const commit = vi.fn(async (command: { commandId: string }) => ({
      commandId: command.commandId,
      outcome: "success",
    }));
    const props = {
      mode: "project",
      snapshot: initial,
      evidence: initial,
      canEdit: true,
      onCommit: commit,
    };
    const r = render(createElement(ProviderChainEditor!, props));
    fireEvent.click(screen.getByRole("button", { name: "Move up: Beta" }));
    const fresh = {
      ...initial,
      revision: "v2",
      entries: initial.entries.map((row) => ({ ...row, revision: row.revision + "next" })),
    };
    r.rerender(createElement(ProviderChainEditor!, { ...props, snapshot: fresh, evidence: fresh }));
    expect(screen.getAllByRole("listitem")[0]!.textContent).toContain("Beta");
    fireEvent.click(screen.getByRole("button", { name: "Move down: Beta" }));
    fireEvent.click(screen.getByRole("button", { name: "Move up: Beta" }));
    fireEvent.click(screen.getByRole("button", { name: "Save fallback order" }));
    await waitFor(() => expect(commit).toHaveBeenCalledTimes(1));
    expect(commit.mock.calls[0]![0]).toMatchObject({
      expectedRevision: "v2",
      entries: [
        { id: "b", expectedRevision: "b1next" },
        { id: "a", expectedRevision: "a1next" },
        { id: "c", expectedRevision: "c1next" },
      ],
    });
  });
  test("review recovery: moving down in the middle preserves focus on the enabled button", async () => {
    const { ProviderChainEditor } = await load(variant, "provider-chain-editor");
    const initial = snapshot();
    initial.entries = [
      ...initial.entries.map((row) => ({ ...row, enabled: true })),
      { id: "d", label: "Delta", enabled: true, revision: "d1" },
    ];
    render(
      createElement(ProviderChainEditor!, {
        mode: "project",
        snapshot: initial,
        evidence: initial,
        canEdit: true,
        onCommit: vi.fn(),
      }),
    );
    const button = screen.getByRole("button", { name: "Move down: Beta" });
    button.focus();
    fireEvent.click(button);
    await waitFor(() => expect(document.activeElement).toBe(button));
    expect((button as HTMLButtonElement).disabled).toBe(false);
  });
  test("review recovery: ambiguous allocation feedback does not claim a conflict", async () => {
    const { ProviderAllocationEditor } = await load(variant, "provider-allocation-editor");
    const props = { rows: initialAllocations, revision: "1" };
    const r = mount(createElement(ProviderAllocationEditor!, props));
    r.demo.setNextOutcome("unknown");
    fireEvent.change(screen.getAllByRole("textbox")[0]!, { target: { value: "1500" } });
    fireEvent.click(screen.getByRole("button", { name: "Save allocations" }));
    await screen.findByRole("button", { name: "Check change status" });
    r.rerender(
      r.wrap(
        createElement(ProviderAllocationEditor!, {
          ...props,
          evidenceRows: initialAllocations.map((row) => ({ ...row, editable: false })),
        }),
      ),
    );
    expect(screen.queryByText(/changed elsewhere/)).toBeNull();
    expect(screen.getByRole("button", { name: "Check change status" })).toBeTruthy();
  });
});

// Host composition contracts run against real shadcn installations for both primitive families.
describe.each(variants)("%s block API adoption", (variant) => {
  const known = (text = "9007199254740993.125", unit = "requests") => ({
    text,
    unit,
    certainty: "measured" as const,
  });
  const summary = () => ({
    state: "ready",
    complete: true,
    measurements: { requests: known() },
    cost: known("22", "cents"),
    funding: [
      {
        key: "own",
        fundingSource: "byok",
        costOwner: "private-owner",
        measurements: { requests: known("7") },
        cost: known("11", "cents"),
        unknownOperations: "0",
      },
      {
        key: "host",
        fundingSource: "platform",
        costOwner: "private-host",
        measurements: { customer_cents: known("123", "customer_cents") },
        cost: known("11", "cents"),
        unknownOperations: "0",
      },
    ],
    unknownOperations: "0",
    rowCount: 2,
    pages: 1,
    nextCursor: null,
    watermark: "w",
    asOf: "2026-10-01T00:00:00Z",
    problem: null,
  });
  const mount = (node: ReactNode) => {
    const demo = createDemoProviderPort(`api:${crypto.randomUUID()}`);
    const wrap = (child: ReactNode) =>
      createElement(ProviderManagementProvider, { port: demo.port, binding: demo.binding }, child);
    return { ...render(wrap(node)), demo, wrap };
  };
  test("platform money uses exact dollars", async () => {
    const { ProviderRateEditor } = await load(variant, "provider-rate-editor");
    const connection = structuredClone(initialConnections[0]!);
    connection.rates = [
      {
        ...connection.rates[0]!,
        fundingSource: "platform",
        priceUnit: "customer_cents",
        price: known("123.4500", "customer_cents"),
      },
    ];
    mount(createElement(ProviderRateEditor!, { connection }));
    expect(screen.getByText(/\$1.2345/)).toBeTruthy();
    expect(screen.queryByText(/customer_cents/)).toBeNull();
  });
  test("platform grouping retains mixed BYOK controls and one note", async () => {
    const { ProviderRateEditor } = await load(variant, "provider-rate-editor");
    const connection = structuredClone(initialConnections[0]!);
    const byok = { ...connection.rates[0]!, label: "Own price" };
    connection.rates = [
      byok,
      {
        ...byok,
        id: "credits",
        label: "Host price",
        fundingSource: "platform",
        price: known("123.4500", "customer_cents"),
        priceUnit: "customer_cents",
      },
    ];
    mount(
      createElement(ProviderRateEditor!, { connection, labels: { platformNote: "Host note" } }),
    );
    expect(screen.getByText("Provider rates")).toBeTruthy();
    expect(
      screen.getByText(
        "Rates retain their source and version. Changing a rate does not change a balance.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Credits prices")).toBeTruthy();
    expect(screen.getAllByText("Host note")).toHaveLength(1);
    const ownRow = screen.getByRole("button", { name: /Own price/ }).closest("li")!;
    fireEvent.click(within(ownRow).getByRole("button", { name: /Own price/ }));
    expect(within(ownRow).getByRole("textbox")).toBeTruthy();
    expect(within(ownRow).getAllByText("Measured").length).toBeGreaterThan(0);
    const platformRow = screen.getByText("Host price").closest("li")!;
    expect(within(platformRow).queryByRole("textbox")).toBeNull();
    expect(within(platformRow).queryByText("Measured")).toBeNull();
    expect(within(platformRow).queryByText("Host note")).toBeNull();
  });
  test("platform null evidence hides figure but unknown evidence has a label", async () => {
    const { ProviderRateEditor } = await load(variant, "provider-rate-editor");
    const connection = structuredClone(initialConnections[0]!);
    connection.rates = [
      {
        ...connection.rates[0]!,
        fundingSource: "platform",
        price: { text: "", unit: "cents", certainty: "unknown" },
      },
    ];
    const r = mount(createElement(ProviderRateEditor!, { connection, evidence: null }));
    expect(screen.queryByText(/Unknown per/)).toBeNull();
    r.rerender(r.wrap(createElement(ProviderRateEditor!, { connection })));
    expect(screen.getByText(/Unknown per/)).toBeTruthy();
    r.rerender(
      r.wrap(
        createElement(ProviderRateEditor!, {
          connection: {
            ...connection,
            rates: connection.rates.map((rate) => ({ ...rate, price: "unavailable" })),
          },
        }),
      ),
    );
    expect(screen.queryByText(/Unknown per/)).toBeNull();
  });
  test.each(["cost-summary-card", "usage-summary-cards"])(
    "selected funding empty label: %s",
    async (block) => {
      const exports = await load(variant, block);
      const Component =
        exports[block === "cost-summary-card" ? "CostSummaryCard" : "UsageSummaryCards"]!;
      const view = summary();
      view.funding = view.funding.filter((row) => row.fundingSource === "byok");
      render(
        createElement(Component, {
          view,
          fundingSource: "platform",
          labels: { empty: "Localized empty" },
        }),
      );
      expect(screen.getByText("Localized empty")).toBeTruthy();
      expect(screen.queryByText("Unavailable")).toBeNull();
    },
  );
  test("selected funding unknown operations sum stays exact", async () => {
    const { UsageSummaryCards } = await load(variant, "usage-summary-cards");
    const view = summary();
    view.unknownOperations = "9007199254741000";
    view.funding[0]!.unknownOperations = "5";
    view.funding[1]!.unknownOperations = "9007199254740993";
    view.funding.push({ ...view.funding[1]!, key: "host2", unknownOperations: "2" });
    render(createElement(UsageSummaryCards!, { view, fundingSource: "platform" }));
    expect(screen.getByText("Operations with unknown measurements: 9007199254740995")).toBeTruthy();
    expect(screen.queryByText(/9007199254741000/)).toBeNull();
  });
  test.each([false, true])("header bound level and wrapping survive link=%s", async (link) => {
    const { HeaderStatusBar } = await load(variant, "header-status");
    const bound = {
      budgetId: "cap",
      kind: "group",
      target: "project",
      unit: "requests",
      remaining: known("9"),
      of: known("10"),
      level: "warning",
      resetsAt: null,
      warningAt: null,
    };
    render(
      createElement(HeaderStatusBar!, {
        status: { state: "ready", level: "exceeded", hidden: 0, bounds: [bound] },
        formatBound: () => "Localized cap",
        ...(link
          ? {
              boundHref: () => "/usage",
              renderLink: (props: Record<string, unknown>) => createElement("a", props),
            }
          : {}),
      }),
    );
    const pill = screen.getByLabelText(/Localized cap:/);
    expect(pill.getAttribute("data-level")).toBe("warning");
    expect(pill.querySelector("span.break-words.min-w-0")).toBeTruthy();
  });
  test("explicit allocation probe evaluates new eligibility", async () => {
    const { ProviderAllocationEditor } = await load(variant, "provider-allocation-editor");
    const row = { ...initialAllocations[0]!, available: undefined };
    const answer = { ...initialAllocations[0]! };
    mount(
      createElement(ProviderAllocationEditor!, {
        rows: [row],
        revision: "1",
        suggestionEligible: (value: { available?: unknown }) => !!value.available,
        onRefreshBalance: async () => answer,
      }),
    );
    const suggestion = screen.getByRole("button", {
      name: "Use available balance",
    }) as HTMLButtonElement;
    expect(suggestion.disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Refresh balance" }));
    await waitFor(() => expect(suggestion.disabled).toBe(false));
    fireEvent.click(suggestion);
    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("9007199254741008.125");
  });
  test("API exact formatting reaches measurement children", async () => {
    const { MeasurementCard } = await load(variant, "measurement-card");
    render(
      createElement(MeasurementCard!, {
        title: "Exact",
        value: known(),
        formatFigure: (v: { text: string }) => `exact:${v.text}`,
        formatUnit: () => "requêtes",
      }),
    );
    expect(screen.getByText("exact:9007199254740993.125")).toBeTruthy();
    expect(screen.getByText("requêtes")).toBeTruthy();
  });
  test("API summaries select funding measurements and propagate formatters", async () => {
    const { UsageSummaryCards } = await load(variant, "usage-summary-cards");
    render(
      createElement(UsageSummaryCards!, {
        view: summary(),
        fundingSource: "platform",
        formatFigure: (v: { text: string }) => `exact:${v.text}`,
        formatUnit: () => "crédits",
      }),
    );
    expect(screen.getByText("exact:123")).toBeTruthy();
    expect(screen.getAllByText("crédits")).toHaveLength(2);
    expect(screen.queryByText("9007199254740993.125")).toBeNull();
  });
  test("API cost owner omission and funding-specific cost visibility", async () => {
    const { CostSummaryCard } = await load(variant, "cost-summary-card");
    render(
      createElement(CostSummaryCard!, {
        view: summary(),
        fundingSource: "byok",
        showCostOwner: false,
        formatFigure: (v: { text: string }) => `cost:${v.text}`,
      }),
    );
    expect(screen.getByText("cost:11")).toBeTruthy();
    expect(screen.queryByText(/private-owner|private-host/)).toBeNull();
    cleanup();
    render(createElement(CostSummaryCard!, { view: summary(), showCost: false }));
    expect(screen.queryByText("22")).toBeNull();
  });
  test("API plain summaries retain metadata and details", async () => {
    const { UsageSummaryCards } = await load(variant, "usage-summary-cards");
    const { CostSummaryCard } = await load(variant, "cost-summary-card");
    for (const Block of [UsageSummaryCards, CostSummaryCard]) {
      const r = render(
        createElement(Block!, {
          view: summary(),
          variant: "plain",
          metadata: createElement("p", {}, "As of today"),
          details: createElement("p", {}, "Unresolved exposure"),
        }),
      );
      expect(screen.getByText("As of today")).toBeTruthy();
      expect(screen.getByText("Unresolved exposure")).toBeTruthy();
      expect(r.container.querySelector('[data-slot="card"]')).toBeNull();
      cleanup();
    }
  });
  test("API usage dimension, unit and funding presentation", async () => {
    const { UsageTable } = await load(variant, "usage-table");
    render(
      createElement(UsageTable!, {
        view: {
          state: "ready",
          groupBy: ["provider"],
          units: ["requests"],
          rows: [
            {
              key: "r",
              dimensions: { provider: "search" },
              units: { requests: known() },
              fundingSource: "platform",
              cost: "unavailable",
              certainty: "measured",
              unknownOperations: "0",
            },
          ],
          nextCursor: null,
        },
        formatDimension: (d: string, v: string) => `${d}:${v}:local`,
        formatUnit: () => "requêtes",
        formatFigure: (v: { text: string }) => `exact:${v.text}`,
        formatFunding: () => "Hosted credits",
        showFunding: true,
      }),
    );
    expect(screen.getByText("provider:search:local")).toBeTruthy();
    expect(screen.getByText("Hosted credits")).toBeTruthy();
    expect(screen.getByText(/exact:9007199254740993.125/)).toBeTruthy();
  });
  test.each([
    ["by default", undefined, true],
    ["when enabled", true, true],
    ["when hidden", false, false],
  ] as const)("API exception principal column %s", async (_, showPrincipal, visible) => {
    const { ExceptionsList } = await load(variant, "exceptions-list");
    const props = showPrincipal === undefined ? {} : { showPrincipal };
    const r = render(
      createElement(ExceptionsList!, {
        ...props,
        view: {
          state: "ok",
          rows: [
            {
              operationId: "exception-op",
              principal: "exception-owner",
              provider: "search",
              operation: "query",
              state: "pending",
              kind: "pending",
              ageSeconds: 2,
            },
          ],
          nextCursor: null,
        },
      }),
    );
    const table = within(screen.getByRole("table", { name: "Needs attention" }));
    const headers = [
      "Operation",
      "Provider",
      ...(visible ? ["Principal"] : []),
      "Exception",
      "State",
      "Age",
    ];
    expect(table.getAllByRole("columnheader").map((header) => header.textContent)).toEqual(headers);
    expect(table.getAllByRole("cell").map((cell) => cell.textContent)).toEqual([
      "exception-op",
      "search query",
      ...(visible ? ["exception-owner"] : []),
      "Pending evidence",
      "pending",
      "2 s",
    ]);
    r.rerender(
      createElement(ExceptionsList!, {
        ...props,
        view: { state: "empty", rows: [], nextCursor: null },
      }),
    );
    expect(table.getAllByRole("columnheader").map((header) => header.textContent)).toEqual(headers);
    expect(table.getAllByRole("cell")).toHaveLength(1);
    expect(
      table.getByRole("cell", { name: "No exceptions in this period." }).getAttribute("colspan"),
    ).toBe(String(headers.length));
  });
  test("API exception pagination works across an empty page and respects busy", async () => {
    const { ExceptionsList } = await load(variant, "exceptions-list");
    const next = vi.fn();
    const first = vi.fn();
    const props = {
      view: { state: "empty", rows: [], nextCursor: "next", asOf: null },
      onNextPage: next,
      onFirstPage: first,
    };
    const r = render(createElement(ExceptionsList!, { ...props, busy: true }));
    expect((screen.getByRole("button", { name: "Next page" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    r.rerender(createElement(ExceptionsList!, props));
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    fireEvent.click(screen.getByRole("button", { name: "First page" }));
    expect(next).toHaveBeenCalledWith("next");
    expect(first).toHaveBeenCalledTimes(1);
  });
  test("API exception lifecycle and identity callbacks", async () => {
    const { ExceptionsList } = await load(variant, "exceptions-list");
    render(
      createElement(ExceptionsList!, {
        view: {
          state: "ready",
          rows: [
            {
              operationId: "o",
              principal: "p",
              provider: "search",
              operation: "query",
              state: "pending",
              kind: "pending",
              ageSeconds: 2,
            },
          ],
          nextCursor: null,
        },
        formatState: () => "En attente",
        formatProvider: () => "Recherche",
        formatOperation: () => "Requête",
        metadata: createElement("p", {}, "Snapshot now"),
      }),
    );
    expect(screen.getByText("En attente")).toBeTruthy();
    expect(screen.getByText("Recherche")).toBeTruthy();
    expect(screen.getByText("Requête")).toBeTruthy();
    expect(screen.getByText("Snapshot now")).toBeTruthy();
  });
  test("API header bound labels, exact figures, units and links", async () => {
    const { HeaderStatusBar } = await load(variant, "header-status");
    render(
      createElement(HeaderStatusBar!, {
        status: {
          state: "ready",
          level: "ok",
          hidden: 0,
          bounds: [
            {
              budgetId: "cap",
              kind: "group",
              target: "project",
              unit: "requests",
              remaining: known("9"),
              of: known("10"),
              level: "ok",
              resetsAt: null,
              warningAt: null,
            },
          ],
        },
        formatBound: () => "Project cap",
        formatFigure: (v: { text: string }) => `exact:${v.text}`,
        formatUnit: () => "requêtes",
        boundHref: () => "/usage",
        renderLink: (p: Record<string, unknown>) => createElement("a", p),
      }),
    );
    expect(screen.getByRole("link", { name: /Project cap/ }).getAttribute("href")).toBe("/usage");
    expect(screen.getByText(/exact:9.*exact:10.*requêtes/)).toBeTruthy();
  });
  test("API compact bound projection preserves exact remaining figures without number precision loss", async () => {
    const mod = await import(
      /* @vite-ignore */ pathToFileURL(
        join(hosts[variant], "components/usagekit/usage-cap-pill.tsx"),
      ).href
    );
    expect(typeof mod.usageCapFromBound).toBe("function");
    const p = mod.usageCapFromBound(
      {
        remaining: known("18014398509481985"),
        of: known("36028797018963968"),
        level: "ok",
        unit: "requests",
      },
      { label: "Project" },
    );
    expect(p.percent).toBe(49.99);
    expect(p.partial).toBe(false);
    expect(
      mod.usageCapFromBound({
        remaining: known("25"),
        of: known("100"),
        level: "ok",
        unit: "requests",
      }).percent,
    ).toBe(75);
  });
  test("API allocation structured validation and dollar/native input policy", async () => {
    const { ProviderAllocationEditor } = await load(variant, "provider-allocation-editor");
    const rows = [
      { ...initialAllocations[0], unit: "customer_cents", limit: known("1250", "customer_cents") },
    ];
    const r = mount(
      createElement(ProviderAllocationEditor!, {
        rows,
        revision: "1",
        inputPolicy: {
          denomination: "dollars",
          precision: 2,
          nativePrecision: 0,
          min: "1",
          max: "922337203685477",
        },
        formatValidation: (issue: { code: string }) => `localized:${issue.code}`,
      }),
    );
    const input = screen.getByRole("textbox") as HTMLInputElement;
    expect(input.value).toBe("12.50");
    fireEvent.change(input, { target: { value: "1.001" } });
    fireEvent.click(screen.getByRole("button", { name: "Save allocations" }));
    expect(await screen.findByText(/localized:precision/)).toBeTruthy();
    expect(r.demo.calls).toEqual([]);
    fireEvent.change(input, { target: { value: "15.25" } });
    fireEvent.click(screen.getByRole("button", { name: "Save allocations" }));
    await waitFor(() => expect(r.demo.calls).toHaveLength(1));
    expect(r.demo.calls[0]).toMatchObject({ changes: [{ limit: "1525" }] });
  });
  test("API per-row suggestion eligibility is independent of other evidence", async () => {
    const { ProviderAllocationEditor } = await load(variant, "provider-allocation-editor");
    mount(
      createElement(ProviderAllocationEditor!, {
        rows: initialAllocations,
        revision: "1",
        suggestionEligible: (row: { id: string }) => row.id === initialAllocations[0]!.id,
      }),
    );
    const button = within(screen.getByRole("region", { name: "Own key App" })).getByRole("button", {
      name: "Use available balance",
    });
    expect((button as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(button);
    expect((screen.getAllByRole("textbox")[0] as HTMLInputElement).value).toBe(
      "9007199254741008.125",
    );
  });
  test("API allocation refresh is explicit and suppresses late identity results", async () => {
    const { ProviderAllocationEditor } = await load(variant, "provider-allocation-editor");
    let resolveProbe!: (v: unknown) => void;
    const probe = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveProbe = resolve;
        }),
    );
    const props = {
      rows: [initialAllocations[0]],
      revision: "1",
      fresh: true,
      onRefreshBalance: probe,
    };
    const r = mount(createElement(ProviderAllocationEditor!, props));
    expect(probe).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Refresh balance" }));
    expect(probe).toHaveBeenCalledWith(initialAllocations[0]);
    expect(
      (screen.getByRole("button", { name: "Use available balance" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    r.rerender(
      r.wrap(
        createElement(ProviderAllocationEditor!, {
          ...props,
          revision: "2",
          rows: [{ ...initialAllocations[0], revision: "2", available: undefined }],
        }),
      ),
    );
    await act(async () => resolveProbe({ ...initialAllocations[0], available: known("999") }));
    expect(
      (screen.getByRole("button", { name: "Use available balance" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
  test("API allocation evidence slots use current evidence and plain composition", async () => {
    const { ProviderAllocationEditor } = await load(variant, "provider-allocation-editor");
    const r = mount(
      createElement(ProviderAllocationEditor!, {
        rows: [initialAllocations[0]],
        evidenceRows: [{ ...initialAllocations[0], label: "Current evidence" }],
        revision: "1",
        variant: "plain",
        renderEvidence: (row: { label: string } | null) =>
          createElement("p", {}, row?.label ?? "No current evidence"),
        help: createElement("p", {}, "Independent limits"),
        evidenceBefore: createElement("p", {}, "Wallet evidence"),
      }),
    );
    expect(screen.getByText("Current evidence")).toBeTruthy();
    expect(screen.getByText("Independent limits")).toBeTruthy();
    expect(screen.getByText("Wallet evidence")).toBeTruthy();
    expect(r.container.querySelector('[data-slot="card"]')).toBeNull();
  });
  test("API allocation completion fires only after definitive success", async () => {
    const { ProviderAllocationEditor } = await load(variant, "provider-allocation-editor");
    const saved = vi.fn();
    const r = mount(
      createElement(ProviderAllocationEditor!, {
        rows: initialAllocations,
        revision: "1",
        onSaved: saved,
      }),
    );
    fireEvent.change(screen.getAllByRole("textbox")[0]!, { target: { value: "123" } });
    fireEvent.click(screen.getByRole("button", { name: "Save allocations" }));
    await waitFor(() => expect(r.demo.calls).toHaveLength(1));
    await waitFor(() => expect(saved).toHaveBeenCalledTimes(1));
  });
  test("API allocation duplicate async form submits execute and complete once", async () => {
    const { ProviderAllocationEditor } = await load(variant, "provider-allocation-editor");
    const saved = vi.fn();
    const submits: Promise<void>[] = [];
    let value = "123";
    const r = mount(
      createElement(ProviderAllocationEditor!, {
        rows: [initialAllocations[0]!],
        revision: "1",
        onSaved: saved,
        formAdapter: {
          field: () => ({
            value,
            setValue: (next: string) => {
              value = next;
            },
          }),
          handleSubmit: (save: () => Promise<void>) => () => {
            // RHF-style async validation resumes both submissions from the same render.
            submits.push(Promise.resolve().then(save));
          },
        },
      }),
    );
    const original = r.demo.port.execute.bind(r.demo.port);
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const execute = vi.spyOn(r.demo.port, "execute").mockImplementation(async (...args) => {
      await gate;
      return original(...args);
    });
    const form = r.container.querySelector("form")!;
    act(() => {
      fireEvent.submit(form);
      fireEvent.submit(form);
    });
    await waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    expect(saved).not.toHaveBeenCalled();
    await act(async () => {
      finish();
      await Promise.all(submits);
    });
    expect(r.demo.calls).toHaveLength(1);
    expect(saved).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        outcome: "success",
        commandId: r.demo.calls[0]!.commandId,
      }),
    );
  });

  test.each(["click", "late validation"] as const)(
    "API allocation success fences %s until refreshed identity remounts",
    async (followup) => {
      const { ProviderAllocationEditor } = await load(variant, "provider-allocation-editor");
      const saved = vi.fn();
      const continuations: (() => Promise<void>)[] = [];
      const props = {
        rows: [initialAllocations[0]!],
        revision: "1",
        onSaved: saved,
        ...(followup === "late validation"
          ? {
              formAdapter: {
                field: () => ({ value: "123", setValue: () => {} }),
                handleSubmit: (save: () => Promise<void>) => () => {
                  continuations.push(save);
                },
              },
            }
          : {}),
      };
      const r = mount(createElement(ProviderAllocationEditor!, props));
      const execute = vi.spyOn(r.demo.port, "execute");
      const save = () =>
        screen.getByRole("button", { name: "Save allocations" }) as HTMLButtonElement;
      if (followup === "late validation") {
        fireEvent.submit(r.container.querySelector("form")!);
        fireEvent.submit(r.container.querySelector("form")!);
        await act(async () => continuations[0]!());
      } else {
        fireEvent.change(screen.getByRole("textbox"), { target: { value: "123" } });
        fireEvent.click(save());
      }
      await waitFor(() => expect(saved).toHaveBeenCalledTimes(1));
      // These props intentionally retain the old identity while the refreshed read is delayed.
      r.rerender(r.wrap(createElement(ProviderAllocationEditor!, props)));
      if (followup === "late validation") await act(async () => continuations[1]!());
      else fireEvent.click(save());
      expect(execute).toHaveBeenCalledTimes(1);
      expect(saved).toHaveBeenCalledTimes(1);
      expect(save().disabled).toBe(true);
      r.rerender(
        r.wrap(
          createElement(ProviderAllocationEditor!, {
            ...props,
            revision: "fresh-2",
            rows: [{ ...initialAllocations[0]!, revision: "fresh-2" }],
          }),
        ),
      );
      if (followup === "click")
        fireEvent.change(screen.getByRole("textbox"), { target: { value: "124" } });
      expect(save().disabled).toBe(false);
    },
  );

  test("API new credentials do not require an unsupported test and cannot reuse stored values", async () => {
    const { ProviderConnectForm } = await load(variant, "provider-connect-form");
    const connected = vi.fn();
    const connection = { ...initialConnections[0]!, capabilities: ["reconnect"] };
    const r = mount(
      createElement(ProviderConnectForm!, {
        provider: demoProviders[0],
        onConnected: connected,
        connection,
        requireNewCredentials: true,
        reuseStoredCredentials: true,
      }),
    );
    const save = screen.getByRole("button", { name: "Replace credentials" });
    expect((save as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(save);
    await screen.findByText("Enter the required credentials.");
    expect(r.demo.calls).toHaveLength(0);
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "replacement" } });
    fireEvent.click(save);
    await waitFor(() => expect(r.demo.calls).toHaveLength(1));
    expect(r.demo.calls[0]).toMatchObject({
      kind: "reconnect",
      expectedRevision: connection.revision,
    });
    await waitFor(() => expect(connected).toHaveBeenCalledTimes(1));
    expect(connected).toHaveBeenCalledWith(expect.objectContaining({ id: connection.id }));
  });

  test("API required credential test without capability explains the blocked save", async () => {
    const { ProviderConnectForm } = await load(variant, "provider-connect-form");
    const r = mount(
      createElement(ProviderConnectForm!, {
        provider: demoProviders[0],
        connection: { ...initialConnections[0]!, capabilities: ["reconnect"] },
        requireTest: true,
        labels: { testUnavailable: "Host requires a test this connection cannot run." },
        renderFooter: (p: { formId: string; canSave: boolean }) =>
          createElement(
            "button",
            {
              form: p.formId,
              type: "submit",
              disabled: !p.canSave,
            },
            "External save",
          ),
      }),
    );
    expect(screen.getByRole("alert").textContent).toBe(
      "Host requires a test this connection cannot run.",
    );
    expect(screen.queryByRole("button", { name: "Test credentials" })).toBeNull();
    expect(
      (screen.getByRole("button", { name: "External save" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.submit(r.container.querySelector("form")!);
    expect(r.demo.calls).toHaveLength(0);
  });

  test.each([false, true])(
    "API reconnect advances CAS from its own successful test (read updated: %s)",
    async (readUpdated) => {
      const { ProviderConnectForm } = await load(variant, "provider-connect-form");
      const connection = structuredClone(initialConnections[0]!);
      const connected = vi.fn();
      const props = {
        provider: demoProviders[0],
        connection,
        requireTest: true,
        onConnected: connected,
      };
      const r = mount(createElement(ProviderConnectForm!, props));
      const execute = vi
        .spyOn(r.demo.port, "execute")
        .mockImplementation(async (_binding, command, secrets) => {
          expect(secrets).toEqual({ key: "replacement" });
          return {
            outcome: "success",
            commandId: command.commandId,
            revision: "own-test-2",
            connection,
          };
        });
      fireEvent.change(screen.getByLabelText("API key"), { target: { value: "replacement" } });
      const save = () =>
        screen.getByRole("button", { name: "Replace credentials" }) as HTMLButtonElement;
      expect(save().disabled).toBe(true);
      fireEvent.click(screen.getByRole("button", { name: "Test credentials" }));
      await waitFor(() => expect(save().disabled).toBe(false));
      expect(execute.mock.calls[0]![1]).toMatchObject({
        kind: "test",
        expectedRevision: connection.revision,
      });
      if (readUpdated)
        r.rerender(
          r.wrap(
            createElement(ProviderConnectForm!, {
              ...props,
              connection: { ...connection, revision: "own-test-2" },
            }),
          ),
        );
      expect((screen.getByLabelText("API key") as HTMLInputElement).value).toBe("replacement");
      fireEvent.click(save());
      await waitFor(() => expect(connected).toHaveBeenCalledTimes(1));
      expect(execute.mock.calls[1]![1]).toMatchObject({
        kind: "reconnect",
        expectedRevision: "own-test-2",
      });
    },
  );

  test.each(["test", "reconnect"] as const)(
    "API credential %s retains its CAS base after an external revision update",
    async (kind) => {
      const { ProviderConnectForm } = await load(variant, "provider-connect-form");
      const connection = structuredClone(initialConnections[0]!);
      const connected = vi.fn();
      const props = {
        provider: demoProviders[0],
        connection,
        requireTest: true,
        onConnected: connected,
      };
      const r = mount(createElement(ProviderConnectForm!, props));
      const execute = vi
        .spyOn(r.demo.port, "execute")
        .mockImplementation(async (_binding, command) => {
          if (execute.mock.calls.length === 1 && kind === "reconnect")
            return { outcome: "success", commandId: command.commandId, revision: "own-test-2" };
          return "expectedRevision" in command && command.expectedRevision === "external-3"
            ? {
                outcome: "success",
                commandId: command.commandId,
                revision: "overwritten",
                connection,
              }
            : { outcome: "conflict", commandId: command.commandId, reason: "Changed elsewhere" };
        });
      fireEvent.change(screen.getByLabelText("API key"), { target: { value: "replacement" } });
      if (kind === "reconnect") {
        fireEvent.click(screen.getByRole("button", { name: "Test credentials" }));
        await waitFor(() =>
          expect(
            (screen.getByRole("button", { name: "Replace credentials" }) as HTMLButtonElement)
              .disabled,
          ).toBe(false),
        );
      }
      r.rerender(
        r.wrap(
          createElement(ProviderConnectForm!, {
            ...props,
            connection: { ...connection, revision: "external-3" },
          }),
        ),
      );
      expect((screen.getByLabelText("API key") as HTMLInputElement).value).toBe("replacement");
      fireEvent.click(
        screen.getByRole("button", {
          name: kind === "test" ? "Test credentials" : "Replace credentials",
        }),
      );
      await waitFor(() => expect(execute).toHaveBeenCalledTimes(kind === "test" ? 1 : 2));
      expect(execute.mock.calls.at(-1)![1]).toMatchObject({
        kind,
        expectedRevision: kind === "test" ? connection.revision : "own-test-2",
      });
      await screen.findAllByText(
        "This connection changed elsewhere. Reload its latest settings before editing.",
      );
      expect(connected).not.toHaveBeenCalled();
    },
  );

  test("API controlled versioned project chain saves one complete ordered set", async () => {
    const { ProviderChainEditor } = await load(variant, "provider-chain-editor");
    const commit = vi.fn(async (command: { commandId: string }) => ({
      outcome: "success",
      commandId: command.commandId,
    }));
    const snapshot = {
      identity: "project",
      revision: "v1",
      entries: [
        { id: "a", label: "Alpha", enabled: true, revision: "a1" },
        { id: "b", label: "Beta", enabled: true, revision: "b1" },
      ],
    };
    render(
      createElement(ProviderChainEditor!, {
        mode: "project",
        snapshot,
        evidence: snapshot,
        canEdit: true,
        onCommit: commit,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Move up: Beta" }));
    fireEvent.click(screen.getByRole("button", { name: "Save fallback order" }));
    await waitFor(() => expect(commit).toHaveBeenCalledTimes(1));
    expect(commit.mock.calls[0]![0]).toMatchObject({
      expectedRevision: "v1",
      entries: [
        { id: "b", enabled: true, expectedRevision: "b1" },
        { id: "a", enabled: true, expectedRevision: "a1" },
      ],
    });
    expect(screen.queryByText(/Add to fallback|Remove from fallback/)).toBeNull();
  });
  test("API provider card slots and controlled actions", async () => {
    const { ProviderCard } = await load(variant, "provider-card");
    const onTest = vi.fn();
    mount(
      createElement(ProviderCard!, {
        connection: initialConnections[0],
        onTest,
        identity: createElement("p", {}, "Logo"),
        body: createElement("p", {}, "Native evidence"),
        source: createElement("p", {}, "Source choice"),
        actions: createElement("p", {}, "Host actions"),
      }),
    );
    expect(screen.getByText("Logo")).toBeTruthy();
    expect(screen.getByText("Native evidence")).toBeTruthy();
    expect(screen.getByText("Source choice")).toBeTruthy();
    expect(screen.getByText("Host actions")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Test stored credentials" }));
    expect(onTest).toHaveBeenCalledTimes(1);
  });
  test("API controlled source choices and transition confirmation", async () => {
    const { ProviderSourceSelector } = await load(variant, "provider-source-selector");
    const select = vi.fn(async () => {});
    const props = {
      mode: "controlled",
      value: "byok",
      choices: [
        { source: "byok" },
        { source: "platform", disabled: true, description: "Not available" },
      ],
      onSelect: select,
      confirmTransition: () => null,
      variant: "plain",
    };
    const r = render(createElement(ProviderSourceSelector!, props));
    expect(select).not.toHaveBeenCalled();
    expect(
      (screen.getByRole("button", { name: "Platform funded" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    r.rerender(
      createElement(ProviderSourceSelector!, {
        ...props,
        choices: [{ source: "byok" }, { source: "platform" }],
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Platform funded" }));
    await waitFor(() => expect(select).toHaveBeenCalledWith("platform"));
    expect(screen.queryByText("Confirm funding change")).toBeNull();
  });
  test("API tested credentials, external footer and form-free OAuth", async () => {
    const { ProviderConnectForm } = await load(variant, "provider-connect-form");
    const r = mount(
      createElement(ProviderConnectForm!, {
        provider: demoProviders[0],
        requireTest: true,
        formId: "host-form",
        oauth: createElement("form", { "aria-label": "OAuth host" }),
        renderFooter: (p: { formId: string; canSave: boolean }) =>
          createElement(
            "button",
            { form: p.formId, type: "submit", disabled: !p.canSave },
            "External save",
          ),
        renderTestFeedback: () => createElement("p", {}, "Structured test"),
      }),
    );
    expect(
      screen.getByRole("form", { name: "OAuth host" }).parentElement?.closest("form"),
    ).toBeNull();
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "key" } });
    expect(
      (screen.getByRole("button", { name: "External save" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Test credentials" }));
    await screen.findByText("Structured test");
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "External save" }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "changed" } });
    expect(
      (screen.getByRole("button", { name: "External save" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(r.demo.calls).toHaveLength(1);
  });
  test("API manager propagates child labels and slots", async () => {
    const { ProviderManagerPanel } = await load(variant, "provider-manager-panel");
    mount(
      createElement(ProviderManagerPanel!, {
        childProps: {
          card: {
            labels: { manage: "Configure host" },
            body: createElement("p", {}, "Host card body"),
          },
          rate: { labels: { title: "Localized rates" } },
        },
      }),
    );
    const manage = (await screen.findAllByRole("button", { name: "Configure host" }))[0]!;
    expect(screen.getAllByText("Host card body").length).toBeGreaterThan(0);
    fireEvent.click(manage);
    expect(await screen.findByText("Localized rates")).toBeTruthy();
  });
  test("API platform rates are a read-only credits price list without provenance or fallback", async () => {
    const { ProviderRateEditor } = await load(variant, "provider-rate-editor");
    const connection = structuredClone(initialConnections[0]!);
    connection.rates = connection.rates.map((r) => ({
      ...r,
      fundingSource: "platform",
      editable: true,
      priceUnit: "customer_cents",
      price: known("123.4500", "customer_cents"),
    }));
    mount(
      createElement(ProviderRateEditor!, {
        connection,
        labels: { platformNote: "Host determines credit prices." },
      }),
    );
    expect(screen.getByText("Credits prices")).toBeTruthy();
    expect(screen.getAllByText("Host determines credit prices.")).toHaveLength(1);
    expect(screen.getByText(/\$1.2345/)).toBeTruthy();
    expect(screen.queryByText(/customer_cents/)).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
    for (const text of [
      "Your rate",
      "Measured",
      "List price",
      "Without your rate",
      "Save rate",
      "Clear your rate",
    ])
      expect(screen.queryByText(text)).toBeNull();
  });
});

describe.each(variants)("%s block API recovery policies", (variant) => {
  const own = (node: ReactNode) => {
    const demo = createDemoProviderPort(`policy:${crypto.randomUUID()}`);
    const wrap = (child: ReactNode) =>
      createElement(ProviderManagementProvider, { port: demo.port, binding: demo.binding }, child);
    return { ...render(wrap(node)), demo, wrap };
  };
  test("project server renders never retain another request's snapshot", async () => {
    const module = await import(
      /* @vite-ignore */ pathToFileURL(
        join(hosts[variant], "components/usagekit/provider-project-chain.tsx"),
      ).href
    );
    const snapshot = {
      identity: crypto.randomUUID(),
      revision: "v1",
      entries: [{ id: "a", label: "Request A", enabled: true, revision: "a1" }],
    };
    const Shell = ({ snapshot }: { snapshot: unknown }) => {
      const state = module.useProjectChainController({
        snapshot,
        evidence: snapshot,
        canEdit: true,
        onCommit: vi.fn(),
      });
      return createElement("p", {}, state.draft[0].label);
    };
    vi.stubGlobal("window", undefined);
    try {
      expect(renderToString(createElement(Shell, { snapshot }))).toContain("Request A");
      expect(
        renderToString(
          createElement(Shell, {
            snapshot: { ...snapshot, entries: [{ ...snapshot.entries[0], label: "Request B" }] },
          }),
        ),
      ).toContain("Request B");
    } finally {
      vi.unstubAllGlobals();
    }
  });
  test.each(["snapshot", "entry"])(
    "project fresh %s revision rebases after success and remount",
    async (revisionKind) => {
      const { ProviderChainEditor } = await load(variant, "provider-chain-editor");
      const snapshot = {
        identity: crypto.randomUUID(),
        revision: "v1",
        entries: [
          { id: "a", label: "Alpha", enabled: true, revision: "a1" },
          { id: "b", label: "Beta", enabled: true, revision: "b1" },
        ],
      };
      const props = {
        mode: "project",
        snapshot,
        evidence: snapshot,
        canEdit: true,
        onCommit: async (command: { commandId: string }) => ({
          commandId: command.commandId,
          outcome: "success",
        }),
      };
      const r = render(createElement(ProviderChainEditor!, props));
      fireEvent.click(screen.getByRole("button", { name: "Move up: Beta" }));
      fireEvent.click(screen.getByRole("button", { name: "Save fallback order" }));
      await screen.findByText("Change applied.");
      const next = {
        ...snapshot,
        revision: revisionKind === "snapshot" ? "v2" : "v1",
        entries: snapshot.entries.map((row) => ({
          ...row,
          revision: revisionKind === "entry" ? row.revision + "next" : row.revision,
        })),
      };
      const node = createElement(ProviderChainEditor!, {
        ...props,
        snapshot: next,
        evidence: next,
      });
      r.rerender(node);
      expect(
        (screen.getByRole("button", { name: "Move up: Beta" }) as HTMLButtonElement).disabled,
      ).toBe(false);
      expect(screen.getAllByRole("listitem")[0]!.textContent).toContain("Alpha");
      expect(screen.queryByText("Change applied.")).toBeNull();
      r.unmount();
      render(node);
      expect(
        (screen.getByRole("button", { name: "Move up: Beta" }) as HTMLButtonElement).disabled,
      ).toBe(false);
    },
  );
  test("project count includes enabled entries only", async () => {
    const { ProviderChainEditor } = await load(variant, "provider-chain-editor");
    const snapshot = {
      identity: crypto.randomUUID(),
      revision: "v1",
      entries: [
        { id: "a", label: "Alpha", enabled: true, revision: "a1" },
        { id: "b", label: "Beta", enabled: false, revision: "b1" },
      ],
    };
    render(
      createElement(ProviderChainEditor!, {
        mode: "project",
        snapshot,
        evidence: snapshot,
        canEdit: true,
        onCommit: vi.fn(),
        formatCount: (count: number) => `${count} active`,
      }),
    );
    expect(screen.getByText("1 active")).toBeTruthy();
  });
  test.each(["submit event", "requestSubmit"])(
    "credential form ignores duplicate %s calls before the connection resolves",
    async (submission) => {
      const { ProviderConnectForm } = await load(variant, "provider-connect-form");
      const connected = vi.fn();
      const r = own(
        createElement(ProviderConnectForm!, { provider: demoProviders[0], onConnected: connected }),
      );
      const execute = r.demo.port.execute.bind(r.demo.port);
      let release!: () => void;
      const deferred = new Promise<void>((resolve) => {
        release = resolve;
      });
      const portCall = vi.spyOn(r.demo.port, "execute").mockImplementation(async (...args) => {
        await deferred;
        return execute(...args);
      });
      fireEvent.change(screen.getByLabelText("API key"), { target: { value: "ephemeral" } });
      const form = screen.getByRole("form", {
        name: `${demoProviders[0]!.label} credentials`,
      }) as HTMLFormElement;
      await act(async () => {
        if (submission === "requestSubmit") {
          form.requestSubmit();
          form.requestSubmit();
        } else {
          fireEvent.submit(form);
          fireEvent.submit(form);
        }
      });
      expect(portCall).toHaveBeenCalledTimes(1);
      expect(connected).not.toHaveBeenCalled();
      await act(async () => release());
      expect(r.demo.calls).toHaveLength(1);
      const result = await portCall.mock.results[0]!.value;
      expect(result.outcome).toBe("success");
      expect(connected).toHaveBeenCalledTimes(1);
      if (result.outcome !== "success") throw new Error("Expected a successful credential command");
      expect(connected).toHaveBeenCalledWith(result.connection);
    },
  );
  test("credential tests ignore repeated clicks without fabricating feedback", async () => {
    const { ProviderConnectForm } = await load(variant, "provider-connect-form");
    const feedback = vi.fn((_result: ProviderActionResult) => null);
    const r = own(
      createElement(ProviderConnectForm!, {
        provider: demoProviders[0],
        renderTestFeedback: feedback,
      }),
    );
    const execute = r.demo.port.execute.bind(r.demo.port);
    let release!: () => void;
    const deferred = new Promise<void>((resolve) => {
      release = resolve;
    });
    const portCall = vi.spyOn(r.demo.port, "execute").mockImplementation(async (...args) => {
      await deferred;
      return execute(...args);
    });
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "ephemeral" } });
    const button = screen.getByRole("button", { name: "Test credentials" });
    await act(async () => {
      fireEvent.click(button);
      fireEvent.click(button);
    });
    expect(portCall).toHaveBeenCalledTimes(1);
    expect(feedback).not.toHaveBeenCalled();
    await act(async () => release());
    expect(r.demo.calls).toHaveLength(1);
    const result = await portCall.mock.results[0]!.value;
    expect(result.outcome).toBe("success");
    expect(feedback).toHaveBeenCalled();
    for (const [rendered] of feedback.mock.calls) {
      expect(rendered).toEqual({ ...result, message: "Provider command completed" });
    }
  });
  test("pending credential saves ignore disconnect confirmation before rendering", async () => {
    const { ProviderConnectForm } = await load(variant, "provider-connect-form");
    const connected = vi.fn();
    const r = own(
      createElement(ProviderConnectForm!, {
        provider: demoProviders[0],
        connection: initialConnections[0],
        onConnected: connected,
      }),
    );
    const execute = r.demo.port.execute.bind(r.demo.port);
    let release!: () => void;
    const deferred = new Promise<void>((resolve) => {
      release = resolve;
    });
    const portCall = vi.spyOn(r.demo.port, "execute").mockImplementation(async (...args) => {
      await deferred;
      return execute(...args);
    });
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "ephemeral" } });
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    const confirm = screen.getByRole("button", { name: "Confirm disconnect" });
    const form = screen.getByRole("form", { name: `${demoProviders[0]!.label} credentials` });
    await act(async () => {
      fireEvent.submit(form);
      fireEvent.click(confirm);
    });
    expect(portCall).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Disconnect this connection?")).toBeTruthy();
    await act(async () => release());
    expect(r.demo.calls).toHaveLength(1);
    const result = await portCall.mock.results[0]!.value;
    expect(result.outcome).toBe("success");
    expect(connected).toHaveBeenCalledTimes(1);
    if (result.outcome !== "success") throw new Error("Expected a successful credential command");
    expect(connected).toHaveBeenCalledWith(result.connection);
  });
  test("credential reconciliation ignores repeated clicks while its status read is pending", async () => {
    const { ProviderConnectForm } = await load(variant, "provider-connect-form");
    const pending = vi.fn();
    const blocked = vi.fn();
    const r = own(
      createElement(ProviderConnectForm!, {
        provider: demoProviders[0],
        onPendingChange: pending,
        onDismissalBlockedChange: blocked,
      }),
    );
    r.demo.setNextOutcome("unknown");
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "ephemeral" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    const button = await screen.findByRole("button", { name: "Check change status" });
    pending.mockClear();
    blocked.mockClear();
    const reconcile = r.demo.port.reconcile!.bind(r.demo.port);
    let release!: () => void;
    const deferred = new Promise<void>((resolve) => {
      release = resolve;
    });
    const portCall = vi.spyOn(r.demo.port, "reconcile").mockImplementation(async (...args) => {
      await deferred;
      return reconcile(...args);
    });
    await act(async () => {
      fireEvent.click(button);
      fireEvent.click(button);
    });
    expect(portCall).toHaveBeenCalledTimes(1);
    expect(pending.mock.calls).toEqual([[true]]);
    expect(blocked.mock.calls).toEqual([[true]]);
    await act(async () => release());
    expect(portCall).toHaveBeenCalledTimes(1);
    expect(pending.mock.calls).toEqual([[true], [false]]);
    expect(blocked.mock.calls).toEqual([[true], [false]]);
  });
  test("credentials report pending dismissal blocking then release", async () => {
    const { ProviderConnectForm } = await load(variant, "provider-connect-form");
    let settle!: (result: unknown) => void;
    let commandId = "";
    const blocked = vi.fn(),
      pending = vi.fn();
    const action = {
      canWrite: true,
      pending: false,
      ambiguous: false,
      state: "idle",
      result: null,
      submittedCommand: null,
      run: vi.fn((command: { commandId: string }) => {
        commandId = command.commandId;
        return new Promise((resolve) => {
          settle = resolve;
        });
      }),
      reconcile: vi.fn(),
      reset: vi.fn(),
    };
    own(
      createElement(ProviderConnectForm!, {
        provider: demoProviders[0],
        action,
        onDismissalBlockedChange: blocked,
        onPendingChange: pending,
      }),
    );
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "ephemeral" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(blocked).toHaveBeenLastCalledWith(true);
    expect(pending).toHaveBeenLastCalledWith(true);
    await act(async () =>
      settle({ commandId, outcome: "success", connection: initialConnections[0] }),
    );
    expect(blocked).toHaveBeenLastCalledWith(false);
    expect(pending).toHaveBeenLastCalledWith(false);
  });
  test("allocation reconciliation reports this editor's command exactly once", async () => {
    const { ProviderAllocationEditor } = await load(variant, "provider-allocation-editor");
    const saved = vi.fn();
    const r = own(
      createElement(ProviderAllocationEditor!, {
        rows: initialAllocations,
        revision: "1",
        onSaved: saved,
      }),
    );
    vi.spyOn(r.demo.port, "reconcile").mockImplementation(async (_binding, command) => ({
      outcome: "success",
      commandId: command.commandId,
      revision: "2",
    }));
    r.demo.setNextOutcome("unknown");
    fireEvent.change(screen.getAllByRole("textbox")[0]!, { target: { value: "123" } });
    fireEvent.click(screen.getByRole("button", { name: "Save allocations" }));
    await screen.findByRole("button", { name: "Check change status" });
    expect(saved).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Check change status" }));
    await waitFor(() => expect(saved).toHaveBeenCalledTimes(1));
    r.rerender(
      r.wrap(
        createElement(ProviderAllocationEditor!, {
          rows: initialAllocations,
          revision: "1",
          onSaved: saved,
        }),
      ),
    );
    expect(saved).toHaveBeenCalledTimes(1);
  });
  test("project explicit reload keeps its fresh base with unchanged parent props", async () => {
    const { ProviderChainEditor } = await load(variant, "provider-chain-editor");
    const snapshot = {
      identity: crypto.randomUUID(),
      revision: "v1",
      entries: [
        { id: "a", label: "Alpha", enabled: true, revision: "a1" },
        { id: "b", label: "Beta", enabled: true, revision: "b1" },
      ],
    };
    const fresh = {
      ...snapshot,
      revision: "v2",
      entries: [...snapshot.entries]
        .reverse()
        .map((row) => ({ ...row, revision: row.revision + "next" })),
    };
    const commit = vi.fn(async (command: { commandId: string }) => ({
      commandId: command.commandId,
      outcome: "success",
    }));
    render(
      createElement(ProviderChainEditor!, {
        mode: "project",
        snapshot,
        evidence: snapshot,
        canEdit: true,
        onCommit: commit,
        onReload: async () => fresh,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Reload order" }));
    await waitFor(() => expect(screen.getAllByRole("listitem")[0]!.textContent).toContain("Beta"));
    fireEvent.click(screen.getByRole("button", { name: "Move up: Alpha" }));
    fireEvent.click(screen.getByRole("button", { name: "Save fallback order" }));
    await waitFor(() => expect(commit).toHaveBeenCalledTimes(1));
    expect(commit.mock.calls[0]![0]).toMatchObject({ expectedRevision: "v2" });
  });
  test("late project completion cannot close a remounted editor", async () => {
    const { ProviderChainEditor } = await load(variant, "provider-chain-editor");
    const snapshot = {
      identity: crypto.randomUUID(),
      revision: "v1",
      entries: [
        { id: "a", label: "Alpha", enabled: true, revision: "a1" },
        { id: "b", label: "Beta", enabled: true, revision: "b1" },
      ],
    };
    let settle!: () => void;
    const oldSaved = vi.fn(),
      newSaved = vi.fn();
    const props = {
      mode: "project",
      snapshot,
      evidence: snapshot,
      canEdit: true,
      onCommit: (command: { commandId: string }) =>
        new Promise((resolve) => {
          settle = () => resolve({ commandId: command.commandId, outcome: "success" });
        }),
    };
    const r = render(createElement(ProviderChainEditor!, { ...props, onSaved: oldSaved }));
    fireEvent.click(screen.getByRole("button", { name: "Move up: Beta" }));
    fireEvent.click(screen.getByRole("button", { name: "Save fallback order" }));
    r.unmount();
    render(createElement(ProviderChainEditor!, { ...props, onSaved: newSaved }));
    await act(async () => settle());
    expect(oldSaved).not.toHaveBeenCalled();
    expect(newSaved).not.toHaveBeenCalled();
    expect(screen.getByText("Change applied.")).toBeTruthy();
  });
  test("credential disconnect and reconciliation keep dismissal fenced through ambiguity", async () => {
    const { ProviderConnectForm } = await load(variant, "provider-connect-form");
    const blocked = vi.fn(),
      pending = vi.fn();
    const r = own(
      createElement(ProviderConnectForm!, {
        provider: demoProviders[0],
        connection: initialConnections[0],
        onDismissalBlockedChange: blocked,
        onPendingChange: pending,
      }),
    );
    r.demo.setNextOutcome("unknown");
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm disconnect" }));
    expect(blocked).toHaveBeenLastCalledWith(true);
    await screen.findByRole("button", { name: "Check change status" });
    expect(blocked).toHaveBeenLastCalledWith(true);
    expect(pending).toHaveBeenLastCalledWith(false);
    fireEvent.click(screen.getByRole("button", { name: "Check change status" }));
    expect(pending).toHaveBeenLastCalledWith(true);
    await waitFor(() => expect(blocked).toHaveBeenLastCalledWith(false));
    expect(pending).toHaveBeenLastCalledWith(false);
  });
  test("a newly mounted allocation editor does not report another editor's successful command", async () => {
    const { ProviderAllocationEditor } = await load(variant, "provider-allocation-editor");
    const saved = vi.fn();
    const r = own(
      createElement(ProviderAllocationEditor!, { rows: initialAllocations, revision: "1" }),
    );
    fireEvent.change(screen.getAllByRole("textbox")[0]!, { target: { value: "123" } });
    fireEvent.click(screen.getByRole("button", { name: "Save allocations" }));
    await waitFor(() => expect(r.demo.calls).toHaveLength(1));
    await screen.findByText("Local change applied.");
    r.rerender(
      r.wrap(
        createElement(ProviderAllocationEditor!, {
          rows: initialAllocations,
          revision: "2",
          onSaved: saved,
        }),
      ),
    );
    expect(saved).not.toHaveBeenCalled();
  });
  test("balance probe failure hides old availability from evidence slots", async () => {
    const { ProviderAllocationEditor } = await load(variant, "provider-allocation-editor");
    const probe = vi.fn(async () => {
      throw new Error("offline");
    });
    own(
      createElement(ProviderAllocationEditor!, {
        rows: [initialAllocations[0]],
        revision: "1",
        fresh: true,
        onRefreshBalance: probe,
        renderEvidence: (row: { available?: { text: string } } | null) =>
          createElement(
            "p",
            {},
            row?.available ? `Probe evidence:${row.available.text}` : "No probe evidence",
          ),
      }),
    );
    expect(screen.getByText(/Probe evidence:/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Refresh balance" }));
    await screen.findByText("Balance refresh is unavailable.");
    expect(screen.queryByText(/Probe evidence:/)).toBeNull();
    expect(screen.getByText("No probe evidence")).toBeTruthy();
  });
  test("project chain preserves original ambiguous command across remount and reconciles once", async () => {
    const { ProviderChainEditor } = await load(variant, "provider-chain-editor");
    const snapshot = {
      identity: crypto.randomUUID(),
      revision: "v1",
      entries: [
        { id: "a", label: "Alpha", enabled: true, revision: "a1" },
        { id: "b", label: "Beta", enabled: true, revision: "b1" },
      ],
    };
    const commit = vi.fn(async (command: { commandId: string }) => ({
      outcome: "unavailable",
      ambiguous: true,
      commandId: command.commandId,
    }));
    const reconcile = vi.fn(async (command: { commandId: string }) => ({
      outcome: "success",
      commandId: command.commandId,
    }));
    const reload = vi.fn(async () => snapshot);
    const props = {
      mode: "project",
      snapshot,
      evidence: snapshot,
      canEdit: true,
      onCommit: commit,
      onReconcile: reconcile,
      onReload: reload,
    };
    const r = render(createElement(ProviderChainEditor!, props));
    fireEvent.click(screen.getByRole("button", { name: "Move up: Beta" }));
    fireEvent.click(screen.getByRole("button", { name: "Save fallback order" }));
    await screen.findByRole("button", { name: "Check change status" });
    r.unmount();
    render(createElement(ProviderChainEditor!, props));
    expect(
      (screen.getByRole("button", { name: "Reload order" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Check change status" }));
    await waitFor(() => expect(reconcile).toHaveBeenCalledTimes(1));
    expect(reconcile.mock.calls[0]![0]).toEqual(commit.mock.calls[0]![0]);
    expect(commit).toHaveBeenCalledTimes(1);
  });
  test("project chain never resubmits obsolete revisions after success", async () => {
    const { ProviderChainEditor } = await load(variant, "provider-chain-editor");
    const snapshot = {
      identity: crypto.randomUUID(),
      revision: "v1",
      entries: [
        { id: "a", label: "Alpha", enabled: true, revision: "a1" },
        { id: "b", label: "Beta", enabled: true, revision: "b1" },
      ],
    };
    const commit = vi.fn(async (command: { commandId: string }) => ({
      outcome: "success",
      commandId: command.commandId,
    }));
    render(
      createElement(ProviderChainEditor!, {
        mode: "project",
        snapshot,
        evidence: snapshot,
        canEdit: true,
        onCommit: commit,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Move up: Beta" }));
    fireEvent.click(screen.getByRole("button", { name: "Save fallback order" }));
    await screen.findByText("Change applied.");
    expect(
      (screen.getByRole("button", { name: "Move down: Beta" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
  test("controlled source confirmation awaits host success and reports failure", async () => {
    const { ProviderSourceSelector } = await load(variant, "provider-source-selector");
    const select = vi.fn(async () => {
      throw new Error("private error");
    });
    render(
      createElement(ProviderSourceSelector!, {
        mode: "controlled",
        value: "byok",
        choices: [{ source: "byok" }, { source: "platform" }],
        onSelect: select,
        confirmTransition: () => createElement("p", {}, "Delete stored key?"),
        feedbackLabels: { unavailable: "Localized failure" },
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Platform funded" }));
    expect(select).not.toHaveBeenCalled();
    expect(screen.getByText("Delete stored key?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Confirm funding change" }));
    await screen.findByText("Localized failure");
    expect(screen.getByText("Current: Own key")).toBeTruthy();
    expect(screen.queryByText("private error")).toBeNull();
  });
  test("blank stored credentials are reused only when host policy permits", async () => {
    const { ProviderConnectForm } = await load(variant, "provider-connect-form");
    const r = own(
      createElement(ProviderConnectForm!, {
        provider: demoProviders[0],
        connection: initialConnections[0],
        reuseStoredCredentials: true,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Replace credentials" }));
    await waitFor(() => expect(r.demo.calls).toHaveLength(1));
    expect(r.demo.calls[0]).toMatchObject({ kind: "reconnect" });
  });
  test("host read-only credential policy fences external footer submission", async () => {
    const { ProviderConnectForm } = await load(variant, "provider-connect-form");
    const r = own(
      createElement(ProviderConnectForm!, {
        provider: demoProviders[0],
        readOnlyCredentials: true,
        renderFooter: (p: { formId: string }) =>
          createElement("button", { form: p.formId, type: "submit" }, "Host submit"),
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Host submit" }));
    expect(r.demo.calls).toEqual([]);
  });
});

describe.each(variants)("%s block API metadata and bounds", (variant) => {
  test("summary date formatting and disclosure slots survive incomplete evidence", async () => {
    const { UsageSummaryCards } = await load(variant, "usage-summary-cards");
    const { CostSummaryCard } = await load(variant, "cost-summary-card");
    const view = {
      state: "ok",
      complete: false,
      measurements: {},
      cost: "unavailable",
      funding: [],
      asOf: "2026-10-01T00:00:00Z",
      unknownOperations: null,
    };
    for (const Block of [UsageSummaryCards, CostSummaryCard]) {
      render(
        createElement(Block!, {
          view,
          formatTime: () => "1 octobre",
          details: createElement("p", {}, "Retained exposure"),
        }),
      );
      expect(screen.getByText(/1 octobre/)).toBeTruthy();
      expect(screen.getByText("Retained exposure")).toBeTruthy();
      cleanup();
    }
  });
  test("compact budget overflow preserves the percentage and renders a capped fill with a notch", async () => {
    const mod = await import(
      /* @vite-ignore */ pathToFileURL(
        join(hosts[variant], "components/usagekit/usage-cap-pill.tsx"),
      ).href
    );
    const known = (text: string) => ({ text, unit: "requests", certainty: "measured" });
    const props = mod.usageCapFromBudget({
      id: "cap",
      kind: "group",
      target: "project",
      unit: "requests",
      used: known("9007199254740993"),
      reserved: known("9007199254740993"),
      limit: known("9007199254740993"),
      remaining: known("0"),
      boundary: { onExceed: "block", hardLimit: null },
      redacted: false,
      level: "exceeded",
    });
    expect(props.percent).toBe(200);
    const r = render(createElement(mod.UsageCapPill, props));
    expect(r.container.querySelector("[data-usage-over]")).not.toBeNull();
    expect(
      (r.container.querySelector("[data-usage-track]") as HTMLElement).style.getPropertyValue(
        "--usage-fill",
      ),
    ).toBe("100%");
    expect(r.container.querySelector('[data-level="exceeded"]')).not.toBeNull();
  });

  test("compact budget projection respects soft policy, reservations, localized labels and actual alerts", async () => {
    const mod = await import(
      /* @vite-ignore */ pathToFileURL(
        join(hosts[variant], "components/usagekit/usage-cap-pill.tsx"),
      ).href
    );
    const known = (text: string) => ({ text, unit: "requests", certainty: "measured" });
    expect(typeof mod.usageCapFromBudget).toBe("function");
    const row = {
      id: "b",
      kind: "group",
      target: "project",
      unit: "requests",
      used: known("85"),
      reserved: { ...known("20"), certainty: "estimated" },
      limit: known("100"),
      remaining: known("0"),
      boundary: { onExceed: "allow", hardLimit: known("200") },
      redacted: false,
      level: "warning",
    };
    const projected = mod.usageCapFromBudget(row, {
      formatBound: () => "Project cap",
      formatUnit: () => "requêtes",
      href: "/usage",
    });
    expect(projected.percent).toBe(52.5);
    expect(projected.level).toBe("warning");
    expect(projected.partial).toBe(false);
    expect(projected.label).toContain("requêtes");
    render(createElement(mod.UsageCapPill, projected));
    expect(screen.getByRole("link").querySelector('[data-level="warning"]')).toBeTruthy();
  });
});

describe.each(variants)("%s block API localized omissions", (variant) => {
  test("a cost-owner formatter can omit the private identity with null", async () => {
    const { CostSummaryCard } = await load(variant, "cost-summary-card");
    const cost = { text: "1", unit: "cents", certainty: "measured" };
    render(
      createElement(CostSummaryCard!, {
        view: {
          state: "ok",
          complete: true,
          cost,
          funding: [
            { key: "a", fundingSource: "byok", costOwner: "private-one", cost },
            { key: "b", fundingSource: "platform", costOwner: "private-two", cost },
          ],
        },
        formatCostOwner: () => null,
      }),
    );
    expect(screen.queryByText(/private-one|private-two/)).toBeNull();
    expect(screen.queryByText(/Cost owner:/)).toBeNull();
  });
  test("compact budget missing and unlimited values use host labels", async () => {
    const mod = await import(
      /* @vite-ignore */ pathToFileURL(
        join(hosts[variant], "components/usagekit/usage-cap-pill.tsx"),
      ).href
    );
    const p = mod.usageCapFromBudget(
      {
        kind: "group",
        target: "project",
        unit: "requests",
        used: "unavailable",
        reserved: { text: "", unit: "requests", certainty: "unknown" },
        limit: "unlimited",
        boundary: { onExceed: "allow", hardLimit: null },
        redacted: false,
        level: "ok",
      },
      { labels: { unknown: "Inconnu", unavailable: "Indisponible", unlimited: "Sans limite" } },
    );
    expect(p.label).toContain("Inconnu");
    expect(p.label).toContain("Indisponible");
    expect(p.label).toContain("Sans limite");
    expect(p.percent).toBeNull();
  });
});

describe.each(variants)("%s allocation host contract", (variant) => {
  const known = (text = "9007199254740993.125", unit = "requests") => ({
    text,
    unit,
    certainty: "measured" as const,
  });
  const mount = (node: ReactNode) => {
    const demo = createDemoProviderPort(`host-contract:${crypto.randomUUID()}`);
    const wrap = (child: ReactNode) =>
      createElement(ProviderManagementProvider, { port: demo.port, binding: demo.binding }, child);
    return { ...render(wrap(node)), demo, wrap };
  };
  test("host contract fix 1: refresh preserves permission and aggregates across editor epochs", async () => {
    const { ProviderAllocationPanel } = await load(variant, "provider-allocation-editor");
    const { providerFeedbackLabels } = (await load(variant, "provider-feedback")) as unknown as {
      providerFeedbackLabels: { readOnly: string };
    };
    const pending = vi.fn();
    const finishes: ((value: null) => void)[] = [];
    const props = {
      connectionIds: [initialAllocations[0]!.connectionId],
      onRefreshNative: () => new Promise<null>((done) => finishes.push(done)),
      onRefreshPendingChange: pending,
    };
    const r = mount(createElement(ProviderAllocationPanel!, props));
    await screen.findAllByRole("textbox");
    fireEvent.change(screen.getAllByRole("textbox")[0]!, { target: { value: "123" } });
    expect(screen.queryByText(providerFeedbackLabels.readOnly)).toBeNull();
    fireEvent.click(screen.getAllByRole("button", { name: "Refresh balance" })[0]!);
    expect.soft(screen.queryByText(providerFeedbackLabels.readOnly)).toBeNull();
    expect(
      (screen.getByRole("button", { name: "Save allocations" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    r.rerender(
      r.wrap(
        createElement(ProviderAllocationPanel!, {
          ...props,
          connectionIds: [...props.connectionIds, "absent"],
        }),
      ),
    );
    await waitFor(() =>
      expect((screen.getAllByRole("textbox")[0] as HTMLInputElement).disabled).toBe(false),
    );
    fireEvent.click(screen.getAllByRole("button", { name: "Refresh balance" })[0]!);
    expect.soft(pending.mock.calls).toEqual([[true]]);
    await act(async () => finishes[0]!(null));
    expect.soft(pending.mock.calls).toEqual([[true]]);
    expect
      .soft(
        (screen.getByRole("button", { name: "Reload allocations" }) as HTMLButtonElement).disabled,
      )
      .toBe(true);
    expect
      .soft(
        (screen.getByRole("button", { name: "Save allocations" }) as HTMLButtonElement).disabled,
      )
      .toBe(true);
    await act(async () => finishes[1]!(null));
    expect(pending.mock.calls).toEqual([[true], [false]]);
    expect(
      (screen.getByRole("button", { name: "Reload allocations" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  test("host contract fix 2: default editor preserves the host form and click-only Save", async () => {
    const { ProviderAllocationEditor } = await load(variant, "provider-allocation-editor");
    const submit = vi.fn((event) => event.preventDefault());
    const r = mount(
      createElement(
        "form",
        { onSubmit: submit },
        createElement(ProviderAllocationEditor!, {
          rows: [initialAllocations[0]!],
          revision: "1",
        }),
      ),
    );
    expect.soft(r.container.querySelectorAll("form")).toHaveLength(1);
    const save = screen.getByRole("button", { name: "Save allocations" }) as HTMLButtonElement;
    expect.soft(save.type).toBe("button");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "1500" } });
    fireEvent.click(save);
    await waitFor(() => expect(r.demo.calls).toHaveLength(1));
    expect(submit).not.toHaveBeenCalled();
    expect(r.demo.calls[0]).toMatchObject({ changes: [{ limit: "1500" }] });
  });

  test("host contract fix 3: structured feedback follows visible action and read subjects", async () => {
    const { ProviderActionFeedback, ProviderReadFeedback } = await load(
      variant,
      "provider-feedback",
    );
    const { ProviderAllocationEditor, ProviderAllocationPanel } = await load(
      variant,
      "provider-allocation-editor",
    );
    type Subject = {
      kind: string;
      result?: { outcome: string } | null;
      ambiguous?: boolean;
      state?: string;
    };
    const mapper = vi.fn((subject: Subject) => ({
      code:
        subject.kind === "read"
          ? `read:${subject.state}`
          : subject.ambiguous
            ? "action:ambiguous"
            : `action:${subject.result?.outcome}`,
    }));
    const format = (message: { code: string }) => `Localized ${message.code}`;
    const action = { canWrite: true, pending: false, ambiguous: false, result: null };
    for (const result of [null, { outcome: "not_applied", commandId: "c" }]) {
      const r = render(
        createElement(ProviderActionFeedback!, {
          action: { ...action, result },
          message: { code: "phantom" },
          formatMessage: format,
        }),
      );
      expect.soft(r.container.textContent).toBe("");
      cleanup();
    }
    const results = [
      { outcome: "success", message: "RAW SUCCESS" },
      { outcome: "conflict", reason: "RAW CONFLICT" },
      { outcome: "invalid", field: "limit", reason: "RAW INVALID" },
      { outcome: "forbidden" },
      {
        outcome: "unavailable",
        message: "Connection management is unavailable.",
        ambiguous: false,
      },
    ];
    for (const result of results) {
      render(
        createElement(ProviderActionFeedback!, {
          action: { ...action, result },
          message: mapper,
          formatMessage: format,
        }),
      );
      expect.soft(screen.queryByText(`Localized action:${result.outcome}`)).toBeTruthy();
      expect.soft(mapper).toHaveBeenLastCalledWith({ kind: "action", result, ambiguous: false });
      cleanup();
    }
    render(
      createElement(ProviderActionFeedback!, {
        action: { ...action, ambiguous: true },
        message: mapper,
        formatMessage: format,
      }),
    );
    expect.soft(screen.queryByText("Localized action:ambiguous")).toBeTruthy();
    cleanup();
    render(
      createElement(ProviderActionFeedback!, {
        action: { ...action, result: results[0] },
        message: () => null,
        formatMessage: format,
      }),
    );
    expect.soft(screen.queryByText("RAW SUCCESS")).toBeTruthy();
    cleanup();
    render(
      createElement(ProviderActionFeedback!, {
        action: { ...action, result: results[2] },
        message: { code: "invalid" },
      }),
    );
    expect.soft(screen.queryByText(/RAW INVALID/)).toBeNull();
    cleanup();
    for (const state of ["loading", "forbidden", "empty", "unavailable"]) {
      mapper.mockClear();
      const error = { message: "RAW READ", kind: "transport" };
      render(
        createElement(ProviderReadFeedback!, {
          state,
          error,
          refresh: vi.fn(),
          message: mapper,
          formatMessage: format,
        }),
      );
      if (state === "loading") {
        expect.soft(screen.queryByText(/Localized/)).toBeNull();
        expect.soft(mapper).not.toHaveBeenCalled();
      } else {
        expect.soft(screen.queryByText(`Localized read:${state}`)).toBeTruthy();
        expect.soft(mapper).toHaveBeenLastCalledWith({ kind: "read", state, error });
      }
      cleanup();
    }
    render(
      createElement(ProviderReadFeedback!, {
        state: "unavailable",
        error: { message: "RAW READ" },
        refresh: vi.fn(),
        message: { code: "read" },
      }),
    );
    expect.soft(screen.queryByText("RAW READ")).toBeNull();
    expect.soft(screen.queryByText("Connection management is unavailable.")).toBeTruthy();
    cleanup();
    render(
      createElement(ProviderReadFeedback!, {
        state: "unavailable",
        error: { message: "Legacy read" },
        refresh: vi.fn(),
        message: () => null,
        formatMessage: format,
      }),
    );
    expect.soft(screen.queryByText("Legacy read")).toBeTruthy();
    cleanup();
    mount(
      createElement(ProviderAllocationEditor!, {
        rows: [initialAllocations[0]!],
        revision: "1",
        action: { ...action, result: results[1] },
        feedbackMessage: mapper,
        formatFeedback: format,
      }),
    );
    expect.soft(screen.queryByText("Localized action:conflict")).toBeTruthy();
    cleanup();
    const demo = createDemoProviderPort(`host-feedback:${crypto.randomUUID()}`);
    demo.port.read = async () => ({ outcome: "unavailable", message: "RAW READ" });
    render(
      createElement(
        ProviderManagementProvider,
        { port: demo.port, binding: demo.binding },
        createElement(ProviderAllocationPanel!, {
          connectionIds: [initialAllocations[0]!.connectionId],
          feedbackMessage: mapper,
          formatFeedback: format,
        }),
      ),
    );
    await screen.findByText("Localized read:unavailable");
  });

  test("host contract fix 4: shared initial draft helper matches every displayed field", async () => {
    const { ProviderAllocationEditor } = await load(variant, "provider-allocation-editor");
    const { allocationDraftValue } = (await load(
      variant,
      "provider-allocation-policy",
    )) as unknown as {
      allocationDraftValue: (
        row: ProviderAllocationRow,
        policy?: { denomination?: "native" | "dollars"; blank?: "unlimited" },
      ) => string;
    };
    expect(allocationDraftValue).toBeTypeOf("function");
    const row = initialAllocations[0]!;
    const rows: ProviderAllocationRow[] = [
      { ...row, id: "native", limit: known() },
      {
        ...row,
        id: "dollars",
        unit: "customer_cents",
        limit: known("1250.6250", "customer_cents"),
      },
      { ...row, id: "unlimited-known", unlimited: true, limit: known("1000") },
      { ...row, id: "unlimited-unavailable", unlimited: true, limit: "unavailable" },
      { ...row, id: "unknown", limit: { text: "", unit: "requests", certainty: "unknown" } },
      { ...row, id: "unavailable", limit: "unavailable" },
    ];
    for (const blank of [undefined, "unlimited"] as const) {
      const policy = { denomination: "dollars" as const, ...(blank ? { blank } : {}) };
      const values = rows.map((row) => allocationDraftValue(row, policy));
      expect(values).toEqual(["9007199254740993.125", "12.50625", blank ? "" : "1000", "", "", ""]);
      mount(createElement(ProviderAllocationEditor!, { rows, revision: "1", inputPolicy: policy }));
      expect(
        (screen.getAllByRole("textbox") as HTMLInputElement[]).map((input) => input.value),
      ).toEqual(values);
      cleanup();
    }
    expect(allocationDraftValue(rows[1]!)).toBe("1250.6250");
  });

  test("host contract 1: controlled fields register blur, errors, focus and one exact submission", async () => {
    const { ProviderAllocationEditor } = await load(variant, "provider-allocation-editor");
    const row = { ...initialAllocations[0]!, limit: known("1000") };
    function Host() {
      const [value, setValue] = useState("1000");
      const [error, setError] = useState<string>();
      const input = useRef<HTMLInputElement>(null);
      return createElement(ProviderAllocationEditor!, {
        rows: [row],
        revision: "1",
        formAdapter: {
          field: () => ({
            value,
            setValue,
            name: "limits.app",
            ref: input,
            onBlur: () => setError(value === "0" ? "Enter a positive budget" : undefined),
            error,
          }),
          handleSubmit:
            (save: () => Promise<void>): FormEventHandler<HTMLFormElement> =>
            (event) => {
              event.preventDefault();
              if (value === "0") {
                setError("Enter a positive budget");
                input.current?.focus();
              } else void save();
            },
        },
      });
    }
    const r = mount(createElement(Host));
    const input = screen.getByRole("textbox") as HTMLInputElement;
    expect(input.name).toBe("limits.app");
    fireEvent.change(input, { target: { value: "0" } });
    fireEvent.blur(input);
    expect(await screen.findByText("Enter a positive budget")).toBeTruthy();
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(document.getElementById(input.getAttribute("aria-describedby")!)?.textContent).toBe(
      "Enter a positive budget",
    );
    fireEvent.click(screen.getByRole("button", { name: "Save allocations" }));
    expect(document.activeElement).toBe(input);
    expect(r.demo.calls).toEqual([]);
    fireEvent.change(input, { target: { value: "1500" } });
    fireEvent.blur(input);
    fireEvent.submit(input.closest("form")!);
    await waitFor(() => expect(r.demo.calls).toHaveLength(1));
    expect(r.demo.calls[0]).toMatchObject({ changes: [{ rowId: row.id, limit: "1500" }] });
  });

  test("host contract 2: blank clears a limit, unlimited stays editable and unknown stays fenced", async () => {
    const { ProviderAllocationEditor } = await load(variant, "provider-allocation-editor");
    const row = { ...initialAllocations[0]!, limit: known("1000") };
    const r = mount(
      createElement(ProviderAllocationEditor!, {
        rows: [
          row,
          { ...row, id: "unlimited", unlimited: true, limit: "unavailable" },
          { ...row, id: "unknown", unlimited: false, limit: "unavailable" },
        ],
        revision: "1",
        inputPolicy: { blank: "unlimited", precision: 0 },
      }),
    );
    const inputs = screen.getAllByRole("textbox") as HTMLInputElement[];
    expect(inputs[1]!.disabled).toBe(false);
    expect(inputs[1]!.value).toBe("");
    expect(inputs[2]!.disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "No limit" })).toBeNull();
    fireEvent.change(inputs[0]!, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save allocations" }));
    await waitFor(() => expect(r.demo.calls).toHaveLength(1));
    expect(r.demo.calls[0]).toMatchObject({ changes: [{ rowId: row.id, limit: null }] });
  });

  test("host contract 3: row labels are unique and provider refresh visibility is per row", async () => {
    const { ProviderAllocationEditor } = await load(variant, "provider-allocation-editor");
    const row = initialAllocations[0]!;
    mount(
      createElement(ProviderAllocationEditor!, {
        rows: [row, { ...row, id: "hosted", fundingSource: "platform" }],
        revision: "1",
        rowLabels: (value: ProviderAllocationRow) => ({
          section: `Section ${value.id}`,
          field: `Budget ${value.id}`,
          available: `Use ${value.id}`,
          refreshBalance: `Probe ${value.id}`,
          unlimited: `Clear ${value.id}`,
        }),
        canRefreshBalance: (value: ProviderAllocationRow) => value.fundingSource === "byok",
        onRefreshBalance: vi.fn(),
      }),
    );
    expect(screen.getByRole("region", { name: `Section ${row.id}` })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: `Budget ${row.id}` })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Budget hosted" })).toBeTruthy();
    expect(screen.getByRole("button", { name: `Use ${row.id}` })).toBeTruthy();
    expect(screen.getByRole("button", { name: `Probe ${row.id}` })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Probe hosted" })).toBeNull();
    expect(screen.getByRole("button", { name: `Clear ${row.id}` })).toBeTruthy();
  });

  test("host contract 4: native observations never supply scoped evidence or suggestions", async () => {
    const { ProviderAllocationEditor } = await load(variant, "provider-allocation-editor");
    const row = { ...initialAllocations[0]!, used: "unavailable", available: undefined };
    const probe = vi.fn(async () => ({ identity: row, value: known("12.34", "USD") }));
    const r = mount(
      createElement(ProviderAllocationEditor!, {
        rows: [row],
        revision: "1",
        fresh: true,
        onRefreshNative: probe,
        renderNativeObservation: (observation: { value: { text: string } } | null) =>
          createElement(
            "p",
            {},
            observation ? `Native ${observation.value.text}` : "No native observation",
          ),
      }),
    );
    expect(screen.getByText("No native observation")).toBeTruthy();
    expect(probe).not.toHaveBeenCalled();
    const input = screen.getByRole("textbox") as HTMLInputElement;
    const before = input.value;
    fireEvent.click(screen.getByRole("button", { name: "Refresh balance" }));
    expect(await screen.findByText("Native 12.34")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Use available balance" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(input.value).toBe(before);
    expect(r.demo.calls).toEqual([]);
    expect(screen.getByText("Unavailable")).toBeTruthy();
  });

  test("host contract 5: panel fences save and reload while probing and discards changed-surface results", async () => {
    const { ProviderAllocationPanel, ProviderAllocationEditor } = await load(
      variant,
      "provider-allocation-editor",
    );
    const pending = vi.fn();
    let resolve!: (value: unknown) => void;
    const probe = vi.fn(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const r = mount(
      createElement(ProviderAllocationPanel!, {
        connectionIds: [initialAllocations[0]!.connectionId],
        onRefreshNative: probe,
        onRefreshPendingChange: pending,
      }),
    );
    const input = await screen.findAllByRole("textbox");
    fireEvent.change(input[0]!, { target: { value: "123" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Refresh balance" })[0]!);
    expect(pending).toHaveBeenLastCalledWith(true);
    expect(
      (screen.getByRole("button", { name: "Save allocations" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Reload allocations" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    await act(async () => resolve(null));
    expect(pending).toHaveBeenLastCalledWith(false);
    r.unmount();
    const row = initialAllocations[0]!;
    const props = {
      rows: [row],
      revision: "1",
      onRefreshNative: probe,
      renderNativeObservation: (observation: { value: { text: string } } | null) =>
        createElement("p", {}, observation?.value.text ?? "No observation"),
    };
    const second = mount(createElement(ProviderAllocationEditor!, props));
    fireEvent.click(screen.getByRole("button", { name: "Refresh balance" }));
    second.rerender(
      second.wrap(
        createElement(ProviderAllocationEditor!, {
          ...props,
          evidenceRows: [{ ...row, surface: "programmatic" }],
        }),
      ),
    );
    await act(async () => resolve({ identity: row, value: known("999", "USD") }));
    expect(screen.queryByText("999")).toBeNull();
  });

  test("host contract 6: empty panel renders the host connect slot without Save", async () => {
    const { ProviderAllocationPanel } = await load(variant, "provider-allocation-editor");
    mount(
      createElement(ProviderAllocationPanel!, {
        connectionIds: ["absent"],
        emptyState: createElement("a", { href: "/connect" }, "Connect a provider"),
      }),
    );
    expect(await screen.findByRole("link", { name: "Connect a provider" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save allocations" })).toBeNull();
    expect(
      screen.queryByText("View only. Connection changes are managed by your administrator."),
    ).toBeNull();
  });

  test("host contract controlled rows retain simultaneous errors and route suggestions through setValue", async () => {
    const { ProviderAllocationEditor } = await load(variant, "provider-allocation-editor");
    const rows = initialAllocations.slice(0, 2);
    const setters = [vi.fn(), vi.fn()];
    mount(
      createElement(ProviderAllocationEditor!, {
        rows,
        revision: "1",
        fresh: true,
        formAdapter: {
          field: (row: ProviderAllocationRow) => {
            const index = rows.findIndex((value) => value.id === row.id);
            return { value: "bad", setValue: setters[index], error: `Invalid ${row.surface}` };
          },
          handleSubmit: () => () => {},
        },
      }),
    );
    const inputs = screen.getAllByRole("textbox");
    for (const [index, input] of inputs.entries()) {
      expect(input.getAttribute("aria-invalid")).toBe("true");
      expect(document.getElementById(input.getAttribute("aria-describedby")!)?.textContent).toBe(
        `Invalid ${rows[index]!.surface}`,
      );
    }
    fireEvent.click(screen.getAllByRole("button", { name: "Use available balance" })[0]!);
    expect(setters[0]).toHaveBeenCalledWith("9007199254741008.125");
    expect(setters[1]).not.toHaveBeenCalled();
  });

  test.each(["id", "connectionId", "revision", "surface", "fundingSource", "unit"] as const)(
    "host contract native observation rejects a mismatched %s",
    async (part) => {
      const { ProviderAllocationEditor } = await load(variant, "provider-allocation-editor");
      const row = initialAllocations[0]!;
      mount(
        createElement(ProviderAllocationEditor!, {
          rows: [row],
          revision: "1",
          onRefreshNative: async () => ({
            identity: { ...row, [part]: "different" },
            value: known("999"),
          }),
          renderNativeObservation: (observation: { value: { text: string } } | null) =>
            createElement("p", {}, observation?.value.text ?? "No observation"),
        }),
      );
      fireEvent.click(screen.getByRole("button", { name: "Refresh balance" }));
      await screen.findByText("Balance refresh is unavailable.");
      expect(screen.queryByText("999")).toBeNull();
    },
  );

  test("host contract repeated native refresh clears previous observation and preserves Meter suggestions", async () => {
    const { ProviderAllocationEditor } = await load(variant, "provider-allocation-editor");
    const row = initialAllocations[0]!;
    let fail = false;
    const pending = vi.fn();
    const r = mount(
      createElement(ProviderAllocationEditor!, {
        rows: [row],
        revision: "1",
        fresh: true,
        onRefreshPendingChange: pending,
        onRefreshNative: async () => {
          if (fail) throw new Error("PRIVATE SERVER DETAIL");
          return { identity: row, value: known("12.34", "USD") };
        },
        renderNativeObservation: (observation: { value: { text: string } } | null) =>
          createElement("p", {}, observation?.value.text ?? "No observation"),
      }),
    );
    const refresh = screen.getByRole("button", { name: "Refresh balance" });
    fireEvent.click(refresh);
    await screen.findByText("12.34");
    fail = true;
    fireEvent.click(refresh);
    expect(screen.queryByText("12.34")).toBeNull();
    await screen.findByText("Balance refresh is unavailable.");
    expect(screen.queryByText(/PRIVATE SERVER DETAIL/)).toBeNull();
    expect(pending.mock.calls.map(([value]) => value)).toEqual([true, false, true, false]);
    fireEvent.click(screen.getByRole("button", { name: "Use available balance" }));
    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("9007199254741008.125");
    expect(r.demo.calls).toEqual([]);
  });

  test("host contract identity cycling cannot restore discarded native observations", async () => {
    const { ProviderAllocationEditor } = await load(variant, "provider-allocation-editor");
    const row = initialAllocations[0]!;
    const props = {
      rows: [row],
      revision: "1",
      onRefreshNative: async () => ({ identity: row, value: known("12.34", "USD") }),
      renderNativeObservation: (observation: { value: { text: string } } | null) =>
        createElement("p", {}, observation?.value.text ?? "No observation"),
    };
    const r = mount(createElement(ProviderAllocationEditor!, props));
    fireEvent.click(screen.getByRole("button", { name: "Refresh balance" }));
    await screen.findByText("12.34");
    r.rerender(
      r.wrap(
        createElement(ProviderAllocationEditor!, {
          ...props,
          evidenceRows: [{ ...row, revision: "2" }],
        }),
      ),
    );
    expect(screen.queryByText("12.34")).toBeNull();
    r.rerender(r.wrap(createElement(ProviderAllocationEditor!, props)));
    expect(screen.queryByText("12.34")).toBeNull();
  });

  test("host contract 7: structured feedback maps sanitized codes without concatenating server reasons", async () => {
    const { ProviderActionFeedback, ProviderReadFeedback } = await load(
      variant,
      "provider-feedback",
    );
    const message = { code: "changed", params: { field: "app" } };
    const formatMessage = (value: typeof message) =>
      value.params.field === "app" ? "App budget changed" : "Budget changed";
    render(
      createElement(ProviderActionFeedback!, {
        action: {
          canWrite: true,
          pending: false,
          ambiguous: false,
          result: { outcome: "conflict", reason: "RAW SERVER DIAGNOSTIC" },
        },
        message,
        formatMessage,
      }),
    );
    expect(screen.getByText("App budget changed")).toBeTruthy();
    expect(screen.queryByText(/RAW SERVER/)).toBeNull();
    cleanup();
    render(
      createElement(ProviderReadFeedback!, {
        state: "unavailable",
        error: { message: "RAW SERVER DIAGNOSTIC" },
        refresh: vi.fn(),
        message,
        formatMessage,
      }),
    );
    expect(screen.getByText("App budget changed")).toBeTruthy();
    expect(screen.queryByText(/RAW SERVER/)).toBeNull();
    cleanup();
    render(
      createElement(ProviderActionFeedback!, {
        action: {
          canWrite: true,
          pending: false,
          ambiguous: false,
          result: { outcome: "unavailable", message: "Safe legacy host message" },
        },
      }),
    );
    expect(screen.getByText("Safe legacy host message")).toBeTruthy();
    cleanup();
    render(
      createElement(ProviderActionFeedback!, {
        action: {
          canWrite: true,
          pending: false,
          ambiguous: false,
          result: { outcome: "conflict", reason: "RAW SERVER DIAGNOSTIC" },
        },
      }),
    );
    expect(screen.queryByText(/RAW SERVER/)).toBeNull();
  });
});
