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
