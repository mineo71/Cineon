using System.Text.Json;
using Cineon.Core.Data;
using Cineon.Core.Parsing;

namespace Cineon.App.Browser;

/// One report from `media.js`.
public readonly record struct MediaEvent
{
    public string Type { get; init; }
    public double Position { get; init; }
    public double Duration { get; init; }
    public bool Paused { get; init; }
    public bool Muted { get; init; }
    public double Rate { get; init; }
    public int Width { get; init; }
    public int Height { get; init; }
    public bool IsTopFrame { get; init; }
    public string FrameUrl { get; init; }
    public bool UserActivated { get; init; }

    /// The Mac's failable `init?(_ body: Any)`: null without a type.
    public static MediaEvent? From(JsonElement body)
    {
        if (body.ValueKind != JsonValueKind.Object || body.Text("type") is not { } type) return null;
        return new MediaEvent
        {
            Type = type,
            Position = body.Number("t") ?? 0,
            Duration = body.Number("d") ?? 0,
            Paused = body.Bool("paused") ?? true,
            Muted = body.Bool("muted") ?? false,
            Rate = body.Number("rate") ?? 1,
            Width = (int)(body.Number("w") ?? 0),
            Height = (int)(body.Number("h") ?? 0),
            IsTopFrame = body.Bool("top") ?? false,
            FrameUrl = body.Text("frame") ?? "",
            UserActivated = body.Bool("active") ?? true,
        };
    }
}

/// What the interface shows about the video in a tab.
public readonly record struct MediaState(double Position, double Duration, bool IsPlaying, double Rate)
{
    public double Fraction => Duration > 0 ? Math.Min(1, Position / Duration) : 0;
}

/// The session being recorded in a tab.
public sealed record LiveTrack
{
    public long TitleId { get; init; }
    public EpisodeRef Ref { get; init; }
    public string UrlKey { get; init; } = "";
    public required WatchSession Session { get; init; }
    public DateTimeOffset LastFlush { get; init; }
    public double StartedWith { get; init; }
    public bool FinishedAnnounced { get; init; }
}

/// Turns raw playback reports into timeline sessions and saved positions.
///
/// Rows are updated in place as playback goes on, so there's no "end session" step to miss:
/// quit, crash or close the tab and the timeline is still right to within ten seconds.
public sealed class WatchTracker
{
    /// Anything shorter is an ad, a trailer or a preview.
    public const double MinimumDuration = 240.0;
    /// Coming back to the same thing within this time continues the same timeline entry.
    public static readonly TimeSpan MergeWindow = TimeSpan.FromMinutes(30);
    private static readonly TimeSpan FlushInterval = TimeSpan.FromSeconds(10);

    private readonly ProfileSession _session;

    public WatchTracker(ProfileSession session)
    {
        _session = session;
    }

    private LibraryStore Library => _session.Library;
    private AppSettings Settings => _session.Settings;
    private Database Db => _session.Db;

    // MARK: Playback reports

    public void Handle(MediaEvent e, BrowserTab tab)
    {
        // A short clip ended and the film may start next, so don't clear anything.
        if (e.Duration < MinimumDuration) return;

        // Silent video nobody asked for is a banner, however long it is. Sound, or a click
        // anywhere on the page, is what makes it someone watching.
        if (e.Muted && !e.UserActivated) return;

        tab.Media = new MediaState(e.Position, e.Duration, !e.Paused && e.Type != "ended", e.Rate);

        // Only the moment playback starts. Doing this on every tick makes two tabs fight forever.
        if (e.Type == "play" && Settings.PauseOtherTabs) _session.Browser.PauseOthers(tab);

        var now = DateTimeOffset.Now;
        if (tab.LastPlaybackReport is { } last && !e.Paused)
        {
            // Real time passed, capped so that sleep or a stall doesn't count as watching.
            tab.PlayedSeconds += Math.Min((now - last).TotalSeconds, 6);
        }
        tab.LastPlaybackReport = e.Paused ? null : now;

        if (tab.Track is { } stale && tab.Url is { } url && stale.UrlKey != UrlKey.Make(url))
        {
            Flush(tab, e);
            tab.Track = null;
            tab.PlayedSeconds = 0;
        }

        if (tab.Track is null && !e.Paused && tab.PlayedSeconds >= Settings.MinimumSecondsToTrack) Begin(tab, e);

        if (tab.Track is not { } track) return;
        _session.Frames.Tick(e, tab, track);

        var isFinished = e.Type == "ended" || e.Position / e.Duration >= Settings.FinishThreshold;
        if (isFinished && !track.FinishedAnnounced) MarkFinished(tab, e);

        var due = now - track.LastFlush >= FlushInterval;
        if (due || e.Type == "pause" || e.Type == "ended") Flush(tab, e);
        _session.Autopilot.Tick(e, tab, track);
    }

