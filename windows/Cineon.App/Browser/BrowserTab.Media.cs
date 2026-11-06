using System.Text.Json;
using Cineon.Core.Data;
using Cineon.Core.Downloads;
using Microsoft.Web.WebView2.Core;
using Windows.Storage.Streams;

namespace Cineon.App.Browser;

// Playing, the player's files and downloading them, captions, voice boost, second subtitles,
// pictures of the page and finding text. The Mac's "Playback commands", "Downloads",
// "Voice boost" and "Second subtitles" parts.
public sealed partial class BrowserTab
{
    // MARK: Playback commands

    private void MediaCommand(string script) => Run($"window.__cineon && __cineon.{script};", MediaFrame);

    /// Runs a script without waiting, in a frame or the main frame.
    private void Run(string script, CoreWebView2Frame? frame)
    {
        if (_bridge is not { } bridge) return;
        Safe.Fire("page script", () => bridge.RunAsync(script, frame));
    }

    /// Runs a command in the frame holding the video.
    public void PlayerCommand(string script) => MediaCommand(script);

    /// Runs a script in the frame holding the video and returns its result as JSON.
    public async Task<string?> EvaluateInPlayerAsync(string script) =>
        _bridge is { } bridge ? await bridge.RunAsync(script, MediaFrame) : null;

    /// Runs in the top frame, which is where a page's episode list lives.
    public async Task<string?> EvaluateInPageAsync(string script) =>
        _bridge is { } bridge ? await bridge.RunAsync(script, null) : null;

    /// A small card over the player, which unlike a toast can still be seen in fullscreen.
    public void ShowBanner(string id, string text, IReadOnlyList<(string Id, string Label, bool Primary)>? actions = null,
        double? seconds = null, string? onExpire = null, double? timeout = null)
    {
        var options = new Dictionary<string, object>
        {
            ["id"] = id,
            ["text"] = text,
            ["actions"] = (actions ?? []).Select(a => new Dictionary<string, object> { ["id"] = a.Id, ["label"] = a.Label, ["primary"] = a.Primary }).ToList(),
        };
        if (seconds is { } s) options["seconds"] = s;
        if (onExpire is not null) options["onExpire"] = onExpire;
        if (timeout is { } t) options["timeout"] = t;
        LastBannerForTests = $"{id}|{text}|{(seconds is null ? "offer" : "countdown")}";
        MediaCommand($"banner({JsonSerializer.Serialize(options)})");
    }

    public void PausePlayback() => MediaCommand("pause()");
    public void Play() => MediaCommand("play()");
    /// Fades the sound out over this long, then pauses and puts the volume back.
    public void FadeOut(double seconds) => MediaCommand($"fadeOut({Json.Num(Math.Max(0.5, seconds))})");
    public void CancelFade() => MediaCommand("cancelFade()");
    public void TogglePlayback() => MediaCommand("toggle()");
    public void Seek(double seconds) => MediaCommand($"seek({Json.Num(seconds)})");
    public void Skip(double seconds) => MediaCommand($"skip({Json.Num(seconds)})");
    public void SetRate(double rate) => MediaCommand($"rate({Json.Num(rate)})");
    public void TogglePictureInPicture() => MediaCommand("pip()");

    public void SetAmbient(bool on)
    {
        if (on)
        {
            if (!AmbientFramesBlocked) MediaCommand("ambient(true)");
        }
        else
        {
            MediaCommand("ambient(false)");
        }
    }

    public void SetTheater(bool on)
    {
        if (_bridge is null) return;
        var run = on ? "window.__cineonTheater.enable()" : "window.__cineonTheater && window.__cineonTheater.clear()";
        Run(on ? PageScripts.Theater + "\n" + run : run, null);
        IsTheaterOn = on;
    }

    /// A long video just became ready. Everything it should know before it starts.
    public Dictionary<string, object>? ReplyToReadyVideo(MediaEvent e)
    {
        var reply = new Dictionary<string, object>();
        if (Session.Tracker.ResumePosition(e, this) is { } position) reply["seekTo"] = position;
        if (Session.Autopilot.Skips(e, this) is { } skips) reply["skips"] = skips;
        if (WantsAutoplay(Url?.OriginalString) && e.Duration >= WatchTracker.MinimumDuration)
        {
            _autoplayKey = null;
            reply["play"] = true;
        }
        return reply.Count == 0 ? null : reply;
    }

