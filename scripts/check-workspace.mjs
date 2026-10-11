import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { git } from "./lib/git.mjs";
import { filesUnder, readJson, validateGraph, validateImports } from "./lib/workspace.mjs";
import { satisfiesRuntimeRange } from "./lib/runtime.mjs";
import { checkPrivateTerms } from "./lib/private-terms.mjs";
import { publishable, releaseVersion } from "./lib/release.mjs";
import { checkPackages } from "./check-packages.mjs";
import "./check-registry.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
process.chdir(root);
const workspace = readJson("usagekit.workspace.json");
validateGraph(workspace.projects);
const rootManifest = readJson("package.json");
if (
  rootManifest.private !== true ||
  workspace.publication !== "restricted-release" ||
  JSON.stringify(workspace.publishable) !== JSON.stringify(publishable) ||
  rootManifest.license !== "Apache-2.0"
)
  throw new Error("Publication allow-list or root identity changed.");
if (git(["ls-files", "--", "docs/adr"]))
  throw new Error("ADR files must remain untracked, including force-added files.");
checkPrivateTerms(root);
if (!satisfiesRuntimeRange(readFileSync(".nvmrc", "utf8").trim(), rootManifest.engines.node))
  throw new Error("Runtime pins disagree.");
const expected = new Set(workspace.projects.map((p) => p.path));
const actual = ["packages", "apps"].flatMap((dir) =>
  (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }) : [])
    .filter((p) => p.isDirectory())
    .map((p) => `${dir}/${p.name}`),
);
if (actual.length !== expected.size || actual.some((p) => !expected.has(p)))
  throw new Error("Workspace directory inventory differs from usagekit.workspace.json.");
const refs = readJson("tsconfig.json").references.map((r) => r.path.replace(/^\.\//, ""));
if (refs.length !== expected.size || refs.some((p) => !expected.has(p)))
  throw new Error("Root TypeScript references do not cover all projects.");
for (const project of workspace.projects) {
  const config = readJson(`${project.path}/tsconfig.json`);
  const base = { web: "tsconfig.base.json", node: "tsconfig.node.json" }[project.runtime];
  if (!base || resolve(project.path, config.extends ?? "") !== resolve(base))
    throw new Error(`Runtime config mismatch: ${project.path} must extend ${base}.`);
  const manifest = readJson(`${project.path}/package.json`);
  const released = publishable.includes(project.name);
  if (
    manifest.name !== project.name ||
    (released ? manifest.private === true : manifest.private !== true) ||
    manifest.license !== "Apache-2.0" ||
    (released &&
      (manifest.version !== releaseVersion ||
        manifest.publishConfig?.access !== "restricted" ||
        manifest.sideEffects !== false))
  ) {
    throw new Error(`Invalid local package identity/publication guard: ${project.path}`);
  }
  if (
    manifest.scripts?.prepublishOnly !==
    `node ../../scripts/${released ? "publish-guard" : "deny-publish"}.mjs`
  )
    throw new Error(`Missing publish guard in ${project.path}`);
  const deps = {
    ...manifest.dependencies,
    ...manifest.devDependencies,
    ...manifest.peerDependencies,
  };
  for (const [name, version] of Object.entries(deps)) {
    if (
      name.startsWith("@usagekit/") &&
      ((!project.allows.includes(name) && !(project.typeAllows ?? []).includes(name)) ||
        version !==
          readJson(`${workspace.projects.find((p) => p.name === name)?.path}/package.json`).version)
    ) {
      throw new Error(`Disallowed workspace dependency in ${project.name}: ${name}`);
    }
  }
  for (const file of filesUnder(resolve(project.path)).filter(
    (f) => f.includes("/src/") || f.includes("/conformance/"),
  )) {
    if (/\.[cm]?[jt]sx?$/.test(file))
      validateImports(
        project,
        readFileSync(file, "utf8"),
        file,
        deps,
        file.endsWith(".test.ts") ? workspace.testDependencies : [],
      );
  }
}
const readmes = filesUnder(root).filter((f) => /(^|\/)readme\.md$/i.test(f));
if (readmes.length !== 1 || readmes[0] !== resolve("README.md"))
  throw new Error("Keep one root README.md.");
checkPackages({ requireBuild: false });
console.log(
  `Workspace boundaries verified: ${workspace.projects.length} projects, publication allow-list, runtime configs, one README, no tracked ADRs.`,
);
