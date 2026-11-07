// Dates the way the apps store them. Everything in the data layer is a plain number of seconds
// since 1970 (the databases' REAL `timeIntervalSince1970`), not milliseconds and not Date objects,
// so records survive structured cloning, chrome.runtime messaging and JSON unchanged.

/** Seconds since 1970-01-01 00:00 UTC, fractional. */
export type UnixTime = number;

/** Swift's reference date, 2001-01-01 00:00 UTC, in seconds since 1970. */
const REFERENCE_DATE = 978_307_200;

export const StoredDate = {
  /** Swift's reference date in seconds since 1970. */
  referenceDateUnixSeconds: REFERENCE_DATE,

  /** Swift's `Date.distantFuture` in seconds since 1970. */
  distantFutureUnixSeconds: 64_092_211_200,

  now(): UnixTime {
    return Date.now() / 1000;
  },

  /** Seconds since 2001, as Swift's `JSONEncoder` writes a `Date` (profiles.json). */
  toReference(date: UnixTime): number {
    return date - REFERENCE_DATE;
  },

  fromReference(seconds: number): UnixTime {
    return seconds + REFERENCE_DATE;
  },

  toDate(date: UnixTime): Date {
    return new Date(date * 1000);
  },

  fromDate(date: Date): UnixTime {
    return date.getTime() / 1000;
  },

  /** Swift's `JSONEncoder.DateEncodingStrategy.iso8601`: UTC, whole seconds (cut, not rounded), a Z. */
  iso8601(date: UnixTime): string {
    const whole = Math.floor(date);
    return new Date(whole * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
  },

  /** An ISO 8601 date and time with a zone, or null. Fractions of a second are kept. */
  parseIso8601(text: string): UnixTime | null {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i.test(text)) return null;
    const ms = Date.parse(text);
    return Number.isFinite(ms) ? ms / 1000 : null;
  },
};