    // MARK: Downloads

    /// The file that is the film being shown, out of everything the player asked for.
    public MediaSource? BestSource => MediaSource.Best(Sources, _playingSource);

    PageTitle? IDownloadTab.Parsed => Parsed is { } p
        ? new PageTitle { Name = p.Name, AltName = p.AltName, Year = p.Year, Ref = p.Ref, KindHint = p.KindHint, PosterUrl = p.PosterUrl, Overview = p.Overview }
        : null;

    EpisodeRef? IDownloadTab.TrackRef => Track?.Ref;

    double IDownloadTab.MediaDuration => Media?.Duration ?? 0;

    private void ReceiveSources(JsonElement body, CoreWebView2Frame? frame)
    {
        if (body.Get("items") is not { ValueKind: JsonValueKind.Array } list) return;
        var found = new List<MediaSource>();
        foreach (var entry in list.EnumerateArray())
        {
            if (Urls.Parse(entry.Text("url")) is not { } url || MediaSourceKindExtensions.FromRaw(entry.Text("kind")) is not { } kind) continue;
            found.Add(new MediaSource { Url = url, Kind = kind, FoundAt = entry.Number("at") ?? 0, IsCurrent = entry.Bool("current") ?? true });
        }
        if (found.Count == 0) return;
        var frameUrl = body.Text("frame");
        found.AddRange(SniffedFor(frameUrl, found));
        Sources = found;
        _sourcesFrame = frame;
        SourcesFrameUrl = frameUrl;
        var newSource = body.Text("src");
        // Another episode started in the same page: its subtitles aren't these.
        if (_playingSource is not null && newSource is not null && _playingSource != newSource && SecondSubtitles is not null) ClearSecondSubtitles();
        _playingSource = newSource;
        OnSources?.Invoke();
        if (IsHelper) return;
        RefreshDownloadPill();
    }

    private void ReceiveDownloadClick(JsonElement body)
    {
        var action = body.Text("action");
        var downloads = Session.Downloads;
        var best = BestSource?.Url.OriginalString;
        if (action == "retry" && downloads.Items.FirstOrDefault(i => i.SourceUrl.OriginalString == best && i.Status == DownloadStatus.Failed) is { } existing)
        {
            downloads.Retry(existing.Id);
        }
        else
        {
            downloads.Download(this);
        }
        RefreshDownloadPill();
    }

    /// Shows the download button in the player's frame, saying what it would do now.
    public void RefreshDownloadPill()
    {
        if (_bridge is null) return;
        Dictionary<string, object>? options = null;
        if (Session.Settings.ShowDownloadButton && BestSource is { } best)
        {
            var downloads = Session.Downloads;
            var existing = downloads.Existing(this)
                ?? downloads.Items.FirstOrDefault(i => i.SourceUrl.OriginalString == MediaUrls.Progressive(best.Url.OriginalString));
            var quality = best.Quality is { } q ? $" · {q}" : "";
            options = existing switch
            {
                { Status: DownloadStatus.Downloading or DownloadStatus.Queued } running => DownloadingPill(downloads.Fraction(running)),
                { Status: DownloadStatus.Done } => new() { ["label"] = "Saved", ["progress"] = 0, ["action"] = "open", ["hint"] = "Play the copy on your PC" },
                { Status: DownloadStatus.Failed } failed => new() { ["label"] = "Download again", ["progress"] = 0, ["action"] = "retry", ["hint"] = failed.Error ?? "" },
                _ => new() { ["label"] = $"Download{quality}", ["progress"] = 0, ["hint"] = "Save this video to your PC" },
            };
        }
        var json = options is null ? "null" : JsonSerializer.Serialize(options);
        if (json == _lastPill) return;
        _lastPill = json;
        Run($"window.__cineon && __cineon.downloadPill({json});", _sourcesFrame);
    }

    private static Dictionary<string, object> DownloadingPill(double fraction) => new()
    {
        ["label"] = fraction > 0 ? $"Downloading {(int)(fraction * 100)}%" : "Starting download…",
        ["progress"] = fraction,
        ["busy"] = true,
        ["hint"] = "Saving to your PC",
    };

