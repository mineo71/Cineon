// Small helpers that count and read the way Swift does (C#'s SwiftText, Urls and JsonArgs.Number).

type Segmenter = { segment(text: string): Iterable<{ segment: string }> };

let segmenter: Segmenter | null | undefined;

function graphemeSegmenter(): Segmenter | null {
  if (segmenter === undefined) {
    const Intl_ = Intl as unknown as { Segmenter?: new (locale?: string, options?: { granularity: string }) => Segmenter };
    segmenter = Intl_.Segmenter ? new Intl_.Segmenter(undefined, { granularity: "grapheme" }) : null;
  }
  return segmenter;
}

/** The characters of a string as Swift counts them (grapheme clusters, or code points without Intl.Segmenter). */
export function characters(text: string): string[] {
  const s = graphemeSegmenter();
  if (!s) return Array.from(text);
  return Array.from(s.segment(text), (part) => part.segment);
}

/** Swift's `String(text.prefix(count))`. */
export function swiftPrefix(text: string, count: number): string {
  if (text.length <= count) return text;
  const parts = characters(text);
  return parts.length <= count ? text : parts.slice(0, count).join("");
}

/** Swift's `trimmingCharacters(in: .whitespacesAndNewlines)`. */
export function swiftTrim(text: string): string {
  return text.trim();
}

/**
 * An absolute address from text (Swift's `URL(string:)` as the apps use it), or null. The text comes
 * back unchanged: addresses travel as their exact text (`absoluteString`).
 */
export function parseUrl(text: string | null | undefined): string | null {
  if (!text) return null;
  try {
    new URL(text);
    return text;
  } catch {
    return null;
  }
}

/** A number as the apps write it in command text and ids: shortest round-trip form (`601`, `1.5`). */
export function numberText(value: number): string {
  return String(value);
}

/** Swift's `rounded()`: half away from zero. */
export function roundHalfAway(value: number): number {
  return Math.sign(value) * Math.round(Math.abs(value));
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Lets a promise run on its own: like C#'s `_ = Task`, a failure is dropped. */
export function detach(promise: Promise<unknown>): void {
  promise.catch(() => {});
}
