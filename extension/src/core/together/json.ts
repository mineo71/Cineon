// Reads JSON values the way Swift's JSONDecoder does for the Together types (port of C#'s JsonRead in
// windows/Cineon.Core/Together/TogetherTypes.cs). Required fields throw when missing or of the wrong
// type, synthesized optionals accept a missing key or null, and the fields the Mac reads with `try?`
// fall back quietly. Every number is a float64, as Convex sends it.

/** A value of the wrong shape: Swift's DecodingError. The client turns it into a TogetherError. */
export class DecodeError extends Error {
  override name = "DecodeError";
}

export type JsonObject = Record<string, unknown>;

export function isNull(value: unknown): boolean {
  return value === null || value === undefined;
}

export function requireObject(value: unknown): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DecodeError(`Expected an object, found ${kindOf(value)}`);
  }
  return value as JsonObject;
}

function kindOf(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "nothing";
  if (Array.isArray(value)) return "a list";
  return typeof value;
}

function has(o: JsonObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, key) && o[key] !== undefined;
}

/** Present and not null. */
function present(o: JsonObject, key: string): boolean {
  return has(o, key) && o[key] !== null;
}

export function required(o: JsonObject, key: string): unknown {
  if (!has(o, key)) throw new DecodeError(`Missing "${key}"`);
  return o[key];
}

export function string(o: JsonObject, key: string): string {
  const value = required(o, key);
  if (typeof value !== "string") throw new DecodeError(`"${key}" isn't text`);
  return value;
}

export function number(o: JsonObject, key: string): number {
  const value = required(o, key);
  if (typeof value !== "number") throw new DecodeError(`"${key}" isn't a number`);
  return value;
}

export function bool(o: JsonObject, key: string): boolean {
  const value = required(o, key);
  if (typeof value !== "boolean") throw new DecodeError(`"${key}" isn't true or false`);
  return value;
}

/** A synthesized Swift optional: missing or null is null, anything else must be text. */
export function optionalString(o: JsonObject, key: string): string | null {
  if (!present(o, key)) return null;
  const value = o[key];
  if (typeof value !== "string") throw new DecodeError(`"${key}" isn't text`);
  return value;
}

export function optionalNumber(o: JsonObject, key: string): number | null {
  if (!present(o, key)) return null;
  const value = o[key];
  if (typeof value !== "number") throw new DecodeError(`"${key}" isn't a number`);
  return value;
}

export function optional<T>(o: JsonObject, key: string, read: (value: unknown) => T): T | null {
  return present(o, key) ? read(o[key]) : null;
}

/** Swift's `try? decodeIfPresent(String.self)`: anything that isn't text is null. */
export function lenientString(o: JsonObject, key: string): string | null {
  const value = o[key];
  return present(o, key) && typeof value === "string" ? value : null;
}

export function lenientNumber(o: JsonObject, key: string): number | null {
  const value = o[key];
  return present(o, key) && typeof value === "number" ? value : null;
}

/** Read as a double and truncated, as the Mac does with `Int(double)`. */
export function lenientInt(o: JsonObject, key: string): number | null {
  const d = lenientNumber(o, key);
  return d !== null && Number.isFinite(d) && Math.abs(d) < 2147483647 ? Math.trunc(d) : null;
}

export function array<T>(o: JsonObject, key: string, read: (value: unknown) => T): T[] {
  return arrayOf(required(o, key), read);
}

export function arrayOf<T>(value: unknown, read: (value: unknown) => T): T[] {
  if (!Array.isArray(value)) throw new DecodeError(`Expected a list, found ${kindOf(value)}`);
  return value.map((item) => read(item));
}

/** Swift's `try? decodeIfPresent([T].self)`: a list that can't be read is null. */
export function lenientArray<T>(o: JsonObject, key: string, read: (value: unknown) => T): T[] | null {
  if (!present(o, key)) return null;
  try {
    return arrayOf(o[key], read);
  } catch (e) {
    if (e instanceof DecodeError) return null;
    throw e;
  }
}
