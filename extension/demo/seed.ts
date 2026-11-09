// The demo page (demo/build.mjs): fills a fresh profile with a believable library, then starts the
// Cineon page as it is. Used for the README's screenshots and the showTime video, so that both show
// a lived-in library without anyone's real one.
//
// Everything is relative to now and drawn from a fixed random seed, so every run looks the same.
// `?reset` in the address wipes the profile and fills it again.

import {
  Database,
  EpisodeAlert,
  EpisodeRef,
  LibraryStore,
  LibraryText,
  ProfileStore,
  type TitleKind,
  type TitleStatus,
  Title,
  UrlKey,
  WatchProgress,
  WatchSession,
} from "../src/core/data";
import { pageStorage } from "../src/ui/lib/session";
import catalogue from "./library.json";

interface Episode {
  readonly name: string | null;
  readonly still: string | null;
}

interface CatalogueTitle {
  readonly imdbId: string;
  readonly name: string;
  readonly year: number;
  readonly kind: TitleKind;
  readonly genres: readonly string[];
  readonly runtimeMinutes: number | null;
  readonly overview: string | null;
  readonly posterUrl: string;
  readonly backdropUrl: string | null;
  readonly seasons?: Record<string, readonly Episode[]>;
}

/** What this person did with a title. `last` is how many days ago they last watched it. */
interface Plan {
  readonly status: TitleStatus;
  readonly rating?: number;
  /** Seasons watched in full or in part: [season, first episode, last episode]. */
  readonly watched?: readonly (readonly [number, number, number])[];
  /** Where they stopped: an episode (or the film, without one) and how far into it. */
  readonly at?: { readonly season?: number; readonly episode?: number; readonly fraction: number };
  readonly last: number;
  readonly host: string;
}

const PLANS: Record<string, Plan> = {
  tt11280740: { status: "watching", watched: [[1, 1, 9], [2, 1, 6]], at: { season: 2, episode: 7, fraction: 0.62 }, last: 0, host: "tubitv.com" },
  tt14452776: { status: "watching", watched: [[1, 1, 8], [2, 1, 10], [3, 1, 3]], at: { season: 3, episode: 4, fraction: 0.35 }, last: 1, host: "pluto.tv" },
  tt2788316: { status: "watching", watched: [[1, 1, 7]], at: { season: 1, episode: 8, fraction: 0.8 }, last: 2, host: "tubitv.com" },
  tt15239678: { status: "watching", at: { fraction: 0.43 }, last: 3, host: "archive.org" },
  tt9253284: { status: "watching", watched: [[1, 1, 12], [2, 1, 2]], at: { season: 2, episode: 3, fraction: 0.2 }, last: 5, host: "pluto.tv" },
  tt12637874: { status: "watching", watched: [[1, 1, 4]], at: { season: 1, episode: 5, fraction: 0.5 }, last: 9, host: "tubitv.com" },
  tt15398776: { status: "watched", rating: 9, last: 12, host: "archive.org" },
  tt11126994: { status: "watched", rating: 10, watched: [[1, 1, 9], [2, 1, 9]], last: 18, host: "tubitv.com" },
  tt9362722: { status: "watched", rating: 9.5, last: 26, host: "pluto.tv" },
  tt1856101: { status: "watched", rating: 9, last: 31, host: "archive.org" },
  tt0816692: { status: "watched", rating: 10, last: 38, host: "tubitv.com" },
  tt6710474: { status: "watched", rating: 8.5, last: 45, host: "pluto.tv" },
  tt3581920: { status: "watched", rating: 8, watched: [[1, 1, 9]], last: 52, host: "tubitv.com" },
  tt0245429: { status: "watched", rating: 10, last: 63, host: "archive.org" },
  tt13238346: { status: "watched", rating: 8.5, last: 69, host: "pluto.tv" },
  tt14230458: { status: "watched", last: 74, host: "tubitv.com" },
  tt2356777: { status: "watched", rating: 9, watched: [[1, 1, 8]], last: 82, host: "pluto.tv" },
  tt6751668: { status: "watched", rating: 9.5, last: 93, host: "archive.org" },
  tt1392190: { status: "watched", last: 99, host: "tubitv.com" },
  tt2278388: { status: "watched", last: 106, host: "archive.org" },
  tt2543164: { status: "watched", last: 113, host: "pluto.tv" },
  tt29623480: { status: "backlog", last: 4, host: "" },
  tt17009710: { status: "backlog", last: 15, host: "" },
};

