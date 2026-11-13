/** Compose fragments before numbering parameters; SQL text is never rewritten. */
class Parameter {
  constructor(readonly value: unknown) {}
}
type Part = string | Parameter;
export type ParameterizedQuery = {
  text: string;
  values: unknown[];
  /** Result fields consumed as integers; other numeric fields may contain fractions. */
  integerColumns?: readonly string[];
};
export class Statement {
  constructor(readonly parts: readonly Part[]) {}
  compile(): ParameterizedQuery {
    const values: unknown[] = [];
    const text = this.parts
      .map((part) => {
        if (typeof part === "string") return part;
        values.push(part.value);
        return `$${values.length}`;
      })
      .join("");
    return { text, values };
  }
}
const parts = (value: unknown): readonly Part[] =>
  value instanceof Statement ? value.parts : [new Parameter(value)];
export const SQL = {
  sql(strings: TemplateStringsArray, ...values: unknown[]): Statement {
    return new Statement(
      strings.flatMap((text, i) => (i < values.length ? [text, ...parts(values[i])] : [text])),
    );
  },
  join(values: readonly unknown[], separator = ","): Statement {
    return new Statement(
      values.flatMap((value, i) => (i === 0 ? [...parts(value)] : [separator, ...parts(value)])),
    );
  },
  empty: new Statement([]),
};
export function schemaIdentifier(schema: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw new TypeError("Invalid metering schema");
  return `"${schema}"`;
}
