import { expect, test } from "vitest";
import * as core from "./index.js";

const operations = [
  { id: "search", billable: true },
  { id: "account", billable: false },
];

test.each(["passthrough", "unpriced"])(
  "platform billable configuration rejects %s tracking",
  (tracking) => {
    expect(
      core.validateConnectionPolicy(
        { fundingSource: "platform", tracking: { search: tracking } },
        operations,
      ),
    ).toMatchObject({
      outcome: "invalid",
      field: "tracking.search",
      reason: expect.stringContaining("credits"),
    });
  },
);

test("BYOK passthrough and platform metered/free configurations remain valid", () => {
  expect(
    core.validateConnectionPolicy(
      { fundingSource: "byok", tracking: { search: "passthrough" } },
      operations,
    ),
  ).toBeNull();
  expect(
    core.validateConnectionPolicy(
      { fundingSource: "platform", tracking: { search: "metered", account: "passthrough" } },
      operations,
    ),
  ).toBeNull();
});

test.each([null, [], "passthrough", { search: "typo" }, { missing: "metered" }])(
  "invalid tracking input is rejected: %j",
  (tracking) => {
    expect(
      core.validateConnectionPolicy({ fundingSource: "byok", tracking }, operations),
    ).toMatchObject({ outcome: "invalid" });
  },
);

test("default tracking and explicit BYOK metering remain valid", () => {
  expect(core.validateConnectionPolicy({ fundingSource: "platform" }, operations)).toBeNull();
  expect(
    core.validateConnectionPolicy(
      { fundingSource: "byok", tracking: { search: "metered" } },
      operations,
    ),
  ).toBeNull();
});

test.each(["manualPrices", "manualPriceBasis"] as const)(
  "platform treats null and empty %s as absent",
  (field) => {
    for (const value of [null, {}])
      expect
        .soft(
          core.validateConnectionPolicy({ fundingSource: "platform", [field]: value }, operations),
        )
        .toBeNull();
  },
);