    /// Caption style for the browser's own text tracks, in the frame that holds the film.
    public void ApplyCaptions(bool force = false)
    {
        if (_bridge is null || !_hasMediaFrame) return;
        var style = Session.Settings.CaptionStyle;
        var key = $"{_mediaFrameUrl}|{style.ToRaw()}";
        if (!force && key == _captionsApplied) return;
        // A frame that never had a style doesn't need clearing.
        if (_captionsApplied is null && style == CaptionStyle.Site) return;
        _captionsApplied = key;
        var css = style.Css is { } text ? JsonSerializer.Serialize(text) : "null";
        Run($"window.__cineon && __cineon.captions({css});", MediaFrame);
    }

    // MARK: Voice boost

    public void ApplyVoiceBoost()
    {
        if (_bridge is null || !_hasMediaFrame) return;
        var on = Session.Settings.VoiceBoost;
        if (!on && BoostState == VoiceBoostState.Off) return;
        MediaCommand($"voiceBoost({(on ? "true" : "false")})");
    }

    // MARK: Second subtitles

    /// Subtitle files the player fetched, which can be shown as a second line.
    public IReadOnlyList<(Uri Url, string Label)> SubtitleChoices =>
        [.. Sources.Where(s => s.Kind == MediaSourceKind.Subtitle).Select((s, index) => (s.Url, SubtitleTrack.LabelFor(s.Url, index)))];

    /// Fetches a subtitle file the way the player did and shows it above the picture.
    public async Task<bool> ShowSecondSubtitlesAsync(Uri url)
    {
        var data = await Session.Downloads.FetchAsync(url, SourcesFrameUrl ?? Url?.OriginalString);
        if (data is null)
        {
            Session.Toasts.Show("Couldn't load those subtitles");
            return false;
        }
        var cues = SubtitleTrack.Parse(Utf8OrCyrillic(data));
        if (cues.Count == 0)
        {
            Session.Toasts.Show("That file has no subtitles Cineon can read");
            return false;
        }
        var index = Math.Max(0, Sources.ToList().FindIndex(s => s.Url.OriginalString == url.OriginalString));
        ShowSecondSubtitles(new SubtitleTrack { Id = url.OriginalString, Label = SubtitleTrack.LabelFor(url, index), Cues = cues });
        return true;
    }

    public void ShowSecondSubtitles(SubtitleTrack track)
    {
        SecondSubtitles = track;
        var cues = track.Cues.Select(c => new Dictionary<string, object> { ["s"] = c.Start, ["e"] = c.End, ["t"] = c.Text });
        MediaCommand($"secondSubtitles({JsonSerializer.Serialize(cues)})");
    }

    public void ClearSecondSubtitles()
    {
        SecondSubtitles = null;
        MediaCommand("secondSubtitles(null)");
    }

    private void ForgetSources()
    {
        Sources = [];
        SecondSubtitles = null;
        BoostState = VoiceBoostState.Off;
        _sourcesFrame = null;
        SourcesFrameUrl = null;
        _playingSource = null;
        _lastPill = null;
        _captionsApplied = null;
    }

    // MARK: Files the network saw

    private sealed record Sniffed(string Url, MediaSourceKind Kind, double At, string? Referer);

    private readonly List<Sniffed> _sniffed = [];

    /// Notes a player file from a response. media.js reads the same from the page's resource
    /// timeline; this also hears what a frame's own script can't report, such as files fetched
    /// by workers. Only kept for the frame they came from (by Referer), as media.js would.
    private void Sniff(string uri, CoreWebView2HttpResponseHeaders response, CoreWebView2HttpRequestHeaders request)
    {
        if (!uri.StartsWith("http", StringComparison.OrdinalIgnoreCase)) return;
        var url = MediaUrls.Progressive(uri);
        var kind = MediaUrls.KindOf(url);
        if (kind is null)
        {
            string? type = null;
            try { type = response.GetHeader("Content-Type"); }
            catch (Exception) { }
            if (type is not null && (type.Contains("mpegurl", StringComparison.OrdinalIgnoreCase))) kind = MediaSourceKind.Hls;
        }
        if (kind is not { } found) return;
        string? referer = null;
        try { if (request.Contains("Referer")) referer = request.GetHeader("Referer"); }
        catch (Exception) { }
        _sniffed.RemoveAll(s => s.Url == url);
        _sniffed.Add(new Sniffed(url, found, DateTimeOffset.Now.ToUnixTimeMilliseconds(), referer));
        if (_sniffed.Count > 60) _sniffed.RemoveAt(0);
    }

