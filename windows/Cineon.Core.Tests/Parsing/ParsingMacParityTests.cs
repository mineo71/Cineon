using System.Runtime.CompilerServices;
using Cineon.Core.Tests.Parsing.MacParity;

namespace Cineon.Core.Tests.Parsing;

/// <summary>
/// Agreement with the Mac's TitleParser, RescueMatcher, EpisodeLinks, SkipLearner, ImportAnalyzer.brand and
/// the MetadataClient/PagePreview parsing: every case in MacParity/corpus.jsonl (page titles in English,
/// Ukrainian and Russian, addresses, link texts, IMDb and Cinemeta responses, dates, HTML heads) gives the
/// same line as MacParity/ParsingDump.swift printed into MacParity/expected.txt when compiled with the Mac
/// sources. Set CINEON_PARSING_DUMP to a file path to get this side's output for a diff.
/// </summary>
public class ParsingMacParityTests
{
    private static string Here([CallerFilePath] string file = "") => Path.Combine(Path.GetDirectoryName(file)!, "MacParity");

    /// <summary>Cases where Windows knowingly differs (windows/notes/parsing.md). They aren't compared.</summary>
    private static readonly (string Input, string Reason)[] Skipped =
    [
        ("ﬁlm online", "ICU's case-insensitive matching folds ligatures and ß, so \"ﬁlm online\" is noise there; .NET's doesn't"),
    ];

    /// <summary>Foundation keeps a relative URL where a page names one; Windows has no relative Uri there, so null.</summary>
    private static readonly (string Mac, string Windows)[] Replaced = [("\"/rel/p.jpg\"", "nil"), ("\"/rel.jpg\"", "nil")];

    [Fact]
    public void MatchesTheMac()
    {
        // A bigger run (make_corpus.py <seed> <scale> <path>, then the Swift dump) can be checked by pointing these elsewhere.
        var corpusPath = Environment.GetEnvironmentVariable("CINEON_PARSING_CORPUS") is { Length: > 0 } c ? c : Path.Combine(Here(), "corpus.jsonl");
        var expectedPath = Environment.GetEnvironmentVariable("CINEON_PARSING_EXPECTED") is { Length: > 0 } e ? e : Path.Combine(Here(), "expected.txt");
        var corpus = File.ReadAllLines(corpusPath).Where(line => line.Length > 0).ToArray();
        var actual = ParsingDump.Run(corpusPath);
        var expected = File.ReadAllLines(expectedPath);
        if (Environment.GetEnvironmentVariable("CINEON_PARSING_DUMP") is { Length: > 0 } dump) File.WriteAllLines(dump, actual);

        Assert.Equal(expected.Length, actual.Count);
        Assert.Equal(corpus.Length, actual.Count);
        var differences = new List<string>();
        var skipped = 0;
        for (var i = 0; i < expected.Length; i++)
        {
            if (Skipped.Any(skip => corpus[i].Contains(skip.Input, StringComparison.Ordinal)))
            {
                skipped++;
                continue;
            }
            var mac = Replaced.Aggregate(expected[i], (line, r) => line.Replace(r.Mac, r.Windows));
            if (mac != actual[i]) differences.Add($"case: {corpus[i]}\nmac: {mac}\nwin: {actual[i]}");
        }
        Assert.True(skipped <= Math.Max(6, expected.Length / 500), $"{skipped} cases skipped; the skip list should only cover a few known edge cases");
        Assert.True(differences.Count == 0, $"{differences.Count} of {expected.Length} differ:\n" + string.Join("\n", differences.Take(40)));
    }
}
