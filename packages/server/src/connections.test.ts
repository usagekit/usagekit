import { expect, test } from "vitest";
import { createCatalog, serpapi } from "@usagekit/providers";
import { connectionMetadata } from "./connections.js";

const catalog = createCatalog({ providers: [serpapi], enabled: ["serpapi"] });

test.each(["passthrough", "unpriced"])(
  "local configuration rejects platform billable %s tracking",
  (tracking) => {
    expect(
      connectionMetadata(
        { provider: "serpapi", fundingSource: "platform", tracking: { search: tracking } },
        catalog,
      ),
    ).toBeNull();
  },
);

test("local configuration preserves BYOK passthrough", () => {
  expect(
    connectionMetadata(
      { provider: "serpapi", fundingSource: "byok", tracking: { search: "passthrough" } },
      catalog,
    ),
  ).toEqual({ tracking: { search: "passthrough" } });
});