    /// Files the network saw for the frame media.js reported from, which its list doesn't have.
    private IEnumerable<MediaSource> SniffedFor(string? frameUrl, List<MediaSource> reported)
    {
        if (Urls.Parse(frameUrl) is not { IsAbsoluteUri: true } frame || _sniffed.Count == 0) yield break;
        var origin = frame.GetLeftPart(UriPartial.Authority);
        var known = reported.Select(s => s.Url.OriginalString).ToHashSet();
        var current = reported.Where(s => s.IsCurrent).Select(s => s.FoundAt).DefaultIfEmpty(double.NaN).Min();
        foreach (var entry in _sniffed)
        {
            if (known.Contains(entry.Url) || entry.Referer is null) continue;
            var fromFrame = entry.Referer == frameUrl || entry.Referer.TrimEnd('/') == origin
                || (Urls.Parse(entry.Referer) is { IsAbsoluteUri: true } referer && referer.GetLeftPart(UriPartial.Authority) == origin
                    && referer.AbsolutePath == frame.AbsolutePath);
            if (!fromFrame || Urls.Parse(entry.Url) is not { } url) continue;
            yield return new MediaSource
            {
                Url = url,
                Kind = entry.Kind,
                FoundAt = entry.At,
                IsCurrent = !double.IsNaN(current) && entry.At >= current - 10000,
            };
        }
    }

    // MARK: Pictures

    /// The page as on screen, as JPEG bytes (quicker to make than PNG, for something sampled
    /// every second and a half). WebView2's capture includes the video picture, which
    /// a WKWebView snapshot leaves black. Null when there's no page or it failed.
    public async Task<byte[]?> CaptureAsync()
    {
        if (_core is not { } core) return null;
        try
        {
            using var stream = new InMemoryRandomAccessStream();
            await core.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Jpeg, stream);
            return await ReadAllAsync(stream);
        }
        catch (Exception)
        {
            return null;
        }
    }

    /// Light from the film when the page won't let its video be read: a small capture of where
    /// the picture is, sampled into six zones. Null when the capture failed. The Mac's
    /// `AppModel.sampleWindow(of:)`.
    public async Task<IReadOnlyList<AmbientModel.Rgb>?> CaptureWindowZonesAsync()
    {
        if (_core is null) return null;
        var rect = await Session.Frames.PictureRectAsync(this);
        var image = await WindowCapture.ImageAsync(this, rect, 48);
        return image is null ? null : ColorZones.Sample(image);
    }

    /// The same from the whole page's capture. The Mac's `AppModel.sampleSnapshot(of:)`.
    public async Task<IReadOnlyList<AmbientModel.Rgb>?> SnapshotZonesAsync()
    {
        if (await CaptureAsync() is not { } png) return null;
        var image = await FrameImage.DecodeAsync(png, 48);
        return image is null ? null : ColorZones.Sample(image);
    }

    // MARK: Find in page

    private string? _findTerm;

    /// Finds text in the page, forwards or backwards, wrapping. True when there's a match.
    public async Task<bool> FindAsync(string text, bool backwards)
    {
        if (_core is not { } core || text.Length == 0) return false;
        try
        {
            var find = core.Find;
            if (_findTerm != text)
            {
                _findTerm = text;
                var options = core.Environment.CreateFindOptions();
                options.FindTerm = text;
                options.SuppressDefaultFindDialog = true;
                options.ShouldHighlightAllMatches = true;
                await find.StartAsync(options);
                for (var wait = 0; wait < 6 && find.MatchCount < 0; wait++) await Task.Delay(50);
                if (backwards && find.MatchCount > 0) find.FindPrevious();
                return find.MatchCount > 0;
            }
            if (backwards) find.FindPrevious(); else find.FindNext();
            return find.MatchCount > 0;
        }
        catch (Exception)
        {
            // An older WebView2 runtime without Find: the page's own search.
            var script = $"window.find({JsonSerializer.Serialize(text)}, false, {(backwards ? "true" : "false")}, true)";
            return await EvaluateInPageAsync(script) == "true";
        }
    }

    public void StopFind()
    {
        _findTerm = null;
        try { _core?.Find.Stop(); }
        catch (Exception) { }
    }
}
