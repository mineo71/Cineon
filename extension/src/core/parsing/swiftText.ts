// The pieces of Swift's string model the parsers depend on: characters are grapheme clusters,
// CharacterSet works on scalars, and NSRegularExpression is ICU. Kept in one place so the parsers
// read like the Swift they came from. Port of windows/Cineon.Core/Parsing/SwiftText.cs; where
// JavaScript already behaves like Swift (full upper-casing, \p{Alphabetic}, \p{Grapheme_Extend})
// it is used directly.

// MARK: Characters (grapheme clusters)

const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });

/** Text where every UTF-16 unit is a whole character: nothing that combines, and no CR (CR LF is one character). */
function isPlain(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0x300 || c === 0x0d) return false;
  }
  return true;
}

/** The characters of a string, in order. */
export function characters(s: string): string[] {
  if (isPlain(s)) return s.split("");
  const list: string[] = [];
  for (const part of segmenter.segment(s)) list.push(part.segment);
  return list;
}

/** Swift's `String.count`: grapheme clusters, not UTF-16 units. */
export function count(s: string): number {
  if (isPlain(s)) return s.length;
  let n = 0;
  for (const _ of segmenter.segment(s)) n++;
  return n;
}

export function first(s: string): string | null {
  if (s.length === 0) return null;
  if (isPlain(s)) return s[0]!;
  for (const part of segmenter.segment(s)) return part.segment;
  return null;
}

export function last(s: string): string | null {
  if (s.length === 0) return null;
  if (isPlain(s)) return s[s.length - 1]!;
  let found: string | null = null;
  for (const part of segmenter.segment(s)) found = part.segment;
  return found;
}

export function dropFirst(s: string): string {
  const f = first(s);
  return f === null ? s : s.slice(f.length);
}

export function dropLast(s: string): string {
  const l = last(s);
  return l === null ? s : s.slice(0, s.length - l.length);
}

/** How many characters pass the test. */
export function countOf(s: string, predicate: (character: string) => boolean): number {
  let n = 0;
  for (const c of characters(s)) if (predicate(c)) n++;
  return n;
}

/**
 * Swift's `split(separator:)` with a one-character separator: on whole characters, without empty
 * pieces. A space followed by a combining accent is a different character, so it doesn't split.
 */
export function split(s: string, separator: string): string[] {
  const parts: string[] = [];
  let current = "";
  for (const character of characters(s)) {
    if (character === separator) {
      if (current.length > 0) parts.push(current);
      current = "";
    } else {
      current += character;
    }
  }
  if (current.length > 0) parts.push(current);
  return parts;
}

// MARK: Searching by character

// Swift's contains, hasPrefix, hasSuffix, components(separatedBy:) and replacingOccurrences(of:with:)
// compare whole characters, by canonical equivalence: "сериал́" doesn't contain "сериал", a
// separator whose last space carries an accent doesn't split, and "й" contains "й".

interface Keyed {
  text: string;
  key: string;
}

function keyed(s: string): Keyed[] {
  return characters(s).map((text) => ({ text, key: text.normalize("NFC") }));
}

function matchesAt(text: Keyed[], at: number, pattern: Keyed[]): boolean {
  if (at + pattern.length > text.length) return false;
  for (let j = 0; j < pattern.length; j++) {
    if (text[at + j]!.key !== pattern[j]!.key) return false;
  }
  return true;
}

export function contains(text: string, pattern: string): boolean {
  if (isPlain(text) && isPlain(pattern)) return text.includes(pattern);
  const t = keyed(text);
  const p = keyed(pattern);
  if (p.length === 0) return true;
  for (let i = 0; i + p.length <= t.length; i++) {
    if (matchesAt(t, i, p)) return true;
  }
  return false;
}

export function hasPrefix(text: string, prefix: string): boolean {
  if (isPlain(text) && isPlain(prefix)) return text.startsWith(prefix);
  return matchesAt(keyed(text), 0, keyed(prefix));
}