    /// Asked once per video, when its length becomes known: where should it start?
    public double? ResumePosition(MediaEvent e, BrowserTab tab)
    {
        if (e.Duration < MinimumDuration) return null;

        if (tab.PendingResume is { } explicitPosition)
        {
            tab.PendingResume = null;
            var expected = tab.ExpectedResumeDuration;
            tab.ExpectedResumeDuration = null;
            if (!(explicitPosition > 1)) return null;
            // A very different length is another cut at best, and another film at worst.
            if (expected is { } length && Math.Abs(length - e.Duration) > Math.Max(180, length * 0.1))
            {
                var weak = new WeakReference<BrowserTab>(tab);
                _session.Toasts.Show(
                    "This video's length is different, so Cineon stayed at the start",
                    $"Jump to {Timecode.String(explicitPosition)}",
                    () => { if (weak.TryGetTarget(out var t)) t.Seek(explicitPosition); });
                return null;
            }
            return explicitPosition;
        }

        if (!Settings.AutoResume || tab.Url is not { } url) return null;
        var key = UrlKey.Make(url);

        var saved = Try(() => Db.Progress(key));
        if (saved is null && tab.Parsed is { } parsed && Library.Find(parsed.Name, parsed.AltName, parsed.Year) is { } title)
        {
            // Same film on a different site. Trust it only if the lengths roughly agree.
            if (Try(() => Db.Progress(title.Id, parsed.Ref)) is { } elsewhere
                && Math.Abs(elsewhere.Duration - e.Duration) < Math.Max(120, e.Duration * 0.08))
            {
                saved = elsewhere;
            }
        }
        if (saved is null || saved.Position < 30 || saved.Finished
            || saved.Position >= e.Duration * 0.95 || saved.Position >= e.Duration - 60)
        {
            return null;
        }

        var position = saved.Position;
        var weakTab = new WeakReference<BrowserTab>(tab);
        _session.Toasts.Show($"Resumed at {Timecode.String(position)}", "Start over", () =>
        {
            if (weakTab.TryGetTarget(out var t)) t.Seek(0);
        });
        return position;
    }

    /// The page changed. Save what we had and get ready for whatever plays next.
    public void TabNavigated(BrowserTab tab)
    {
        _session.Autopilot.WillLeave(tab);
        tab.FrameState = new FrameState();
        if (tab.Track is not null)
        {
            if (tab.Media is { } media) WriteFlush(tab, media.Position, media.Duration);
            tab.Track = null;
        }
        tab.Media = null;
        tab.PlayedSeconds = 0;
        tab.LastPlaybackReport = null;
    }

    // MARK: Sessions

    private void Begin(BrowserTab tab, MediaEvent e)
    {
        if (tab.Url is not { } url) return;
        var key = UrlKey.Make(url);
        if (Try(() => Db.IsIgnored(key))) return;
        if (_session.Shields.TrackingOff(Host(url))) return;

        var (titleId, episode, episodeName) = ResolveTitle(tab, key, url);
        if (titleId is not long id) return;

        Library.RecordWatchStart(id);
        _session.Metadata.Enrich(id, tab.Parsed?.AltName);

        var now = DateTimeOffset.Now;
        var host = Host(url) ?? "";
        var row = Try(() => Db.LatestSession(id, episode, now - MergeWindow))
            ?? Library.SaveSession(new WatchSession
            {
                Id = 0, TitleId = id, Ref = episode, EpisodeName = episodeName, Url = url, Host = host, StartedAt = now,
                EndedAt = now, WatchedSeconds = 0, StartPosition = e.Position, EndPosition = e.Position,
                Duration = e.Duration, Finished = false,
            });
        // Seconds played before tracking started still count as watched.
        var alreadyPlayed = tab.PlayedSeconds;
        tab.PlayedSeconds = 0;
        tab.LinkedTitleId = id;
        tab.Track = new LiveTrack
        {
            TitleId = id, Ref = episode, UrlKey = key, Session = row, LastFlush = now,
            StartedWith = row.WatchedSeconds + alreadyPlayed, FinishedAnnounced = false,
        };
        WriteFlush(tab, e.Position, e.Duration);
        if (tab.Track is { } track) _session.Autopilot.TrackBegan(tab, track);
    }

    private (long? TitleId, EpisodeRef Ref, string? EpisodeName) ResolveTitle(BrowserTab tab, string urlKey, Uri url)
    {
        // A correction made by hand always wins.
        if (Try(() => Db.Link(urlKey)) is { } link && Library.Titles.ContainsKey(link.TitleId))
        {
            return (link.TitleId, link.Ref, null);
        }

        var parsed = tab.Parsed;
        if (parsed is null && tab.PageMeta is { } meta) parsed = TitleParser.Parse(meta);
        parsed ??= TitleParser.Parse(new PageMeta { Url = url.OriginalString, Title = tab.Title });
        if (parsed is null) return (null, EpisodeRef.None, null);
        tab.Parsed = parsed;

        if (Library.Find(parsed.Name, parsed.AltName, parsed.Year) is { } existing)
        {
            return (existing.Id, parsed.Ref, parsed.EpisodeName);
        }
        var created = Library.AddTitle(
            parsed.Name, parsed.Year, parsed.KindHint, TitleStatus.Watching,
            posterUrl: parsed.PosterUrl, overview: parsed.Overview);
        return (created?.Id, parsed.Ref, parsed.EpisodeName);
    }

