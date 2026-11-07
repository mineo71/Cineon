using System.Globalization;
using System.Text.RegularExpressions;
using Cineon.App.Playback;
using Cineon.Core.Data;

namespace Cineon.App.Services;

/// `cineon://` links. The Mac's `DeepLink`, plus the Jump List's tasks, which stand in for the
/// Mac's Siri and Shortcuts intents (Intents.swift):
///
///   cineon://open?url=<address>      opens the address in a tab
///   cineon://search?q=<words>        searches every site
///   cineon://continue[?title=<id>]   Continue Watching
///   cineon://playpause               Play or Pause
///   cineon://next                    Next Episode
///   cineon://sleep?minutes=<n>       Set a Sleep Timer (0: at the end of this)
///   cineon://downloads               Open Downloads
///   cineon://profile                 Open My Profile
///   cineon://rate                    Rate My Films
///   cineon://debug/...               test commands, Debug builds on scratch data only (DebugCommands.cs)
public static partial class DeepLink
{
    public const string Scheme = "cineon";

    public static void Handle(Uri url, AppModel app)
    {
        if (!string.Equals(url.Scheme, Scheme, StringComparison.OrdinalIgnoreCase)) return;
        var query = Query(url);
        switch (url.Host.ToLowerInvariant())
        {
            case "open":
                if (query.TryGetValue("url", out var raw) && Uri.TryCreate(raw, UriKind.Absolute, out var target)) app.Browser.Open(target);
                break;
            case "search":
                if (query.TryGetValue("q", out var q)) app.Browser.SearchEverywhere(q);
                break;
            case "continue":
                app.ContinueWatching(query.TryGetValue("title", out var id) && long.TryParse(id, NumberStyles.Integer, CultureInfo.InvariantCulture, out var titleId) ? titleId : null);
                break;
            case "playpause":
                app.TogglePlayback();
                break;
            case "next":
                app.PlayNextEpisode();
                break;
            case "sleep":
                var minutes = query.TryGetValue("minutes", out var text) && int.TryParse(text, NumberStyles.Integer, CultureInfo.InvariantCulture, out var m) ? m : 30;
                app.StartSleepTimer(minutes <= 0 ? SleepTimerMode.EndOfItem : SleepTimerMode.ForMinutes(Math.Min(240, minutes)));
                break;
            case "downloads":
                app.Go(Route.Downloads);
                break;
            case "profile":
                app.Go(Route.Profile);
                break;
            case "rate":
                app.Go(Route.Rate);
                break;
#if DEBUG_COMMANDS
            case "debug":
                // Test commands change and remove things. Only ever on throwaway test data.
                if (!AppPaths.IsScratch) return;
                // The reply goes to debug-output.txt, as on the Mac. The tests use the local port instead.
                DebugCommands.RunFromLink(url.AbsolutePath, query, app);
                break;
#endif
        }
    }

    /// The query's names and values, the last one winning, like the Mac's URLComponents reading.
    public static Dictionary<string, string> Query(Uri url)
    {
        var result = new Dictionary<string, string>(StringComparer.Ordinal);
        var query = url.Query.TrimStart('?');
        if (query.Length == 0) return result;
        foreach (var part in query.Split('&'))
        {
            if (part.Length == 0) continue;
            var equals = part.IndexOf('=');
            var name = equals < 0 ? part : part[..equals];
            var value = equals < 0 ? "" : part[(equals + 1)..];
            result[Uri.UnescapeDataString(name)] = Uri.UnescapeDataString(value);
        }
        return result;
    }

    /// The `cineon:` links in a command line, quoted or not.
    public static IReadOnlyList<Uri> Find(string? commandLine)
    {
        if (string.IsNullOrEmpty(commandLine)) return [];
        var links = new List<Uri>();
        foreach (Match match in LinkPattern().Matches(commandLine))
        {
            var text = match.Groups[1].Success ? match.Groups[1].Value : match.Groups[2].Value;
            if (Uri.TryCreate(text, UriKind.Absolute, out var url)) links.Add(url);
        }
        return links;
    }

    [GeneratedRegex("\"(cineon:[^\"]*)\"|(cineon:[^\\s\"]+)", RegexOptions.IgnoreCase)]
    private static partial Regex LinkPattern();
}
