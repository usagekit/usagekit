import { runStoreConformance, runStoreScalingConformance } from "@usagekit/store/conformance";
import { describe } from "vitest";
import { fixture } from "./test-fixture.js";

describe.each(["pg", "prisma"] as const)("%s", (mode) => {
  runStoreConformance(() => fixture(mode), {
    durable: true,
    rollingWindows: false,
    maxMoneyUnits: 2n ** 63n - 1n,
    maxQuantityScale: 18,
  });
  runStoreScalingConformance(async () => {
    const f = await fixture(mode);
    return {
      store: f.store,
      snapshot: () => ({ ...f.counters }),
      close: f.close,
      async readOnly(run) {
        await run();
      },
    };
  });
});
