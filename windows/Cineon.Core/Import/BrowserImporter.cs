using System.Text.Json;
using Cineon.Core.Data;

namespace Cineon.Core.Import;

// Port of BrowserImporter in Cineon/Core/BrowserImport.swift.
//
// Imports from browsers already on this PC. It reads each browser's files directly, always from a
// private copy, so it works while that browser is open. Only pages and bookmarks are read:
// passwords and cookies are left alone.

/// <summary>
/// The two folders browsers keep their profiles in: <c>%LOCALAPPDATA%</c> (Chrome, Edge, Brave,
/// Vivaldi, Arc…) and <c>%APPDATA%</c> (Opera). A fake set of browsers uses one folder for both.
/// </summary>
public sealed record ImportRoots(string Local, string Roaming)
{
    public const string OverrideVariable = "CINEON_IMPORT_ROOT";

    /// <summary>
    /// <c>CINEON_IMPORT_ROOT</c> when set, so tests can point the importer at fake browsers, otherwise
    /// the real profile folders.
    /// </summary>
    public static ImportRoots Default
    {
        get
        {
            if (Environment.GetEnvironmentVariable(OverrideVariable) is { Length: > 0 } root)
            {
                var full = Path.GetFullPath(root);
                return new ImportRoots(full, full);
            }
            return new ImportRoots(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData, Environment.SpecialFolderOption.DoNotVerify),
                Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData, Environment.SpecialFolderOption.DoNotVerify));
        }
    }
}

public static class BrowserImporter
{
    /// <summary>Keeps searching history instant in the command bar.</summary>
    public const int PageLimit = 25_000;

    private enum Base { Local, Roaming }

    /// <summary>
    /// Where each browser keeps its Chromium profiles, in the Mac's order. The first place that exists
    /// is used. The Windows folder comes first; the Mac's layout follows it, so a fake set of
    /// browsers made for the Mac's tests (<c>CINEON_IMPORT_ROOT</c>) works here too. On a real PC the
    /// Mac's folders never hold profiles.
    /// </summary>
    private static readonly (string Name, (Base Base, string Path)[] Places)[] Browsers =
    [
        // Arc for Windows is a Store app: its data sits in its package's LocalCache.
        ("Arc", [(Base.Local, @"Packages\TheBrowserCompany.Arc_*\LocalCache\Local\Arc\User Data"), (Base.Local, "Arc/User Data")]),
        ("Chrome", [(Base.Local, @"Google\Chrome\User Data"), (Base.Local, "Google/Chrome")]),
        ("Brave", [(Base.Local, @"BraveSoftware\Brave-Browser\User Data"), (Base.Local, "BraveSoftware/Brave-Browser")]),
        ("Edge", [(Base.Local, @"Microsoft\Edge\User Data"), (Base.Local, "Microsoft Edge")]),
        ("Vivaldi", [(Base.Local, @"Vivaldi\User Data"), (Base.Local, "Vivaldi")]),
        ("Dia", [(Base.Local, "Dia/User Data")]),
        ("Opera", [(Base.Roaming, @"Opera Software\Opera Stable"), (Base.Local, "com.operasoftware.Opera")]),
        ("Opera GX", [(Base.Roaming, @"Opera Software\Opera GX Stable"), (Base.Local, "com.operasoftware.OperaGX")]),
        ("Yandex", [(Base.Local, @"Yandex\YandexBrowser\User Data"), (Base.Local, "Yandex/YandexBrowser")]),
        ("Chromium", [(Base.Local, @"Chromium\User Data"), (Base.Local, "Chromium")]),
    ];

    private static readonly string[] SkippedProfiles = ["Guest Profile", "System Profile"];

    /// <summary>Finds every browser profile that actually has something in it, in <see cref="ImportRoots.Default"/>.</summary>
    public static IReadOnlyList<ImportSource> Discover() => Discover(ImportRoots.Default);

    /// <summary>The Mac's <c>discover(root:)</c>: one folder standing in for both of Windows' profile folders.</summary>
    public static IReadOnlyList<ImportSource> Discover(string root) => Discover(new ImportRoots(root, root));