export function hasSuffix(text: string, suffix: string): boolean {
  if (isPlain(text) && isPlain(suffix)) return text.endsWith(suffix);
  const t = keyed(text);
  const p = keyed(suffix);
  return p.length <= t.length && matchesAt(t, t.length - p.length, p);
}

/** `components(separatedBy:)`: empty pieces kept. */
export function components(text: string, separator: string): string[] {
  if (isPlain(text) && isPlain(separator)) return text.split(separator);
  const t = keyed(text);
  const p = keyed(separator);
  const parts: string[] = [];
  let current = "";
  for (let i = 0; i < t.length; ) {
    if (p.length > 0 && matchesAt(t, i, p)) {
      parts.push(current);
      current = "";
      i += p.length;
    } else {
      current += t[i]!.text;
      i++;
    }
  }
  parts.push(current);
  return parts;
}

/** `replacingOccurrences(of:with:)`. */
export function replace(text: string, old: string, replacement: string): string {
  if (isPlain(text) && isPlain(old)) return text.split(old).join(replacement);
  return components(text, old).join(replacement);
}

// MARK: Numbers

const NUMERIC = /^[\p{Nd}\p{Nl}\p{No}]/u;

/** Ideographs that Unicode gives a numeric value, which Swift counts as numbers. From Swift itself. */
const HAN_NUMERALS = new Set([
  0x3405, 0x3483, 0x382a, 0x3b4d, 0x4e00, 0x4e03, 0x4e07, 0x4e09, 0x4e24, 0x4e5d, 0x4e8c, 0x4e94, 0x4e96,
  0x4eac, 0x4ebf, 0x4ec0, 0x4edf, 0x4ee8, 0x4f0d, 0x4f70, 0x4fe9, 0x5006, 0x5104, 0x5146, 0x5169, 0x516b,
  0x516d, 0x5341, 0x5343, 0x5344, 0x5345, 0x534c, 0x53c1, 0x53c2, 0x53c3, 0x53c4, 0x56db, 0x58f1, 0x58f9,
  0x5e7a, 0x5efe, 0x5eff, 0x5f0c, 0x5f0d, 0x5f0e, 0x5f10, 0x62d0, 0x62fe, 0x634c, 0x67d2, 0x6d1e, 0x6f06,
  0x7396, 0x767e, 0x7695, 0x79ed, 0x8086, 0x842c, 0x8cae, 0x8cb3, 0x8d30, 0x920e, 0x94a9, 0x9621, 0x9646,
  0x964c, 0x9678, 0x96f6, 0xf96b, 0xf973, 0xf978, 0xf9b2, 0xf9d1, 0xf9d3, 0xf9fd, 0x12038, 0x12039,
  0x12079, 0x12226, 0x1222b, 0x1230b, 0x1230d, 0x12399, 0x20001, 0x20064, 0x200e2, 0x20121, 0x2092a,
  0x20983, 0x2098c, 0x2099c, 0x20aea, 0x20afd, 0x20b19, 0x22390, 0x22998, 0x23b1b, 0x2626d, 0x2f890,
]);

/** `Character.isNumber`: any numeric type, which includes CJK numerals like 一 and 百. */
export function isNumber(character: string): boolean {
  if (character.length === 0) return false;
  const cp = character.codePointAt(0)!;
  return NUMERIC.test(character) || HAN_NUMERALS.has(cp);
}

const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;
const INT_TEXT = /^[+-]?[0-9]+$/;

/**
 * Swift's `Int(_:)` for text: optional sign, ASCII digits only, 64-bit. Values past 2^53 come back
 * rounded, which only matters for telling a number from text, never for its value.
 */
export function int(s: string): number | null {
  if (!INT_TEXT.test(s)) return null;
  if (s.length < 16) return Number(s);
  const value = BigInt(s);
  return value < INT64_MIN || value > INT64_MAX ? null : Number(value);
}

/** `int` narrowed to 32 bits, for values that are small in practice. */
export function int32(s: string): number | null {
  const value = int(s);
  return value !== null && value >= -2147483648 && value <= 2147483647 ? value : null;
}

// MARK: Case

