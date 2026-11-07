import { describe, expect, it } from "vitest";
import { PetTraits, PixelPet, ProfileStats } from "../../src/core/profile";
import {
  averageText,
  bingeText,
  cloudStatus,
  decadeDetail,
  decadeHeight,
  favouriteDecade,
  genreDetail,
  genrePercent,
  heatHelp,
  heatOpacity,
  heatmapDetail,
  histogramHeight,
  hourLabel,
  hours,
  hoursNote,
  petLine,
  raisedOn,
  starsDetail,
  statTiles,
  topTitleLine,
} from "../../src/ui/lib/profileText";
import { shareCardData, shareCardFileName, shareCardHeight } from "../../src/ui/lib/shareCard";

function stats(fields: Partial<ProfileStats>): ProfileStats {
  return Object.assign(new ProfileStats(), fields);
}

describe("stat tiles", () => {
  it("round hours and explain estimates", () => {
    expect(hours(0.4)).toBe("0");
    expect(hours(12.5)).toBe("13");
    expect(hours(240.2)).toBe("240");
    expect(hoursNote({ estimatedHours: 10, trackedHours: 9.5 })).toBeNull();
    expect(hoursNote({ estimatedHours: 40, trackedHours: 0.5 })).toBe("worked out from the runtimes of what you finished");
    expect(hoursNote({ estimatedHours: 40, trackedHours: 12.4 })).toBe("12 timed by Cineon, the rest from runtimes");
  });

  it("name the numbers", () => {
    const tiles = statTiles(stats({ estimatedHours: 3, trackedHours: 3, filmsWatched: 1, seriesFinished: 2, episodesFinished: 1, currentStreak: 1, longestStreak: 4 }));
    expect(tiles).toEqual([
      { value: "3", label: "hours watched", note: null },
      { value: "1", label: "film", note: "and 2 series finished" },
      { value: "1", label: "episode", note: null },
      { value: "1", label: "day in a row", note: "longest 4" },
    ]);
    const more = statTiles(stats({ filmsWatched: 5, episodesFinished: 0, currentStreak: 3 }));
    expect(more.map((t) => t.label)).toEqual(["hours watched", "films", "episodes", "days in a row"]);
    expect(more[1]!.note).toBeNull();
    expect(averageText(null)).toBe("–");
    expect(averageText(7.25)).toBe("7.3");
  });
});

describe("the hero", () => {
  const pet = PixelPet.make(new ProfileStats().petTraits(PetTraits.seedFor("6F9619FF-8B86-D011-B42D-00C04FC964FF")));

  it("describes the pet", () => {
    expect(petLine({ stageLabel: "Teen", speciesLabel: "Fox", level: 7 })).toBe("Teen fox, level 7");
    expect(petLine(pet)).toContain(`, level ${pet.level}`);
  });

  it("says what raised it", () => {
    expect(raisedOn([], "Pip")).toBeNull();
    expect(raisedOn([{ name: "Drama", weight: 1 }], "Pip")).toBe("Raised on drama. Watch more and Pip grows up.");
    expect(
      raisedOn(
        [
          { name: "Drama", weight: 0.6 },
          { name: "Sci-Fi", weight: 0.4 },
        ],
        "Pip",
      ),
    ).toBe("Raised on drama and sci-fi. Watch more and Pip grows up.");
  });
});

