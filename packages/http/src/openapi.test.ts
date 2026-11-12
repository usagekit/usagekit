import { expect, test } from "vitest";
import { generateOpenApi } from "./openapi.js";
// Checked through a web-standard import; generation itself is a separate Node script.
import document from "../openapi.json" with { type: "json" };
test("checked-in OpenAPI is current", () => {
  expect(generateOpenApi()).toEqual(document);
});

test("every published OpenAPI enum has unique values", () => {
  const duplicates: string[] = [];
  const visit = (node: unknown, path: string) => {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach((value, index) => visit(value, `${path}/${index}`));
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === "enum" && Array.isArray(value)) {
        const values = value.map((item) => JSON.stringify(item));
        if (new Set(values).size !== values.length) duplicates.push(`${path}/enum`);
      }
      visit(value, `${path}/${key}`);
    }
  };
  visit(generateOpenApi(), "generated");
  visit(document, "published");
  expect(duplicates).toEqual([]);
});

test("C6 OpenAPI and runtime agree on money scale and policy boundaries", async () => {
  const { Ajv } = await import("ajv");
  const v = await import("valibot");
  const { schemas, responses, Money } = await import("./schemas/index.js");
  const doc = generateOpenApi() as any;
  const reserveSchema =
    doc.paths["/v1/operations/reserve"].post.requestBody.content["application/json"].schema;
  const ajv = new Ajv({ strict: false, validateFormats: false });
  const policySchema = reserveSchema.properties.settlementPolicy;
  expect(policySchema.properties.requiredUnits.items).toMatchObject({
    pattern: "^[\\s\\S]*\\S[\\s\\S]*$",
    not: { const: "budget_cents" },
  });
  const policy = ajv.compile(policySchema);
  for (const requiredUnits of [
    [],
    ["requests"],
    Array.from({ length: 64 }, (_, n) => "unit" + n),
    Array.from({ length: 65 }, (_, n) => "unit" + n),
    ["requests", "requests"],
    ["budget_cents"],
    ["budget_cents_extra"],
    ["budget_cents\n"],
    [""],
    ["\n\t"],
    [" "],
    ["a b"],
  ]) {
    const value = { requiredUnits, requireMoney: false };
    const runtime = v.safeParse((schemas.reserve as any).entries.settlementPolicy, value).success;
    const expected =
      requiredUnits.length > 0 &&
      requiredUnits.length <= 64 &&
      new Set(requiredUnits).size === requiredUnits.length &&
      requiredUnits.every((u) => u.trim() && u !== "budget_cents");
    expect(runtime, JSON.stringify(value)).toBe(expected);
    expect(policy(value), JSON.stringify(value)).toBe(expected);
  }
  const moneySchema =
    doc.paths["/v1/operations/settle"].post.requestBody.content["application/json"].schema
      .properties.receipt.properties.cost.anyOf[1].properties.money;
  const checkMoney = ajv.compile(moneySchema);
  const reconciliationSchema = doc.paths["/v1/billing/import"].post.responses["200"].content[
    "application/json"
  ].schema.anyOf.find((s: any) => s.properties?.record)?.properties.record.properties
    .reconciliations.items;
  const checkDifference = ajv.compile(reconciliationSchema.properties.differenceScale);
  for (const scale of [-1, 0, 4, 18, 19, 2.5]) {
    const expected = Number.isInteger(scale) && scale >= 0 && scale <= 18;
    expect(checkMoney({ units: "1", currency: "USD", scale })).toBe(expected);
    expect(v.safeParse(Money, { units: "1", currency: "USD", scale }).success).toBe(expected);
    expect(checkDifference(scale)).toBe(expected);
    expect(
      v.safeParse(
        (responses.importBilling as any).options.find((s: any) => s.entries?.record).entries.record
          .entries.reconciliations.item.entries.differenceScale,
        scale,
      ).success,
    ).toBe(expected);
  }
});