    public static IReadOnlyList<ImportSource> Discover(ImportRoots roots)
    {
        var found = new List<ImportSource>();
        foreach (var (name, places) in Browsers)
        {
            var browserRoot = places
                .SelectMany(place => Expand(place.Base == Base.Local ? roots.Local : roots.Roaming, place.Path))
                .FirstOrDefault(Directory.Exists);
            if (browserRoot is null) continue;
            var isArc = name == "Arc";
            var arcDirectory = isArc ? Directory.GetParent(browserRoot)?.FullName : null;
            var names = ProfileNames(browserRoot);

            List<string> profiles;
            try
            {
                profiles = [.. Directory.EnumerateFileSystemEntries(browserRoot)
                    .Where(entry => File.Exists(Path.Combine(entry, "History")))
                    .Where(entry => !SkippedProfiles.Contains(Path.GetFileName(entry)))];
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException)
            {
                profiles = [];
            }
            if (File.Exists(Path.Combine(browserRoot, "History"))) profiles.Add(browserRoot);

            foreach (var profile in profiles.OrderBy(Path.GetFileName, StringComparer.Ordinal))
            {
                var history = CountHistory(profile);
                var bookmarks = ReadBookmarks(profile).Count;
                // Arc's sidebar is shared, so it's counted against its main profile only.
                var isMainArcProfile = isArc && Path.GetFileName(profile) == "Default";
                var pinned = isMainArcProfile ? ReadArcTabs(arcDirectory).Count : 0;
                if (history + bookmarks + pinned <= 0) continue;
                found.Add(new ImportSource
                {
                    Browser = name,
                    ProfileName = names.GetValueOrDefault(Path.GetFileName(profile)) ?? "",
                    ProfileDirectory = profile,
                    ArcDirectory = isMainArcProfile ? arcDirectory : null,
                    HistoryCount = history,
                    BookmarkCount = bookmarks,
                    PinnedCount = pinned,
                });
            }
        }
        return found;
    }

    /// <summary>A relative path under a root, with <c>*</c> in a folder name matching any text.</summary>
    private static IEnumerable<string> Expand(string root, string relative)
    {
        if (string.IsNullOrEmpty(root)) return [];
        IEnumerable<string> current = [root];
        foreach (var part in relative.Split(['/', '\\'], StringSplitOptions.RemoveEmptyEntries))
        {
            if (!part.Contains('*'))
            {
                current = current.Select(folder => Path.Combine(folder, part));
                continue;
            }
            current = current.SelectMany(folder =>
            {
                try
                {
                    return Directory.Exists(folder) ? Directory.EnumerateDirectories(folder, part).Order(StringComparer.Ordinal).ToList() : [];
                }
                catch (Exception e) when (e is IOException or UnauthorizedAccessException)
                {
                    return [];
                }
            });
        }
        return current;
    }

    /// <summary>Reads the profile's pages, adds its bookmarks and pinned tabs, and sorts out the films.</summary>
    public static ImportScan Scan(ImportSource source, ITitleRecognizer recognizer, DateTimeOffset? now = null)
    {
        var pages = ReadHistory(source.ProfileDirectory);
        var visitsByUrl = new Dictionary<string, BrowsedPage>();
        foreach (var page in pages) visitsByUrl.TryAdd(page.Url.OriginalString, page);

        // A bookmark or pinned tab you also visited keeps its real date and visit count.
        var saved = ReadBookmarks(source.ProfileDirectory).Concat(ReadArcTabs(source.ArcDirectory));
        var seen = new HashSet<string>();
        foreach (var savedPage in saved)
        {
            if (!seen.Add(savedPage.Url.OriginalString)) continue;
            var page = savedPage;
            if (visitsByUrl.TryGetValue(page.Url.OriginalString, out var visited))
            {
                page = page with { Visits = visited.Visits, LastVisit = visited.LastVisit };
            }
            pages.Add(page);
        }
        return ImportAnalyzer.Analyze(pages, source.Label, recognizer, now);
    }

    // MARK: Profiles

    private static Dictionary<string, string> ProfileNames(string browserRoot)
    {
        var names = new Dictionary<string, string>();
        try
        {
            using var doc = JsonDocument.Parse(File.ReadAllBytes(Path.Combine(browserRoot, "Local State")));
            if (doc.RootElement.ValueKind != JsonValueKind.Object ||
                !doc.RootElement.TryGetProperty("profile", out var profile) || profile.ValueKind != JsonValueKind.Object ||
                !profile.TryGetProperty("info_cache", out var cache) || cache.ValueKind != JsonValueKind.Object)
            {
                return names;
            }
            foreach (var entry in cache.EnumerateObject())
            {
                if (entry.Value.ValueKind == JsonValueKind.Object &&
                    entry.Value.TryGetProperty("name", out var name) && name.ValueKind == JsonValueKind.String)
                {
                    names[entry.Name] = name.GetString()!;
                }
            }
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or JsonException)
        {
        }
        return names;
    }

    // MARK: History

    /// <summary>
    /// Browsers hold their history file open, and on Windows lock it against ordinary copies. It's
    /// read through a share-everything handle into a private folder, and opened from there.
    /// </summary>
    private static T? WithCopiedHistory<T>(string profile, Func<SqliteDb, T> body)
    {
        var folder = Path.Combine(Path.GetTempPath(), "CineonImport-" + Guid.NewGuid().ToString("D").ToUpperInvariant());
        try
        {
            Directory.CreateDirectory(folder);
            foreach (var name in (string[])["History", "History-wal", "History-shm", "History-journal"])
            {
                var source = Path.Combine(profile, name);
                if (File.Exists(source)) CopyShared(source, Path.Combine(folder, name));
            }
            using var db = new SqliteDb(Path.Combine(folder, "History"));
            return body(db);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or SqlError)
        {
            return default;
        }
        finally
        {
            try
            {
                Directory.Delete(folder, recursive: true);
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException)
            {
            }
        }
    }