    private void Flush(BrowserTab tab, MediaEvent e) => WriteFlush(tab, e.Position, e.Duration);

    private void WriteFlush(BrowserTab tab, double position, double duration)
    {
        if (tab.Track is not { } track) return;
        // A background lookup may have merged this title into one already in the library.
        if (Library.CurrentId(track.TitleId) is not long currentId)
        {
            tab.Track = null;
            return;
        }
        tab.LinkedTitleId = currentId;
        var now = DateTimeOffset.Now;
        var session = track.Session with
        {
            TitleId = currentId,
            EndedAt = now,
            WatchedSeconds = track.StartedWith + tab.PlayedSeconds,
            EndPosition = position,
            Duration = duration,
            Url = tab.Url ?? track.Session.Url,
            Host = (tab.Url is { } u ? Host(u) : null) ?? track.Session.Host,
            Finished = track.Session.Finished || track.FinishedAnnounced,
        };
        session = Library.SaveSession(session);
        track = track with { TitleId = currentId, Session = session, LastFlush = now };
        tab.Track = track;

        Library.SaveProgress(new WatchProgress
        {
            TitleId = track.TitleId, Ref = track.Ref, UrlKey = track.UrlKey, Url = tab.Url,
            Host = (tab.Url is { } address ? Host(address) : null) ?? "",
            Position = position, Duration = duration, Finished = track.FinishedAnnounced, UpdatedAt = now,
        });
    }

    private void MarkFinished(BrowserTab tab, MediaEvent e)
    {
        if (tab.Track is not { } track || !Library.Titles.TryGetValue(track.TitleId, out var title)) return;
        track = track with { FinishedAnnounced = true };
        tab.Track = track;
        Flush(tab, e);

        if (track.Ref.IsEpisode)
        {
            _session.Toasts.Show($"Finished season {track.Ref.Season}, episode {track.Ref.Episode} of {title.Name}");
        }
        else
        {
            Library.SetStatus(title.Id, TitleStatus.Watched);
            _session.Toasts.Show($"Finished {title.Name}. Moved to Watched.");
        }
    }

    // MARK: Corrections

    /// "This page is actually that film." Remembered for this address, and moves any records.
    public void Relink(BrowserTab tab, long titleId, EpisodeRef episode)
    {
        if (tab.Url is not { } url) return;
        var key = UrlKey.Make(url);
        Try(() => Db.SetLink(key, titleId, episode));
        if (tab.Track is { } track && track.TitleId != titleId)
        {
            var old = track.TitleId;
            var hasOtherRecords = Library.SessionsForTitle(old).Count > 1;
            if (hasOtherRecords)
            {
                TabNavigated(tab);
            }
            else
            {
                Library.Merge(old, titleId);
                tab.Track = null;
            }
        }
        tab.LinkedTitleId = titleId;
        tab.PlayedSeconds = Math.Max(tab.PlayedSeconds, Settings.MinimumSecondsToTrack);
    }

    /// "Nothing on this site is a film." Removes the current entry, and stops tracking the site.
    public void StopTrackingSite(BrowserTab tab)
    {
        Ignore(tab);
        _session.Shields.Update(tab.Url is { } url ? Host(url) : null, trackingOff: true);
    }

    /// "This isn't a film." Stops tracking this page for good.
    public void Ignore(BrowserTab tab)
    {
        if (tab.Url is not { } url) return;
        Try(() => Db.Ignore(UrlKey.Make(url)));
        if (tab.Track is { } track)
        {
            var sessions = Library.SessionsForTitle(track.TitleId);
            if (sessions.Count <= 1 && Library.Titles.TryGetValue(track.TitleId, out var title) && title.Status == TitleStatus.Watching
                && Library.ProgressList(title.Id).Count <= 1)
            {
                Library.Delete(title.Id);
            }
            else
            {
                Library.DeleteSession(track.Session.Id);
            }
        }
        tab.Track = null;
        tab.LinkedTitleId = null;
        tab.PlayedSeconds = 0;
    }

    // MARK: Helpers

    /// Swift's `url.host`: null when there's none.
    internal static string? Host(Uri url) => url.IsAbsoluteUri && url.Host.Length > 0 ? url.Host : null;

    private static T? Try<T>(Func<T> read)
    {
        try { return read(); }
        catch (Exception) { return default; }
    }

    private static void Try(Action write)
    {
        try { write(); }
        catch (Exception) { }
    }
}