/**
 * Swift's `lowercased()`: each scalar's full mapping, so İ becomes i and a combining dot, but with
 * no context, so a final Σ is σ (JavaScript would make it ς).
 */
export function lowercased(s: string): string {
  if (!s.includes("Σ")) return s.toLowerCase();
  return s
    .split("Σ")
    .map((part) => part.toLowerCase())
    .join("σ");
}

/** Swift's `uppercased()`: full mappings, so ß becomes SS and ﬁ becomes FI, as in JavaScript. */
export function uppercased(s: string): string {
  return s.toUpperCase();
}

// MARK: CharacterSet (scalars)

const SPACE_LINE_PARAGRAPH = /^[\p{Zs}\p{Zl}\p{Zp}]$/u;
const SPACE_SEPARATOR = /^\p{Zs}$/u;
const LETTER_OR_MARK = /^[\p{L}\p{M}]$/u;
const DECIMAL_DIGIT = /^\p{Nd}$/u;
const ANY_NUMBER = /^\p{N}$/u;

function scalar(cp: number): string {
  return String.fromCodePoint(cp);
}

/**
 * `CharacterSet.whitespacesAndNewlines`: Z*, U+0009 to U+000D and U+0085, and, as in
 * CoreFoundation, the zero-width space U+200B.
 */
export function isWhitespaceOrNewline(cp: number): boolean {
  if ((cp >= 0x09 && cp <= 0x0d) || cp === 0x85 || cp === 0x200b) return true;
  if (cp < 0x20) return false;
  return SPACE_LINE_PARAGRAPH.test(scalar(cp));
}

/** `CharacterSet.whitespaces`: Zs, tab and U+200B. */
export function isWhitespace(cp: number): boolean {
  if (cp === 0x09 || cp === 0x200b) return true;
  return SPACE_SEPARATOR.test(scalar(cp));
}

/** `CharacterSet.letters`: L* and M*, less the scripts newer than Foundation's tables. */
export function isLetter(cp: number): boolean {
  if ((cp >= 0x105c0 && cp <= 0x105f3) || (cp >= 0x17000 && cp <= 0x187ff) || (cp >= 0x18d00 && cp <= 0x18d1e)) {
    return false;
  }
  return LETTER_OR_MARK.test(scalar(cp));
}

/** `CharacterSet.decimalDigits`: Nd. */
export function isDecimalDigit(cp: number): boolean {
  return DECIMAL_DIGIT.test(scalar(cp));
}

/** `CharacterSet.alphanumerics`: L*, M* and N*. */
export function isAlphanumeric(cp: number): boolean {
  return isLetter(cp) || ANY_NUMBER.test(scalar(cp));
}

/** `rangeOfCharacter(from:) != nil`. */
export function containsAny(s: string, set: (cp: number) => boolean): boolean {
  for (const ch of s) if (set(ch.codePointAt(0)!)) return true;
  return false;
}

/** `trimmingCharacters(in:)`, which works scalar by scalar. */
export function trim(s: string, set: (cp: number) => boolean): string {
  let start = 0;
  while (start < s.length) {
    const cp = s.codePointAt(start)!;
    if (!set(cp)) break;
    start += cp > 0xffff ? 2 : 1;
  }
  let end = s.length;
  while (end > start) {
    const low = s.charCodeAt(end - 1);
    const index =
      low >= 0xdc00 && low <= 0xdfff && end - 2 >= start && isHighSurrogate(s.charCodeAt(end - 2)) ? end - 2 : end - 1;
    const cp = s.codePointAt(index)!;
    if (!set(cp)) break;
    end = index;
  }
  return s.slice(start, end);
}

function isHighSurrogate(c: number): boolean {
  return c >= 0xd800 && c <= 0xdbff;
}

export function trimWhitespacesAndNewlines(s: string): string {
  return trim(s, isWhitespaceOrNewline);
}

// MARK: Regular expressions

