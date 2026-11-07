#if DEBUG_COMMANDS
using System.Diagnostics;
using System.Globalization;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using Cineon.App.Browser;
using Cineon.App.Playback;
using Cineon.App.Services;
using Cineon.App.UI;
using Cineon.Core.Data;
using Cineon.Core.Downloads;
using Cineon.Core.Import;
using Cineon.Core.Metadata;
using Cineon.Core.Together;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Windowing;
using Windows.Foundation;
using Windows.Graphics;

namespace Cineon.App;

/// Lets end-to-end tests drive a Debug build, like the Mac's `cineon://debug/...` links
/// (Cineon/App/DebugCommands.swift). Compiled only with DEBUG_COMMANDS (the Debug configuration),
/// and only ever active on scratch data (`CINEON_DATA_DIR`).
///
/// Two ways in, one set of commands:
///   - `GET http://127.0.0.1:$CINEON_DEBUG_PORT/<command>?<query>` with the header
///     `X-Cineon-Debug: 1`. The reply text is the response body. This is what `fixtures/e2e_windows.py`
///     uses. The header keeps web pages in the test browser from driving the app.
///   - `cineon://debug/<command>?<query>`, which writes the reply to `debug-output.txt` in the data
///     folder, as the Mac does.
///
/// Command names, parameters and reply formats are the Mac's, so the Python checks carry over.
/// Numbers print the way Swift prints them (`300.0`, `true`). Commands the Mac answers with nothing
/// answer `ok` here. Windows additions: `/ping`, `/link?url=`, `/quit`.
public static class DebugCommands
{
    public const string PortVariable = "CINEON_DEBUG_PORT";
    public const string HeaderName = "X-Cineon-Debug";

    private static AppModel? _app;
    private static DispatcherQueue? _queue;
    private static TcpListener? _listener;
    private static int _port;

    private static string OutputPath => Path.Combine(AppPaths.Root, "debug-output.txt");

    // MARK: Transport

    /// Starts the local port when this is a test run on scratch data that asked for one.
    public static void Start(AppModel app, DispatcherQueue queue)
    {
        _app = app;
        _queue = queue;
        if (!AppPaths.IsScratch || _listener is not null) return;
        if (!int.TryParse(Environment.GetEnvironmentVariable(PortVariable), NumberStyles.Integer, CultureInfo.InvariantCulture, out var port)
            || port is <= 0 or > 65535)
        {
            return;
        }
        _port = port;
        _ = Task.Run(() => ListenAsync(port));
    }

    private static async Task ListenAsync(int port)
    {
        // A copy that was killed a moment ago may still hold the port for a little while.
        TcpListener? listener = null;
        for (var attempt = 0; attempt < 40 && listener is null; attempt++)
        {
            try
            {
                var candidate = new TcpListener(IPAddress.Loopback, port);
                candidate.Server.SetSocketOption(SocketOptionLevel.Socket, SocketOptionName.ReuseAddress, true);
                candidate.Start();
                listener = candidate;
            }
            catch (SocketException error)
            {
                if (attempt == 39) CrashLog.Write($"debug port {port}", error);
                await Task.Delay(250);
            }
        }
        if (listener is null) return;
        _listener = listener;
        while (true)
        {
            TcpClient client;
            try
            {
                client = await listener.AcceptTcpClientAsync();
            }
            catch (ObjectDisposedException)
            {
                return;
            }
            catch (SocketException)
            {
                continue;
            }
            _ = Task.Run(() => ServeAsync(client));
        }
    }

    private static async Task ServeAsync(TcpClient client)
    {
        using var owned = client;
        try
        {
            client.NoDelay = true;
            var stream = client.GetStream();
            var head = await ReadHeadAsync(stream);
            if (head is null) return;
            var lines = head.Split("\r\n");
            var parts = lines[0].Split(' ');
            if (parts.Length < 2 || parts[0] != "GET")
            {
                await RespondAsync(client, 405, "GET only");
                return;
            }
            var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (var line in lines.Skip(1))
            {
                var colon = line.IndexOf(':');
                if (colon > 0) headers[line[..colon].Trim()] = line[(colon + 1)..].Trim();
            }
            var host = headers.GetValueOrDefault("Host") ?? "";
            if (!headers.ContainsKey(HeaderName) || headers.ContainsKey("Origin")
                || !(host == $"127.0.0.1:{_port}" || host == $"localhost:{_port}"))
            {
                await RespondAsync(client, 403, $"needs the {HeaderName} header and a local Host");
                return;
            }
            if (!Uri.TryCreate("http://127.0.0.1" + (parts[1].StartsWith('/') ? parts[1] : "/" + parts[1]), UriKind.Absolute, out var url))
            {
                await RespondAsync(client, 400, "bad address");
                return;
            }
            var path = url.AbsolutePath;
            var query = DeepLink.Query(url);
            string reply;
            try
            {
                reply = await RunOnUiThreadAsync(path, query).WaitAsync(TimeSpan.FromSeconds(240));
            }
            catch (TimeoutException)
            {
                reply = $"timeout {path}";
            }
            await RespondAsync(client, 200, reply);
            if (path == "/quit") _queue?.TryEnqueue(Quit);
        }
        catch (Exception error) when (error is IOException or SocketException or ObjectDisposedException or OperationCanceledException)
        {
            // The test gave up on this request.
        }
        catch (Exception error)
        {
            CrashLog.Write("debug port", error);
        }
    }

