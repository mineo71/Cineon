// Reads JSON the way Swift's synthesised `Decodable` does: a missing optional is nil, a missing
// required value or a value of the wrong type fails the whole document. Integers may be written as
// 2024.0 or 1e3, as JSONDecoder allows, but not as 2024.5 or "2024". Port of StrictJson.cs.

export class Mismatch extends Error {}

export type JsonObject = Record<string, unknown>;

/** `JSON.parse`, failing with a `Mismatch` like any other decoding error. */
export function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Mismatch(e instanceof Error ? e.message : "Not JSON");
  }
}

function kind(v: unknown): string {
  return v === null ? "null" : Array.isArray(v) ? "array" : typeof v;
}

export function object(v: unknown): JsonObject {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Mismatch(`Expected an object, found ${kind(v)}`);
  return v as JsonObject;
}

function value(o: JsonObject, key: string): unknown {
  if (!Object.hasOwn(o, key)) return undefined;
  const v = o[key];
  return v === null ? undefined : v;
}

export function string(o: JsonObject, key: string): string | null {
  const v = value(o, key);
  if (v === undefined) return null;
  if (typeof v !== "string") throw new Mismatch(`${key} is ${kind(v)}, not a string`);
  return v;
}

export function requiredString(o: JsonObject, key: string): string {
  const v = string(o, key);
  if (v === null) throw new Mismatch(`Missing ${key}`);
  return v;
}

const INT64_LIMIT = 2 ** 63;

/** Swift's `Int`: a whole number that fits 64 bits, however it's written. */
export function int(o: JsonObject, key: string): number | null {
  const v = value(o, key);
  if (v === undefined) return null;
  if (typeof v !== "number") throw new Mismatch(`${key} is ${kind(v)}, not a number`);
  if (!Number.isInteger(v) || v >= INT64_LIMIT || v < -INT64_LIMIT) throw new Mismatch(`${key} is not a whole number that fits`);
  return v === 0 ? 0 : v;
}

export function array(o: JsonObject, key: string): unknown[] | null {
  const v = value(o, key);
  if (v === undefined) return null;
  if (!Array.isArray(v)) throw new Mismatch(`${key} is ${kind(v)}, not an array`);
  return v;
}

export function requiredArray(o: JsonObject, key: string): unknown[] {
  const v = array(o, key);
  if (v === null) throw new Mismatch(`Missing ${key}`);
  return v;
}

export function optionalObject(o: JsonObject, key: string): JsonObject | null {
  const v = value(o, key);
  return v === undefined ? null : object(v);
}

export function stringArray(o: JsonObject, key: string): string[] | null {
  const items = array(o, key);
  if (items === null) return null;
  return items.map((item) => {
    if (typeof item !== "string") throw new Mismatch(`${key} holds ${kind(item)}, not strings`);
    return item;
  });
}
