// A copy of the data layer's LibraryText.normalize (windows/Cineon.Core/Data/LibraryText.cs), kept
// here until src/core/data lands; then this file should re-export that one, so the library's keys
// (titles.norm_name) and the parser's never drift apart.

const SPECIAL_FOLDS = new Map<number, string>([
  [0x00df, "ss"], [0x1e9e, "ss"], [0xfb00, "ff"], [0xfb01, "fi"], [0xfb02, "fl"], [0xfb03, "ffi"], [0xfb04, "ffl"],
  [0xfb05, "st"], [0xfb06, "st"], [0xfb13, "մն"], [0xfb14, "մե"], [0xfb15, "մի"], [0xfb16, "վն"], [0xfb17, "մխ"],
  [0x0587, "եւ"], [0x0149, "ʼn"], [0x017f, "s"], [0x00b5, "μ"], [0x03c2, "σ"], [0x03d0, "β"], [0x03d1, "θ"],
  [0x03d5, "φ"], [0x03d6, "π"], [0x03f0, "κ"], [0x03f1, "ρ"], [0x03f5, "ε"], [0x1e9b, "ṡ"], [0x1fbe, "ι"],
  [0x0130, "i"],
]);

function caseFolded(cp: number): string {
  const special = SPECIAL_FOLDS.get(cp);
  if (special !== undefined) return special;
  // One scalar alone: JavaScript's full mapping is the simple one here (İ is handled above, and a
  // lone Σ has no word to end).
  return String.fromCodePoint(cp).toLowerCase();
}

/** The combining accents Foundation's diacritic folding removes. */
function isDiacritic(cp: number): boolean {
  return (
    (cp >= 0x0300 && cp <= 0x036f) ||
    (cp >= 0x1ab0 && cp <= 0x1aff) ||
    (cp >= 0x1dc0 && cp <= 0x1dff) ||
    (cp >= 0x20d0 && cp <= 0x20ff) ||
    (cp >= 0xfe20 && cp <= 0xfe2f)
  );
}

const ALPHANUMERIC = /[\p{L}\p{M}\p{N}]/u;
const ALPHANUMERICS = /[\p{L}\p{M}\p{N}]+/gu;
const ASCII = /^[\x00-\x7f]*$/;

/**
 * A title's matching key: case, width and diacritics folded away, then only letters, marks and
 * numbers kept. "Dune: Part Two" becomes "duneparttwo", "Ёлки 2" becomes "елки2". Matches
 * Foundation's `folding([.diacriticInsensitive, .caseInsensitive, .widthInsensitive])` followed by a
 * `CharacterSet.alphanumerics` filter.
 */
export function normalize(s: string): string {
  if (!s) return "";
  if (ASCII.test(s)) return s.toLowerCase().replace(/[^a-z0-9]+/g, "");

  // Width and case.
  let folded = "";
  let isFirst = true;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    const wasFirst = isFirst;
    isFirst = false;
    if (cp === 0x3000) {
      folded += " ";
    } else if (cp >= 0xff01 && cp <= 0xff5e) {
      folded += caseFolded(cp - 0xfee0);
    } else if (cp >= 0xff61 && cp <= 0xffee) {
      // Foundation leaves a half-width voicing mark alone after a letter.
      folded += (cp === 0xff9e || cp === 0xff9f) && !wasFirst ? ch : ch.normalize("NFKC");
    } else {
      folded += caseFolded(cp);
    }
  }

  // Diacritics: decompose, drop the combining accents, put back together.
  let stripped = "";
  for (const ch of folded.normalize("NFD")) {
    if (!isDiacritic(ch.codePointAt(0)!)) stripped += ch;
  }
  const composed = stripped.normalize("NFC");

  if (!ALPHANUMERIC.test(composed)) return "";
  return (composed.match(ALPHANUMERICS) ?? []).join("");
}
