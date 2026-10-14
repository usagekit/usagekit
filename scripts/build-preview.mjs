import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { examplesHtml } from "./lib/examples-page.mjs";
import { styles } from "../packages/registry/styles/styles.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(root, ".vercel/output");
const staticRoot = join(output, "static");
const variants = [
  { registry: "radix", route: "new-york", label: "New York / Radix" },
  { registry: "base", route: "base-vega", label: "Base UI / Vega" },
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
  .preview-banner{font:12px/1.6 system-ui,sans-serif;color:var(--foreground);background:var(--background);border-bottom:1px solid var(--border);padding:12px max(20px,calc((100vw - 1200px)/2))}
  .preview-banner nav{display:flex;flex-wrap:wrap;gap:8px 20px;margin-bottom:6px}
  .preview-banner a{text-decoration:none;opacity:.75}
  .preview-banner a:hover{opacity:1}
  .preview-banner a:focus-visible{outline:2px solid currentColor;outline-offset:4px}
  .preview-banner p{margin:0;opacity:.7}
  body:has(.example-surface)>.preview-banner{display:none}
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
    await writeFile(
      join(staticRoot, "examples/index.html"),
      examplesHtml(index.items, styles, "0.9.1 source candidate · Publication pending"),
    );
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
