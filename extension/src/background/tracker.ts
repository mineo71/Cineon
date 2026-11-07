// Port of Browser/WatchTracker.swift (checked against windows/Cineon.App/Browser/WatchTracker.cs):
// turns raw playback reports into timeline sessions and saved positions. Rows are updated in place
// as playback goes on, so there's no "end session" step to miss: close the tab, quit the browser or
// let the worker stop, and the timeline is still right to within ten seconds.
//
// Everything that touches the database is async here; the browser serializes each tab's reports
// (Browser.receiveMedia), so a report is handled only once the one before it has been.

import { EpisodeRef, Timecode, UrlKey, WatchProgress, WatchSession } from "../core/data";
import { type ParsedTitle, TitleParser } from "../core/parsing";
import type { SessionContext } from "./context";
import { hostOf } from "./env";
import type { MediaEvent, TabState } from "./tabState";

export class WatchTracker {
  /** Anything shorter is an ad, a trailer or a preview. */
  static readonly minimumDuration = 240;
  /** Coming back to the same thing within this time (seconds) continues the same timeline entry. */
  static readonly mergeWindow = 30 * 60;
  /** Milliseconds between writes while playing. */
  static readonly flushInterval = 10_000;

  constructor(private readonly ctx: SessionContext) {}

  private get library() {
    return this.ctx.library;
  }

  private get settings() {
    return this.ctx.settings;
  }

  // MARK: Playback reports

  async handle(event: MediaEvent, tab: TabState): Promise<void> {
    // A short clip ended and the film may start next, so don't clear anything.
    if (event.duration < WatchTracker.minimumDuration) return;

    // Silent video nobody asked for is a banner, however long it is. Sound, or a click anywhere on
    // the page, is what makes it someone watching.
    if (event.muted && !event.userActivated) return;

    tab.media = {
      position: event.position,
      duration: event.duration,
      isPlaying: !event.paused && event.type !== "ended",
      rate: event.rate,
    };

    // Only the moment playback starts. Doing this on every tick makes two tabs fight forever.
    if (event.type === "play" && this.settings.pauseOtherTabs) this.ctx.browser.pauseOthers(tab);

    const now = this.ctx.clock.now();
    if (tab.lastPlaybackReport != null && !event.paused) {
      // Real time passed, capped so that sleep or a stall doesn't count as watching.
      tab.playedSeconds += Math.min((now - tab.lastPlaybackReport) / 1000, 6);
    }
    tab.lastPlaybackReport = event.paused ? null : now;

    if (tab.track && tab.url && tab.track.urlKey !== UrlKey.make(tab.url)) {
      await this.flush(tab, event);
      tab.track = null;
      tab.playedSeconds = 0;
    }

    if (tab.track == null && !event.paused && tab.playedSeconds >= this.settings.minimumSecondsToTrack) {
      await this.begin(tab, event);
    }

    const track = tab.track;
    if (!track) return;
    this.ctx.frames.tick(event, tab, track);

    const isFinished = event.type === "ended" || event.position / event.duration >= this.settings.finishThreshold;
    if (isFinished && !track.finishedAnnounced) await this.markFinished(tab, event);

    const current = tab.track;
    if (!current) return;
    const due = now - current.lastFlush >= WatchTracker.flushInterval;
    if (due || event.type === "pause" || event.type === "ended") await this.flush(tab, event);
    if (tab.track) await this.ctx.autopilot.tick(event, tab, tab.track);
  }

  /** Asked once per video, when its length becomes known: where should it start? */
  async resumePosition(event: MediaEvent, tab: TabState): Promise<number | null> {
    if (event.duration < WatchTracker.minimumDuration) return null;

    if (tab.pendingResume != null) {
      const explicit = tab.pendingResume;
      tab.pendingResume = null;
      const expected = tab.expectedResumeDuration;
      tab.expectedResumeDuration = null;
      if (!(explicit > 1)) return null;
      // A very different length is another cut at best, and another film at worst.
      if (expected != null && Math.abs(expected - event.duration) > Math.max(180, expected * 0.1)) {
        this.ctx.toasts.show("This video's length is different, so Cineon stayed at the start", {
          tab,
          action: { title: `Jump to ${Timecode.string(explicit)}`, run: () => this.ctx.browser.seek(tab, explicit) },
        });
        return null;
      }
      return explicit;
    }

    if (!this.settings.autoResume || !tab.url) return null;
    const key = UrlKey.make(tab.url);

    let saved = await this.ctx.db.progress(key).catch(() => null);
    if (saved == null && tab.parsed) {
      const title = this.library.find(tab.parsed.name, tab.parsed.altName, tab.parsed.year);
      if (title) {
        // Same film on a different site. Trust it only if the lengths roughly agree.
        const elsewhere = await this.ctx.db.progress(title.id, tab.parsed.ref).catch(() => null);
        if (elsewhere && Math.abs(elsewhere.duration - event.duration) < Math.max(120, event.duration * 0.08)) saved = elsewhere;
      }
    }
    if (
      saved == null ||
      saved.position < 30 ||
      saved.finished ||
      saved.position >= event.duration * 0.95 ||
      saved.position >= event.duration - 60
    ) {
      return null;
    }

    const position = saved.position;
    this.ctx.toasts.show(`Resumed at ${Timecode.string(position)}`, {
      tab,
      action: { title: "Start over", run: () => this.ctx.browser.seek(tab, 0) },
    });
    return position;
  }

