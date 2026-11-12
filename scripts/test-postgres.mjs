import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { userInfo } from "node:os";
import "./check-runtime.mjs";
import { generatePrismaFixture } from "./generate-prisma-fixture.mjs";

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}`);
};
const tests = (url) => {
  generatePrismaFixture();
  run(
    process.execPath,
    [
      "node_modules/vitest/vitest.mjs",
      "run",
      "--project",
      "store-postgres",
      ...process.argv.slice(2),
    ],
    {
      env: { ...process.env, USAGEKIT_POSTGRES_TEST_URL: url },
    },
  );
};
const verifyRestart = (url, restart = () => {}) => {
  const env = {
    ...process.env,
    USAGEKIT_POSTGRES_TEST_URL: url,
    USAGEKIT_POSTGRES_RESTART_SCHEMA: `uk_restart_${randomUUID().replaceAll("-", "")}`,
  };
  const smoke = (mode) =>
    run(process.execPath, ["scripts/postgres-restart-smoke.mjs", mode], { env });
  try {
    smoke("prepare");
    const crash = spawnSync(process.execPath, ["scripts/postgres-restart-smoke.mjs", "crash"], {
      env,
      stdio: "inherit",
    });
    assert.equal(
      crash.signal,
      "SIGKILL",
      "expected the owned child to die inside its write transaction",
    );
    restart();
    smoke("verify");
  } finally {
    smoke("cleanup");
  }
};
if (process.env.USAGEKIT_POSTGRES_TEST_URL) {
  tests(process.env.USAGEKIT_POSTGRES_TEST_URL);
  verifyRestart(process.env.USAGEKIT_POSTGRES_TEST_URL);
} else {
  const config = spawnSync("pg_config", ["--bindir"], { encoding: "utf8" });
  const bin = process.env.POSTGRES_BIN ?? (config.status === 0 ? config.stdout.trim() : "");
  if (!bin)
    throw new Error(
      "Install PostgreSQL or set POSTGRES_BIN / USAGEKIT_POSTGRES_TEST_URL; real Postgres verification is required.",
    );
  const directory = mkdtempSync("/tmp/usagekit-pg-"),
    data = join(directory, "data");
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  let started = false;
  try {
    run(
      join(bin, "initdb"),
      ["-D", data, "--locale=C", "--encoding=UTF8", "--auth-local=trust", "--auth-host=trust"],
      { stdio: "ignore" },
    );
    run(join(bin, "pg_ctl"), [
      "-D",
      data,
      "-l",
      join(directory, "postgres.log"),
      "-o",
      `-h 127.0.0.1 -p ${port} -k ${directory}`,
      "-w",
      "-t",
      "30",
      "start",
    ]);
    started = true;
    run(join(bin, "createdb"), ["-h", "127.0.0.1", "-p", String(port), "usagekit_store_fixture"]);
    const url = `postgresql://${encodeURIComponent(userInfo().username)}@127.0.0.1:${port}/usagekit_store_fixture`;
    tests(url);
    verifyRestart(url, () => run(join(bin, "pg_ctl"), ["-D", data, "-m", "fast", "-w", "restart"]));
  } finally {
    if (started) run(join(bin, "pg_ctl"), ["-D", data, "-m", "fast", "-w", "stop"]);
    rmSync(directory, { recursive: true, force: true });
  }
}
