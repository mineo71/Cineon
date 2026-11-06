using System.Globalization;
using System.Text.Json;
using Cineon.App.UI;
using Cineon.Core.Data;
using Cineon.Core.Metadata;
using Cineon.Core.Parsing;

namespace Cineon.App.Browser;

/// The episode after this one, and how to get there.
public sealed record NextEpisodeTarget(EpisodeRef Ref, string? Name, bool IsOnPage, bool IsNextInSeason, Uri? Url);

/// What the autopilot knows about the video in one tab. Starts over on every page.
public sealed class AutopilotState
{
    public List<SkipRule> Rules { get; set; } = [];
    public SkipLearner.Jump? Jump { get; set; }
    public (double From, double To)? ProposedIntro { get; set; }
    public bool DidAskAboutIntro { get; set; }
    public (double From, double To)? LastSkip { get; set; }

    public NextEpisodeTarget? Target { get; set; }
    public bool IsResolving { get; set; }
    public bool IsResolved { get; set; }
    public bool DidOffer { get; set; }
    public bool IsCountingDown { get; set; }
    public bool IsDeclined { get; set; }
    public bool DidMove { get; set; }
    /// A sleep timer is waiting for this episode to end, so nothing should start after it.
    public bool IsHeldForSleep { get; set; }
}

/// Where someone left an episode, to spot them skipping its credits.
public sealed record EpisodeExit(long TitleId, EpisodeRef Ref, double Remaining, double Duration, DateTimeOffset At);

/// Skips what you skip and moves on to the next episode. Everything here is a guess from watching
/// someone's habits, so every action can be undone or turned down right where it happens.
public sealed class EpisodeAutopilot
{
    private readonly ProfileSession _session;

    public EpisodeAutopilot(ProfileSession session)
    {
        _session = session;
    }

    private AppSettings Settings => _session.Settings;
    private LibraryStore Library => _session.Library;

    // MARK: Rules

    private void LoadRules(long titleId, BrowserTab tab)
    {
        if (tab.Url is not { } url || WatchTracker.Host(url) is not { } host) return;
        tab.Autopilot.Rules = Try(() => _session.Db.SkipRules(titleId, SkipLearner.SiteKey(host))) ?? [];
    }

    private List<Dictionary<string, object>> IntroSkips(BrowserTab tab)
    {
        if (!Settings.LearnSkips) return [];
        return [.. tab.Autopilot.Rules.Where(r => r.Kind == SkipRuleKind.Intro).Select(r => new Dictionary<string, object>
        {
            ["kind"] = r.Kind.ToRaw(),
            ["from"] = r.Start,
            ["to"] = r.End,
        })];
    }

    private void PushSkips(BrowserTab tab) => tab.PlayerCommand($"setSkips({JsonSerializer.Serialize(IntroSkips(tab))})");

    /// Asked as soon as a video's length is known, which can be before tracking begins, so that
    /// an intro in the first seconds is still caught.
    public List<Dictionary<string, object>>? Skips(MediaEvent e, BrowserTab tab)
    {
        if (tab.Parsed is not { Ref.IsEpisode: true } parsed || Library.Find(parsed.Name, parsed.AltName, parsed.Year) is not { } title) return null;
        LoadRules(title.Id, tab);
        var skips = IntroSkips(tab);
        return skips.Count == 0 ? null : skips;
    }

    // MARK: Following playback

    public void TrackBegan(BrowserTab tab, LiveTrack track)
    {
        if (Settings.LearnSkips && tab.LastEpisodeExit is { } exit && exit.TitleId == track.TitleId && exit.Ref != track.Ref
            && (DateTimeOffset.Now - exit.At).TotalSeconds < 180)
        {
            NoteCredits(exit.Remaining, exit.Duration, track.TitleId, tab);
        }
        tab.LastEpisodeExit = null;
        LoadRules(track.TitleId, tab);
        PushSkips(tab);
    }

