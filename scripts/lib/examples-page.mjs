import { readFileSync } from "node:fs";

const escapeHtml = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character],
  );
const groups = [
  {
    title: "Usage",
    names: [
      "usage-overview-card",
      "usage-summary-cards",
      "usage-table",
      "measurement-card",
      "cost-summary-card",
      "usage-filters",
    ],
  },
  {
    title: "Budgets",
    names: [
      "budget-card",
      "budget-editor",
      "budget-manager-panel",
      "usage-cap-pill",
      "header-status",
    ],
  },
  {
    title: "Providers",
    names: [
      "provider-manager-panel",
      "provider-card",
      "provider-connect-form",
      "provider-source-selector",
      "provider-rate-editor",
      "provider-chain-editor",
      "provider-balance-card",
      "provider-allocation-editor",
      "connection-list",
    ],
  },
  { title: "Monitoring", names: ["coverage-summary", "exceptions-list"] },
];
const icon = (name) => {
  const paths = {
    copy: '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
    arrow: '<path d="M7 17 17 7M7 7h10v10"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>',
    search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
    chevron: '<path d="m8 10 4 4 4-4"/>',
  };
  return `<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${paths[name]}</svg>`;
};

/** A static catalog whose isolated previews use the same installed block sources as the showcase. */
export function examplesHtml(items, styles, runtimeCohort) {
  const byName = new Map(items.map((item) => [item.name, item]));
  const known = new Set(groups.flatMap((group) => group.names));
  if (items.some((item) => !known.has(item.name)))
    throw Error("Registry item needs an examples group");
  const navigation = groups
    .map(
      (group) =>
        `<section class="nav-group" aria-label="${group.title}"><h2>${group.title}</h2>${group.names
          .filter((name) => byName.has(name))
          .map((name) => {
            const item = byName.get(name);
            return `<a href="?block=${name}" data-block="${name}" data-search="${escapeHtml(`${item.title} ${item.description}`.toLowerCase())}">${escapeHtml(item.title)}</a>`;
          })
          .join("")}</section>`,
    )
    .join("");
  const data = JSON.stringify({
    items: items.map(({ name, title, description }) => ({ name, title, description })),
    styles,
  }).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="description" content="Explore live Usagekit components, inspect their source and copy the shadcn install command for every Radix and Base UI style."><title>Examples — Usagekit</title><link rel="icon" href="/favicon.svg">
<style>${readFileSync(new URL("../examples/catalog.css", import.meta.url), "utf8")}</style>
</head><body>
<a class="skip-link" href="#example">Skip to component preview</a>
<header class="site-header"><div class="header-inner"><a class="brand" href="/" aria-label="Usagekit home"><span class="brand-mark" aria-hidden="true"><i></i><i></i><i></i></span>usagekit</a><nav aria-label="Main navigation"><a href="/docs/">Docs</a><a href="/components/">Components</a><a href="/examples/" aria-current="page">Examples</a><a href="/agents/">Agents</a></nav><div class="header-actions"><a class="source-link" href="https://github.com/usagekit/usagekit">GitHub ${icon("arrow")}</a><span class="divider"></span><button id="theme-toggle" class="icon-button" type="button" aria-label="Switch to dark theme" aria-pressed="false">${icon("sun")}</button></div></div></header>
<div class="catalog-layout"><aside class="sidebar" aria-label="Component library"><div class="sidebar-heading"><span>Components</span><span class="count">${items.length}</span></div><div class="search">${icon("search")}<input id="component-search" type="search" placeholder="Find a component…" aria-label="Find a component" autocomplete="off"></div><nav aria-label="Component examples">${navigation}</nav><p id="search-empty" class="muted" hidden>No components found.</p><a class="sidebar-footer" href="/docs/#components">Installation guide ${icon("arrow")}</a></aside>
<main id="example" tabindex="-1"><div class="page-intro"><span class="eyebrow">THE COMPONENT LIBRARY</span><h1>Build your usage UI.</h1><p>Usage, budgets and provider controls. Ready to make your own.</p><div class="intro-meta"><span>${items.length} components</span><span>${styles.length} shadcn styles</span><span>Radix & Base UI</span></div></div>
<section aria-labelledby="component-title"><div class="component-heading"><div><h2 id="component-title">Usage overview card</h2><p id="component-description"></p></div><a id="open-example" class="button outline" href="/examples/showcase/">Open showcase ${icon("arrow")}</a></div>
<div class="example-panel"><div class="example-toolbar"><div class="tabs" role="tablist" aria-label="Example view"><button id="preview-tab" type="button" role="tab" aria-selected="true" aria-controls="preview-panel">Preview</button><button id="code-tab" type="button" role="tab" aria-selected="false" aria-controls="code-panel" tabindex="-1">Code</button></div><div class="preview-options"><div class="library-toggle" role="group" aria-label="Component library"><button type="button" data-library="radix" aria-pressed="true">Radix</button><button type="button" data-library="base" aria-pressed="false">Base UI</button></div><details id="style-menu" class="style-menu"><summary><span id="style-label">New York</span>${icon("chevron")}</summary><div class="style-options" role="group" aria-label="shadcn style">${styles.map((style) => `<button type="button" data-style="${style.name}" data-variant="${style.variant}" aria-pressed="false">${escapeHtml(style.label)}</button>`).join("")}</div></details></div></div>
<div id="state-controls" class="state-controls" role="group" aria-label="Sample state"><span>State</span>${[
    ["within", "Within budget"],
    ["near", "Near limit"],
    ["over", "Over limit"],
    ["partial", "Partial data"],
    ["unknown", "Unknown"],
  ]
    .map(
      ([key, label]) =>
        `<button type="button" data-state="${key}" aria-pressed="false">${label}</button>`,
    )
    .join("")}</div>
<div id="preview-panel" role="tabpanel" aria-labelledby="preview-tab"><div class="preview-canvas"><iframe id="component-preview" title="Usage overview card live preview" src="/examples/showcase/?embed=usage-overview-card&style=new-york" height="540"></iframe></div><div class="preview-caption"><span class="sample-dot" aria-hidden="true"></span>Interactive sample · Changes reset when you switch examples.</div></div>
<div id="code-panel" role="tabpanel" aria-labelledby="code-tab" hidden><div id="source-files" class="source-files" role="group" aria-label="Source files"></div><div class="code-content"><button id="copy-source" class="icon-button" type="button" aria-label="Copy component source">${icon("copy")}</button><pre tabindex="0" aria-label="Component source"><code id="source-code">Select Code to load this component's source.</code></pre></div></div></div>
<div class="install-section"><div class="install-heading"><h3>Add to your project</h3><a id="registry-link" href="/r/styles/new-york/usage-overview-card.json">Registry JSON ${icon("arrow")}</a></div><div class="install-command"><span class="terminal-prompt" aria-hidden="true">$</span><code id="install-command"></code><button id="copy-install" class="icon-button" type="button" aria-label="Copy install command">${icon("copy")}</button></div><p class="muted">Uses your selected shadcn style and your app's UI primitives. <a href="/docs/#checkout">Installation guide</a></p><p id="copy-status" class="muted" role="status" aria-live="polite"></p></div>
</section><footer class="page-footer"><p>Local sample data. No provider calls or charges.</p><p>${escapeHtml(runtimeCohort)} · <a href="/LICENSE">Apache-2.0</a></p></footer></main></div>
<script id="catalog-data" type="application/json">${data}</script><script>${readFileSync(new URL("../examples/catalog.js", import.meta.url), "utf8")}</script></body></html>\n`;
}
