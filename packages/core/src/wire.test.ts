import { expect, test } from "vitest";
import { decodeMeterJson } from "./wire.js";
test("integer conversion follows DTO shapes rather than generic field names", () => {
  const data = {
    metadata: { value: "0007", units: "0008", unknownOperations: "0009" },
    money: { currency: "USD", units: "9223372036854775807" },
    quantity: { unit: "units", value: "1", scale: 18 },
    query: { units: ["42"] },
    row: {
      dimensions: { provider: "example" },
      measurements: [],
      cost: { certainty: "unknown", money: null },
      fundingSource: "byok",
      costOwner: "u",
      unknownOperations: "2",
    },
    counted: { dimensions: { operation: "search" }, state: "passthrough", count: "3" },
    notCounted: { dimensions: {}, state: "metered", count: "3" },
  };
  expect(decodeMeterJson(JSON.stringify(data))).toEqual({
    ...data,
    money: { currency: "USD", units: 9223372036854775807n },
    quantity: { unit: "units", value: 1n, scale: 18 },
    row: { ...data.row, unknownOperations: 2n },
    counted: { ...data.counted, count: 3n },
  });
});

test("billing reconciliation restores signed differences and unknown counts without changing metadata", () => {
  const entry = {
    id: "r",
    importId: "i",
    kind: "import_total",
    scope: { namespace: "n", principal: "p", connection: "c" },
    window: { from: "2026-10-01T00:00:00Z", to: "2026-11-01T00:00:00Z" },
    ledgerTotal: { certainty: "measured", money: { currency: "USD", units: "9007199254740993" } },
    evidenceTotal: { currency: "USD", units: "9007199254740992" },
    differenceUnits: "-1",
    unknownOperations: "0",
    metadata: { differenceUnits: "-001", unknownOperations: "002" },
  };
  expect(decodeMeterJson(JSON.stringify(entry))).toEqual({
    ...entry,
    ledgerTotal: { certainty: "measured", money: { currency: "USD", units: 9007199254740993n } },
    evidenceTotal: { currency: "USD", units: 9007199254740992n },
    differenceUnits: -1n,
    unknownOperations: 0n,
  });
  expect(
    decodeMeterJson(JSON.stringify({ ...entry, differenceUnits: null, unknownOperations: "2" })),
  ).toMatchObject({ differenceUnits: null, unknownOperations: 2n });
});

test("explicit money scale survives wire decoding without coercing unrelated objects", () => {
  expect(decodeMeterJson('{"money":{"currency":"USD","units":"13","scale":8}}')).toEqual({
    money: { currency: "USD", units: 13n, scale: 8 },
  });
  expect(decodeMeterJson('{"currency":"USD","units":"13","other":8}')).toEqual({
    currency: "USD",
    units: "13",
    other: 8,
  });
});