    public void Tick(MediaEvent e, BrowserTab tab, LiveTrack track)
    {
        SettleJump(tab, track);
        var state = tab.Autopilot;
        if (!track.Ref.IsEpisode || !Settings.AutoNextEpisode || state.IsDeclined || state.DidMove) return;

        var ended = e.Type == "ended";
        // Pausing during the countdown means they're not ready to move on. A video that reaches
        // its end also reports a pause, which is why it has to be away from the end to count.
        if (e.Type == "pause" && state.IsCountingDown && e.Duration - e.Position > 1)
        {
            state.IsCountingDown = false;
            tab.PlayerCommand("clearBanner('next')");
            return;
        }
        if (e.Paused && !ended) return;
        var remaining = e.Duration - e.Position;
        var credits = state.Rules.FirstOrDefault(r => r.Kind == SkipRuleKind.Credits);
        var reachedCredits = credits is not null && remaining <= credits.Start;
        var nearEnd = e.Position / e.Duration >= Settings.FinishThreshold;
        if (!(ended || reachedCredits || nearEnd)) return;

        // Moving on by itself takes more certainty than offering to: the episode is really over,
        // or two earlier episodes agreed on where the credits start.
        var isSure = ended || (reachedCredits && (credits?.Sightings ?? 0) >= 2);
        OfferNext(tab, track, isSure);
    }

    /// Called before a page's records are saved and cleared.
    public void WillLeave(BrowserTab tab)
    {
        if (tab.Track is { Ref.IsEpisode: true } track && tab.Media is { } media && !tab.Autopilot.DidMove)
        {
            tab.LastEpisodeExit = new EpisodeExit(track.TitleId, track.Ref, media.Duration - media.Position, media.Duration, DateTimeOffset.Now);
        }
        tab.Autopilot = new AutopilotState();
    }

    // MARK: Learning intros

    public void HandleJump(JsonElement body, BrowserTab tab)
    {
        if (!Settings.LearnSkips || body.Number("from") is not { } from || body.Number("to") is not { } to) return;
        var now = DateTimeOffset.Now;
        if (tab.Autopilot.Jump?.Extended(from, to, now) is { } extended)
        {
            tab.Autopilot.Jump = extended;
        }
        else
        {
            tab.Autopilot.Jump = to > from ? new SkipLearner.Jump(from, to, now) : null;
        }
    }

    /// Waits for the jumping to stop before deciding what it was.
    private void SettleJump(BrowserTab tab, LiveTrack track)
    {
        var state = tab.Autopilot;
        if (state.Jump is not { } jump || DateTimeOffset.Now - jump.LastAt <= SkipLearner.MergeWindow) return;
        state.Jump = null;
        if (!track.Ref.IsEpisode || tab.Media?.Duration is not { } duration || !SkipLearner.IsIntro(jump.From, jump.To, duration)
            || !Library.Titles.TryGetValue(track.TitleId, out var title))
        {
            return;
        }

        if (state.Rules.FirstOrDefault(r => r.Kind == SkipRuleKind.Intro) is { } known
            && Math.Abs(known.Start - jump.From) <= 20 && Math.Abs(known.End - jump.To) <= 20)
        {
            Try(() => _session.Db.SaveSkipRule(known with { Sightings = known.Sightings + 1, UpdatedAt = DateTimeOffset.Now }));
            return;
        }
        if (state.DidAskAboutIntro) return;
        state.DidAskAboutIntro = true;
        state.ProposedIntro = (jump.From, jump.To);
        tab.ShowBanner(
            "intro",
            $"Skip {Timecode.String(jump.From)} to {Timecode.String(jump.To)} in every episode of {title.Name}?",
            [("always", "Always skip", true), ("no", "No", false)],
            timeout: 12);
    }

    private void SaveIntro(double from, double to, BrowserTab tab)
    {
        if (tab.Track is not { } track || tab.Url is not { } url || WatchTracker.Host(url) is not { } host) return;
        var rule = new SkipRule
        {
            Id = 0, TitleId = track.TitleId, Site = SkipLearner.SiteKey(host), Kind = SkipRuleKind.Intro, Start = from, End = to,
            Sightings = 1, Misses = 0, UpdatedAt = DateTimeOffset.Now,
        };
        Try(() => _session.Db.SaveSkipRule(rule));
        LoadRules(track.TitleId, tab);
        PushSkips(tab);
        tab.ShowBanner("saved", "Cineon will skip this from now on", timeout: 3);
    }

