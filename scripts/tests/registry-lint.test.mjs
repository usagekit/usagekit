import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const root = resolve(import.meta.dirname, "../..");
const lint = (input) => {
  const cwd = mkdtempSync(join(tmpdir(), "usagekit-registry-lint-"));
  try {
    cpSync(join(root, "biome.json"), join(cwd, "biome.json"));
    const path = "packages/registry/registry/radix/a11y-probe.tsx";
    mkdirSync(join(cwd, "packages/registry/registry/radix"), { recursive: true });
    writeFileSync(join(cwd, path), input);
    return spawnSync(resolve(root, "node_modules/.bin/biome"), ["lint", path], {
      cwd,
      encoding: "utf8",
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
};

for (const [rule, source] of [
  ["noLabelWithoutControl", "<label>Period</label>"],
  ["noNoninteractiveTabindex", "<span tabIndex={0}>Details</span>"],
  ["useSemanticElements", '<div role="group" aria-label="Providers" />'],
  ["useAltText", '<img src="provider.png" />'],
  ["useButtonType", "<button>Confirm</button>"],
]) {
  test(`registry lint rejects ${rule} regressions`, () => {
    const result = lint(`export const probe = ${source};`);
    assert.equal(result.status, 1);
    assert.match(result.stdout + result.stderr, new RegExp(`lint/a11y/${rule}`));
  });
}

test("registry lint accepts accessible controls and the host's decorative SVG exception", () => {
  const result = lint(`export const probe = <fieldset aria-label="Providers">
    <label htmlFor="period">Period</label><input id="period" />
    <button type="button"><svg aria-hidden="true" />Details</button>
  </fieldset>;`);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