/** Series with new episodes, and how many. */
const NEW_EPISODES: Record<string, number> = { tt14452776: 2, tt12637874: 1, tt9253284: 3 };

const SEEDED_KEY = "cineon.demo.seeded";
const DAY = 86_400;

/** Mulberry32: the same "random" library on every run. */
function random(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Seconds since 1970 for `daysAgo` days back at `hour` (local, may run past midnight). */
function evening(daysAgo: number, hour: number): number {
  const day = new Date();
  day.setHours(0, 0, 0, 0);
  day.setDate(day.getDate() - daysAgo);
  return Math.floor(day.getTime() / 1000 + hour * 3600);
}

function pageUrl(host: string, title: CatalogueTitle, ref: EpisodeRef): string {
  const slug = LibraryText.normalize(title.name).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const episode = EpisodeRef.isEpisode(ref) ? `/season-${ref.season}/episode-${ref.episode}` : "";
  return `https://${host}/watch/${slug}-${title.year}${episode}`;
}

async function seed(): Promise<void> {
  const next = random(20261109);
  const storage = pageStorage();
  const profiles = await ProfileStore.open({ storage, deleteProfileData: (id) => Database.delete(Database.nameFor(id)) });
  const profile = profiles.lastUsed;
  await profiles.rename(profile.id, "Alex");
  await Database.delete(Database.nameFor(profile.id));
  const db = await Database.open(Database.nameFor(profile.id));
  const library = await LibraryStore.open(db);
  await library.seedDefaultSitesIfNeeded();

  const settings = await db.loadSettings();
  // Nothing looked up while the demo runs: the library stays exactly as written here.
  await db.saveSettings({ ...settings, fetchMetadata: false, theme: "dark" });

  for (const entry of catalogue.titles as readonly CatalogueTitle[]) {
    const plan = PLANS[entry.imdbId];
    if (!plan) continue;
    const runtime = (entry.runtimeMinutes ?? 100) * 60;

    // What was watched, newest first: [ref, fraction played, finished].
    const plays: { ref: EpisodeRef; name: string | null; fraction: number; finished: boolean }[] = [];
    const episodeName = (season: number, episode: number) => entry.seasons?.[String(season)]?.[episode - 1]?.name ?? null;
    if (plan.at) {
      const ref = plan.at.season ? { season: plan.at.season, episode: plan.at.episode ?? 1 } : EpisodeRef.none;
      plays.push({ ref, name: plan.at.season ? episodeName(ref.season, ref.episode) : null, fraction: plan.at.fraction, finished: false });
    }
    for (const [season, first, last] of [...(plan.watched ?? [])].reverse()) {
      for (let episode = last; episode >= first; episode--) {
        plays.push({ ref: { season, episode }, name: episodeName(season, episode), fraction: 1, finished: true });
      }
    }
    if (plan.status === "watched" && !plan.watched) {
      plays.push({ ref: EpisodeRef.none, name: null, fraction: 1, finished: true });
    }

    // One to three episodes an evening, an evening every day or two, going back from `last`.
    let day = plan.last;
    let hour = 20 + next() * 2.5;
    let leftTonight = 1 + Math.floor(next() * 3);
    let cursor = 0;
    const sessions: WatchSession[] = [];
    for (const play of plays) {
      if (leftTonight === 0) {
        day += 1 + Math.floor(next() * 2);
        hour = 19.5 + next() * 3;
        leftTonight = 1 + Math.floor(next() * 3);
        cursor = 0;
      }
      leftTonight--;
      const watched = Math.round(runtime * play.fraction);
      const started = evening(day, hour) - cursor - watched;
      cursor += watched + 300;
      sessions.push(
        WatchSession.make({
          titleId: 0,
          ref: play.ref,
          episodeName: play.name,
          url: pageUrl(plan.host, entry, play.ref),
          host: plan.host,
          startedAt: started,
          endedAt: started + watched,
          watchedSeconds: watched,
          startPosition: 0,
          endPosition: watched,
          duration: runtime,
          finished: play.finished,
        }),
      );
    }

    const lastEnd = sessions[0]?.endedAt ?? evening(plan.last, 21);
    const firstStart = sessions.at(-1)?.startedAt ?? lastEnd;
    const kind: TitleKind = entry.kind;
    const id = await db.insertTitle(
      Title.make({
        name: entry.name,
        normName: LibraryText.normalize(entry.name),
        year: entry.year,
        kind,
        status: plan.status,
        imdbId: entry.imdbId,
        posterUrl: entry.posterUrl,
        backdropUrl: entry.backdropUrl,
        overview: entry.overview,
        genres: [...entry.genres],
        runtimeMinutes: entry.runtimeMinutes,
        ratingHalves: plan.rating == null ? null : Math.round(plan.rating * 2),
        addedAt: firstStart - DAY * (2 + Math.floor(next() * 20)),
        updatedAt: lastEnd,
        finishedAt: plan.status === "watched" ? lastEnd : null,
        lastWatchedAt: sessions.length ? lastEnd : null,
        metadataChecked: true,
        ratedAt: plan.rating == null ? null : lastEnd + 600,
        statusAt: plan.status === "backlog" ? evening(plan.last, 22) : plan.status === "watched" ? lastEnd : firstStart,
      }),
    );

    for (const s of sessions) {
      await db.insertSession({ ...s, titleId: id });
      await db.upsertProgress(
        WatchProgress.make({
          titleId: id,
          ref: s.ref,
          urlKey: UrlKey.make(s.url!),
          url: s.url,
          host: s.host,
          position: s.endPosition,
          duration: s.duration,
          finished: s.finished,
          updatedAt: s.endedAt,
        }),
      );
    }

    if (plan.status === "backlog") await db.addEvent("addedToBacklog", id, evening(plan.last, 22));
    if (plan.status === "watched") await db.addEvent("markedWatched", id, lastEnd);
    if (plan.status === "watching") await db.addEvent("markedWatching", id, firstStart);

    // Three series have new episodes out since they were last watched (Home shows an alert only
    // until the series is watched again, so they're dated this morning).
    const fresh = NEW_EPISODES[entry.imdbId];
    if (fresh) {
      const seasons = Object.keys(entry.seasons ?? {}).map(Number);
      const season = Math.max(...seasons);
      const count = entry.seasons![String(season)]!.length;
      await db.saveEpisodeAlert(
        EpisodeAlert.make({
          titleId: id,
          latest: { season, episode: count },
          checkedAt: evening(0, 9),
          newest: { season, episode: count },
          newCount: fresh,
          newAt: evening(0, 3),
        }),
      );
    }
  }
  db.close();
}

async function main(): Promise<void> {
  const reset = new URLSearchParams(location.search).has("reset");
  let seeded = false;
  try {
    seeded = localStorage.getItem(SEEDED_KEY) === "1";
  } catch {
    // No storage: seed every time.
  }
  if (reset || !seeded) {
    await seed();
    try {
      localStorage.setItem(SEEDED_KEY, "1");
    } catch {
      // Fine: the next load seeds again.
    }
  }
  // Next to this file in demo/site; a variable, so the bundler leaves it to the browser.
  const app = "./app.js";
  await import(app);
}

void main();
