import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { styles } from "../packages/registry/styles/styles.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(root, ".vercel/output");
const staticRoot = join(output, "static");
const variants = [
  { registry: "radix", route: "new-york", label: "New York / Radix" },
  { registry: "base", route: "base-vega", label: "Base UI / Vega" },
];
const libraries = [
  { key: "radix", label: "Radix" },
  { key: "base", label: "Base UI" },
];
// One page shows every style; the style picker swaps it in place and keeps it in ?style=.
const showcase = (style) => `/examples/showcase/?style=${style}`;
const runNode = (script, args = []) =>
  execFileSync(process.execPath, [join(root, script), ...args], { cwd: root, stdio: "inherit" });
const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const writeJson = async (path, value) => writeFile(path, JSON.stringify(value, null, 2) + "\n");
const escapeHtml = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character],
  );

// The build copies only the site's output, never the workspace or Vercel project credentials.
async function checkStaticTree(path) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw Error("Static output must not contain symlinks");
    if (entry.name.startsWith(".env") || /\.(?:pem|key|sqlite|db)$/.test(entry.name))
      throw Error("Unexpected private file in static output");
    if (entry.isDirectory()) await checkStaticTree(join(path, entry.name));
  }
}

function navigation() {
  return '<a href="/">Usagekit</a><a href="/components/">Components</a><a href="/agents/">Agents</a><a href="/docs/">Docs</a><a href="/examples/">Examples</a><a href="/examples/showcase/">Showcase</a><a href="https://github.com/usagekit/usagekit">Source on GitHub</a>';
}

const bannerCss = `
  .preview-banner{font:14px/1.6 system-ui,sans-serif;color:#292c25;background:#f2f1e9;border-bottom:1px solid #d4d6cb;padding:16px max(20px,calc((100vw - 1200px)/2))}
  .preview-banner nav{display:flex;flex-wrap:wrap;gap:8px 20px;margin-bottom:8px}
  .preview-banner a{color:#30392a;text-decoration:underline;text-underline-offset:3px}
  .preview-banner a:focus-visible{outline:2px solid #376318;outline-offset:4px}
  .preview-banner p{margin:0}
`;

async function addDemoBanner(path, label) {
  const html = await readFile(path, "utf8");
  const title = escapeHtml(`Usagekit — ${label} component examples`);
  const banner = `<header class="preview-banner"><nav aria-label="Preview navigation">${navigation()}</nav><p><strong>${escapeHtml(label)} · Interactive component examples.</strong> Local demo data. Changes reset on reload. Use demo credential values only; no provider calls are made.</p></header>`;
  await writeFile(
    path,
    html
      .replace(/<title>[^<]*<\/title>/, `<title>${title}</title>`)
      .replace("</head>", `<style>${bannerCss}</style></head>`)
      .replace(/<body([^>]*)>/, `<body$1>${banner}`),
  );
}

