using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Cineon.Core.Shields;

public sealed record FilterListInfo(string Id, string Name, string Summary, Uri? UpdateUrl);

public enum FilterStatusKind
{
    Idle,
    Preparing,
    Failed,
}

/// <summary>The Mac's <c>FilterEngine.Status</c>. <see cref="ToString"/> prints it the way Swift does.</summary>
public readonly record struct FilterStatus(FilterStatusKind Kind, string Text)
{
    public static FilterStatus Idle => new(FilterStatusKind.Idle, "");
    public static FilterStatus Preparing(string text) => new(FilterStatusKind.Preparing, text);
    public static FilterStatus Failed(string text) => new(FilterStatusKind.Failed, text);

    /// <summary>"idle", <c>preparing("…")</c> or <c>failed("…")</c>, as the debug state shows it.</summary>
    public override string ToString() => Kind switch
    {
        FilterStatusKind.Preparing => $"preparing({Quoted(Text)})",
        FilterStatusKind.Failed => $"failed({Quoted(Text)})",
        _ => "idle",
    };

    private static string Quoted(string s) => "\"" + s.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";
}

/// <summary>
/// Owns the parsed filter lists. Lists are global, since they're the same for every profile, while
/// each profile chooses which of them to switch on (<see cref="RulesFor"/>).
///
/// On the Mac, WebKit keeps compiled lists on disk and this only compiles the missing ones. Here
/// parsing is the compiling, and it happens on every launch in the background; the status line only
/// shows it for lists that have never been prepared before, which is when the Mac shows it too.
/// </summary>
public sealed class FilterEngine
{
    public static IReadOnlyList<FilterListInfo> Catalog { get; } =
    [
        new("easylist", "EasyList", "The main list of ads", new Uri("https://easylist.to/easylist/easylist.txt")),
        new("easyprivacy", "EasyPrivacy", "Trackers and analytics", new Uri("https://easylist.to/easylist/easyprivacy.txt")),
        new("ublock", "uBlock filters", "Extra rules from the uBlock Origin project", new Uri("https://ublockorigin.github.io/uAssets/filters/filters.txt")),
        new("peterlowe", "Peter Lowe's list", "Ad and tracking servers", new Uri("https://pgl.yoyo.org/adservers/serverlist.php?hostformat=adblockplus&mimetype=plaintext")),
        new("cineon-streaming", "Cineon streaming", "Pop-under networks used by streaming sites", null),
    ];

    private static readonly HttpClient SharedHttp = new();

    private readonly string _directory;
    private readonly string _bundledDirectory;
    private readonly string _statePath;
    private readonly HttpClient _http;
    private readonly Func<DateTimeOffset> _now;
    private readonly Dictionary<string, int> _ruleCounts = new(StringComparer.Ordinal);
    private readonly Dictionary<string, FilterList> _compiled = new(StringComparer.Ordinal);
    private DateTimeOffset? _firstSeen;
    private int _generation;

    /// <param name="directory">Where downloaded lists and this engine's state live: the data folder's "Filters".</param>
    /// <param name="bundledDirectory">The lists shipped with the app. Defaults to "Filters" next to the executable.</param>
    /// <param name="http">For downloading list updates.</param>
    /// <param name="now">The clock, for tests.</param>
    public FilterEngine(string directory, string? bundledDirectory = null, HttpClient? http = null, Func<DateTimeOffset>? now = null)
    {
        _directory = directory;
        _bundledDirectory = bundledDirectory ?? Path.Combine(AppContext.BaseDirectory, "Filters");
        _statePath = Path.Combine(directory, "filters.json");
        _http = http ?? SharedHttp;
        _now = now ?? (() => DateTimeOffset.Now);
        Directory.CreateDirectory(directory);
        LoadState();
        if (_firstSeen is null)
        {
            _firstSeen = _now();
            SaveState();
        }
    }

    public FilterStatus Status { get; private set; } = FilterStatus.Idle;

    /// <summary>Rules per list id, kept between launches so Settings can show them straight away.</summary>
    public IReadOnlyDictionary<string, int> RuleCounts => _ruleCounts;

