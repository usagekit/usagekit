import { expect, test, vi } from "vitest";
import { fork } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createManualClock } from "@usagekit/store";
import { createRemoteMeter } from "@usagekit/client";
import { startServer } from "./index.js";
test("SIGKILL after reserve before intent: startup expiry restores headroom", async () => {
  const dir = mkdtempSync(join(tmpdir(), "usagekit-orphan-")),
    clock = createManualClock();
  let token = "",
    s = await startServer({
      configDir: dir,
      port: 0,
      clock,
      onToken: (t) => {
        token = t;
      },
    });
  const clientModule = new URL("../../client/dist/index.js", import.meta.url).href;
  const script = `import {createRemoteMeter} from ${JSON.stringify(clientModule)};const meter=createRemoteMeter({baseUrl:process.env.URL,token:process.env.TOKEN});const result=await meter.reserve({operationId:'orphan',reservationTtlMs:1000,scope:{namespace:'local',principal:'local',connection:'c'},fundingSource:'byok',costOwner:'local',surface:'programmatic',source:'cli',provider:'example',operation:'search',estimate:[{unit:'requests',value:1n,scale:0}]});process.on('message',()=>{});process.send({outcome:result.outcome});`;
  let child: ReturnType<typeof fork> | undefined;
  try {
    s.vault.unlock("test-passphrase");
    s.vault.put("example", "c", "test-secret");
    s.vault.lock();
    s.store.putBudget({
      id: "b",
      version: 1,
      scope: { kind: "principal", namespace: "local", principal: "local" },
      unit: "requests",
      limit: { unit: "requests", value: 1n, scale: 0 },
      surface: "any",
      window: { kind: "calendar_month", timezone: "UTC" },
      onExceed: "block",
    });
    child = fork("--eval", [script], {
      execArgv: ["--input-type=module"],
      env: { ...process.env, URL: s.url, TOKEN: token },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    const message = await new Promise((resolve, reject) => {
      child!.once("message", resolve);
      child!.once("error", reject);
      child!.once("exit", () => reject(new Error("child exited before reserve")));
    });
    expect(message).toEqual({ outcome: "reserved" });
    const exited = new Promise((resolve) => child!.once("exit", resolve));
    child.kill("SIGKILL");
    await exited;
    await s.stop();
    clock.advance(1000);
    s = await startServer({
      configDir: dir,
      port: 0,
      clock,
      onToken: () => {
        throw new Error("token printed twice");
      },
    });
    const orphan = await s.store.getOperation({
      namespace: "local",
      principal: "local",
      operationId: "orphan",
    });
    expect(orphan).toMatchObject({ state: "released", version: 2, lease: null });
    expect(
      await createRemoteMeter({ baseUrl: s.url, token }).reserve({
        operationId: "next",
        scope: { namespace: "local", principal: "local", connection: "c" },
        fundingSource: "byok",
        costOwner: "local",
        surface: "programmatic",
        source: "cli",
        provider: "example",
        operation: "search",
        estimate: [{ unit: "requests", value: 1n, scale: 0 }],
      }),
    ).toMatchObject({ outcome: "reserved" });
    console.info(
      "Orphan recovery: SIGKILL between reserve and intent -> restart -> expired reservation released -> full headroom available",
    );
  } finally {
    child?.kill();
    await s.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("idle local server periodically expires reservations without a new caller", async () => {
  const dir = mkdtempSync(join(tmpdir(), "usagekit-idle-expiry-")),
    clock = createManualClock();
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const s = await startServer({ configDir: dir, port: 0, clock, onToken: () => {} });
  try {
    const ref = { namespace: "local", principal: "local", operationId: "idle" };
    await s.store.reserve({
      operationId: "idle",
      reservationTtlMs: 1,
      scope: { namespace: "local", principal: "local", connection: "c" },
      fundingSource: "byok",
      costOwner: "local",
      surface: "app",
      source: "app",
      provider: "example",
      operation: "search",
      estimate: [{ value: 1n, scale: 0, unit: "requests" }],
    });
    clock.advance(1);
    expect(await s.store.getOperation(ref)).toMatchObject({ state: "reserved" });
    await vi.advanceTimersByTimeAsync(30000);
    expect(await s.store.getOperation(ref)).toMatchObject({ state: "released" });
  } finally {
    await s.stop();
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  }
});
