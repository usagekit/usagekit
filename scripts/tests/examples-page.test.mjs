import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { examplesHtml } from "../lib/examples-page.mjs";
import { styles } from "../../packages/registry/styles/styles.mjs";

const items = JSON.parse(
  readFileSync(new URL("../../packages/registry/registry.json", import.meta.url), "utf8"),
).items;
function catalog(
  query = "",
  fetch = async () => ({
    ok: true,
    json: async () => ({
      files: [{ path: "example.tsx", content: "export const Example = () => null;" }],
    }),
  }),
) {
  const dom = new JSDOM(examplesHtml(items, styles, "candidate"), {
    url: `https://preview.example/examples/${query}`,
    runScripts: "outside-only",
  });
  const { window } = dom;
  window.fetch = fetch;
  const copied = [];
  Object.defineProperty(window.navigator, "clipboard", {
    value: { writeText: async (text) => copied.push(text) },
  });
  window.eval(window.document.scripts[1].textContent);
  return {
    dom,
    window,
    document: window.document,
    copied,
    click: (selector) => window.document.querySelector(selector).click(),
  };
}
const tick = () => new Promise((done) => setImmediate(done));

test("every registry item is browsable and selects its own live example and install artifact", (t) => {
  const { dom, document, click } = catalog();
  t.after(() => dom.window.close());
  assert.equal(document.querySelectorAll("[data-block]").length, items.length);
  for (const item of items) {
    click(`[data-block="${item.name}"]`);
    assert.equal(document.querySelector("#component-title").textContent, item.title);
    assert.equal(
      new URL(document.querySelector("iframe").src).searchParams.get("embed"),
      item.name,
    );
    assert.equal(
      document.querySelector("#registry-link").pathname,
      `/r/styles/new-york/${item.name}.json`,
    );
  }
});

test("invalid URL choices are bounded and library changes retain the sheet and exact install origin", async (t) => {
  const { dom, window, document, click, copied } = catalog(
    "?block=../private&style=invalid&state=bad",
  );
  t.after(() => window.close());
  assert.equal(document.querySelector("#component-title").textContent, "Usage overview card");
  click('[data-library="base"]');
  assert.equal(
    new URL(document.querySelector("iframe").src).searchParams.get("style"),
    "base-vega",
  );
  click('[data-style="base-maia"]');
  click('[data-library="radix"]');
  assert.equal(
    new URL(document.querySelector("iframe").src).searchParams.get("style"),
    "radix-maia",
  );
  click("#copy-install");
  await tick();
  assert.equal(
    copied[0],
    "npx shadcn add https://preview.example/r/styles/radix-maia/usage-overview-card.json",
  );
  assert.equal(
    dom.window.document.querySelector("#copy-status").textContent,
    "Copied to clipboard.",
  );
});

test("search exposes no-results and restores all groups; tabs support keyboard selection", (t) => {
  const { dom, window, document } = catalog();
  t.after(() => window.close());
  const input = document.querySelector("input");
  input.value = "not-a-component";
  input.dispatchEvent(new window.Event("input"));
  assert.equal(document.querySelector("#search-empty").hidden, false);
  assert.equal(
    [...document.querySelectorAll("[data-block]")].every((link) => link.hidden),
    true,
  );
  input.value = "";
  input.dispatchEvent(new window.Event("input"));
  assert.equal(
    [...document.querySelectorAll(".nav-group")].every((group) => !group.hidden),
    true,
  );
  document
    .querySelector("#preview-tab")
    .dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowRight" }));
  assert.equal(document.querySelector("#code-tab").getAttribute("aria-selected"), "true");
  assert.equal(document.activeElement.id, "code-tab");
  assert.equal(dom.window.document.querySelector("#preview-panel").hidden, true);
});

test("late source responses cannot replace another component's source, and source is rendered as text", async (t) => {
  const pending = [];
  const { dom, window, document, click } = catalog(
    "",
    () => new Promise((done) => pending.push(done)),
  );
  t.after(() => window.close());
  click("#code-tab");
  click('[data-block="budget-editor"]');
  pending[1]({
    ok: true,
    json: async () => ({
      files: [{ path: "budget.tsx", content: '<img src=x onerror="alert(1)">' }],
    }),
  });
  await tick();
  pending[0]({
    ok: true,
    json: async () => ({ files: [{ path: "old.tsx", content: "old component" }] }),
  });
  await tick();
  assert.equal(
    document.querySelector("#source-code").textContent,
    '<img src=x onerror="alert(1)">',
  );
  assert.equal(document.querySelector("#source-code img"), null);
  assert.equal(dom.window.document.querySelector("#source-files button").textContent, "budget.tsx");
});

test("only the selected same-origin iframe can resize the preview; oversized content stays scrollable", (t) => {
  const { dom, window, document } = catalog();
  t.after(() => window.close());
  const frame = document.querySelector("iframe");
  const data = { type: "usagekit-example-size", block: "usage-overview-card", height: 450 };
  window.dispatchEvent(
    new window.MessageEvent("message", {
      origin: "https://foreign.example",
      source: frame.contentWindow,
      data,
    }),
  );
  assert.equal(frame.height, "540");
  window.dispatchEvent(
    new window.MessageEvent("message", { origin: window.location.origin, source: window, data }),
  );
  assert.equal(frame.height, "540");
  window.dispatchEvent(
    new window.MessageEvent("message", {
      origin: window.location.origin,
      source: frame.contentWindow,
      data,
    }),
  );
  assert.equal(frame.height, "450");
  window.dispatchEvent(
    new window.MessageEvent("message", {
      origin: window.location.origin,
      source: frame.contentWindow,
      data: { ...data, height: 9000 },
    }),
  );
  assert.equal(frame.height, "1000");
  assert.equal(dom.window.document.querySelector("iframe").getAttribute("scrolling"), null);
});

test("registry text cannot close the data script, and an unclassified registry item fails the build", (t) => {
  const { dom, window } = catalog();
  t.after(() => window.close());
  const poisoned = items.map((item) => ({
    ...item,
    description: "</script><script>window.injected=true</script>",
  }));
  const html = examplesHtml(poisoned, styles, "candidate");
  assert(!html.includes("</script><script>window.injected=true"));
  assert.throws(
    () => examplesHtml([...items, { name: "unclassified" }], styles, "candidate"),
    /examples group/,
  );
  assert.equal(dom.window.injected, undefined);
});