    /// <summary>Parsed lists by id.</summary>
    public IReadOnlyDictionary<string, FilterList> Compiled => _compiled;

    public bool IsReady { get; private set; }

    /// <summary>Bumped whenever the parsed set changes, so tabs can pick up <see cref="Rules"/> again.</summary>
    public int Generation
    {
        get => _generation;
        private set
        {
            _generation = value;
            Changed?.Invoke();
        }
    }

    /// <summary>The Mac's <c>onChange</c>: raised after <see cref="Generation"/> changes.</summary>
    public event Action? Changed;

    /// <summary>When the lists were last downloaded. Null means still on the copies built into the app.</summary>
    public DateTimeOffset? LastUpdated { get; private set; }

    /// <summary>Every parsed list, indexed, in catalog order. Use <see cref="RulesFor"/> for a profile.</summary>
    public ShieldEngine Rules { get; private set; } = ShieldEngine.Empty;

    public int TotalRules => _ruleCounts.Values.Sum();

    /// <summary>The Mac debug state's "rules=" value: lists compiled, then total rules.</summary>
    public string RulesSummary => $"{_compiled.Count}/{TotalRules}";

    /// <summary>
    /// The lists one profile has switched on, like ProfileSession.applyRules on the Mac: none when
    /// network blocking is off, otherwise the enabled ones that are ready, in catalog order.
    /// </summary>
    public ShieldEngine RulesFor(bool networkBlocking, IEnumerable<string> enabledLists)
    {
        if (!networkBlocking) return ShieldEngine.Empty;
        var enabled = enabledLists.ToHashSet(StringComparer.Ordinal);
        return Rules.WithLists(Catalog.Select(info => info.Id).Where(enabled.Contains));
    }

    /// <summary>Parses every list. Lists prepared before are done quietly, new ones with a status.</summary>
    public async Task PrepareAsync()
    {
        var known = Catalog.Where(info => _ruleCounts.ContainsKey(info.Id)).ToList();
        var missing = Catalog.Where(info => !_ruleCounts.ContainsKey(info.Id)).ToList();

        if (known.Count > 0)
        {
            var sources = known.Select(info => (info.Id, Text: ReadSource(info.Id))).Where(s => s.Text is not null).ToList();
            var parsed = await Task.Run(() =>
                sources.AsParallel().AsOrdered().Select(s => FilterList.Compile(s.Id, s.Text!)).ToList());
            foreach (var list in parsed)
            {
                _compiled[list.Id] = list;
                _ruleCounts[list.Id] = list.RuleCount;
            }
            if (parsed.Count > 0)
            {
                Rules = await Task.Run(() => BuildRules(_compiled));
                SaveState();
                Generation++;
            }
        }
        IsReady = true;

        if (missing.Count == 0) return;
        for (int index = 0; index < missing.Count; index++)
        {
            var info = missing[index];
            Status = FilterStatus.Preparing($"Preparing ad blocker, {index + 1} of {missing.Count}");
            var text = ReadSource(info.Id);
            if (text is null) continue;
            await CompileAsync(info.Id, text);
        }
        Status = FilterStatus.Idle;
    }

    private string? ReadSource(string id)
    {
        foreach (var path in new[] { Path.Combine(_directory, $"{id}.txt"), Path.Combine(_bundledDirectory, $"{id}.txt") })
        {
            try
            {
                if (File.Exists(path)) return File.ReadAllText(path, Encoding.UTF8);
            }
            catch (IOException)
            {
            }
            catch (UnauthorizedAccessException)
            {
            }
        }
        return null;
    }

    private async Task<bool> CompileAsync(string id, string text)
    {
        try
        {
            var snapshot = new Dictionary<string, FilterList>(_compiled, StringComparer.Ordinal);
            var (list, rules) = await Task.Run(() =>
            {
                var list = FilterList.Compile(id, text);
                snapshot[id] = list;
                return (list, BuildRules(snapshot));
            });
            _compiled[id] = list;
            _ruleCounts[id] = list.RuleCount;
            Rules = rules;
            SaveState();
            Generation++;
            return true;
        }
        catch (Exception error)
        {
            Status = FilterStatus.Failed($"{id}: {error.Message}");
            return false;
        }
    }