    /// Each episode you leave early with the same time left adds confidence about the credits.
    private void NoteCredits(double remaining, double duration, long titleId, BrowserTab tab)
    {
        if (!SkipLearner.IsCredits(remaining, duration) || tab.Url is not { } url || WatchTracker.Host(url) is not { } host) return;
        var site = SkipLearner.SiteKey(host);
        var existing = Try(() => _session.Db.SkipRules(titleId, site))?.FirstOrDefault(r => r.Kind == SkipRuleKind.Credits);
        var rule = existing ?? new SkipRule
        {
            Id = 0, TitleId = titleId, Site = site, Kind = SkipRuleKind.Credits, Start = remaining, End = 0, Sightings = 0, Misses = 0,
            UpdatedAt = DateTimeOffset.Now,
        };
        rule = SkipLearner.Agree(rule.Start, remaining)
            // Never earlier than the shortest time seen, so an ending isn't cut off.
            ? rule with { Sightings = rule.Sightings + 1, Start = Math.Min(rule.Start, remaining) }
            : rule with { Sightings = 1, Start = remaining };
        rule = rule with { UpdatedAt = DateTimeOffset.Now };
        Try(() => _session.Db.SaveSkipRule(rule));
    }

    // MARK: What the player reports

    public void HandleSkipped(JsonElement body, BrowserTab tab)
    {
        if (body.Number("from") is not { } from || body.Number("to") is not { } to) return;
        tab.Autopilot.LastSkip = (from, to);
        tab.ShowBanner("skipped", "Skipped intro", [("undo", "Undo", false)], timeout: 6);
    }

    /// A banner button, as the tests press it (the Mac's debug `/banner`).
    public void HandleBanner(string banner, string action, BrowserTab tab) =>
        HandleBanner(JsonSerializer.SerializeToElement(new Dictionary<string, string> { ["banner"] = banner, ["action"] = action }), tab);

    public void HandleBanner(JsonElement body, BrowserTab tab)
    {
        if (body.Text("banner") is not { } banner || body.Text("action") is not { } action) return;
        switch (banner, action)
        {
            case ("intro", "always"):
                if (tab.Autopilot.ProposedIntro is { } proposed) SaveIntro(proposed.From, proposed.To, tab);
                break;
            case ("skipped", "undo"):
                UndoSkip(tab);
                break;
            case ("next", "play"):
                PlayNext(tab, byHand: true);
                break;
            case ("next", "auto"):
                PlayNext(tab, byHand: false);
                break;
            case ("next", "no"):
                tab.Autopilot.IsDeclined = true;
                tab.Autopilot.IsCountingDown = false;
                break;
            case ("rescue", "find"):
                tab.PlayerCommand("exitFullscreen()");
                _session.Rescue.FindElsewhere(tab);
                break;
        }
    }

    private void UndoSkip(BrowserTab tab)
    {
        if (tab.Autopilot.LastSkip is not { } last) return;
        tab.Seek(last.From);
        if (tab.Autopilot.Rules.FirstOrDefault(r => r.Kind == SkipRuleKind.Intro) is not { } rule) return;
        rule = rule with { Misses = rule.Misses + 1 };
        if (rule.Misses >= 2)
        {
            Try(() => _session.Db.DeleteSkipRule(rule.Id));
            tab.Autopilot.Rules.RemoveAll(r => r.Id == rule.Id);
            PushSkips(tab);
            tab.ShowBanner("saved", "Cineon won't skip this any more", timeout: 3);
        }
        else
        {
            Try(() => _session.Db.SaveSkipRule(rule with { UpdatedAt = DateTimeOffset.Now }));
        }
    }

    // MARK: Next episode

