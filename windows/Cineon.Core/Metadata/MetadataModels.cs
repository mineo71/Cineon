using Cineon.Core.Data;

namespace Cineon.Core.Metadata;

/// <summary>One search result: an IMDb ID and what the suggestion said about it.</summary>
public sealed record MetadataHit(
    string Id,
    string Name,
    int? Year,
    TitleKind Kind,
    Uri? PosterUrl = null,
    string? Subtitle = null,
    int? Rank = null);

public sealed record EpisodeInfo(
    int Season,
    int Episode,
    string? Name = null,
    string? Overview = null,
    Uri? ThumbnailUrl = null,
    DateTimeOffset? Released = null)
{
    /// <summary>"2x4", as on the Mac.</summary>
    public string Id => $"{Season}x{Episode}";
}

public sealed record MetadataDetail
{
    public string? Overview { get; init; }
    public IReadOnlyList<string> Genres { get; init => field = ValueList<string>.Of(value); } = ValueList<string>.Empty;
    public int? RuntimeMinutes { get; init; }
    public Uri? PosterUrl { get; init; }
    public Uri? BackdropUrl { get; init; }
    public int? Year { get; init; }
    /// <summary>Numbered seasons only, in order.</summary>
    public IReadOnlyList<EpisodeInfo> Episodes { get; init => field = ValueList<EpisodeInfo>.Of(value); } = ValueList<EpisodeInfo>.Empty;
}
