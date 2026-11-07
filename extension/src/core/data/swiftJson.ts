// JSON written exactly as Swift's JSONEncoder writes it with [.prettyPrinted, .sortedKeys]:
// two-space indents, `"key" : value`, slashes escaped, empty arrays on three lines, doubles in
// Swift's shortest form (`1e-05`, `1e+16`). `undefined` members are left out, as nil optionals.

function indent(level: number): string {
  return "  ".repeat(level);
}

/** A Double as Swift's `description` prints it. */
export function swiftNumber(n: number): string {
  if (!Number.isFinite(n)) throw new RangeError(`Swift can't encode ${n} as JSON`);
  if (Object.is(n, -0)) return "-0";
  const [mantissa, exp] = n.toExponential().split("e") as [string, string];
  const exponent = Number(exp);
  if (exponent < -4 || exponent >= 16) {
    return `${mantissa}e${exponent < 0 ? "-" : "+"}${String(Math.abs(exponent)).padStart(2, "0")}`;
  }
  return String(n);
}

export function swiftString(s: string): string {
  let out = '"';
  for (const ch of s) {
    switch (ch) {
      case '"':
        out += '\\"';
        break;
      case "\\":
        out += "\\\\";
        break;
      case "/":
        out += "\\/";
        break;
      case "\n":
        out += "\\n";
        break;
      case "\r":
        out += "\\r";
        break;
      case "\t":
        out += "\\t";
        break;
      case "\b":
        out += "\\b";
        break;
      case "\f":
        out += "\\f";
        break;
      default: {
        const code = ch.codePointAt(0)!;
        out += code < 0x20 ? "\\u" + code.toString(16).padStart(4, "0") : ch;
      }
    }
  }
  return out + '"';
}

function sortedKeys(object: Record<string, unknown>): string[] {
  return Object.keys(object)
    .filter((key) => object[key] !== undefined)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function write(value: unknown, level: number): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      return swiftNumber(value);
    case "string":
      return swiftString(value);
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return "[\n\n" + indent(level) + "]";
    return (
      "[\n" +
      value.map((item) => indent(level + 1) + write(item ?? null, level + 1)).join(",\n") +
      "\n" +
      indent(level) +
      "]"
    );
  }
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    const keys = sortedKeys(object);
    if (keys.length === 0) return "{\n\n" + indent(level) + "}";
    return (
      "{\n" +
      keys.map((key) => indent(level + 1) + swiftString(key) + " : " + write(object[key], level + 1)).join(",\n") +
      "\n" +
      indent(level) +
      "}"
    );
  }
  throw new TypeError(`Can't encode ${typeof value} as JSON`);
}

/** The text Swift's pretty, sorted JSONEncoder would write for this value. */
export function swiftPrettyJson(value: unknown): string {
  return write(value, 0);
}
