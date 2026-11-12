import { describe, afterAll } from "vitest";
import type { StoreFactory, StoreCapabilities } from "./factory.js";
import { expirationTests } from "./expiration.js";
import { reserveTests } from "./reserve.js";
import { admissionTests } from "./admission.js";
import { alertTests } from "./alerts.js";
import { tagTests } from "./tags.js";
import { dispatchTests } from "./dispatch.js";
import { authorityTests } from "./authority.js";
import { recoveryTests } from "./recovery.js";
import { readsTests } from "./reads.js";
import { operationsTests } from "./operations.js";
import { propertyTests } from "./properties.js";
import { capabilityTests } from "./capabilities.js";
import { counterTests } from "./counters.js";
import { billingTests } from "./billing.js";
import { settlementTests } from "./settlement.js";
import { correctionTests } from "./corrections.js";
import { nativeSettlementTests } from "./native-settlement.js";
export function runStoreConformance(factory: StoreFactory, capabilities: StoreCapabilities) {
  describe("store conformance", () => {
    reserveTests(factory);
    expirationTests(factory);
    admissionTests(factory);
    alertTests(factory);
    tagTests(factory);
    dispatchTests(factory);
    authorityTests(factory);
    recoveryTests(factory);
    readsTests(factory, capabilities);
    operationsTests(factory);
    counterTests(factory);
    billingTests(factory, capabilities);
    settlementTests(factory);
    nativeSettlementTests(factory, capabilities);
    correctionTests(factory, capabilities);
    propertyTests(factory);
    capabilityTests(factory, capabilities);
    afterAll(() =>
      console.info(
        "Skipped guarantees: " +
          [!capabilities.durable && "durable", !capabilities.rollingWindows && "rollingWindows"]
            .filter(Boolean)
            .join(", "),
      ),
    );
  });
}
