import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import ts from "typescript";
import { filesUnder } from "./lib/workspace.mjs";

const root = resolve(import.meta.dirname, "..");
let failed = false;
try {
  execFileSync(
    join(root, "node_modules/.bin/biome"),
    ["lint", "--max-diagnostics=none", "packages/registry/registry"],
    {
      cwd: root,
      stdio: "inherit",
    },
  );
} catch {
  failed = true;
}
// Include type-only edges too: copied blocks must not depend on a host's cycle exclusions.
for (const variant of ["radix", "base"]) {
  const files = filesUnder(join(root, "packages/registry/registry", variant)).filter((file) =>
    file.endsWith(".tsx"),
  );
  const byName = new Map(files.map((file) => [basename(file, ".tsx"), file]));
  const graph = new Map(
    files.map((file) => [
      file,
      ts
        .preProcessFile(readFileSync(file, "utf8"), true, true)
        .importedFiles.flatMap(({ fileName }) => {
          const target = fileName.startsWith("@/components/usagekit/")
            ? byName.get(fileName.slice("@/components/usagekit/".length))
            : fileName.startsWith(".")
              ? resolve(dirname(file), `${fileName.replace(/\.[jt]sx?$/, "")}.tsx`)
              : undefined;
          return target && files.includes(target) ? [target] : [];
        }),
    ]),
  );
  const complete = new Set();
  function visit(file, path = []) {
    if (path.includes(file)) {
      console.error(
        `Registry import cycle: ${[...path.slice(path.indexOf(file)), file].map((p) => basename(p)).join(" -> ")}`,
      );
      failed = true;
      return;
    }
    if (complete.has(file)) return;
    for (const target of graph.get(file) ?? []) visit(target, [...path, file]);
    complete.add(file);
  }
  for (const file of files) visit(file);
}
if (failed) process.exitCode = 1;
