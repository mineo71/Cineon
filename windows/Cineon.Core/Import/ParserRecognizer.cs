using Cineon.Core.Data;
using Cineon.Core.Parsing;

namespace Cineon.Core.Import;

/// The import's title recognition, done by the real TitleParser, as on the Mac.
public sealed class ParserRecognizer : ITitleRecognizer
{
    public static ParserRecognizer Shared { get; } = new();

    public RecognizedTitle? Parse(string url, string title) =>
        TitleParser.Parse(new PageMeta { Url = url, Title = title }) is { } parsed
            ? new RecognizedTitle
            {
                Name = parsed.Name,
                AltName = parsed.AltName,
                Year = parsed.Year,
                Ref = parsed.Ref,
                KindHint = parsed.KindHint,
                Confidence = parsed.Confidence,
            }
            : null;

    public EpisodeRef? EpisodeRefIn(string text) => TitleParser.EpisodeRefIn(text);
}