function examplesHtml(items) {
  const rows = items
    .map(
      (item) =>
        `<tr><th scope="row">${escapeHtml(item.title ?? item.name)}<small>${escapeHtml(item.description)}</small></th>${variants
          .map((variant) => {
            const path = `/r/${variant.registry}/${item.name}.json`;
            return `<td><a href="${path}">JSON</a><button type="button" data-install="${path}" aria-label="Copy ${escapeHtml(variant.label)} install command for ${escapeHtml(item.title ?? item.name)}">Copy install</button></td>`;
          })
          .join("")}</tr>`,
    )
    .join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="description" content="Interactive Usagekit component examples in New York and Base UI, with a static shadcn registry."><title>Usagekit — Component examples</title>
<style>
${bannerCss}
*{box-sizing:border-box}body{margin:0;background:#faf9f4;color:#292c25;font:16px/1.6 system-ui,sans-serif}main{max-width:1200px;margin:0 auto;padding:64px 24px}h1{font-size:clamp(36px,7vw,64px);line-height:1.05;letter-spacing:-.04em;margin:0 0 24px;max-width:800px}h2{font-size:28px;margin:48px 0 12px}p{max-width:780px}.eyebrow{font-size:13px;letter-spacing:.12em;text-transform:uppercase;color:#535b49}a{color:#35551d;text-underline-offset:4px}a:focus-visible,button:focus-visible,.table-wrap:focus-visible{outline:3px solid #587438;outline-offset:4px}.cards{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px;margin:32px 0}.card{display:block;border:1px solid #c9cebf;border-radius:16px;padding:28px;color:inherit;text-decoration:none;background:#f0f1e8}.card strong{display:block;font-size:24px}.card span{display:block;margin:12px 0;color:#4d5544}.card em{font-style:normal;text-decoration:underline;color:#35551d}.styles{display:flex;flex-wrap:wrap;gap:8px 18px;margin:0;padding:0;list-style:none}.styles a{font-weight:600}.note{border-left:3px solid #8a9e71;padding:8px 20px;background:#f0f1e8}.table-wrap{overflow:auto;border:1px solid #c9cebf;border-radius:12px}table{border-collapse:collapse;width:100%;min-width:600px}th,td{text-align:left;padding:16px 20px;border-bottom:1px solid #d9ddcf}thead{background:#eef0e5}th[scope=row]{font-weight:600;min-width:300px}small{display:block;font-weight:400;color:#535b49;font-size:13px;line-height:1.6;margin-top:4px;max-width:600px}td{white-space:nowrap}button{font:inherit;font-size:13px;margin-left:14px;border:1px solid #adb7a1;border-radius:6px;background:#fff;padding:7px 10px;color:#30392a;cursor:pointer}#copy-status{min-height:26px}#install-command{display:block;white-space:pre-wrap;overflow-wrap:anywhere;margin:16px 0;font:14px/1.6 ui-monospace,monospace;color:#30392a}footer{padding-top:40px;color:#535b49;font-size:14px}@media(max-width:640px){main{padding:40px 20px}.cards{grid-template-columns:1fr}.card{padding:22px}}
</style></head><body><header class="preview-banner"><nav aria-label="Preview navigation">${navigation()}</nav><p>Static preview · Browser-only fixtures · React and views · 0.9.1 source candidate, publication pending</p></header><main>
<p class="eyebrow">Usagekit / Component examples</p><h1>One metering model in every shadcn style.</h1><p>Try the actual Usagekit React hooks and all ${items.length} registry blocks with local metering, budgets and provider-management fixtures. The examples use the same component sources that the registry copies into your app, in each shadcn style for Radix and Base UI.</p>
<div class="cards">${libraries
    .map(
      (library) =>
        `<div class="card"><strong>${escapeHtml(library.label)}</strong><span>Explore usage, limits, budgets and provider controls in one page. Its style picker switches every shadcn style in place.</span><ul class="styles">${styles
          .filter((style) => style.variant === library.key)
          .map(
            (style) => `<li><a href="${showcase(style.name)}">${escapeHtml(style.label)}</a></li>`,
          )
          .join("")}</ul></div>`,
    )
    .join("")}</div>
<div class="note"><p>Each example runs in memory in your browser. Changes reset on reload; there is no durable backend, provider request or billing action. Credential fields accept demo values only.</p></div>
<h2>Copy a block into your app</h2><p>These JSON artifacts are ready for the shadcn CLI. Every shadcn style has its own build with the style baked into the blocks: point a registry at <code>/r/styles/{style}/{name}.json</code> in <code>components.json</code> and the shadcn CLI fills in your style. The table offers the New York and Base UI Vega builds. First install <code>@usagekit/react</code>, <code>@usagekit/views</code> and their dependencies from the 0.9.1 candidate cohort that these blocks request; they resolve anonymously from npm once it is published. Until then, use reviewed tarballs as described in <a href="/docs/#checkout">the installation guide</a>. Hosting the registry does not publish npm packages.</p><p>The install command below uses this preview's own origin.</p>
<p id="copy-status" role="status" aria-live="polite">Choose a block to get its install command.</p><code id="install-command"></code><div class="table-wrap" role="region" aria-label="Component registry" tabindex="0"><table><thead><tr><th scope="col">Block</th><th scope="col">New York / Radix</th><th scope="col">Base UI / Vega</th></tr></thead><tbody>${rows}</tbody></table></div>
<footer><p>Apache-2.0 · <a href="/LICENSE">License</a> · <a href="https://github.com/usagekit/usagekit">Usagekit source</a></p></footer>
</main><script>
document.querySelectorAll('[data-install]').forEach(function(button){button.addEventListener('click',async function(){var command='npx shadcn add '+new URL(button.dataset.install,location.origin).href;document.getElementById('install-command').textContent=command;try{await navigator.clipboard.writeText(command);document.getElementById('copy-status').textContent='Install command copied.';}catch{document.getElementById('copy-status').textContent='Select and copy the install command shown below.';}});});
</script></body></html>\n`;
}

async function buildPreview() {
  runNode("scripts/check-runtime.mjs");
  runNode("node_modules/typescript/bin/tsc", ["-b"]);
  execFileSync("npm", ["run", "build", "--workspace", "@usagekit/site"], {
    cwd: root,
    stdio: "inherit",
  });
  const site = join(root, "packages/site/dist/site");
  for (const page of [
    "index.html",
    "components/index.html",
    "agents/index.html",
    "docs/index.html",
  ])
    await readFile(join(site, page));
  await checkStaticTree(site);

  // Preserve .vercel/project.json and local environment files. Only generated output is replaced.
  await rm(output, { recursive: true, force: true });
  await mkdir(staticRoot, { recursive: true });
  try {
    await cp(site, staticRoot, { recursive: true });
    runNode("packages/registry/consumers/prepare.mjs");
    const work = join(root, "packages/registry/.work/showcase");
    const host = join(work, "app");
    const outDir = join(staticRoot, "examples/showcase");
    await build({
      root: host,
      configFile: join(host, "vite.config.ts"),
      base: "/examples/showcase/",
      logLevel: "error",
      build: { outDir, emptyOutDir: true, sourcemap: false },
    });
    await addDemoBanner(join(outDir, "index.html"), "Every shadcn style");
    await cp(join(work, "registry/r"), join(staticRoot, "r"), { recursive: true });
    const index = await readJson(join(staticRoot, "r/radix/registry.json"));
    for (const item of index.items)
      if (!/^[a-z][a-z-]*$/.test(item.name)) throw Error("Invalid registry block name");
    await writeJson(join(staticRoot, "r/registry.json"), index);
    await writeFile(join(staticRoot, "examples/index.html"), examplesHtml(index.items));
    const directories = ["components", "agents", "docs", "examples", "examples/showcase"];
    await writeJson(join(output, "config.json"), {
      version: 3,
      routes: [
        { src: "/(.*)", headers: { "X-Content-Type-Options": "nosniff" }, continue: true },
        {
          src: "/r/(.*)\\.json",
          headers: { "Content-Type": "application/json; charset=utf-8" },
          continue: true,
        },
        ...directories.flatMap((path) => [
          { src: `/${path}`, status: 308, headers: { Location: `/${path}/` } },
          { src: `/${path}/`, dest: `/${path}/index.html` },
        ]),
        // The earlier example pages open the showcase in their style.
        { src: "/examples/base/?", status: 308, headers: { Location: showcase("base-vega") } },
        ...styles.map((style) => ({
          src: `/examples/${style.name}/?`,
          status: 308,
          headers: { Location: showcase(style.name) },
        })),
        { src: "/", dest: "/index.html" },
        { handle: "filesystem" },
      ],
    });
    await writeJson(join(staticRoot, "preview-manifest.json"), {
      sourceRevision: execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: root,
        encoding: "utf8",
      }).trim(),
      sourceDirty: Boolean(
        execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim(),
      ),
      backend: "none",
      examples: "browser-only in-memory fixtures",
      uiPackages: "0.9.1 source candidate; publication pending",
      registryBlocksPerVariant: index.items.length,
      routes: [
        "/",
        "/components/",
        "/agents/",
        "/docs/",
        "/examples/",
        "/examples/showcase/",
        "/r/registry.json",
        ...variants.map((variant) => `/r/${variant.registry}/registry.json`),
        ...styles.map((style) => `/r/styles/${style.name}/registry.json`),
      ],
    });
    await checkStaticTree(staticRoot);
    console.log(
      `Static preview ready: ${staticRoot}\n${index.items.length} blocks per variant; no functions or backend.`,
    );
  } catch (error) {
    await rm(output, { recursive: true, force: true });
    throw error;
  }
}

await buildPreview();
