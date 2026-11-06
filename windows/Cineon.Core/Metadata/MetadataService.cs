using Cineon.Core.Data;

namespace Cineon.Core.Metadata;

/// <summary>
/// Fills in posters and details for titles in the background. Like the library it writes to, it
/// belongs to the UI thread: call it from there and its work continues there.
/// </summary>
public sealed class MetadataService
{
    private readonly LibraryStore _library;
    private readonly Func<bool> _enabled;
    private readonly MetadataClient _client;
    private readonly PagePreview _preview;
    private readonly Lock _lock = new();
    private readonly HashSet<long> _inFlight = [];
    private readonly List<(long Id, string? AltName)> _queue = [];
    private readonly Dictionary<string, IReadOnlyList<EpisodeInfo>> _episodeCache = [];
    private bool _isDraining;
    private Task _drain = Task.CompletedTask;

    /// <param name="library">Where the titles are.</param>
    /// <param name="enabled">The "look up posters and details" setting.</param>
    /// <param name="client">Null for <see cref="MetadataClient.Shared"/>.</param>
    /// <param name="preview">Null for <see cref="PagePreview.Shared"/>.</param>
    public MetadataService(LibraryStore library, Func<bool> enabled, MetadataClient? client = null, PagePreview? preview = null)
    {
        _library = library;
        _enabled = enabled;
        _client = client ?? MetadataClient.Shared;
        _preview = preview ?? PagePreview.Shared;
    }

    /// <summary>The pause between lookups, so importing hundreds of films doesn't hammer the services.</summary>
    internal TimeSpan Pause { get; init; } = TimeSpan.FromMilliseconds(120);

    /// <summary>Finishes when the queue is empty. For tests.</summary>
    internal Task Idle
    {
        get
        {
            lock (_lock) return _drain;
        }
    }

    /// <summary>
    /// Looks up a title that was recognised from a page. Lookups run one at a time, so that
    /// importing hundreds of films doesn't hammer the services. What you're watching goes first.
    /// </summary>
    public void Enrich(long titleId, string? altName = null, bool inBackground = false)
    {
        if (!_enabled() || _library.Titles.GetValueOrDefault(titleId) is not { MetadataChecked: false }) return;
        lock (_lock)
        {
            if (!_inFlight.Add(titleId)) return;
            if (inBackground) _queue.Add((titleId, altName));
            else _queue.Insert(0, (titleId, altName));
            if (_isDraining) return;
            _isDraining = true;
        }
        var drain = DrainQueueAsync();
        lock (_lock)
        {
            if (_isDraining) _drain = drain;
        }
    }

    private async Task DrainQueueAsync()
    {
        // Starts after the caller is done, like Swift's Task, so more can join the queue first.
        await Task.Yield();
        while (true)
        {
            (long Id, string? AltName) next;
            lock (_lock)
            {
                if (_queue.Count == 0)
                {
                    _isDraining = false;
                    return;
                }
                next = _queue[0];
                _queue.RemoveAt(0);
            }
            try
            {
                await LookUpAsync(next.Id, next.AltName);
            }
            catch (Exception e) when (e is not OutOfMemoryException)
            {
                // A failed lookup leaves the title as it was. The queue goes on.
            }
            lock (_lock) _inFlight.Remove(next.Id);
            await Task.Delay(Pause);
        }
    }

    private async Task LookUpAsync(long titleId, string? altName)
    {
        if (_library.Titles.GetValueOrDefault(titleId) is not { MetadataChecked: false } title) return;
        MetadataHit? match = null;
        foreach (var query in new[] { altName, title.Name }.OfType<string>())
        {
            var hits = await _client.SearchAsync(query);
            if (MetadataClient.BestMatch(hits, query, title.Year, title.Kind) is { } found)
            {
                match = found;
                break;
            }
        }
        await ApplyMatchAsync(match, titleId);
        if (match is null) await FillFromPageAsync(titleId);
    }

    /// <summary>Not in the catalogue, so ask the page it was watched on.</summary>
    private async Task FillFromPageAsync(long titleId)
    {
        if (_library.Titles.GetValueOrDefault(titleId) is not { PosterUrl: null } || _library.LatestProgress(titleId)?.Url is not { } url) return;
        var preview = await _preview.FetchAsync(url);
        if (_library.Titles.GetValueOrDefault(titleId) is not { } fresh || (preview.Poster is null && preview.Overview is null)) return;
        _library.Update(fresh with
        {
            PosterUrl = preview.Poster ?? fresh.PosterUrl,
            Overview = fresh.Overview ?? preview.Overview,
        });
    }

    /// <summary>Applies an explicit choice, when someone corrects a title by hand.</summary>
    public Task ApplyAsync(MetadataHit hit, long titleId)
    {
        if (_library.Titles.GetValueOrDefault(titleId) is not { } title) return Task.CompletedTask;
        _library.Update(title with { MetadataChecked = false });
        return Later();

        async Task Later()
        {
            await Task.Yield();
            await ApplyMatchAsync(hit, titleId);
        }
    }

    private async Task ApplyMatchAsync(MetadataHit? match, long titleId)
    {
        if (_library.Titles.GetValueOrDefault(titleId) is not { } title) return;
        if (match is null)
        {
            _library.Update(title with { MetadataChecked = true });
            return;
        }

        // The same film may already be here under another name, say the Ukrainian one.
        if (_library.Titles.Values.FirstOrDefault(t => t.ImdbId == match.Id && t.Id != titleId) is { } other)
        {
            _library.Merge(titleId, other.Id);
            return;
        }

        var detail = await _client.DetailAsync(match.Id, match.Kind);
        if (_library.Titles.GetValueOrDefault(titleId) is not { } fresh) return;
        var genres = detail?.Genres ?? fresh.Genres;
        _library.Update(fresh with
        {
            MetadataChecked = true,
            ImdbId = match.Id,
            Name = match.Name,
            NormName = LibraryText.Normalize(match.Name),
            Year = match.Year ?? fresh.Year,
            PosterUrl = match.PosterUrl ?? detail?.PosterUrl ?? fresh.PosterUrl,
            BackdropUrl = detail?.BackdropUrl ?? fresh.BackdropUrl,
            Overview = detail?.Overview ?? fresh.Overview,
            Genres = genres,
            RuntimeMinutes = detail?.RuntimeMinutes ?? fresh.RuntimeMinutes,
            Kind = genres.Contains("Animation") ? TitleKind.Cartoon : match.Kind,
        });
        if (detail is { Episodes.Count: > 0 })
        {
            lock (_lock) _episodeCache[match.Id] = detail.Episodes;
        }
    }

    /// <summary>Episode lists set by the test commands, by title, which win over the real services.</summary>
    public Dictionary<long, IReadOnlyList<EpisodeInfo>> TestEpisodes { get; } = [];

    /// <summary>A series' episodes. <paramref name="fresh"/> skips the copy kept from earlier, to see episodes that came out since.</summary>
    public async Task<IReadOnlyList<EpisodeInfo>> EpisodesAsync(Title title, bool fresh = false)
    {
        if (TestEpisodes.TryGetValue(title.Id, out var test)) return test;
        if (!_enabled() || title.ImdbId is not { } imdbId) return [];
        lock (_lock)
        {
            if (!fresh && _episodeCache.TryGetValue(imdbId, out var cached)) return cached;
        }
        if (title.Kind is not (TitleKind.Series or TitleKind.Cartoon)) return [];
        var detail = await _client.DetailAsync(imdbId, TitleKind.Series);
        var episodes = detail?.Episodes ?? [];
        lock (_lock) _episodeCache[imdbId] = episodes;
        return episodes;
    }
}