    private void OfferNext(BrowserTab tab, LiveTrack track, bool countdown)
    {
        var state = tab.Autopilot;
        if (state.IsHeldForSleep) return;
        if (state.IsCountingDown || (!countdown && state.DidOffer)) return;
        if (!state.IsResolved)
        {
            if (state.IsResolving) return;
            state.IsResolving = true;
            Safe.Fire("next episode", async () =>
            {
                var target = await FindNextAsync(tab, track);
                // The person may have moved on while this was being worked out.
                if (tab.Track?.UrlKey != track.UrlKey && tab.Media is null) return;
                var now = tab.Autopilot;
                now.Target = target;
                now.IsResolved = true;
                now.IsResolving = false;
                if (!now.IsDeclined && !now.DidMove) OfferNext(tab, track, countdown);
            });
            return;
        }
        if (state.Target is not { } next) return;
        state.DidOffer = true;
        state.IsCountingDown = countdown;
        var name = next.Name is { } n ? $", {n}" : "";
        tab.ShowBanner(
            "next",
            $"Next: {next.Ref.ShortLabel}{name}",
            [("play", "Play now", true), ("no", "Not now", false)],
            seconds: countdown ? 10 : null,
            onExpire: countdown ? "auto" : null,
            timeout: countdown ? null : 14);
    }

    private async Task<NextEpisodeTarget?> FindNextAsync(BrowserTab tab, LiveTrack track)
    {
        IReadOnlyList<EpisodeInfo> episodes = Library.Titles.TryGetValue(track.TitleId, out var title)
            ? await _session.Metadata.EpisodesAsync(title)
            : [];
        foreach (var episode in NextEpisode.Candidates(track.Ref, episodes))
        {
            var isNextInSeason = episode.Season == track.Ref.Season && episode.Episode == track.Ref.Episode + 1;
            var name = episodes.FirstOrDefault(e => e.Season == episode.Season && e.Episode == episode.Episode)?.Name;
            var script = string.Create(CultureInfo.InvariantCulture,
                $"window.__cineon ? __cineon.hasEpisode({episode.Season},{episode.Episode},{(isNextInSeason ? "true" : "false")}) : false");
            var onPage = await tab.EvaluateInPageAsync(script) == "true";
            var address = tab.Url is { } url ? EpisodeLinks.Url(url, track.Ref, episode) : null;
            if (onPage) return new NextEpisodeTarget(episode, name, true, isNextInSeason, address);
            if (address is null) continue;
            if (await SiteProbe.CheckAsync(address) is SiteProbe.Result.Alive)
            {
                return new NextEpisodeTarget(episode, name, false, isNextInSeason, address);
            }
        }
        return null;
    }

    /// The next episode now, from a media key, the Jump List or the menu.
    public void SkipToNext(BrowserTab tab)
    {
        if (tab.Track is not { } track)
        {
            _session.Toasts.Show("Cineon doesn't know which episode this is");
            return;
        }
        if (tab.Autopilot.IsResolved)
        {
            if (tab.Autopilot.Target is null) _session.Toasts.Show("This looks like the last episode");
            PlayNext(tab, byHand: true);
            return;
        }
        Safe.Fire("next episode", async () =>
        {
            var target = await FindNextAsync(tab, track);
            tab.Autopilot.Target = target;
            tab.Autopilot.IsResolved = true;
            if (target is null) _session.Toasts.Show("This looks like the last episode");
            PlayNext(tab, byHand: true);
        });
    }

    private void PlayNext(BrowserTab tab, bool byHand)
    {
        if (!byHand && tab.Autopilot.IsHeldForSleep) return;
        if (tab.Autopilot.Target is not { } target) return;
        tab.Autopilot.DidMove = true;
        if (byHand && Settings.LearnSkips && tab.Track is { } track && tab.Media is { } media)
        {
            NoteCredits(media.Duration - media.Position, media.Duration, track.TitleId, tab);
        }
        Safe.Fire("play next", async () =>
        {
            if (target.IsOnPage)
            {
                var script = string.Create(CultureInfo.InvariantCulture,
                    $"__cineon.openEpisode({target.Ref.Season},{target.Ref.Episode},{(target.IsNextInSeason ? "true" : "false")})");
                if (await tab.EvaluateInPageAsync(script) == "true") return;
            }
            if (target.Url is not { } url) return;
            // Changing only the fragment doesn't reload a page, and these sites read it on load.
            var onlyFragmentChanges = Urls.Parse(tab.Core?.Source) is { } now && WithoutFragment(now) == WithoutFragment(url);
            tab.LoadToKeepWatching(url);
            if (onlyFragmentChanges) tab.Reload();
        });
    }

    private static string WithoutFragment(Uri url)
    {
        var text = url.OriginalString;
        var hash = text.IndexOf('#');
        return hash < 0 ? text : text[..hash];
    }

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
