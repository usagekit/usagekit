import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { build } from "esbuild";

// Read only committed objects from the existing repository, with no checkout or network.
const base = "c6865b250e01ee2e45bee01446b52f18ddd125db";
if (!process.argv[2])
  throw new Error("Usage: node scripts/capture-policy-free.mjs SCRATCH_DIRECTORY");
const scratch = resolve(process.argv[2]);
mkdirSync(scratch, { recursive: true });
const temporary = mkdtempSync(join(scratch, "policy-free-"));
try {
  const archive = execFileSync("git", ["archive", base, "packages/core/src", "packages/store/src"]);
  execFileSync("tar", ["-x", "-C", temporary], { input: archive });
  const bundle = join(temporary, "capture.mjs");
  await build({
    stdin: {
      contents: `import { createMemoryStore, createManualClock } from '@usagekit/store';
        import { capturePolicyFree, serializePolicyFree } from './packages/store/conformance/policy-free.ts';
        process.stdout.write(serializePolicyFree(await capturePolicyFree(createMemoryStore({ clock: createManualClock(), budgets: [] }))));`,
      resolveDir: process.cwd(),
      loader: "ts",
    },
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: bundle,
    alias: {
      "@usagekit/core": join(temporary, "packages/core/src/index.ts"),
      "@usagekit/store": join(temporary, "packages/store/src/index.ts"),
    },
  });
  const json = execFileSync(process.execPath, [bundle], { encoding: "utf8" });
  writeFileSync(join(scratch, "policy-free-0.11.0.json"), json);
  process.stdout.write(
    `// Captured from ${base}; see policy-free-golden.md.\nexport default ${json.trim()};\n`,
  );
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