    private static async Task<string?> ReadHeadAsync(NetworkStream stream)
    {
        var buffer = new byte[256 * 1024];
        var length = 0;
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(15));
        while (length < buffer.Length)
        {
            var read = await stream.ReadAsync(buffer.AsMemory(length), timeout.Token);
            if (read == 0) return null;
            length += read;
            var text = Encoding.UTF8.GetString(buffer, 0, length);
            var end = text.IndexOf("\r\n\r\n", StringComparison.Ordinal);
            if (end >= 0) return text[..end];
        }
        return null;
    }

    private static async Task RespondAsync(TcpClient client, int status, string body)
    {
        var bytes = Encoding.UTF8.GetBytes(body);
        var reason = status switch { 200 => "OK", 400 => "Bad Request", 403 => "Forbidden", 405 => "Method Not Allowed", _ => "Error" };
        var head = Encoding.ASCII.GetBytes(
            $"HTTP/1.1 {status} {reason}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {bytes.Length}\r\nConnection: close\r\n\r\n");
        var stream = client.GetStream();
        await stream.WriteAsync(head);
        await stream.WriteAsync(bytes);
        await stream.FlushAsync();
        // Lets the test close first (it reads to Content-Length and hangs up), so the TIME_WAIT is on
        // its side and a restarted copy can listen on the port again at once.
        try
        {
            using var wait = new CancellationTokenSource(TimeSpan.FromSeconds(2));
            var sink = new byte[512];
            while (await stream.ReadAsync(sink, wait.Token) > 0) { }
        }
        catch (Exception)
        {
            // Closed either way.
        }
    }

    /// Runs a command on the UI thread, where everything it touches lives, and waits for its reply.
    private static Task<string> RunOnUiThreadAsync(string path, IReadOnlyDictionary<string, string> query)
    {
        var done = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
        if (_queue is not { } queue || _app is not { } app)
        {
            done.SetResult("not ready");
            return done.Task;
        }
        if (!queue.TryEnqueue(async () =>
            {
                try
                {
                    done.TrySetResult(await RunAsync(path, query, app));
                }
                catch (Exception error)
                {
                    CrashLog.Write($"debug {path}", error);
                    done.TrySetResult($"error: {error.GetType().Name}: {error.Message}");
                }
            }))
        {
            done.TrySetResult("error: the UI thread is gone");
        }
        return done.Task;
    }

    /// `cineon://debug/...`: the same commands, with the reply written to `debug-output.txt` like the Mac.
    /// Called on the UI thread by DeepLink, which has already checked for scratch data.
    public static void RunFromLink(string path, IReadOnlyDictionary<string, string> query, AppModel app)
    {
        _app ??= app;
        _queue ??= DispatcherQueue.GetForCurrentThread();
        Safe.Fire($"debug {path}", async () =>
        {
            var reply = await RunAsync(path, query, app);
            // Commands the Mac answers with nothing leave the file alone here too.
            if (reply != Ok) Write(reply);
            if (path == "/quit") Quit();
        });
    }

    private static void Write(string text)
    {
        try { File.WriteAllText(OutputPath, text, new UTF8Encoding(false)); }
        catch (Exception) { }
    }

    private static void Quit()
    {
        try { _listener?.Stop(); }
        catch (Exception) { }
        _app?.PrepareToQuit();
        Microsoft.UI.Xaml.Application.Current?.Exit();
    }

    private const string Ok = "ok";

    // MARK: Commands

    private static async Task<string> RunAsync(string path, IReadOnlyDictionary<string, string> q, AppModel app)
    {
        string? Get(string key) => q.TryGetValue(key, out var value) ? value : null;
        double? Double(string key) => double.TryParse(Get(key), NumberStyles.Float, CultureInfo.InvariantCulture, out var v) ? v : null;
        long? Long(string key) => long.TryParse(Get(key), NumberStyles.Integer, CultureInfo.InvariantCulture, out var v) ? v : null;
        int? Int(string key) => int.TryParse(Get(key), NumberStyles.Integer, CultureInfo.InvariantCulture, out var v) ? v : null;
        Uri? Address(string key) => Uri.TryCreate(Get(key), UriKind.Absolute, out var v) ? v : null;
        var tab = app.Browser.Selected;

        switch (path)
        {
            case "/ping":
                return "pong";
            case "/quit":
                return "bye";
            case "/link":
                // Windows only: a `cineon://` link as a second launch would hand it over.
                if (Address("url") is { } link) DeepLink.Handle(link, app);
                return Ok;
            case "/updatecheck":
                Updater.Shared.CheckInBackground();
                return Ok;
            case "/route":
                Route? route = Get("to") switch
                {
                    "home" => Route.Home,
                    "library" => Route.Library,
                    "timeline" => Route.Timeline,
                    "settings" => Route.Settings,
                    "web" => Route.Web,
                    "downloads" => Route.Downloads,
                    "together" => Route.Together,
                    "profile" => Route.Profile,
                    "rate" => Route.Rate,
                    _ => null,
                };
                if (route is { } destination) app.Go(destination);
                return Ok;
            case "/theme":
                app.IsDark = Get("to") != "white";
                return Ok;
            case "/open":
                if (Address("url") is { } target) app.Browser.OpenTab(target);
                return Ok;
            case "/addsite":
                if (Address("url") is { } siteUrl && app.Library.AddSite(siteUrl, Get("name")) is { } site)
                {
                    app.Library.UpdateSite(site with { SearchTemplate = Get("search") });
                }
                return Ok;
            case "/eval":
                // The Mac's `world=cineon` has no counterpart: WebView2 has no content worlds.
                if (tab is not { HasWebView: true }) return "no web view";
                return Shown(await tab.EvaluateInPageAsync(Get("js") ?? ""));
            case "/mediaeval":
                if (tab is not { HasWebView: true }) return "no web view";
                return Shown(await tab.EvaluateInPlayerAsync(Get("js") ?? ""));
            case "/searchselect":
                if (app.Browser.Search is { } search && search.Results.FirstOrDefault(r => r.Site.Host == Get("host")) is { } result)
                {
                    search.Select(result.Id);
                }
                return Ok;
            case "/importreport":
                return await ImportReportAsync(Get("apply"), app);
            case "/windowclick":
                // Window coordinates in view pixels from the top left, for driving native screens.
                if (app.Window is not { } clickWindow) return "no window";
                return await ClickAsync(clickWindow, new Point(Double("x") ?? 0, Double("y") ?? 0), $"clicked window {Get("x")},{Get("y")}");
            case "/fullscreen":
                if (app.Window is { } fullWindow)
                {
                    var on = Get("on") == "1";
                    var isOn = fullWindow.AppWindow.Presenter.Kind == AppWindowPresenterKind.FullScreen;
                    if (on != isOn) fullWindow.AppWindow.SetPresenter(on ? AppWindowPresenterKind.FullScreen : AppWindowPresenterKind.Overlapped);
                }
                return Ok;
            case "/windowsize":
                if (app.Window is { } sizedWindow && Double("w") is { } width && Double("h") is { } height)
                {
                    if (sizedWindow.AppWindow.Presenter is OverlappedPresenter { State: OverlappedPresenterState.Maximized } presenter) presenter.Restore();
                    var scale = Scale(sizedWindow);
                    sizedWindow.AppWindow.Resize(new SizeInt32((int)Math.Round(width * scale), (int)Math.Round(height * scale)));
                }
                return Ok;
            case "/sitepref":
                app.Session.Shields.Update(Get("host"),
                    shieldsOff: Get("shieldsOff") is { } off ? off == "1" : null,
                    trackingOff: Get("trackingOff") is { } tracking ? tracking == "1" : null);
                return Ok;
            case "/hibernate":
                foreach (var other in app.Browser.Tabs.ToList())
                {
                    if (other.Id != app.Browser.SelectedId) other.Hibernate();
                }
                return Ok;
            case "/selecttab":
                app.Browser.SelectTab(Int("i") ?? 0);
                return Ok;
            case "/closetab":
                if (tab is not null) app.Browser.Close(tab);
                return Ok;
            case "/settings":
                ChangeSettings(q, app);
                return Ok;
            case "/click":
                // Page coordinates from the web view's top left.
                if (tab?.Control is not { } control || app.Window is not { } window) return "no web view";
                var origin = control.TransformToVisual(null).TransformPoint(new Point(Double("x") ?? 0, Double("y") ?? 0));
                return await ClickAsync(window, origin, $"clicked {Get("x")},{Get("y")}");
            case "/state":
                return State(app);
            case "/commandbar":
                app.OpenCommandBar(Get("seed") ?? "");
                return Ok;
            case "/detail":
                app.DetailTitleId = Long("id");
                return Ok;
            case "/resume":
                if (Address("url") is { } resumeUrl)
                {
                    var opened = app.Browser.OpenTab(null);
                    opened.ExpectedResumeDuration = Double("expected");
                    opened.Load(resumeUrl, Double("at"));
                }
                return Ok;
            case "/banner":
                if (tab is not null) app.Session.Autopilot.HandleBanner(Get("banner") ?? "", Get("action") ?? "", tab);
                return Ok;
            case "/removesites":
                foreach (var each in app.Library.Sites.ToList()) app.Library.RemoveSite(each.Id);
                return Ok;
            case "/deletesession":
                if (Long("id") is { } sessionId) app.Library.DeleteSession(sessionId);
                return Ok;
            case "/download":
                if (tab is not null) app.Session.Downloads.Download(tab);
                return Ok;
            case "/downloads":
                return DownloadsReport(app);
            case "/keepwatching":
                if (Address("url") is { } keepUrl) app.Resume(keepUrl, Double("at"));
                return Ok;
            case "/sleep":
                switch (Get("mode"))
                {
                    case "end": app.StartSleepTimer(SleepTimerMode.EndOfItem); break;
                    case "cancel": app.CancelSleepTimer(); break;
                    case "seconds": app.StartSleepTimer(Double("s") ?? 30); break;
                    default: app.StartSleepTimer(SleepTimerMode.ForMinutes(Int("m") ?? 30)); break;
                }
                return Ok;
            case "/sleepstate":
            {
                var timer = app.SleepTimer;
                return Lines(
                    $"active={B(timer is not null)}",
                    $"mode={(timer is null ? "-" : timer.Mode.Minutes is int minutes ? $"minutes({minutes})" : "endOfItem")}",
                    $"fading={B(timer?.IsFading ?? false)}",
                    $"remaining={S(app.SleepTimerRemaining ?? -1)}",
                    "end=1");
            }
            case "/nowplaying":
                return Lines([.. app.NowPlaying.Published.OrderBy(p => p.Key, StringComparer.Ordinal).Select(p => $"{p.Key}={p.Value}"), "end=1"]);
            case "/remote":
                if (app.NowPlaying.Handlers.TryGetValue(Get("cmd") ?? "", out var handler)) handler(Double("to") ?? 0);
                return Ok;
            case "/voiceboost":
            {
                var level = Number(tab is null ? null : await tab.EvaluateInPlayerAsync("__cineon.boostLevel()")) ?? -2;
                var volume = Number(tab is null ? null : await tab.EvaluateInPlayerAsync("__cineon.volume()")) ?? -2;
                return Lines($"state={tab?.BoostState.ToRaw() ?? "-"}", $"level={S(level)}", $"volume={S(volume)}", "end=1");
            }
            case "/subs2":
                if (tab is null) return Ok;
                if (Get("clear") == "1")
                {
                    tab.ClearSecondSubtitles();
                    return Ok;
                }
                if (Get("file") is { } file)
                {
                    if (SubtitleTrack.Load(file) is { } track) tab.ShowSecondSubtitles(track);
                }
                else if (Int("index") is { } index && index >= 0 && index < tab.SubtitleChoices.Count)
                {
                    await tab.ShowSecondSubtitlesAsync(tab.SubtitleChoices[index].Url);
                }
                return Ok;
            case "/subs2state":
            {
                var raw = tab is null ? null : Json.Parse(await tab.EvaluateInPlayerAsync("__cineon.secondSubtitleText()"));
                var text = raw is { ValueKind: JsonValueKind.String } s ? s.GetString() ?? "-" : "-";
                var choices = string.Join(",", (tab?.SubtitleChoices ?? []).Select(c => $"{c.Label}|{c.Url.OriginalString}"));
                return Lines($"track={tab?.SecondSubtitles?.Label ?? "-"}", $"text={text}", $"choices={choices}", "end=1");
            }
            case "/localsubs":
                if (app.LocalPlayback is not { } local) return Ok;
                if (Get("add") is { } add) local.AddSubtitles(add);
                if (Int("second") is { } second && second >= 0 && second < local.SubtitleTracks.Count)
                {
                    local.SecondSubtitleId = local.SubtitleTracks[second].Id;
                }
                return Ok;
            case "/season":
                if (tab is null) return Ok;
                if (Get("from") == "series") app.Session.Seasons.StartSeries(tab);
                else app.Session.Seasons.Start(tab, fromCurrent: Get("from") == "current");
                return Ok;
            case "/seasoncancel":
                app.Session.Seasons.Cancel();
                return Ok;
            case "/seasonconfirm":
                app.Session.Seasons.Confirm();
                return Ok;
            case "/seasonresume":
                app.Session.Seasons.Resume();
                return Ok;
            case "/seasonstate":
                return SeasonReport(app);
            case "/upnext":
            {
                var reply = Lines(
                    $"next={(app.UpNext is { } next ? next.Item.Id.ToString(CultureInfo.InvariantCulture) : "-")}",
                    $"playing={app.LocalPlayback?.DownloadId ?? -1}",
                    $"ended={B(app.LocalPlayback?.DidEnd ?? false)}",
                    "end=1");
                if (Get("play") == "1") app.PlayUpNext();
                return reply;
            }
            case "/fakeepisodes":
                if (Long("title") is { } fakeTitle) app.Session.Metadata.TestEpisodes[fakeTitle] = FakeEpisodes(Get("list") ?? "");
                return Ok;
            case "/checknew":
            {
                var alerts = app.Session.Alerts;
                await alerts.CheckAsync(force: true);
                return Lines([
                    .. alerts.Alerts.Values.Select(a => $"alert {a.TitleId} latest={a.Latest.ShortLabel} new={a.NewCount}"),
                    $"fresh={alerts.Fresh.Count}",
                    $"notified={alerts.LastNotificationForTests ?? "-"}",
                    "end=1",
                ]);
            }
            case "/deletetitle":
                if (Long("id") is { } deleteId) app.Library.Delete(deleteId);
                return Ok;
            case "/addtitle":
            {
                if (Get("name") is not { } name) return Ok;
                var added = app.Library.AddTitle(name, Int("year"),
                    TitleKind.FromRaw(Get("kind")) ?? TitleKind.Film,
                    TitleStatus.FromRaw(Get("status")) ?? TitleStatus.Watched);
                return Lines($"id={added?.Id ?? -1}", "end=1");
            }
            case "/sharecard":
            {
                var written = false;
                try
                {
                    var png = await ShareCard.RenderAsync(app.Session.Stats, app.Session.Pet, app.Session.Profile.Name);
                    await File.WriteAllBytesAsync(Path.Combine(AppPaths.Root, "share-card.png"), png);
                    written = png.Length > 0;
                }
                catch (Exception error)
                {
                    CrashLog.Write("debug share card", error);
                }
                return Lines($"written={B(written)}", "end=1");
            }
            case "/rate":
                if (Long("id") is { } rateId) app.Library.SetRating(rateId, Int("halves"));
                return Ok;
            case "/cloud":
            {
                var cloud = app.Session.Cloud;
                if (Get("do") == "sync") await cloud.SyncAsync();
                return Lines(
                    $"lastSync={(cloud.LastSync is { } at ? S(at.ToUnixTimeMilliseconds() / 1000.0) : "-")}",
                    $"error={cloud.LastError ?? "-"}",
                    $"count={cloud.CloudCount}",
                    $"key={app.Session.Together.RecoveryCode}",
                    "end=1");
            }
            case "/adopt":
            {
                if (Get("code") is not { } code) return Ok;
                var ok = await app.Session.Together.AdoptAsync(code);
                if (ok) await app.Session.Cloud.SyncAsync();
                return Lines($"adopted={B(ok)}", "end=1");
            }
            case "/stats":
            {
                var stats = app.Session.Stats;
                var pet = app.Session.Pet;
                return Lines(
                    $"hours={S(stats.EstimatedHours)}", $"tracked={S(stats.TrackedHours)}", $"films={stats.FilmsWatched}",
                    $"episodes={stats.EpisodesFinished}", $"rated={stats.Rated}", $"average={S(stats.AverageRating ?? -1)}",
                    $"genre={stats.FavouriteGenre ?? "-"}",
                    $"genres={string.Join(",", stats.Genres.Take(4).Select(g => $"{g.Name}:{g.Weight.ToString("F2", CultureInfo.InvariantCulture)}"))}",
                    $"streak={stats.CurrentStreak}", $"longest={stats.LongestStreak}", $"sessions={stats.Sessions}",
                    $"pet={pet.Code}", $"species={pet.SpeciesLabel}", "end=1");
            }
            case "/intent":
            {
                // Siri and Shortcuts have no Windows counterpart. The Jump List's tasks do the same
                // things through these links (Services/JumpList.cs).
                var jumpLink = Get("name") switch
                {
                    "playpause" => "cineon://playpause",
                    "continue" => "cineon://continue",
                    "next" => "cineon://next",
                    "sleep" => $"cineon://sleep?minutes={Int("minutes") ?? 30}",
                    "profile" => "cineon://profile",
                    _ => null,
                };
                if (jumpLink is null) return "n/a";
                DeepLink.Handle(new Uri(jumpLink), app);
                return Ok;
            }
            case "/playdownload":
                if (Long("id") is { } downloadId && app.Session.Downloads.Item(downloadId) is { } item) app.PlayDownload(item);
                return Ok;
            case "/player":
            {
                var playback = app.LocalPlayback;
                return Lines(
                    $"playing={B(playback?.IsPlaying ?? false)}",
                    $"position={S(playback?.Position ?? -1)}",
                    $"duration={S(playback?.Duration ?? -1)}",
                    $"caption={OneLine(playback?.Caption ?? "-")}",
                    $"tracks={playback?.SubtitleTracks.Count ?? 0}",
                    $"route={RouteName(app.Route)}",
                    $"ambient={Ambient(app)}",
                    $"windowVisible={B(app.Window?.IsShowing ?? false)}",
                    "end=1");
            }
            case "/playerseek":
                if (app.LocalPlayback is { } seeking && Double("to") is { } to) seeking.Skip(to - seeking.Position);
                return Ok;
            case "/together":
                return await TogetherAsync(q, app);
            case "/moment":
                if (tab is not null) app.Session.Frames.SaveMoment(tab);
                return Ok;
            case "/findelsewhere":
                if (tab is not null) app.Session.Rescue.FindElsewhere(tab);
                return Ok;
            case "/rescuetake":
                if (tab?.Rescue is { Options: [var first, ..] }) app.Session.Rescue.Take(first, tab);
                return Ok;
            case "/stallseconds":
                var stallSeconds = Double("s") is { } stall ? Json.Num(stall) : "30";
                tab?.PlayerCommand($"setStallSeconds({stallSeconds})");
                return Ok;
            case "/cinema":
                app.ToggleCinema();
                return Ok;
            case "/seed":
                SeedDemo(app);
                return Ok;
            case "/profiles":
                app.IsProfilePickerVisible = Get("show") != "0";
                return Ok;
            case "/addprofile":
            {
                var profile = app.Profiles.Add(Get("name") ?? "Guest");
                if (Get("switch") == "1") app.SwitchProfile(profile);
                return Ok;
            }
            case "/switchprofile":
                if (app.Profiles.Profiles.FirstOrDefault(p => p.Name == Get("name")) is { } chosen) app.SwitchProfile(chosen);
                return Ok;
            case "/sheet":
                app.Sheet = Get("kind") switch
                {
                    "addsite" => new AppSheet.AddSite(null),
                    "addtitle" => new AppSheet.AddTitle(Get("q")),
                    "relink" => new AppSheet.Relink(),
                    "import" => new AppSheet.ImportBrowser(),
                    _ => null,
                };
                return Ok;
            case "/filterupdate":
                return $"filterupdate {B(await app.Filters.UpdateAsync())}";
            default:
                return $"unknown {path}";
        }
    }

    private static void ChangeSettings(IReadOnlyDictionary<string, string> q, AppModel app)
    {
        bool? Flag(string key) => q.TryGetValue(key, out var value) ? value == "1" : null;
        var s = app.Settings;
        if (q.TryGetValue("minimumSeconds", out var minimumText)
            && double.TryParse(minimumText, NumberStyles.Float, CultureInfo.InvariantCulture, out var minimum))
        {
            s = s with { MinimumSecondsToTrack = minimum };
        }
        if (Flag("ambient") is { } ambient) s = s with { AmbientLight = ambient };
        if (Flag("metadata") is { } metadata) s = s with { FetchMetadata = metadata };
        if (Flag("frames") is { } frames) s = s with { KeepFrames = frames };
        if (Flag("downloadButton") is { } button) s = s with { ShowDownloadButton = button };
        if (q.TryGetValue("captions", out var captions) && CaptionStyle.FromRaw(captions) is { } style) s = s with { CaptionStyle = style };
        if (Flag("voiceBoost") is { } boost) s = s with { VoiceBoost = boost };
        if (Flag("binWatched") is { } bin) s = s with { BinWatchedDownloads = bin };
        if (Flag("playNext") is { } next) s = s with { PlayNextDownload = next };
        if (Flag("alerts") is { } alerts) s = s with { NewEpisodeAlerts = alerts };
        if (Flag("cloud") is { } cloud) s = s with { CloudBackup = cloud };
        if (Flag("sharePet") is { } pet) s = s with { SharePet = pet };
        app.Settings = s;
    }

    // MARK: Reports

    private static string State(AppModel app)
    {
        var browser = app.Browser;
        var tab = browser.Selected;
        IReadOnlyDictionary<string, string> extra;
        try { extra = browser.DebugState(); }
        catch (Exception) { extra = new Dictionary<string, string>(); }
        string X(string key) => extra.TryGetValue(key, out var value) ? value : "-";
        var parsed = tab?.Parsed;
        var media = tab?.Media;
        var blocked = tab?.Blocked ?? default;
        var window = app.Window;
        var lines = new List<(string Key, string Value)>
        {
            ("profile", app.Session.Profile.Name),
            ("profileid", Database.UuidString(app.Session.Profile.Id)),
            ("route", RouteName(app.Route)),
            ("url", tab?.Url?.OriginalString ?? "-"),
            ("title", tab?.Title ?? "-"),
            ("parsed", parsed is null ? "-"
                : $"{parsed.Name}|{parsed.Year ?? 0}|S{parsed.Ref.Season}E{parsed.Ref.Episode}|{parsed.KindHint.ToRaw()}|{S(parsed.Confidence)}"),
            ("media", media is { } m ? $"{S(m.Position)}/{S(m.Duration)} playing={B(m.IsPlaying)}" : "-"),
            ("track", (tab?.Track?.TitleId ?? -1).ToString(CultureInfo.InvariantCulture)),
            ("blocked", $"ShieldStats(ads: {blocked.Ads}, popups: {blocked.Popups}, redirects: {blocked.Redirects}, overlays: {blocked.Overlays})"),
            ("framesBlocked", B(tab?.AmbientFramesBlocked ?? false)),
            ("fullscreen", tab is null ? "-1" : X("fullscreen")),
            ("hasSuperview", tab is null ? "false" : X("hasSuperview")),
            ("windowVisible", B(window?.IsShowing ?? false)),
            ("appActive", B(window is not null && GetForegroundWindow() == window.Handle)),
            ("ambientOn", B(app.Settings.AmbientLight)),
            ("ambient", Ambient(app)),
            ("tabs", browser.Tabs.Count.ToString(CultureInfo.InvariantCulture)),
            ("rules", app.Filters.RulesSummary),
            ("tablist", X("tablist")),
            ("search", X("search")),
            ("toast", app.Toasts.Current?.Message ?? "-"),
            ("banner", tab?.LastBannerForTests ?? "-"),
            // Windows only: what the autopilot thinks, for tests that wait on its banners.
            ("autopilot", tab is { } t
                ? $"target={t.Autopilot.Target?.Ref.ShortLabel ?? "-"} resolving={t.Autopilot.IsResolving} resolved={t.Autopilot.IsResolved} offered={t.Autopilot.DidOffer} countdown={t.Autopilot.IsCountingDown} declined={t.Autopilot.IsDeclined} moved={t.Autopilot.DidMove} trackref={t.Track?.Ref.ShortLabel ?? "-"} cleared={t.TrackClearedForTests ?? "-"}"
                : "-"),
            ("rescue", tab?.Rescue?.DebugText ?? "-"),
            ("failure", tab?.Failure?.Host ?? "-"),
            ("frames", app.Library.FramesBySession.Values.Sum(list => list.Count).ToString(CultureInfo.InvariantCulture)),
            ("sites", string.Join(",", app.Library.Sites.Select(site => $"{site.Host}|{site.SearchTemplate ?? "-"}"))),
            ("cinema", B(app.IsCinema)),
            ("theater", B(tab?.IsTheaterOn ?? false)),
            ("canGoBack", B(tab?.CanGoBack ?? false)),
            ("status", app.Filters.Status.ToString()),
            ("window", window is null ? "-1" : window.Handle.ToInt64().ToString(CultureInfo.InvariantCulture)),
            ("lights", Lights(window)),
            ("version", Updater.Shared.Version),
            ("canUpdate", B(Updater.Shared.CanCheck)),
            ("updateEvent", Updater.Shared.LastEvent),
            // Windows additions, before memory, which the tests read as the last line.
            ("hibernated", X("hibernated")),
            ("ready", X("ready")),
            ("zoom", X("zoom")),
            ("boost", X("boost")),
            ("best", X("best")),
            ("sourcesFrame", X("sourcesFrame")),
            ("selected", X("selected")),
            ("pageFullscreen", X("pageFullscreen")),
            ("awake", B(app.IsKeepingAwakeForTests)),
            ("scale", window is null ? "-" : S(Scale(window))),
            ("memory", $"{Environment.WorkingSet / 1_048_576}MB"),
        };
        return string.Join("\n", lines.Select(line => $"{line.Key}={OneLine(line.Value)}"));
    }

    /// The window's caption buttons, the Windows stand-in for the Mac's traffic lights: their width and
    /// height in view pixels, or `fullscreen` when the window has none.
    private static string Lights(MainWindow? window)
    {
        if (window is null) return "-";
        try
        {
            if (window.AppWindow.Presenter.Kind == AppWindowPresenterKind.FullScreen) return "fullscreen";
            var scale = Scale(window);
            var bar = window.AppWindow.TitleBar;
            return $"{(int)Math.Round(bar.RightInset / scale)},{(int)Math.Round(bar.Height / scale)}";
        }
        catch (Exception)
        {
            return "-";
        }
    }

    private static string Ambient(AppModel app)
    {
        var zone = app.Ambient.Zones.Count > 0 ? app.Ambient.Zones[0] : AmbientModel.Rgb.Black;
        return $"{S(app.Ambient.Level)} RGB(r: {S(zone.R)}, g: {S(zone.G)}, b: {S(zone.B)})";
    }

    private static string DownloadsReport(AppModel app)
    {
        var downloads = app.Session.Downloads;
        var tab = app.Browser.Selected;
        var lines = new List<string>
        {
            $"best={tab?.BestSource?.Url.OriginalString ?? "-"}",
            $"folder={downloads.Folder}",
        };
        lines.AddRange((tab?.Sources ?? []).Select(s => $"source {s.Kind.ToRaw()} current={B(s.IsCurrent)} {s.Url.OriginalString}"));
        foreach (var item in downloads.Items)
        {
            lines.Add(string.Join("\t",
                "download", $"id={item.Id}", $"status={item.Status.ToRaw()}", $"kind={item.Kind.ToRaw()}",
                $"name={item.FileBaseName}", $"bytes={item.Bytes}", $"total={item.TotalBytes}",
                $"fraction={S(downloads.Fraction(item))}", $"file={item.File ?? "-"}", $"subtitles={item.Subtitles.Count}",
                $"error={OneLine(item.Error ?? "-")}", $"source={item.SourceUrl.OriginalString}", $"title={item.TitleId ?? -1}"));
        }
        lines.Add("end=1");
        return string.Join("\n", lines);
    }

    private static string SeasonReport(AppModel app)
    {
        var seasons = app.Session.Seasons;
        var job = seasons.CurrentJob;
        var proposal = seasons.PendingProposal;
        static string List(IEnumerable<EpisodeRef>? episodes) =>
            episodes is null ? "-" : string.Join(",", episodes.Select(SeasonGrabber.ShortLabel));
        return Lines(
            $"running={B(seasons.IsRunning)}",
            $"finished={B(job?.IsFinished ?? false)}",
            $"looking={B(seasons.IsLooking)}",
            $"paused={B(job?.IsPaused ?? false)}",
            $"scope={(job is null ? "-" : job.Scope.ToString().ToLowerInvariant())}",
            $"label={job?.Label ?? "-"}",
            $"proposal={List(proposal?.Job.Episodes)}",
            $"proposalBytes={proposal?.TotalBytes ?? 0}",
            $"proposalFits={B(proposal?.Fits ?? false)}",
            $"episodes={List(job?.Episodes)}",
            $"queued={List(job?.Queued)}",
            $"missed={List(job?.Missed)}",
            $"current={(job?.Current is { } current ? SeasonGrabber.ShortLabel(current) : "-")}",
            "end=1");
    }

    private static async Task<string> ImportReportAsync(string? apply, AppModel app)
    {
        // Counts only, so a test never prints anyone's browsing.
        var started = Stopwatch.StartNew();
        var sources = await Task.Run(() => BrowserImporter.Discover(ImportRoots.Default));
        var lines = new List<string> { $"discoverSeconds={S(started.Elapsed.TotalSeconds)}", $"sources={sources.Count}" };
        foreach (var source in sources)
        {
            var scanStart = Stopwatch.StartNew();
            var scan = await Task.Run(() => BrowserImporter.Scan(source, ParserRecognizer.Shared));
            lines.Add($"source browser={source.Browser} history={source.HistoryCount} saved={source.BookmarkCount + source.PinnedCount} "
                + $"scanSeconds={S(scanStart.Elapsed.TotalSeconds)} sites={scan.Sites.Count} titles={scan.Titles.Count} pages={scan.Pages.Count}");
            if (apply != source.Browser) continue;
            var applyStart = Stopwatch.StartNew();
            var result = app.Library.ApplyImport(new ImportSelection
            {
                Sites = scan.Sites,
                Titles = [.. scan.Titles.Select(t => (t, t.SuggestedStatus))],
                Pages = scan.Pages,
            });
            lines.Add($"applied seconds={S(applyStart.Elapsed.TotalSeconds)} sites={result.Sites} titles={result.Titles} pages={result.Pages}");
            foreach (var (id, altName) in result.NewTitleIds) app.Session.Metadata.Enrich(id, altName, inBackground: true);
        }
        return string.Join("\n", lines);
    }

    private static async Task<string> TogetherAsync(IReadOnlyDictionary<string, string> q, AppModel app)
    {
        string? Get(string key) => q.TryGetValue(key, out var value) ? value : null;
        var together = app.Session.Together;
        // The Mac starts these and moves on; here each is awaited, so the reply comes once it's done.
        if (Get("code") is { } code) await together.Enter(code);
        if (Get("party") == "start") await together.StartParty();
        if (Get("party") == "leave") await together.LeaveParty();
        if (Get("react") is { } emoji) await together.React(emoji);
        if (Get("say") is { } text) await together.Say(text);
        if (long.TryParse(Get("challenge"), NumberStyles.Integer, CultureInfo.InvariantCulture, out var titleId)
            && app.Library.Titles.TryGetValue(titleId, out var title))
        {
            await together.CreateChallenge(title);
        }
        if (Get("sharewatched") == "1") await together.ShareWatched();
        if (int.TryParse(Get("addshared"), NumberStyles.Integer, CultureInfo.InvariantCulture, out var index)
            && together.OpenedShares.FirstOrDefault() is { } share && index >= 0 && index < share.Titles.Count)
        {
            together.AddToBacklog(share.Titles[index]);
        }
        if (Get("refresh") == "1") await together.RefreshChallengesAsync();
        if (Get("dump") != "1") return Ok;

        var party = together.Party;
        var lines = new List<string>
        {
            $"person={together.PersonId ?? "-"}",
            $"party={(party is null ? "-" : $"{party.Code}|host={party.HostName}|playing={B(party.Playing)}|position={S(party.ExpectedPosition)}|members={string.Join(",", party.Members.Select(m => m.Name))}")}",
            $"isHost={B(together.IsHost)}",
            $"shareCode={together.LastShareCode ?? "-"}",
            $"shares={string.Join(",", together.OpenedShares.Select(s => $"{s.Code}:{string.Join(";", s.Titles.Select(t => t.Name))}"))}",
            $"messages={(party is null ? "-" : string.Join("|", party.Messages.Select(m => $"{m.Name}:{m.Text}")))}",
            $"pets={(party is null ? "-" : string.Join(",", party.Members.Select(m => $"{m.Name}:{m.Pet ?? "-"}")))}",
        };
        foreach (var summary in together.Challenges)
        {
            var state = together.Details.GetValueOrDefault(summary.Code);
            var members = state is null ? "-" : string.Join(",", state.Members.Select(m => $"{m.Name}:{S(m.Fraction)}:{m.Label}"));
            lines.Add($"challenge={summary.Code}|{summary.Title.Name}|total={(int)summary.TotalEpisodes}|winner={state?.WinnerName ?? "-"}|{members}");
        }
        lines.Add("end=1");
        return string.Join("\n", lines.Select(OneLine));
    }

    private static IReadOnlyList<EpisodeInfo> FakeEpisodes(string list)
    {
        var episodes = new List<EpisodeInfo>();
        foreach (var entry in list.Split(',', StringSplitOptions.RemoveEmptyEntries))
        {
            var parts = entry.Split(':');
            var numbers = parts[0].Split('x').Select(n => int.TryParse(n, NumberStyles.Integer, CultureInfo.InvariantCulture, out var v) ? (int?)v : null)
                .OfType<int>().ToList();
            if (numbers.Count != 2) continue;
            DateTimeOffset? released = parts.Length > 1
                && DateTimeOffset.TryParseExact(parts[1], "yyyy-MM-dd", CultureInfo.InvariantCulture,
                    DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out var date)
                ? date : null;
            episodes.Add(new EpisodeInfo(numbers[0], numbers[1], Released: released));
        }
        return episodes;
    }

    /// Fills a throwaway profile with real titles, for reviewing the design with content.
    private static void SeedDemo(AppModel app)
    {
        var library = app.Library;
        var session = app.Session;
        var now = DateTimeOffset.Now;
        (string Name, int Year, TitleKind Kind, TitleStatus Status, string Imdb)[] items =
        [
            ("Dune: Part Two", 2024, TitleKind.Film, TitleStatus.Watching, "tt15239678"),
            ("Severance", 2022, TitleKind.Series, TitleStatus.Watching, "tt11280740"),
            ("Spirited Away", 2001, TitleKind.Cartoon, TitleStatus.Watching, "tt0245429"),
            ("Oppenheimer", 2023, TitleKind.Film, TitleStatus.Watched, "tt15398776"),
            ("Blade Runner 2049", 2017, TitleKind.Film, TitleStatus.Watched, "tt1856101"),
            ("The Bear", 2022, TitleKind.Series, TitleStatus.Watched, "tt14452776"),
            ("Parasite", 2019, TitleKind.Film, TitleStatus.Watched, "tt6751668"),
            ("Arrival", 2016, TitleKind.Film, TitleStatus.Backlog, "tt2543164"),
            ("Past Lives", 2023, TitleKind.Film, TitleStatus.Backlog, "tt13238346"),
            ("Andor", 2022, TitleKind.Series, TitleStatus.Backlog, "tt9253284"),
            ("Princess Mononoke", 1997, TitleKind.Cartoon, TitleStatus.Backlog, "tt0119698"),
            ("The Zone of Interest", 2023, TitleKind.Film, TitleStatus.Backlog, "tt7160372"),
            ("Shogun", 2024, TitleKind.Series, TitleStatus.Backlog, "tt2788316"),
        ];
        for (var index = 0; index < items.Length; index++)
        {
            var (name, year, kind, status, imdb) = items[index];
            if (library.AddTitle(name, year, kind, status, imdbId: imdb) is not { } title) continue;
            Safe.Fire("seed metadata", async () =>
            {
                var hits = await MetadataClient.Shared.SearchAsync(name);
                var hit = hits.FirstOrDefault(h => h.Id == imdb) ?? new MetadataHit(imdb, name, year, kind);
                await session.Metadata.ApplyAsync(hit, title.Id);
            });
            if (status == TitleStatus.Backlog) continue;
            var duration = kind == TitleKind.Series ? 3100.0 : 8700.0;
            var episode = kind == TitleKind.Series ? new EpisodeRef(2, index + 1) : EpisodeRef.None;
            var host = new[] { "flixhub.example", "kino.example", "uaserial.example" }[index % 3];
            var url = new Uri($"https://{host}/watch/{name.ToLowerInvariant().Replace(' ', '-')}");
            var position = status == TitleStatus.Watched ? duration : duration * new[] { 0.36, 0.62, 0.18 }[index % 3];
            var at = now.AddSeconds(-index * 40000 - 3000);
            library.SaveProgress(new WatchProgress
            {
                TitleId = title.Id, Ref = episode, UrlKey = UrlKey.Make(url), Url = url, Host = host, Position = position,
                Duration = duration, Finished = status == TitleStatus.Watched, UpdatedAt = at,
            });
            library.SaveSession(new WatchSession
            {
                Id = 0, TitleId = title.Id, Ref = episode, Url = url, Host = host, StartedAt = at.AddSeconds(-position), EndedAt = at,
                WatchedSeconds = position, StartPosition = 0, EndPosition = position, Duration = duration,
                Finished = status == TitleStatus.Watched,
            });
        }
    }

    // MARK: Real clicks

    /// Clicks through the real input path (SendInput), so pages see a trusted click with a user
    /// gesture, as the Mac's NSEvents do. `point` is in view pixels from the window's top left.
    private static async Task<string> ClickAsync(MainWindow window, Point point, string label)
    {
        var handle = window.Handle;
        BringForward(window);
        var scale = Scale(window);
        var screen = new NativePoint { X = (int)Math.Round(point.X * scale), Y = (int)Math.Round(point.Y * scale) };
        ClientToScreen(handle, ref screen);
        // Gives the window a moment to come forward before the pointer arrives.
        await Task.Delay(150);
        var sent = await Task.Run(() => Inject(screen.X, screen.Y));
        await Task.Delay(120);
        return $"{label} screen={screen.X},{screen.Y} sent={sent} key={B(GetForegroundWindow() == handle)}";
    }

    private static void BringForward(MainWindow window)
    {
        var handle = window.Handle;
        try
        {
            if (IsIconic(handle)) ShowWindow(handle, SwRestore);
            if (GetForegroundWindow() == handle) return;
            // Above everything for a moment, without needing the right to take the foreground.
            SetWindowPos(handle, HwndTopmost, 0, 0, 0, 0, SwpNoMove | SwpNoSize | SwpShowWindow);
            SetWindowPos(handle, HwndNoTopmost, 0, 0, 0, 0, SwpNoMove | SwpNoSize | SwpShowWindow);
            window.BringToFront();
            var foreground = GetForegroundWindow();
            if (foreground == handle || foreground == IntPtr.Zero) return;
            var theirs = GetWindowThreadProcessId(foreground, out _);
            var mine = GetCurrentThreadId();
            if (theirs == mine) return;
            AttachThreadInput(mine, theirs, true);
            SetForegroundWindow(handle);
            BringWindowToTop(handle);
            AttachThreadInput(mine, theirs, false);
        }
        catch (Exception error)
        {
            CrashLog.Write("debug bring forward", error);
        }
    }

    /// A move to the point, then a left button press and release. Runs off the UI thread so the
    /// window can take the events in between.
    private static uint Inject(int x, int y)
    {
        SetCursorPos(x, y);
        var left = GetSystemMetrics(SmXVirtualScreen);
        var top = GetSystemMetrics(SmYVirtualScreen);
        var width = Math.Max(2, GetSystemMetrics(SmCxVirtualScreen));
        var height = Math.Max(2, GetSystemMetrics(SmCyVirtualScreen));
        var nx = (int)Math.Round((x - left) * 65535.0 / (width - 1));
        var ny = (int)Math.Round((y - top) * 65535.0 / (height - 1));
        uint sent = 0;
        sent += Send(nx, ny, MouseMove | MouseAbsolute | MouseVirtualDesk);
        Thread.Sleep(40);
        sent += Send(0, 0, MouseLeftDown);
        Thread.Sleep(50);
        sent += Send(0, 0, MouseLeftUp);
        return sent;
    }

    private static uint Send(int dx, int dy, uint flags)
    {
        var input = new Input
        {
            Type = InputMouse,
            Mouse = new MouseInput { Dx = dx, Dy = dy, Flags = flags },
        };
        return SendInput(1, [input], Marshal.SizeOf<Input>());
    }

    // MARK: Formatting

    /// A number the way Swift prints a Double: `300.0`, `0.25`.
    private static string S(double value)
    {
        if (double.IsNaN(value)) return "nan";
        if (double.IsInfinity(value)) return value > 0 ? "inf" : "-inf";
        var text = value.ToString("R", CultureInfo.InvariantCulture).Replace('E', 'e');
        return text.Contains('.') || text.Contains('e') ? text : text + ".0";
    }

    private static string B(bool value) => value ? "true" : "false";

    private static string RouteName(Route route) => route.ToString().ToLowerInvariant();

    private static string OneLine(string text) => text.Replace("\r", " ").Replace("\n", " ");

    private static string Lines(params IEnumerable<string> lines) => string.Join("\n", lines.Select(OneLine));

    /// What `ExecuteScriptAsync` returned, as the Mac writes `"\(value)"` for what WebKit gives back:
    /// strings bare, Booleans as 1 and 0, whole numbers without a decimal point.
    private static string Shown(string? json)
    {
        if (json is null) return "error: the script couldn't run";
        try
        {
            using var document = JsonDocument.Parse(json);
            var value = document.RootElement;
            return value.ValueKind switch
            {
                JsonValueKind.String => value.GetString() ?? "",
                JsonValueKind.True => "1",
                JsonValueKind.False => "0",
                JsonValueKind.Null or JsonValueKind.Undefined => "<null>",
                JsonValueKind.Number => value.GetDouble() is var n && n == Math.Floor(n) && Math.Abs(n) < 1e15
                    ? ((long)n).ToString(CultureInfo.InvariantCulture)
                    : value.GetDouble().ToString("R", CultureInfo.InvariantCulture),
                _ => json,
            };
        }
        catch (JsonException)
        {
            return json;
        }
    }

    private static double? Number(string? json) => Json.Parse(json) switch
    {
        { ValueKind: JsonValueKind.Number } n => n.GetDouble(),
        { ValueKind: JsonValueKind.True } => 1,
        { ValueKind: JsonValueKind.False } => 0,
        _ => null,
    };

    private static double Scale(MainWindow window)
    {
        if (window.Content?.XamlRoot?.RasterizationScale is double scale && scale > 0) return scale;
        var dpi = GetDpiForWindow(window.Handle);
        return dpi > 0 ? dpi / 96.0 : 1;
    }

    // MARK: Win32

    private const uint InputMouse = 0;
    private const uint MouseMove = 0x0001;
    private const uint MouseLeftDown = 0x0002;
    private const uint MouseLeftUp = 0x0004;
    private const uint MouseVirtualDesk = 0x4000;
    private const uint MouseAbsolute = 0x8000;
    private const int SmXVirtualScreen = 76;
    private const int SmYVirtualScreen = 77;
    private const int SmCxVirtualScreen = 78;
    private const int SmCyVirtualScreen = 79;
    private const int SwRestore = 9;
    private const uint SwpNoSize = 0x0001;
    private const uint SwpNoMove = 0x0002;
    private const uint SwpShowWindow = 0x0040;
    private static readonly IntPtr HwndTopmost = new(-1);
    private static readonly IntPtr HwndNoTopmost = new(-2);

    [StructLayout(LayoutKind.Sequential)]
    private struct NativePoint
    {
        public int X;
        public int Y;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MouseInput
    {
        public int Dx;
        public int Dy;
        public uint MouseData;
        public uint Flags;
        public uint Time;
        public IntPtr ExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct KeyboardInput
    {
        public ushort Key;
        public ushort Scan;
        public uint Flags;
        public uint Time;
        public IntPtr ExtraInfo;
    }

    [StructLayout(LayoutKind.Explicit)]
    private struct InputUnion
    {
        [FieldOffset(0)] public MouseInput Mouse;
        [FieldOffset(0)] public KeyboardInput Keyboard;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Input
    {
        public uint Type;
        public InputUnion Union;

        public MouseInput Mouse
        {
            readonly get => Union.Mouse;
            set => Union.Mouse = value;
        }
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint count, Input[] inputs, int size);

    [DllImport("user32.dll")]
    private static extern bool SetCursorPos(int x, int y);

    [DllImport("user32.dll")]
    private static extern int GetSystemMetrics(int index);

    [DllImport("user32.dll")]
    private static extern bool ClientToScreen(IntPtr window, ref NativePoint point);

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr window);

    [DllImport("user32.dll")]
    private static extern bool BringWindowToTop(IntPtr window);

    [DllImport("user32.dll")]
    private static extern bool IsIconic(IntPtr window);

    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr window, int command);

    [DllImport("user32.dll")]
    private static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);

    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();

    [DllImport("user32.dll")]
    private static extern bool AttachThreadInput(uint attach, uint to, bool on);

    [DllImport("user32.dll")]
    private static extern uint GetDpiForWindow(IntPtr window);
}
#endif