  /** The page changed. Save what we had and get ready for whatever plays next. */
  tabNavigated(tab: TabState): Promise<void> {
    this.ctx.autopilot.willLeave(tab);
    tab.frameState = { sessionId: null, count: 0, lastPosition: null, blanks: 0, isCapturing: false, notBefore: 0 };
    let write: Promise<void> = Promise.resolve();
    if (tab.track) {
      if (tab.media) write = this.writeFlush(tab, tab.media.position, tab.media.duration);
      tab.track = null;
    }
    tab.media = null;
    tab.playedSeconds = 0;
    tab.lastPlaybackReport = null;
    return write;
  }

  // MARK: Sessions

  private async begin(tab: TabState, event: MediaEvent): Promise<void> {
    const url = tab.url;
    if (!url) return;
    const key = UrlKey.make(url);
    if (await this.ctx.db.isIgnored(key).catch(() => false)) return;
    if (this.ctx.shields.prefsFor(hostOf(url)).trackingOff) return;

    const { titleId, ref, episodeName } = await this.resolveTitle(tab, key, url);
    if (titleId == null) return;
    // The page may have moved on while the title was being found.
    if (tab.url !== url || tab.track != null) return;

    void this.library.recordWatchStart(titleId);
    this.ctx.metadata.enrich(titleId, tab.parsed?.altName ?? null);

    const nowMs = this.ctx.clock.now();
    const now = nowMs / 1000;
    const host = hostOf(url) ?? "";
    let row = await this.ctx.db.latestSession(titleId, ref, now - WatchTracker.mergeWindow).catch(() => null);
    if (row == null) {
      row = await this.library.saveSession(
        WatchSession.make({
          titleId,
          ref,
          episodeName,
          url,
          host,
          startedAt: now,
          endedAt: now,
          watchedSeconds: 0,
          startPosition: event.position,
          endPosition: event.position,
          duration: event.duration,
          finished: false,
        }),
      );
    }
    if (row.id === 0 || tab.url !== url || tab.track != null) return;
    // Seconds played before tracking started still count as watched.
    const alreadyPlayed = tab.playedSeconds;
    tab.playedSeconds = 0;
    tab.linkedTitleId = titleId;
    tab.track = {
      titleId,
      ref,
      urlKey: key,
      session: row,
      lastFlush: nowMs,
      startedWith: row.watchedSeconds + alreadyPlayed,
      finishedAnnounced: false,
    };
    await this.writeFlush(tab, event.position, event.duration);
    if (tab.track) await this.ctx.autopilot.trackBegan(tab, tab.track);
  }

  private async resolveTitle(
    tab: TabState,
    urlKey: string,
    url: string,
  ): Promise<{ titleId: number | null; ref: EpisodeRef; episodeName: string | null }> {
    // A correction made by hand always wins.
    const link = await this.ctx.db.link(urlKey).catch(() => null);
    if (link && this.library.titles.has(link.titleId)) return { titleId: link.titleId, ref: link.ref, episodeName: null };

    let parsed: ParsedTitle | null = tab.parsed;
    if (parsed == null && tab.pageMeta) parsed = TitleParser.parse(tab.pageMeta);
    if (parsed == null) parsed = TitleParser.parse({ url, title: tab.title, ld: [] });
    if (parsed == null) return { titleId: null, ref: EpisodeRef.none, episodeName: null };
    tab.parsed = parsed;

    const existing = this.library.find(parsed.name, parsed.altName, parsed.year);
    if (existing) return { titleId: existing.id, ref: parsed.ref, episodeName: parsed.episodeName };
    const created = await this.library.addTitle(parsed.name, {
      year: parsed.year,
      kind: parsed.kindHint,
      status: "watching",
      posterUrl: parsed.posterUrl,
      overview: parsed.overview,
    });
    return { titleId: created?.id ?? null, ref: parsed.ref, episodeName: parsed.episodeName };
  }