// ICU's \w: Alphabetic, marks, decimal digits, connector punctuation, ZWNJ and ZWJ.
const WORD = "\\p{Alphabetic}\\p{M}\\p{Nd}\\p{Pc}\\u200C\\u200D";
// What ICU's \b steps over: Grapheme_Extend and format characters.
const EXTEND = "\\p{Grapheme_Extend}\\p{Cf}";
const BEFORE = `(?:(?![${EXTEND}])[${WORD}])[${EXTEND}]*`;
const BOUNDARY = `(?:(?![${EXTEND}])(?:(?<=${BEFORE})(?![${WORD}])|(?<!${BEFORE})(?=[${WORD}])))`;
// ICU's . stops at every line break, and its $ allows one before the end.
const DOT = "[^\\n\\v\\f\\r\\u0085\\u2028\\u2029]";
const END = "(?![\\s\\S])";
const DOLLAR = `(?:${END}|(?=[\\v\\f\\r\\u0085\\u2028\\u2029]${END})|(?<!\\r)(?=\\n${END})|(?=\\r\\n${END}))`;

/**
 * Characters whose full case folding is more than one character. ICU folds the text this way when it
 * compares a literal string case-insensitively, so "ﬁlm" matches "film"; JavaScript's `i` uses simple
 * folding only, so literal runs are expanded with these as alternatives.
 */
const MULTI_FOLDS: readonly (readonly [string, string])[] = [
  ["ß", "ss"], ["ẞ", "ss"], ["İ", "i̇"], ["ŉ", "ʼn"], ["և", "եւ"],
  ["ﬀ", "ff"], ["ﬁ", "fi"], ["ﬂ", "fl"], ["ﬃ", "ffi"], ["ﬄ", "ffl"], ["ﬅ", "st"],
  ["ﬆ", "st"], ["ﬓ", "մն"], ["ﬔ", "մե"], ["ﬕ", "մի"],
  ["ﬖ", "վն"], ["ﬗ", "մխ"],
];

interface Literal {
  /** As written in the JavaScript pattern. */
  source: string;
  /** The character it stands for, lower-cased. */
  folded: string;
}

/** A run of literal characters, as ICU compares it case-insensitively: ligatures in the text count. */
function expandRun(run: readonly Literal[], from: number): string {
  if (from >= run.length) return "";
  const alternatives: string[] = [];
  for (const [ligature, fold] of MULTI_FOLDS) {
    if (from + fold.length > run.length) continue;
    let matches = true;
    for (let k = 0; k < fold.length && matches; k++) matches = run[from + k]!.folded === fold[k];
    if (matches) alternatives.push(ligature + expandRun(run, from + fold.length));
  }
  const plain = run[from]!.source + expandRun(run, from + 1);
  return alternatives.length === 0 ? plain : `(?:${[plain, ...alternatives].join("|")})`;
}

const QUANTIFIERS = "?*+{";
const SYNTAX = "\\^$.|?*+()[]{}";

/**
 * Turns an ICU pattern, as `NSRegularExpression` reads it, into a JavaScript one (`u` mode) that
 * matches the same text: ICU's `\w` knows letters of every script and marks, its `\b` looks past
 * combining marks, its `\d` and `\s` are Unicode's, its `.` stops at every line break, its `$`
 * allows any line break before the end, and, ignoring case, its literal strings match ligatures and ß
 * by their full folding. A leading `(?i)` becomes the `i` flag.
 */
export function icuSource(pattern: string, ignoreCase = false): { source: string; ignoreCase: boolean } {
  let p = pattern;
  if (p.startsWith("(?i)")) {
    ignoreCase = true;
    p = p.slice(4);
  }
  const translated = translate(p, ignoreCase);
  return { source: translated, ignoreCase };
}

