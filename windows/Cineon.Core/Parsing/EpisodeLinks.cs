using System.Globalization;
using System.Text.RegularExpressions;
using Cineon.Core.Data;
using Cineon.Core.Metadata;

namespace Cineon.Core.Parsing;

/// <summary>Finds the address of another episode by rewriting where this one is named in the current address.</summary>
public static class EpisodeLinks
{
    private sealed record Pattern(Regex Regex, bool HasSeason);

    private const string Words = "(?:seriya|seriia|seria|serija|epizod|episode|ep)";
    private const string SeasonWords = "(?:sezona|sezonu|sezon|season)";

    /// <summary>
    /// Most specific first. The numbers have to match the episode that's playing, which is
    /// what stops a film called "Part 2" or a site with "2" in its path from being rewritten.
    /// </summary>
    private static readonly Pattern[] Patterns =
    [
        // #t:238-s:3-e:5
        new(SwiftText.Icu(@"(?:^|[#-])s:(?<s>\d+)-e:(?<e>\d+)", true), true),
        // s02e04, s2-e4, s02.e04
        new(SwiftText.Icu(@"(?<![a-z0-9])s(?<s>\d{1,2})[._-]?e(?<e>\d{1,3})(?![0-9])", true), true),
        // 2x04
        new(SwiftText.Icu(@"(?<![a-z0-9])(?<s>\d{1,2})x(?<e>\d{1,3})(?![0-9])", true), true),
        // 2-sezon/4-seriya, 2-season-4-episode
        new(SwiftText.Icu(@"(?<![0-9])(?<s>\d{1,2})[-_]?" + SeasonWords + @"[^/?#]*?[/_-]+(?<e>\d{1,3})[-_]?" + Words + "(?![a-z])", true), true),
        // season-2/episode-4, season/2/episode/4, sezon-2-seriya-4, season=2&episode=4
        new(SwiftText.Icu(SeasonWords + @"[-_/=]?(?<s>\d{1,2})(?![0-9])[^/?#]*?[/_&-]+" + Words + @"[-_/=]?(?<e>\d{1,3})(?![0-9])", true), true),
        // ?s=2&e=4
        new(SwiftText.Icu(@"[?&]s=(?<s>\d{1,2})&e=(?<e>\d{1,3})(?![0-9])", true), true),
        // episode-4, seriya/4, ep=4
        new(SwiftText.Icu("(?<![a-z])" + Words + @"[-_/=]?(?<e>\d{1,3})(?![0-9])", true), false),
        // 4-seriya, 4-episode
        new(SwiftText.Icu(@"(?<![0-9])(?<e>\d{1,3})[-_]?" + Words + "(?![a-z])", true), false),
    ];

    /// <summary>
    /// Null when the address doesn't name this episode, or names it in a way that can't reach the
    /// target. The result's <see cref="Uri.OriginalString"/> is what the Mac's <c>absoluteString</c> is.
    /// </summary>
    public static Uri? Url(Uri url, EpisodeRef current, EpisodeRef target)
    {
        var text = SwiftUrl.From(url).AbsoluteString;
        foreach (var pattern in Patterns)
        {
            foreach (Match match in pattern.Regex.Matches(text))
            {
                var episode = match.Groups["e"];
                if (!episode.Success || SwiftText.Int(episode.Value) != current.Episode) continue;
                var replacements = new List<(Group Range, int Number)> { (episode, target.Episode) };

                if (pattern.HasSeason)
                {
                    var season = match.Groups["s"];
                    if (!season.Success || SwiftText.Int(season.Value) != current.Season) continue;
                    replacements.Add((season, target.Season));
                }
                else if (target.Season != current.Season)
                {
                    // An address with only an episode number can't change season.
                    continue;
                }

                // One zero-padded number means they all are: s02e10 goes to s03e01, not s03e1.
                var isPadded = replacements.Any(r => r.Range.Value.StartsWith('0'));
                var result = text;
                foreach (var (range, number) in replacements.OrderByDescending(r => r.Range.Index))
                {
                    var digits = isPadded
                        ? number.ToString("D" + range.Length.ToString(CultureInfo.InvariantCulture), CultureInfo.InvariantCulture)
                        : number.ToString(CultureInfo.InvariantCulture);
                    result = result[..range.Index] + digits + result[(range.Index + range.Length)..];
                }
                return Urls.Parse(result);
            }
        }
        return null;
    }
}

public static class NextEpisode
{
    /// <summary>
    /// What could come next. With a published episode list that's one answer, or none after the
    /// last aired episode. Without one, either the next number or the start of the next season.
    /// </summary>
    public static IReadOnlyList<EpisodeRef> Candidates(EpisodeRef after, IEnumerable<EpisodeInfo> episodes, DateTimeOffset? now = null)
    {
        if (after.Season == 0) return [new EpisodeRef(0, after.Episode + 1)];
        var numbered = episodes.Where(e => e.Season > 0).ToList();
        if (numbered.Count == 0) return [new EpisodeRef(after.Season, after.Episode + 1), new EpisodeRef(after.Season + 1, 1)];
        var next = numbered
            .OrderBy(e => e.Season).ThenBy(e => e.Episode)
            .FirstOrDefault(e => (e.Season, e.Episode).CompareTo((after.Season, after.Episode)) > 0);
        if (next is null) return [];
        if (next.Released is { } released && released > (now ?? DateTimeOffset.Now)) return [];
        return [new EpisodeRef(next.Season, next.Episode)];
    }
}

/// <summary>Reads intro and credits out of what someone does while watching.</summary>
public static class SkipLearner
{
    /// <summary>A run of forward jumps made close together, such as pressing the right arrow nine times.</summary>
    public readonly record struct Jump(double From, double To, DateTimeOffset LastAt)
    {
        /// <summary>Null when the new jump starts a new run. A jump backwards also ends the run.</summary>
        public Jump? Extended(double from, double to, DateTimeOffset at)
        {
            if ((at - LastAt).TotalSeconds > MergeWindow.TotalSeconds || !(to > from) || !(Math.Abs(from - To) <= 8)) return null;
            return new Jump(From, to, at);
        }
    }

    public static readonly TimeSpan MergeWindow = TimeSpan.FromSeconds(4);

    /// <summary>Is this jump shaped like skipping an intro?</summary>
    public static bool IsIntro(double from, double to, double duration)
    {
        var length = to - from;
        if (!(length >= 15) || !(length <= 240)) return false;
        return from <= Math.Min(duration * 0.35, 900) && to < duration * 0.5;
    }

    /// <summary>Is leaving this far from the end shaped like skipping the credits?</summary>
    public static bool IsCredits(double remaining, double duration) =>
        remaining >= 15 && remaining <= Math.Min(duration * 0.2, 420);

    /// <summary>Two sightings of credits describe the same thing.</summary>
    public static bool Agree(double a, double b) => Math.Abs(a - b) <= 30;

    /// <summary>
    /// Rules are shared between mirrors of a site, not between different sites, whose copies
    /// can be cut differently.
    /// </summary>
    public static string SiteKey(string host)
    {
        var registrable = DomainName.Registrable(host);
        return DomainName.IsIPAddress(registrable) ? registrable : SiteBrand.Of(registrable);
    }
}
