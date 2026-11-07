// The two text rules the library is keyed on: exact ports of the Mac's `TitleParser.normalize` and
// `ProfileStats.canonicalGenre` (via windows/Cineon.Core/Data/LibraryText.cs). `titles.norm_name`
// depends on them, so the parsing and profile ports should call these rather than keep copies.

const SPECIAL_FOLDS: ReadonlyMap<number, string> = new Map([
  [0x00df, "ss"],
  [0x1e9e, "ss"],
  [0xfb00, "ff"],
  [0xfb01, "fi"],
  [0xfb02, "fl"],
  [0xfb03, "ffi"],
  [0xfb04, "ffl"],
  [0xfb05, "st"],
  [0xfb06, "st"],
  [0xfb13, "մն"],
  [0xfb14, "մե"],
  [0xfb15, "մի"],
  [0xfb16, "վն"],
  [0xfb17, "մխ"],
  [0x0587, "եւ"],
  [0x0149, "ʼn"],
  [0x017f, "s"],
  [0x00b5, "μ"],
  [0x03c2, "σ"],
  [0x03d0, "β"],
  [0x03d1, "θ"],
  [0x03d5, "φ"],
  [0x03d6, "π"],
  [0x03f0, "κ"],
  [0x03f1, "ρ"],
  [0x03f5, "ε"],
  [0x1e9b, "ṡ"],
  [0x1fbe, "ι"],
  [0x0130, "i"],
]);

/**
 * Case folding as Foundation does it: the special full foldings above, otherwise the simple
 * lower-case mapping. Lower-casing one code point at a time keeps JavaScript's context rules
 * (final sigma) out of it.
 */
function caseFolded(codePoint: number): string {
  return SPECIAL_FOLDS.get(codePoint) ?? String.fromCodePoint(codePoint).toLowerCase();
}

/** The combining accents Foundation's diacritic folding removes. */
function isDiacritic(v: number): boolean {
  return (
    (v >= 0x0300 && v <= 0x036f) ||
    (v >= 0x1ab0 && v <= 0x1aff) ||
    (v >= 0x1dc0 && v <= 0x1dff) ||
    (v >= 0x20d0 && v <= 0x20ff) ||
    (v >= 0xfe20 && v <= 0xfe2f)
  );
}

/** `CharacterSet.alphanumerics`: Unicode categories L*, M* and N*. */
const ALPHANUMERIC = /^[\p{L}\p{M}\p{N}]$/u;

const graphemes: Intl.Segmenter | null =
  typeof Intl !== "undefined" && "Segmenter" in Intl ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;

/** The first user-perceived character, Swift's `prefix(1)`. */
export function firstGrapheme(text: string): string {
  if (text.length === 0) return "";
  if (graphemes) {
    for (const { segment } of graphemes.segment(text)) return segment;
  }
  return String.fromCodePoint(text.codePointAt(0)!);
}

/** Splits into user-perceived characters. */
export function graphemeClusters(text: string): string[] {
  if (graphemes) return Array.from(graphemes.segment(text), (s) => s.segment);
  return Array.from(text);
}

export const LibraryText = {
  /**
   * A title's matching key: case, width and diacritics folded away, then only letters, marks and
   * numbers kept. "Dune: Part Two" becomes "duneparttwo", "Ёлки 2" becomes "елки2". Matches
   * Foundation's `folding([.diacriticInsensitive, .caseInsensitive, .widthInsensitive])` followed
   * by a `CharacterSet.alphanumerics` filter.
   */
  normalize(s: string): string {
    if (!s) return "";

    // Width and case.
    let folded = "";
    let index = 0;
    for (const ch of s) {
      const value = ch.codePointAt(0)!;
      const isFirst = index++ === 0;
      if (value === 0x3000) {
        folded += " ";
        continue;
      }
      if (value >= 0xff01 && value <= 0xff5e) {
        folded += caseFolded(value - 0xfee0);
        continue;
      }
      if (value >= 0xff61 && value <= 0xffee) {
        // Foundation leaves a half-width voicing mark alone after a letter.
        if ((value === 0xff9e || value === 0xff9f) && !isFirst) {
          folded += ch;
          continue;
        }
        folded += ch.normalize("NFKC");
        continue;
      }
      folded += caseFolded(value);
    }

    // Diacritics: decompose, drop the combining accents, put back together.
    let stripped = "";
    for (const ch of folded.normalize("NFD")) {
      if (!isDiacritic(ch.codePointAt(0)!)) stripped += ch;
    }
    const composed = stripped.normalize("NFC");

    let result = "";
    for (const ch of composed) {
      if (ALPHANUMERIC.test(ch)) result += ch;
    }
    return result;
  },

  /** One name per genre, whatever the source called it. */
  canonicalGenre(raw: string): string {
    const lower = raw.toLowerCase().replace(/^[\p{Zs}\t]+|[\p{Zs}\t]+$/gu, "");
    switch (lower) {
      case "science fiction":
      case "sci-fi":
      case "scifi":
      case "science-fiction":
        return "Sci-Fi";
      case "film-noir":
      case "film noir":
        return "Film-Noir";
      case "tv movie":
        return "TV Movie";
    }
    if (raw.length === 0) return raw;
    const first = firstGrapheme(raw);
    return first.toUpperCase() + raw.slice(first.length);
  },
};