describe("charts", () => {
  it("genres", () => {
    expect(genreDetail([])).toBeNull();
    expect(genreDetail([{ name: "Comedy", weight: 1 }])).toBe("mostly comedy");
    expect(genrePercent(0.335)).toBe(34);
  });

  it("stars", () => {
    expect(starsDetail(new Array(10).fill(0))).toBe("nothing rated yet");
    expect(starsDetail([0, 0, 1, 0, 0, 0, 3, 2, 0, 0])).toBe("6 rated");
    expect(histogramHeight(0, 5)).toBe(2);
    expect(histogramHeight(5, 5)).toBe(86);
    expect(histogramHeight(1, 100)).toBe(4);
  });

  it("decades: the first of the most", () => {
    const decades = [
      { decade: 1990, count: 4 },
      { decade: 2000, count: 6 },
      { decade: 2010, count: 6 },
    ];
    expect(favouriteDecade(decades)!.decade).toBe(2000);
    expect(decadeDetail(decades)).toBe("the 2000s most");
    expect(decadeDetail([])).toBeNull();
    expect(decadeHeight(6, 6)).toBe(64);
    expect(decadeHeight(0, 6)).toBe(3);
  });

  it("the heatmap", () => {
    expect(hourLabel(0)).toBe("00:00");
    expect(hourLabel(21)).toBe("21:00");
    expect(heatmapDetail(4, 21)).toBe("mostly Fridays, around 21:00");
    expect(heatmapDetail(null, 3)).toBeNull();
    expect(heatOpacity(0, 9)).toBe(0);
    expect(heatOpacity(9, 9)).toBeCloseTo(0.92);
    expect(heatOpacity(1, 4)).toBeCloseTo(0.14 + 0.78 * 0.5);
    expect(heatHelp(6, 9, 1)).toBe("Sun 09:00: 1 session");
    expect(heatHelp(0, 23, 3)).toBe("Mon 23:00: 3 sessions");
  });

  it("the biggest day", () => {
    expect(bingeText({ day: { year: 2026, month: 3, day: 3 }, seconds: 22_320, sessions: 6 }, "en-GB")).toBe(
      "Your biggest day: 6 h 12 min on 3 March 2026.",
    );
    expect(bingeText({ day: { year: 2026, month: 3, day: 3 }, seconds: 600, sessions: 14 }, "en-GB")).toBe(
      "Your biggest day: 14 things opened on 3 March 2026.",
    );
  });

  it("most watched", () => {
    expect(topTitleLine({ id: 1, name: "Dune", posterUrl: null, hours: 2.5, sessions: 3 })).toBe("2 h 30 min");
    expect(topTitleLine({ id: 1, name: "Dune", posterUrl: null, hours: 0.1, sessions: 1 })).toBe("1 visit");
    expect(topTitleLine({ id: 1, name: "Dune", posterUrl: null, hours: 0, sessions: 4 })).toBe("4 visits");
  });
});

describe("cloud status", () => {
  const now = new Date("2026-11-07T12:00:00Z");
  const cloud = { lastSync: null, isSyncing: false, lastError: null, cloudCount: 0 };

  it("reads the backup's state", () => {
    expect(cloudStatus(false, cloud, true, now)).toEqual({ icon: "icloud.slash", text: "Cloud backup is off" });
    expect(cloudStatus(true, null, false, now).text).toBe("Backup runs in Cineon's background");
    expect(cloudStatus(true, null, true, now).text).toBe("Backing up your ratings…");
    expect(cloudStatus(true, { ...cloud, lastError: "Offline" }, true, now).text).toBe("Backup waiting: Offline");
    expect(cloudStatus(true, { ...cloud, lastSync: now.getTime() - 5 * 60_000 }, true, now)).toEqual({
      icon: "checkmark.icloud",
      text: "Ratings backed up 5 minutes ago",
    });
    expect(cloudStatus(true, cloud, true, now).text).toBe("Backing up your ratings…");
  });
});

describe("the share card", () => {
  it("collects what it shows", () => {
    const s = stats({ estimatedHours: 120.4, filmsWatched: 31, episodesFinished: 210, averageRating: 7.44, genres: [{ name: "Drama", weight: 0.5 }] });
    const pet = PixelPet.make(s.petTraits(PetTraits.seedFor("6F9619FF-8B86-D011-B42D-00C04FC964FF")));
    const data = shareCardData(s, pet, "Ana", new Date(2026, 10, 7), "en-GB");
    expect(data.date).toBe("November 2026");
    expect(data.genreLine).toBe("Mostly drama");
    expect(data.numbers).toEqual([
      { value: "120", label: "hours" },
      { value: "31", label: "films" },
      { value: "210", label: "episodes" },
    ]);
    expect(data.average).toBe("7.4");
    expect(data.petLine.startsWith(`${pet.name}, `)).toBe(true);
    expect(shareCardHeight(data)).toBeGreaterThan(400);
    const three = { ...data, genres: [...data.genres, { name: "Comedy", weight: 0.3 }, { name: "Crime", weight: 0.2 }] };
    expect(shareCardHeight(three) - shareCardHeight(data)).toBe(2 * (16 + 9));
  });

  it("names the file", () => {
    expect(shareCardFileName("Ana")).toBe("Ana on Cineon.png");
    expect(shareCardFileName("a/b:c")).toBe("a b c on Cineon.png");
    expect(shareCardFileName("  ")).toBe("Me on Cineon.png");
  });
});