  private flush(tab: TabState, event: MediaEvent): Promise<void> {
    return this.writeFlush(tab, event.position, event.duration);
  }

  /** Writes the track's session and the saved position. Reads the tab before its first await. */
  private async writeFlush(tab: TabState, position: number, duration: number): Promise<void> {
    const track = tab.track;
    if (!track) return;
    // A background lookup may have merged this title into one already in the library.
    const currentId = this.library.currentId(track.titleId);
    if (currentId == null) {
      tab.track = null;
      return;
    }
    tab.linkedTitleId = currentId;
    const nowMs = this.ctx.clock.now();
    const now = nowMs / 1000;
    const url = tab.url ?? track.session.url;
    const session: WatchSession = {
      ...track.session,
      titleId: currentId,
      endedAt: now,
      watchedSeconds: track.startedWith + tab.playedSeconds,
      endPosition: position,
      duration,
      url,
      host: hostOf(tab.url) ?? track.session.host,
      finished: track.session.finished || track.finishedAnnounced,
    };
    track.titleId = currentId;
    track.session = session;
    track.lastFlush = nowMs;
    const progress = WatchProgress.make({
      titleId: currentId,
      ref: track.ref,
      urlKey: track.urlKey,
      url,
      host: hostOf(tab.url) ?? "",
      position,
      duration,
      finished: track.finishedAnnounced,
      updatedAt: now,
    });
    const saved = await this.library.saveSession(session);
    if (tab.track === track) track.session = saved;
    await this.library.saveProgress(progress);
  }

  private async markFinished(tab: TabState, event: MediaEvent): Promise<void> {
    const track = tab.track;
    if (!track) return;
    const title = this.library.titles.get(track.titleId);
    if (!title) return;
    track.finishedAnnounced = true;
    await this.flush(tab, event);

    if (EpisodeRef.isEpisode(track.ref)) {
      this.ctx.toasts.show(`Finished season ${track.ref.season}, episode ${track.ref.episode} of ${title.name}`, { tab });
    } else {
      void this.library.setStatus(title.id, "watched");
      this.ctx.toasts.show(`Finished ${title.name}. Moved to Watched.`, { tab });
    }
  }

  // MARK: Corrections

  /** "This page is actually that film." Remembered for this address, and moves any records. */
  async relink(tab: TabState, titleId: number, ref: EpisodeRef): Promise<void> {
    if (!tab.url) return;
    const key = UrlKey.make(tab.url);
    await this.ctx.db.setLink(key, titleId, ref).catch(() => undefined);
    const track = tab.track;
    if (track && track.titleId !== titleId) {
      const old = track.titleId;
      const hasOtherRecords = (await this.library.sessionsForTitle(old)).length > 1;
      if (hasOtherRecords) {
        await this.tabNavigated(tab);
      } else {
        await this.library.merge(old, titleId);
        tab.track = null;
      }
    }
    tab.linkedTitleId = titleId;
    tab.playedSeconds = Math.max(tab.playedSeconds, this.settings.minimumSecondsToTrack);
  }

  /** "Nothing on this site is a film." Removes the current entry, and stops tracking the site. */
  async stopTrackingSite(tab: TabState): Promise<void> {
    const host = hostOf(tab.url);
    await this.ignore(tab);
    await this.ctx.shields.update(host, { trackingOff: true });
  }

  /** "This isn't a film." Stops tracking this page for good. */
  async ignore(tab: TabState): Promise<void> {
    if (!tab.url) return;
    await this.ctx.db.ignore(UrlKey.make(tab.url)).catch(() => undefined);
    const track = tab.track;
    if (track) {
      const sessions = await this.library.sessionsForTitle(track.titleId);
      const title = this.library.titles.get(track.titleId);
      if (sessions.length <= 1 && title && title.status === "watching" && this.library.progressList(title.id).length <= 1) {
        await this.library.delete(title.id);
      } else {
        await this.library.deleteSession(track.session.id);
      }
    }
    tab.track = null;
    tab.linkedTitleId = null;
    tab.playedSeconds = 0;
  }
}