    private static ShieldEngine BuildRules(IReadOnlyDictionary<string, FilterList> compiled) =>
        ShieldEngine.From(Catalog.Select(info => compiled.GetValueOrDefault(info.Id)).OfType<FilterList>());

    /// <summary>
    /// Once a week across the whole app. The built-in lists count as fresh on first launch, and
    /// downloading and parsing costs a moment of work, so it's worth avoiding.
    /// </summary>
    public async Task UpdateIfDueAsync()
    {
        var since = LastUpdated ?? _firstSeen ?? _now();
        if (_now() - since <= TimeSpan.FromDays(7)) return;
        await UpdateAsync();
    }

    /// <summary>Downloads fresh copies, then parses them. Rules already in use keep working until the swap.</summary>
    public async Task<bool> UpdateAsync(CancellationToken cancellationToken = default)
    {
        bool changed = false;
        var lists = Catalog.Where(info => info.UpdateUrl is not null).ToList();
        for (int index = 0; index < lists.Count; index++)
        {
            var info = lists[index];
            Status = FilterStatus.Preparing($"Updating {info.Name}, {index + 1} of {lists.Count}");
            try
            {
                using var response = await _http.GetAsync(info.UpdateUrl, cancellationToken);
                if ((int)response.StatusCode != 200) continue;
                var data = await response.Content.ReadAsByteArrayAsync(cancellationToken);
                string text;
                try
                {
                    text = new UTF8Encoding(false, throwOnInvalidBytes: true).GetString(data);
                }
                catch (DecoderFallbackException)
                {
                    continue;
                }
                if (text.Length <= 1000) continue;
                WriteAtomically(Path.Combine(_directory, $"{info.Id}.txt"), text);
                if (await CompileAsync(info.Id, text)) changed = true;
            }
            catch (Exception error) when (error is HttpRequestException or IOException or UnauthorizedAccessException or TaskCanceledException)
            {
                if (cancellationToken.IsCancellationRequested) break;
            }
        }
        Status = FilterStatus.Idle;
        if (changed)
        {
            LastUpdated = _now();
            SaveState();
        }
        return changed;
    }

    private static void WriteAtomically(string path, string text)
    {
        var temporary = path + ".tmp";
        File.WriteAllText(temporary, text, new UTF8Encoding(false));
        File.Move(temporary, path, overwrite: true);
    }

    // MARK: State

    // The Mac keeps these in UserDefaults under "filters.ruleCounts", "filters.lastUpdated" and
    // "filters.firstSeen". Windows has no UserDefaults, so they go in Filters/filters.json.

    private void LoadState()
    {
        try
        {
            if (!File.Exists(_statePath)) return;
            if (JsonNode.Parse(File.ReadAllText(_statePath)) is not JsonObject state) return;
            if (state["ruleCounts"] is JsonObject counts)
            {
                foreach (var (id, value) in counts)
                {
                    if (value is JsonValue number && number.TryGetValue(out int count)) _ruleCounts[id] = count;
                }
            }
            LastUpdated = ReadDate(state["lastUpdated"]);
            _firstSeen = ReadDate(state["firstSeen"]);
        }
        catch (Exception error) when (error is IOException or JsonException or UnauthorizedAccessException)
        {
        }
    }

    private static DateTimeOffset? ReadDate(JsonNode? node) =>
        node is JsonValue value && value.TryGetValue(out string? text)
            && DateTimeOffset.TryParse(text, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out var date)
            ? date
            : null;

    private void SaveState()
    {
        var counts = new JsonObject();
        foreach (var (id, count) in _ruleCounts.OrderBy(pair => pair.Key, StringComparer.Ordinal)) counts[id] = count;
        var state = new JsonObject
        {
            ["ruleCounts"] = counts,
            ["lastUpdated"] = LastUpdated?.ToString("o", CultureInfo.InvariantCulture),
            ["firstSeen"] = _firstSeen?.ToString("o", CultureInfo.InvariantCulture),
        };
        try
        {
            WriteAtomically(_statePath, state.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
        }
    }
}