function translate(p: string, foldLiterals: boolean): string {
  let out = "";
  let inClass = false;
  // ICU joins consecutive literal characters into one string, less a last one that has a quantifier.
  let run: Literal[] = [];
  const flush = () => {
    if (run.length > 0) out += foldLiterals ? expandRun(run, 0) : run.map((l) => l.source).join("");
    run = [];
  };
  for (let i = 0; i < p.length; i++) {
    const c = p[i]!;
    if (!inClass) {
      // A literal: a plain character, or escaped punctuation.
      let literal: Literal | null = null;
      let width = 1;
      if (c === "\\" && i + 1 < p.length && /^[^\p{L}\p{N}]$/u.test(p[i + 1]!)) {
        literal = { source: "\\" + p[i + 1]!, folded: p[i + 1]! };
        width = 2;
      } else if (!SYNTAX.includes(c)) {
        const cp = p.codePointAt(i)!;
        const ch = String.fromCodePoint(cp);
        literal = { source: ch, folded: ch.toLowerCase() };
        width = ch.length;
      }
      if (literal !== null) {
        if (QUANTIFIERS.includes(p[i + width] ?? "")) {
          flush();
          out += literal.source;
        } else {
          run.push(literal);
        }
        i += width - 1;
        continue;
      }
      flush();
    }
    if (c === "\\" && i + 1 < p.length) {
      const next = p[++i]!;
      switch (next) {
        case "w":
          out += inClass ? WORD : `[${WORD}]`;
          break;
        case "W":
          if (inClass) throw new Error("\\W inside a class isn't supported");
          out += `[^${WORD}]`;
          break;
        case "d":
          out += "\\p{Nd}";
          break;
        case "D":
          out += "\\P{Nd}";
          break;
        case "s":
          out += "\\p{White_Space}";
          break;
        case "S":
          out += "\\P{White_Space}";
          break;
        case "b":
          out += inClass ? "\\b" : BOUNDARY;
          break;
        case "B":
          out += inClass ? "\\B" : `(?!${BOUNDARY})`;
          break;
        case "p":
        case "P": {
          // A property, \p{L}, copied whole.
          const close = p[i + 1] === "{" ? p.indexOf("}", i + 1) : -1;
          if (close < 0) throw new Error(`Unsupported property in ${p}`);
          out += "\\" + next + p.slice(i + 1, close + 1);
          i = close;
          break;
        }
        default:
          out += "\\" + next;
      }
      continue;
    }
    if (inClass) {
      if (c === "]") inClass = false;
      out += c;
      continue;
    }
    switch (c) {
      case "[":
        inClass = true;
        out += c;
        // A ] straight after [ or [^ is a literal.
        if (p[i + 1] === "^") {
          out += "^";
          i++;
        }
        if (p[i + 1] === "]") {
          out += "\\]";
          i++;
        }
        break;
      case ".":
        out += DOT;
        break;
      case "$":
        out += DOLLAR;
        break;
      case "(": {
        // A group's opening, kept whole so a name like (?<s>) isn't read as text.
        const opener = /^\((?:\?(?:<[A-Za-z_][A-Za-z0-9_]*>|<=|<!|[:=!]))?/.exec(p.slice(i))![0];
        out += opener;
        i += opener.length - 1;
        break;
      }
      default:
        out += c;
    }
  }
  flush();
  return out;
}

/** An ICU pattern ready to use: first match, every match, replacing, with group indices when asked. */
export class IcuRegex {
  private readonly single: RegExp;
  private readonly global: RegExp;

  constructor(pattern: string, ignoreCase = false, indices = false) {
    const translated = icuSource(pattern, ignoreCase);
    const flags = "u" + (translated.ignoreCase ? "i" : "") + (indices ? "d" : "");
    this.single = new RegExp(translated.source, flags);
    this.global = new RegExp(translated.source, flags + "g");
  }

  /** `firstMatch(in:range:)`. */
  match(text: string): RegExpExecArray | null {
    return this.single.exec(text);
  }

  test(text: string): boolean {
    return this.single.test(text);
  }

  /** `matches(in:range:)`. */
  matches(text: string): RegExpExecArray[] {
    this.global.lastIndex = 0;
    return [...text.matchAll(this.global)];
  }

  /** `stringByReplacingMatches(in:range:withTemplate:)` with a template that has no references. */
  replace(text: string, replacement: string): string {
    this.global.lastIndex = 0;
    return text.replace(this.global, () => replacement);
  }
}

/** `NSRegularExpression.escapedPattern(for:)`, for JavaScript's `u` mode. */
export function escapePattern(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&");
}