    private static void CopyShared(string source, string target)
    {
        using var input = new FileStream(source, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        using var output = new FileStream(target, FileMode.CreateNew, FileAccess.Write, FileShare.None);
        input.CopyTo(output);
    }

    private static int CountHistory(string profile) =>
        WithCopiedHistory(profile, db => db.Query("SELECT count(*) FROM urls WHERE hidden=0", r => r.IntValue(0)).FirstOrDefault());

    public static List<BrowsedPage> ReadHistory(string profile) =>
        WithCopiedHistory(profile, db => db.Query(
                "SELECT url,title,visit_count,last_visit_time FROM urls WHERE hidden=0 ORDER BY last_visit_time DESC LIMIT 200000",
                r => Page(r.Text(0)) is { } url
                    ? new BrowsedPage
                    {
                        Url = url, Title = r.Text(1), Visits = r.IntValue(2), LastVisit = ChromiumDate(r.Int(3)), Origin = PageOrigin.History,
                    }
                    : null)
            .OfType<BrowsedPage>()
            .ToList()) ?? [];

    /// <summary>An address with a host, as <c>URL(string:)</c> with <c>url.host != nil</c> accepts.</summary>
    private static Uri? Page(string text) =>
        Urls.Parse(text) is { } url && SwiftUrl.Host(url) is not null && !url.IsFile ? url : null;

    /// <summary>Chromium counts microseconds since 1601.</summary>
    public static DateTimeOffset ChromiumDate(long microseconds) =>
        StoredDate.FromUnix(microseconds / 1_000_000.0 - 11_644_473_600);

    // MARK: Bookmarks

    public static List<BrowsedPage> ReadBookmarks(string profile)
    {
        var pages = new List<BrowsedPage>();
        try
        {
            using var doc = JsonDocument.Parse(File.ReadAllBytes(Path.Combine(profile, "Bookmarks")));
            if (doc.RootElement.ValueKind != JsonValueKind.Object ||
                !doc.RootElement.TryGetProperty("roots", out var roots) || roots.ValueKind != JsonValueKind.Object)
            {
                return pages;
            }
            void Walk(JsonElement node)
            {
                if (String(node, "type") == "url" && String(node, "url") is { } raw && Page(raw) is { } url)
                {
                    var added = String(node, "date_added") is { } text && long.TryParse(text, out var micro)
                        ? ChromiumDate(micro)
                        : DateTimeOffset.MinValue;
                    pages.Add(new BrowsedPage
                    {
                        Url = url, Title = String(node, "name") ?? "", Visits = 0, LastVisit = added, Origin = PageOrigin.Bookmark,
                    });
                }
                if (node.TryGetProperty("children", out var children) && children.ValueKind == JsonValueKind.Array)
                {
                    foreach (var child in children.EnumerateArray())
                    {
                        if (child.ValueKind == JsonValueKind.Object) Walk(child);
                    }
                }
            }
            foreach (var root in roots.EnumerateObject())
            {
                if (root.Value.ValueKind == JsonValueKind.Object) Walk(root.Value);
            }
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or JsonException)
        {
        }
        return pages;
    }

    private static string? String(JsonElement node, string key) =>
        node.TryGetProperty(key, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;

    // MARK: Arc

    /// <summary>
    /// Pinned and archived tabs. Arc changes these files often, so rather than relying on their
    /// exact layout, this looks for anything anywhere in them that holds a saved address.
    /// </summary>
    public static List<BrowsedPage> ReadArcTabs(string? directory)
    {
        var pages = new List<BrowsedPage>();
        if (directory is null) return pages;
        var seen = new HashSet<string>();
        foreach (var name in (string[])["StorableSidebar.json", "StorableArchiveItems.json"])
        {
            try
            {
                using var doc = JsonDocument.Parse(File.ReadAllBytes(Path.Combine(directory, name)));
                void Walk(JsonElement value)
                {
                    if (value.ValueKind == JsonValueKind.Object)
                    {
                        if (String(value, "savedURL") is { } raw && Page(raw) is { } url && seen.Add(url.OriginalString))
                        {
                            pages.Add(new BrowsedPage
                            {
                                Url = url, Title = String(value, "savedTitle") ?? "", Visits = 0,
                                LastVisit = DateTimeOffset.MinValue, Origin = PageOrigin.Pinned,
                            });
                        }
                        foreach (var child in value.EnumerateObject()) Walk(child.Value);
                    }
                    else if (value.ValueKind == JsonValueKind.Array)
                    {
                        foreach (var child in value.EnumerateArray()) Walk(child);
                    }
                }
                Walk(doc.RootElement);
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException or JsonException)
            {
            }
        }
        return pages;
    }
}
