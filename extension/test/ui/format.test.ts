import { describe, expect, it } from "vitest";
import { DateText, RefText, bareHost, directUrl, fileSize, hostOf, isVisitOnly, percent, plural } from "../../src/ui/lib/format";

describe("fileSize (ByteCountFormatter .file)", () => {
  it("writes decimal units the way Finder does", () => {
    expect(fileSize(0)).toBe("Zero KB");
    expect(fileSize(1)).toBe("1 byte");
    expect(fileSize(999)).toBe("999 bytes");
    expect(fileSize(1_000)).toBe("1 KB");
    expect(fileSize(345_400)).toBe("345 KB");
    expect(fileSize(1_234_567)).toBe("1.2 MB");
    expect(fileSize(2_000_000_000)).toBe("2 GB");
    expect(fileSize(1_540_000_000)).toBe("1.5 GB");
  });
});

describe("DateText", () => {
  const now = new Date(2026, 10, 7, 21, 30);
  const at = (d: Date) => d.getTime() / 1000;

  it("names today and yesterday", () => {
    expect(DateText.day(at(new Date(2026, 10, 7, 8, 0)), now)).toBe("Today");
    expect(DateText.day(at(new Date(2026, 10, 6, 23, 59)), now)).toBe("Yesterday");
  });

  it("writes other days with the weekday, and the year only when it isn't this one", () => {
    const thisYear = DateText.day(at(new Date(2026, 10, 2, 12)), now, "en-GB");
    expect(thisYear).toContain("Monday");
    expect(thisYear).toContain("November");
    expect(thisYear).not.toContain("2026");
    expect(DateText.day(at(new Date(2025, 0, 3, 12)), now, "en-GB")).toContain("2025");
  });

  it("writes relative times in full", () => {
    expect(DateText.relative(at(now) - 3 * 3600, now, "en")).toBe("3 hours ago");
    expect(DateText.relative(at(now) - 2 * 86_400, now, "en")).toBe("2 days ago");
    expect(DateText.relativeNamed(at(now) - 86_400, now, "en")).toBe("yesterday");
  });
});

describe("labels", () => {
  it("writes episodes short and long", () => {
    expect(RefText.short({ season: 2, episode: 5 })).toBe("S2 E5");
    expect(RefText.long({ season: 2, episode: 5 })).toBe("Season 2, episode 5");
  });

  it("knows a visit from a watch", () => {
    expect(isVisitOnly({ duration: 0 })).toBe(true);
    expect(isVisitOnly({ duration: 10 })).toBe(false);
  });

  it("plurals, percent, hosts", () => {
    expect(plural(1, "film", "films")).toBe("1 film");
    expect(plural(3, "film", "films")).toBe("3 films");
    expect(percent(0.999)).toBe(99);
    expect(bareHost("www.site.to")).toBe("site.to");
    expect(hostOf("https://www.site.to/x")).toBe("www.site.to");
    expect(hostOf("nope")).toBeNull();
  });
});

describe("directUrl (CommandBar.directURL)", () => {
  it("recognises addresses typed without a scheme", () => {
    expect(directUrl("site.to/film")).toBe("https://site.to/film");
    expect(directUrl("https://example.com")).toBe("https://example.com");
    expect(directUrl("localhost:3000")).toBe("http://localhost:3000");
    expect(directUrl("кино.укр")).toBe("https://кино.укр");
  });

  it("leaves searches alone", () => {
    expect(directUrl("the matrix")).toBeNull();
    expect(directUrl("matrix")).toBeNull();
    expect(directUrl("file.mp4x1")).toBeNull();
    expect(directUrl("v1.2")).toBeNull();
  });
});
