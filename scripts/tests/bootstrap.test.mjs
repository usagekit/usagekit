import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { git } from "../lib/git.mjs";
import { satisfiesRuntimeRange } from "../lib/runtime.mjs";
import { clearExpiredApproval } from "../lib/approval.mjs";
import { checkPrivateTerms } from "../lib/private-terms.mjs";

function temporary(t) {
  const dir = mkdtempSync(join(tmpdir(), "usagekit-bootstrap-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("runtime ranges accept stable patches and reject old or next-major releases", () => {
  for (const version of ["22.23.4", "22.23.5", "22.24.0"])
    assert.ok(satisfiesRuntimeRange(version, ">=22.23.4 <23"));
  for (const version of [
    "22.23.0",
    "22.23.1",
    "22.23.2",
    "22.23.3",
    "21.99.0",
    "23.0.0",
    "22.24.0-rc.1",
  ])
    assert.equal(satisfiesRuntimeRange(version, ">=22.23.4 <23"), false);
  assert.ok(satisfiesRuntimeRange("10.9.4", ">=10.9.3 <11"));
  assert.equal(satisfiesRuntimeRange("10.9.2", ">=10.9.3 <11"), false);
  assert.equal(satisfiesRuntimeRange("11.0.0", ">=10.9.3 <11"), false);
});

test("manifest and runtime selection enforce the patched Node baseline", () => {
  const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  const lock = JSON.parse(
    readFileSync(new URL("../../package-lock.json", import.meta.url), "utf8"),
  );
  const pinned = readFileSync(new URL("../../.nvmrc", import.meta.url), "utf8").trim();
  assert.equal(pinned, "22.23.4");
  assert.equal(manifest.engines.node, ">=22.23.4 <23");
  assert.equal(lock.packages[""].engines.node, manifest.engines.node);
  assert.ok(satisfiesRuntimeRange(pinned, manifest.engines.node));
  for (const version of ["22.23.1", "22.23.2", "22.23.3", "22.23.4-rc.1", "23.0.0"])
    assert.equal(satisfiesRuntimeRange(version, manifest.engines.node), false);
  assert.equal(manifest.packageManager, "npm@10.9.3");
  assert.equal(manifest.engines.npm, ">=10.9.3 <11");
});

test("expired approval is removed while active approval reports path and lifetime", (t) => {
  const file = join(temporary(t), "main-approval.json");
  writeFileSync(file, JSON.stringify({ expiresAt: 999 }));
  clearExpiredApproval(file, 1000);
  assert.equal(existsSync(file), false);
  writeFileSync(file, JSON.stringify({ expiresAt: 60_500 }));
  assert.throws(
    () => clearExpiredApproval(file, 1000),
    (error) => {
      assert.ok(error.message.includes(file));
      assert.match(error.message, /60 seconds remaining/);
      return true;
    },
  );
  assert.ok(existsSync(file));
});

test("private terms cover untracked source, tracked files and staged-only content", (t) => {
  const cwd = temporary(t);
  git(["init", "-b", "chore/fixture"], { cwd });
  checkPrivateTerms(cwd); // Missing private configuration is allowed.
  mkdirSync(join(cwd, "docs/adr"), { recursive: true });
  mkdirSync(join(cwd, "scripts"));
  writeFileSync(join(cwd, "docs/adr/private-terms.txt"), "InternalExample\n");
  const script = join(cwd, "scripts/probe.txt");
  writeFileSync(script, "INTERNALexample");
  assert.throws(() => checkPrivateTerms(cwd), /Private term found/);
  rmSync(script);
  const tracked = join(cwd, "outside-source.txt");
  writeFileSync(tracked, "InternalExample");
  git(["add", "outside-source.txt"], { cwd });
  writeFileSync(tracked, "safe worktree");
  assert.throws(() => checkPrivateTerms(cwd), /Private term found/);
  git(["add", "outside-source.txt"], { cwd });
  checkPrivateTerms(cwd);
});

test("a private term can be allowed under listed paths only", (t) => {
  const cwd = temporary(t);
  git(["init", "-b", "chore/fixture"], { cwd });
  mkdirSync(join(cwd, "docs/adr"), { recursive: true });
  mkdirSync(join(cwd, "packages/site"), { recursive: true });
  mkdirSync(join(cwd, "packages/core"), { recursive: true });
  writeFileSync(
    join(cwd, "docs/adr/private-terms.txt"),
    "InternalExample allow: packages/site/ docs/SITE.md\nOtherSecret\n",
  );
  writeFileSync(join(cwd, "packages/site/page.tsx"), "Built with InternalExample");
  writeFileSync(join(cwd, "docs/SITE.md"), "InternalExample is public here");
  git(["add", "docs/SITE.md"], { cwd });
  checkPrivateTerms(cwd);
  writeFileSync(join(cwd, "packages/site/other.tsx"), "othersecret");
  assert.throws(() => checkPrivateTerms(cwd), /Private term found/);
  rmSync(join(cwd, "packages/site/other.tsx"));
  writeFileSync(join(cwd, "packages/core/index.ts"), "internalexample");
  assert.throws(() => checkPrivateTerms(cwd), /Private term found/);
  rmSync(join(cwd, "packages/core/index.ts"));
  writeFileSync(join(cwd, "docs/OTHER.md"), "InternalExample");
  git(["add", "docs/OTHER.md"], { cwd });
  assert.throws(() => checkPrivateTerms(cwd), /Private term found/);
});

test("node:fs compiles under Node config and fails under web config", (t) => {
  const cwd = temporary(t);
  const root = fileURLToPath(new URL("../../", import.meta.url));
  writeFileSync(join(cwd, "package.json"), '{"type":"module"}');
  writeFileSync(
    join(cwd, "probe.ts"),
    'import { readFileSync } from "node:fs";\nvoid readFileSync;\n',
  );
  for (const runtime of ["node", "base"]) {
    writeFileSync(
      join(cwd, "tsconfig.json"),
      JSON.stringify({
        extends: join(root, `tsconfig.${runtime}.json`),
        compilerOptions: {
          noEmit: true,
          composite: false,
          typeRoots: [join(root, "node_modules/@types")],
        },
        files: ["probe.ts"],
      }),
    );
    const result = spawnSync(
      process.execPath,
      [join(root, "node_modules/typescript/bin/tsc"), "-p", join(cwd, "tsconfig.json")],
      { encoding: "utf8" },
    );
    if (runtime === "node") assert.equal(result.status, 0, result.stdout + result.stderr);
    else {
      assert.notEqual(result.status, 0);
      assert.match(result.stdout, /node:fs/);
    }
  }
});
