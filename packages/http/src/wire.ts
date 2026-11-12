import { decodeMeterJson, normalizeLegacyMoney } from "@usagekit/core";
/** Only DTO integer fields become bigint. Decimal strings remain exact on the wire. */
export const encodeWire = (value: unknown): string =>
  JSON.stringify(normalizeLegacyMoney(value), (_, v) => (typeof v === "bigint" ? v.toString() : v));
export const decodeWire = decodeMeterJson;
export function decodeQuery(q: string): unknown {
  if (!/^[A-Za-z0-9_-]+$/.test(q)) throw new Error("Invalid query");
  const bytes = Uint8Array.from(atob(q.replaceAll("-", "+").replaceAll("_", "/")), (c) =>
    c.charCodeAt(0),
  );
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}
