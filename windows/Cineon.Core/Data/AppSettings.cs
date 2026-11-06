using System.Text.Json;

namespace Cineon.Core.Data;

// Part of the Models.swift port: Swift's AppSettings lives there.

/// <summary>
/// Stored per profile, so each family member keeps their own preferences. Kept as JSON in the
/// profile database's <c>settings</c> table under the key <c>app</c>, with the Mac's key names, so
/// a profile copied from a Mac keeps its settings.
/// </summary>
public sealed record AppSettings
{
    public AppTheme Theme { get; init; } = AppTheme.Dark;
    public bool AmbientLight { get; init; } = true;
    public double AmbientStrength { get; init; } = 0.55;
    public bool LaunchAnimation { get; init; } = true;
    public double SidebarWidth { get; init; } = 252.0;
    public bool SidebarHidden { get; init; }

    public bool AutoResume { get; init; } = true;
    public double FinishThreshold { get; init; } = 0.92;
    public double MinimumSecondsToTrack { get; init; } = 15.0;
    public double HibernateMinutes { get; init; } = 20.0;
    public bool PauseOtherTabs { get; init; } = true;
    public bool AutoRescue { get; init; } = true;
    public bool LearnSkips { get; init; } = true;
    public bool AutoNextEpisode { get; init; } = true;
    public bool KeepFrames { get; init; } = true;

    public bool NetworkBlocking { get; init; } = true;
    public bool PopupShield { get; init; } = true;
    public bool RedirectShield { get; init; } = true;
    public bool OverlaySweeper { get; init; } = true;
    public bool DownloadShield { get; init; } = true;
    public IReadOnlySet<string> EnabledLists { get; init => field = ValueSet<string>.Of(value); } =
        ValueSet<string>.Of(["easylist", "easyprivacy", "ublock", "peterlowe", "cineon-streaming"]);

    public bool FetchMetadata { get; init; } = true;
    public bool SaveBrowsingHistory { get; init; } = true;
    public SearchEngine SearchEngine { get; init; } = SearchEngine.DuckDuckGo;

    public bool ShowDownloadButton { get; init; } = true;
    /// <summary>Empty means the default, a Cineon folder in Videos.</summary>
    public string DownloadsFolder { get; init; } = "";
    public CaptionStyle CaptionStyle { get; init; } = CaptionStyle.Site;

    /// <summary>Dialogue louder, explosions softer, in players whose sound the page may process.</summary>
    public bool VoiceBoost { get; init; }
    /// <summary>Downloaded episodes go to the Recycle Bin once watched to the end.</summary>
    public bool BinWatchedDownloads { get; init; } = true;
    /// <summary>The native player moves on to the next downloaded episode.</summary>
    public bool PlayNextDownload { get; init; } = true;
    /// <summary>A notification when a series you're watching gets a new episode.</summary>
    public bool NewEpisodeAlerts { get; init; } = true;
    /// <summary>Your pixel pet is your avatar in parties and challenges.</summary>
    public bool SharePet { get; init; } = true;
    /// <summary>Ratings and lists are kept in the cloud too, so they survive starting over.</summary>
    public bool CloudBackup { get; init; } = true;

