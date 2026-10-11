import { schemas, responses, routes } from "./schemas/index.js";
/** Translate the Valibot schema graph, including strict object and decimal validation. */
function jsonSchema(s: any): Record<string, unknown> {
  if (s.pipe) {
    const [base, ...actions] = s.pipe;
    const out = jsonSchema({ ...base, pipe: undefined });
    for (const a of actions) {
      if (a.type === "regex") out.pattern = a.requirement.source;
      if (a.type === "integer") out.type = "integer";
      if (a.type === "min_value") out.minimum = a.requirement;
      if (a.type === "max_value") out.maximum = a.requirement;
      if (a.type === "min_length")
        out[out.type === "array" ? "minItems" : "minLength"] = a.requirement;
      if (a.type === "max_length")
        out[out.type === "array" ? "maxItems" : "maxLength"] = a.requirement;
      if (a.type === "iso_timestamp") out.format = "date-time";
      if (a.type === "ends_with") out.pattern = `${a.requirement}$`;
    }
    return out;
  }
  switch (s.type) {
    case "string":
    case "number":
    case "boolean":
    case "null":
      return { type: s.type };
    case "literal":
      return { const: s.literal };
    case "picklist":
      return { enum: s.options };
    case "optional":
      return jsonSchema(s.wrapped);
    case "nullable":
      return { anyOf: [jsonSchema(s.wrapped), { type: "null" }] };
    case "array":
      return { type: "array", items: jsonSchema(s.item) };
    case "union":
    case "variant":
      return { anyOf: s.options.map(jsonSchema) };
    case "record":
      return { type: "object", additionalProperties: jsonSchema(s.value) };
    case "strict_object":
      return {
        type: "object",
        additionalProperties: false,
        properties: Object.fromEntries(
          Object.entries(s.entries).map(([k, v]) => [k, jsonSchema(v)]),
        ),
        required: Object.entries(s.entries)
          .filter(([, v]) => (v as any).type !== "optional")
          .map(([k]) => k),
      };
    default:
      throw new Error(`Unsupported schema node ${s.type}`);
  }
}
export function generateOpenApi() {
  const paths: Record<string, unknown> = {};
  for (const [name, schema] of Object.entries(schemas)) {
    const response = jsonSchema(responses[name as keyof typeof responses]),
      { read, path } = routes[name as keyof typeof routes];
    const operation = {
      security: [{ bearerAuth: [] }],
      ...(read
        ? name === "quote"
          ? {
              description:
                "Authorized advisory estimate using the same pricing resolution as reserve. Available with commands: false. Never mutates accounting or dispatches a provider call; budget availability is not admission.",
            }
          : {}
        : {
            description:
              name === "importBilling"
                ? "Billing import command. Requires explicit canImportBilling permission from verified server authentication and host connection ownership. A handler mounted with commands: false answers 404 here after authentication. Never dispatches a provider request."
                : "Command route. A handler mounted with commands: false answers 404 here after authentication.",
          }),
      responses: {
        "200": {
          description: "Typed result",
          content: { "application/json": { schema: response } },
        },
        "400": { description: "Invalid schema" },
        "401": { description: "Authentication required" },
        "403": { description: "Forbidden" },
        ...(read ? {} : { "404": { description: "Commands disabled on this mount" } }),
        "500": { description: "Unexpected failure" },
      },
      ...(read
        ? {
            parameters: [
              ...(name === "operation"
                ? [{ name: "id", in: "path", required: true, schema: { type: "string" } }]
                : []),
              {
                name: "q",
                in: "query",
                required: true,
                description: "Base64url-encoded JSON query",
                schema: { type: "string" },
                "x-decoded-schema": jsonSchema(schema),
              },
            ],
          }
        : {
            requestBody: {
              required: true,
              content: { "application/json": { schema: jsonSchema(schema) } },
            },
          }),
    };
    paths[path] = { [read ? "get" : "post"]: operation };
    if (name === "usage")
      paths["/v1/usage/query"] = {
        post: {
          ...operation,
          parameters: [],
          requestBody: {
            required: true,
            content: { "application/json": { schema: jsonSchema(schema) } },
          },
        },
      };
  }
  return {
    openapi: "3.1.0",
    info: { title: "usagekit", version: "0.0.0" },
    components: { securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } } },
    paths,
  };
}
