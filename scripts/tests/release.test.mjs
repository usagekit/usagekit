import assert from "node:assert/strict";
import { test } from "node:test";
import {
  privatePackageTerms,
  publishArgs,
  validatePackFiles,
  validateReleaseIdentity,
} from "../lib/release.mjs";

test("public site source exceptions cannot leak a private term into a library tarball", () => {
  const terms = privatePackageTerms(
    "PrivateWord allow: packages/site/ docs/SITE.md\n\nOtherWord\n",
  );
  assert.deepEqual(terms, ["privateword", "otherword"]);
  assert.throws(() => validatePackFiles(["dist/privateword.js"], terms));
});

test("release requires reviewed main and its annotated version tag", () => {
  const valid = { branch: "main", head: "a", tagCommit: "a", tagType: "tag" };
  validateReleaseIdentity(valid);
  for (const change of [{ branch: "feat/example" }, { tagCommit: "b" }, { tagType: "commit" }])
    assert.throws(() => validateReleaseIdentity({ ...valid, ...change }));
});
test("tarball audit rejects source, test files, maps, missing notices and private terms", () => {
  const files = ["package.json", "LICENSE", "NOTICE", "dist/index.js", "dist/index.d.ts"];
  validatePackFiles(files, []);
  for (const path of [
    "src/index.ts",
    "dist/a.test.js",
    "dist/index.js.map",
    ".env",
    "dist/privateword.js",
  ])
    assert.throws(() => validatePackFiles([...files, path], ["privateword"]));
  assert.throws(() =>
    validatePackFiles(
      files.filter((f) => f !== "NOTICE"),
      [],
    ),
  );
  assert.throws(() => validatePackFiles(files, [], true));
  validatePackFiles(
    [...files, "dist/conformance/index.js", "dist/conformance/index.d.ts"],
    [],
    true,
  );
});
test("release publishes the allow-listed packages with public access", () => {
  const args = publishArgs();
  assert.deepEqual(args.slice(0, 15), [
    "publish",
    "--workspace",
    "@usagekit/core",
    "--workspace",
    "@usagekit/store",
    "--workspace",
    "@usagekit/meter",
    "--workspace",
    "@usagekit/providers",
    "--workspace",
    "@usagekit/views",
    "--workspace",
    "@usagekit/react",
    "--workspace",
    "@usagekit/store-postgres",
  ]);
  assert.equal(args[args.indexOf("--access") + 1], "public");
  assert.equal(args.includes("restricted"), false);
  assert.equal(args[args.indexOf("--registry") + 1], "https://registry.npmjs.org/");
});
test("the 0.9.0 contract cohort stays aligned across public and private consumers", async () => {
  const { readFileSync } = await import("node:fs");
  const { releaseVersion } = await import("../lib/release.mjs");
  assert.equal(releaseVersion, "0.9.0");
  for (const name of [
    "core",
    "store",
    "meter",
    "http",
    "client",
    "views",
    "react",
    "providers",
    "store-postgres",
  ]) {
    const manifest = JSON.parse(
      readFileSync(new URL(`../../packages/${name}/package.json`, import.meta.url), "utf8"),
    );
    assert.equal(manifest.version, releaseVersion, name);
  }
});