    /// <summary>
    /// Reads settings JSON the way the Mac does: every field falls back to its default when it's
    /// missing or the wrong type, so adding a setting never loses the others. Null when the text
    /// isn't a JSON object at all (the Mac then uses the defaults).
    /// </summary>
    public static AppSettings? Decode(ReadOnlySpan<byte> json)
    {
        JsonDocument document;
        try
        {
            var reader = new Utf8JsonReader(json);
            document = JsonDocument.ParseValue(ref reader);
        }
        catch (JsonException)
        {
            return null;
        }
        using (document)
        {
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object) return null;
            var d = new AppSettings();
            return d with
            {
                Theme = Lenient.Enum(root, "theme", AppTheme.FromRaw) ?? d.Theme,
                AmbientLight = Lenient.Bool(root, "ambientLight") ?? d.AmbientLight,
                AmbientStrength = Lenient.Double(root, "ambientStrength") ?? d.AmbientStrength,
                LaunchAnimation = Lenient.Bool(root, "launchAnimation") ?? d.LaunchAnimation,
                SidebarWidth = Lenient.Double(root, "sidebarWidth") ?? d.SidebarWidth,
                SidebarHidden = Lenient.Bool(root, "sidebarHidden") ?? d.SidebarHidden,
                AutoResume = Lenient.Bool(root, "autoResume") ?? d.AutoResume,
                FinishThreshold = Lenient.Double(root, "finishThreshold") ?? d.FinishThreshold,
                MinimumSecondsToTrack = Lenient.Double(root, "minimumSecondsToTrack") ?? d.MinimumSecondsToTrack,
                HibernateMinutes = Lenient.Double(root, "hibernateMinutes") ?? d.HibernateMinutes,
                PauseOtherTabs = Lenient.Bool(root, "pauseOtherTabs") ?? d.PauseOtherTabs,
                AutoRescue = Lenient.Bool(root, "autoRescue") ?? d.AutoRescue,
                LearnSkips = Lenient.Bool(root, "learnSkips") ?? d.LearnSkips,
                AutoNextEpisode = Lenient.Bool(root, "autoNextEpisode") ?? d.AutoNextEpisode,
                KeepFrames = Lenient.Bool(root, "keepFrames") ?? d.KeepFrames,
                NetworkBlocking = Lenient.Bool(root, "networkBlocking") ?? d.NetworkBlocking,
                PopupShield = Lenient.Bool(root, "popupShield") ?? d.PopupShield,
                RedirectShield = Lenient.Bool(root, "redirectShield") ?? d.RedirectShield,
                OverlaySweeper = Lenient.Bool(root, "overlaySweeper") ?? d.OverlaySweeper,
                DownloadShield = Lenient.Bool(root, "downloadShield") ?? d.DownloadShield,
                EnabledLists = Lenient.StringSet(root, "enabledLists") ?? d.EnabledLists,
                FetchMetadata = Lenient.Bool(root, "fetchMetadata") ?? d.FetchMetadata,
                SaveBrowsingHistory = Lenient.Bool(root, "saveBrowsingHistory") ?? d.SaveBrowsingHistory,
                SearchEngine = Lenient.Enum(root, "searchEngine", SearchEngine.FromRaw) ?? d.SearchEngine,
                ShowDownloadButton = Lenient.Bool(root, "showDownloadButton") ?? d.ShowDownloadButton,
                DownloadsFolder = Lenient.String(root, "downloadsFolder") ?? d.DownloadsFolder,
                CaptionStyle = Lenient.Enum(root, "captionStyle", CaptionStyle.FromRaw) ?? d.CaptionStyle,
                VoiceBoost = Lenient.Bool(root, "voiceBoost") ?? d.VoiceBoost,
                BinWatchedDownloads = Lenient.Bool(root, "binWatchedDownloads") ?? d.BinWatchedDownloads,
                PlayNextDownload = Lenient.Bool(root, "playNextDownload") ?? d.PlayNextDownload,
                NewEpisodeAlerts = Lenient.Bool(root, "newEpisodeAlerts") ?? d.NewEpisodeAlerts,
                SharePet = Lenient.Bool(root, "sharePet") ?? d.SharePet,
                CloudBackup = Lenient.Bool(root, "cloudBackup") ?? d.CloudBackup,
            };
        }
    }

    /// <summary>The same JSON object the Mac writes, with the same keys, as UTF-8.</summary>
    public byte[] Encode()
    {
        using var stream = new MemoryStream();
        using (var w = new Utf8JsonWriter(stream))
        {
            w.WriteStartObject();
            w.WriteString("theme", Theme.ToRaw());
            w.WriteBoolean("ambientLight", AmbientLight);
            w.WriteNumber("ambientStrength", AmbientStrength);
            w.WriteBoolean("launchAnimation", LaunchAnimation);
            w.WriteNumber("sidebarWidth", SidebarWidth);
            w.WriteBoolean("sidebarHidden", SidebarHidden);
            w.WriteBoolean("autoResume", AutoResume);
            w.WriteNumber("finishThreshold", FinishThreshold);
            w.WriteNumber("minimumSecondsToTrack", MinimumSecondsToTrack);
            w.WriteNumber("hibernateMinutes", HibernateMinutes);
            w.WriteBoolean("pauseOtherTabs", PauseOtherTabs);
            w.WriteBoolean("autoRescue", AutoRescue);
            w.WriteBoolean("learnSkips", LearnSkips);
            w.WriteBoolean("autoNextEpisode", AutoNextEpisode);
            w.WriteBoolean("keepFrames", KeepFrames);
            w.WriteBoolean("networkBlocking", NetworkBlocking);
            w.WriteBoolean("popupShield", PopupShield);
            w.WriteBoolean("redirectShield", RedirectShield);
            w.WriteBoolean("overlaySweeper", OverlaySweeper);
            w.WriteBoolean("downloadShield", DownloadShield);
            w.WriteStartArray("enabledLists");
            foreach (var list in EnabledLists) w.WriteStringValue(list);
            w.WriteEndArray();
            w.WriteBoolean("fetchMetadata", FetchMetadata);
            w.WriteBoolean("saveBrowsingHistory", SaveBrowsingHistory);
            w.WriteString("searchEngine", SearchEngine.ToRaw());
            w.WriteBoolean("showDownloadButton", ShowDownloadButton);
            w.WriteString("downloadsFolder", DownloadsFolder);
            w.WriteString("captionStyle", CaptionStyle.ToRaw());
            w.WriteBoolean("voiceBoost", VoiceBoost);
            w.WriteBoolean("binWatchedDownloads", BinWatchedDownloads);
            w.WriteBoolean("playNextDownload", PlayNextDownload);
            w.WriteBoolean("newEpisodeAlerts", NewEpisodeAlerts);
            w.WriteBoolean("sharePet", SharePet);
            w.WriteBoolean("cloudBackup", CloudBackup);
            w.WriteEndObject();
        }
        return stream.ToArray();
    }

    /// <summary>Readers matching Swift's <c>try? container.decode(T.self, forKey:)</c>.</summary>
    private static class Lenient
    {
        private static JsonElement? Find(JsonElement root, string key)
        {
            JsonElement? found = null;
            foreach (var property in root.EnumerateObject())
            {
                if (property.NameEquals(key)) found = property.Value;
            }
            return found;
        }

        public static bool? Bool(JsonElement root, string key) => Find(root, key) switch
        {
            { ValueKind: JsonValueKind.True } => true,
            { ValueKind: JsonValueKind.False } => false,
            _ => null,
        };

        public static double? Double(JsonElement root, string key) =>
            Find(root, key) is { ValueKind: JsonValueKind.Number } e && e.TryGetDouble(out var v) && double.IsFinite(v)
                ? v
                : null;

        public static string? String(JsonElement root, string key) =>
            Find(root, key) is { ValueKind: JsonValueKind.String } e ? e.GetString() : null;

        public static T? Enum<T>(JsonElement root, string key, Func<string?, T?> fromRaw) where T : struct =>
            String(root, key) is { } raw ? fromRaw(raw) : null;

        public static IReadOnlySet<string>? StringSet(JsonElement root, string key)
        {
            if (Find(root, key) is not { ValueKind: JsonValueKind.Array } array) return null;
            var items = new List<string>();
            foreach (var item in array.EnumerateArray())
            {
                if (item.ValueKind != JsonValueKind.String) return null;
                items.Add(item.GetString()!);
            }
            return ValueSet<string>.Of(items);
        }
    }
}
