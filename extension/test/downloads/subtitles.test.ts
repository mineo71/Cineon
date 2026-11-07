// Port of Cineon.Core.Tests/Downloads/SubtitleTests.cs (the subtitle cases of CineonTests/DownloadTests.swift).

import { SubtitleTrack } from "../../src/core/downloads";

/** Windows-1251 bytes for Cyrillic and ASCII text, as an old SubRip file has them. */
function cp1251(text: string): Uint8Array {
  return new Uint8Array(
    Array.from(text, (c) => {
      const code = c.codePointAt(0)!;
      if (code < 0x80) return code;
      if (code >= 0x410 && code <= 0x44f) return code - 0x410 + 0xc0;
      if (c === "і") return 0xb3;
      if (c === "І") return 0xb2;
      throw new Error(`No cp1251 byte for ${c}`);
    }),
  );
}

test("parses WebVTT", () => {
  const vtt = `WEBVTT

1
00:00:01.500 --> 00:00:04.000 align:center
<i>Hello</i> there

00:01:05.000 --> 00:01:07.250
Second line
and more`;
  const cues = SubtitleTrack.parse(vtt);
  expect(cues).toHaveLength(2);
  expect(cues[0]!.start).toBeCloseTo(1.5, 3);
  expect(cues[0]!.text).toBe("Hello there");
  expect(cues[1]!.end).toBeCloseTo(67.25, 3);
  expect(cues[1]!.text).toBe("Second line\nand more");
});

test("parses SubRip with Windows line ends", () => {
  const srt = "1\r\n00:00:02,000 --> 00:00:03,000\r\nПривіт\r\n\r\n2\r\n00:00:05,000 --> 00:00:06,000\r\nDruhyi\r\n";
  const cues = SubtitleTrack.parse(srt);
  expect(cues).toHaveLength(2);
  expect(cues[0]!.text).toBe("Привіт");
  expect(cues[1]!.start).toBeCloseTo(5, 3);
});

test("cleans tags, overrides and entities, and drops empty or backwards cues", () => {
  const cues = SubtitleTrack.parse(
    "00:00:01.000 --> 00:00:02.000\n{\\an8}<b>Tom &amp; Jerry</b>&nbsp;&lt;3&gt;\n\n00:00:05.000 --> 00:00:04.000\nBackwards\n\n00:00:06.000 --> 00:00:07.000\n<i></i>\n",
  );
  expect(cues).toEqual([{ start: 1, end: 2, text: "Tom & Jerry <3>" }]);
});

test("finds the cue on screen", () => {
  const track: SubtitleTrack = {
    id: "x",
    label: "English",
    cues: [
      { start: 1, end: 3, text: "one" },
      { start: 5, end: 8, text: "two" },
      { start: 6, end: 7, text: "overlap" },
    ],
  };
  expect(SubtitleTrack.text(track, 0.5)).toBeNull();
  expect(SubtitleTrack.text(track, 2)).toBe("one");
  expect(SubtitleTrack.text(track, 4)).toBeNull();
  expect(SubtitleTrack.text(track, 6.5)).toBe("two\noverlap");
  expect(SubtitleTrack.text(track, 7.5)).toBe("two");
});

test("language from a subtitle address", () => {
  expect(SubtitleTrack.labelFor("https://x.test/subs/film_eng.vtt", 0)).toBe("en");
  expect(SubtitleTrack.labelFor("https://x.test/subs/ukr/1.vtt", 0)).toBe("uk");
  expect(SubtitleTrack.labelFor("https://x.test/s/1234.vtt", 2)).toBe("sub3");
  expect(SubtitleTrack.labelFor("https://x.test/s/%D1%80%D1%83%D1%81%D1%81%D0%BA%D0%B8%D0%B9.vtt", 0)).toBe("ru");
  expect(SubtitleTrack.labelForFile("C:\\Users\\me\\Downloads\\Film.rus.srt", 0)).toBe("ru");
  expect(SubtitleTrack.labelForFile("Arrival.ukr.srt", 0)).toBe("uk");
});

test("loads Cyrillic SubRip that isn't UTF-8, and labels it", () => {
  const path = "/Downloads/Cineon/Film [1080p].uk.srt";
  const track = SubtitleTrack.fromData(path, cp1251("1\r\n00:00:01,000 --> 00:00:02,000\r\nПривіт, світе\r\n"))!;
  expect(track).not.toBeNull();
  expect(track.cues.map((c) => c.text)).toEqual(["Привіт, світе"]);
  expect(track.id).toBe(path);
  expect(SubtitleTrack.displayName("sub2")).toBe("Subtitles 2");
  expect(SubtitleTrack.displayName("uk", "en")).toBe("Ukrainian");
  expect(SubtitleTrack.displayName("en", "en")).toBe("English");
  expect(SubtitleTrack.displayName("zz", "en")).toBe("ZZ");
  expect(SubtitleTrack.fromData("missing.vtt", new Uint8Array())).toBeNull();
});

test("times in every form", () => {
  expect(SubtitleTrack.time("00:01:02.345")).toBeCloseTo(62.345, 3);
  expect(SubtitleTrack.time("01:02.345")).toBeCloseTo(62.345, 3);
  expect(SubtitleTrack.time(" 00:01:02,345 ")).toBeCloseTo(62.345, 3);
  expect(SubtitleTrack.time("12")).toBeNull();
  expect(SubtitleTrack.time("a:b")).toBeNull();
});
