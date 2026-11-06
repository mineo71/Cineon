using System.Globalization;
using Cineon.Core.Data;

namespace Cineon.Core.Downloads;

// New on Windows. The Mac hands playlists to AVFoundation, which saves them as .movpkg packages.
// Windows has nothing like it, so Cineon reads the playlists itself (RFC 8216) and writes one file.

/// <summary>One quality of a stream, from a master playlist's <c>#EXT-X-STREAM-INF</c>.</summary>
public sealed record HlsVariant
{
    public required Uri Url { get; init; }
    public long Bandwidth { get; init; }
    /// <summary>"1920x1080", when the playlist says.</summary>
    public string? Resolution { get; init; }
    public string? Codecs { get; init; }
    /// <summary>The <c>AUDIO</c> group whose renditions carry its sound, when that's kept apart.</summary>
    public string? AudioGroup { get; init; }

    /// <summary>The picture's height, 1080 for "1920x1080", or 0.</summary>
    public int Height =>
        Resolution?.Split('x') is [_, var h] && int.TryParse(h, NumberStyles.None, CultureInfo.InvariantCulture, out var height) ? height : 0;
}

/// <summary>A master playlist: the qualities on offer.</summary>
public sealed record HlsMaster
{
    public IReadOnlyList<HlsVariant> Variants { get; init; } = [];
    /// <summary>Audio groups that have at least one rendition in its own playlist.</summary>
    public IReadOnlySet<string> SeparateAudioGroups { get; init; } = new HashSet<string>();

    /// <summary>
    /// The quality the Mac would save. AVFoundation's download task takes the highest bitrate when it
    /// isn't told otherwise, so this does too. Variants with their sound in the same segments come
    /// first, because sound kept apart would need merging into the file.
    /// </summary>
    public HlsVariant? Best
    {
        get
        {
            var muxed = Variants.Where(v => !NeedsSeparateAudio(v)).ToList();
            var pool = muxed.Count > 0 ? muxed : [.. Variants];
            HlsVariant? best = null;
            foreach (var variant in pool)
            {
                if (best is null || variant.Bandwidth > best.Bandwidth ||
                    (variant.Bandwidth == best.Bandwidth && variant.Height > best.Height))
                {
                    best = variant;
                }
            }
            return best;
        }
    }

    public bool NeedsSeparateAudio(HlsVariant variant) => variant.AudioGroup is { } group && SeparateAudioGroups.Contains(group);
}

/// <summary>How a run of segments is encrypted.</summary>
public sealed record HlsKey
{
    /// <summary><c>NONE</c>, <c>AES-128</c>, <c>SAMPLE-AES</c>…</summary>
    public required string Method { get; init; }
    public Uri? Url { get; init; }
    /// <summary>16 bytes, or null to use the segment's sequence number.</summary>
    public byte[]? Iv { get; init; }
    public string? KeyFormat { get; init; }

    public bool IsAes128 => Method == "AES-128";
}

/// <summary>A byte range within a resource: <c>#EXT-X-BYTERANGE:length@offset</c>.</summary>
public readonly record struct HlsByteRange(long Length, long Offset);

/// <summary>The initialisation section fragmented-MP4 segments need: <c>#EXT-X-MAP</c>.</summary>
public sealed record HlsMap
{
    public required Uri Url { get; init; }
    public HlsByteRange? Range { get; init; }
    public HlsKey? Key { get; init; }
}

public sealed record HlsSegment
{
    public required Uri Url { get; init; }
    public double Duration { get; init; }
    public long Sequence { get; init; }
    public HlsKey? Key { get; init; }
    public HlsByteRange? Range { get; init; }
    public HlsMap? Map { get; init; }
}

/// <summary>A media playlist: the segments of one quality, in order.</summary>
public sealed record HlsMediaPlaylist
{
    public IReadOnlyList<HlsSegment> Segments { get; init; } = [];
    public bool EndList { get; init; }
    public double TargetDuration { get; init; }

    public double TotalDuration => Segments.Sum(s => s.Duration);
    /// <summary>Fragmented MP4 rather than MPEG-TS: the segments share an initialisation section.</summary>
    public bool IsFragmentedMp4 => Segments.Any(s => s.Map is not null);
}

public static class HlsPlaylist
{
    public static bool IsPlaylist(string text) => text.TrimStart('﻿', ' ', '\t', '\r', '\n').StartsWith("#EXTM3U", StringComparison.Ordinal);

    public static bool IsMaster(string text) => text.Contains("#EXT-X-STREAM-INF", StringComparison.Ordinal);

    private static IEnumerable<string> Lines(string text) =>
        text.Replace("\r\n", "\n").Replace('\r', '\n').Split('\n').Select(l => l.Trim()).Where(l => l.Length > 0);

    public static HlsMaster ParseMaster(string text, Uri baseUrl)
    {
        var variants = new List<HlsVariant>();
        var separateAudio = new HashSet<string>();
        Dictionary<string, string>? pending = null;
        foreach (var line in Lines(text))
        {
            if (line.StartsWith("#EXT-X-STREAM-INF:", StringComparison.Ordinal))
            {
                pending = Attributes(line["#EXT-X-STREAM-INF:".Length..]);
            }
            else if (line.StartsWith("#EXT-X-MEDIA:", StringComparison.Ordinal))
            {
                var media = Attributes(line["#EXT-X-MEDIA:".Length..]);
                if (media.GetValueOrDefault("TYPE") == "AUDIO" && media.ContainsKey("URI") && media.GetValueOrDefault("GROUP-ID") is { } group)
                {
                    separateAudio.Add(group);
                }
            }
            else if (line.StartsWith('#'))
            {
                continue;
            }
            else if (pending is not null)
            {
                if (Resolve(baseUrl, line) is { } url)
                {
                    variants.Add(new HlsVariant
                    {
                        Url = url,
                        Bandwidth = long.TryParse(pending.GetValueOrDefault("BANDWIDTH"), NumberStyles.None, CultureInfo.InvariantCulture, out var b) ? b : 0,
                        Resolution = pending.GetValueOrDefault("RESOLUTION"),
                        Codecs = pending.GetValueOrDefault("CODECS"),
                        AudioGroup = pending.GetValueOrDefault("AUDIO"),
                    });
                }
                pending = null;
            }
        }
        return new HlsMaster { Variants = variants, SeparateAudioGroups = separateAudio };
    }

    public static HlsMediaPlaylist ParseMedia(string text, Uri baseUrl)
    {
        var segments = new List<HlsSegment>();
        long sequence = 0;
        double targetDuration = 0;
        var endList = false;
        double? duration = null;
        HlsByteRange? range = null;
        HlsKey? key = null;
        HlsMap? map = null;
        // Where the last ranged segment of each resource ended, for ranges with no offset.
        var rangeEnds = new Dictionary<string, long>();

        foreach (var line in Lines(text))
        {
            if (line.StartsWith("#EXT-X-MEDIA-SEQUENCE:", StringComparison.Ordinal))
            {
                _ = long.TryParse(line["#EXT-X-MEDIA-SEQUENCE:".Length..], NumberStyles.None, CultureInfo.InvariantCulture, out sequence);
            }
            else if (line.StartsWith("#EXT-X-TARGETDURATION:", StringComparison.Ordinal))
            {
                _ = double.TryParse(line["#EXT-X-TARGETDURATION:".Length..], NumberStyles.Float, CultureInfo.InvariantCulture, out targetDuration);
            }
            else if (line.StartsWith("#EXTINF:", StringComparison.Ordinal))
            {
                var value = line["#EXTINF:".Length..];
                var comma = value.IndexOf(',');
                if (comma >= 0) value = value[..comma];
                duration = double.TryParse(value, NumberStyles.Float, CultureInfo.InvariantCulture, out var d) ? d : 0;
            }
            else if (line.StartsWith("#EXT-X-BYTERANGE:", StringComparison.Ordinal))
            {
                range = ParseRange(line["#EXT-X-BYTERANGE:".Length..]);
            }
            else if (line.StartsWith("#EXT-X-KEY:", StringComparison.Ordinal))
            {
                var attributes = Attributes(line["#EXT-X-KEY:".Length..]);
                var format = attributes.GetValueOrDefault("KEYFORMAT");
                // Several keys can stand side by side for different DRM systems. Only the plain one counts.
                if (format is not null && format != "identity" && key is not null) continue;
                var method = attributes.GetValueOrDefault("METHOD") ?? "NONE";
                key = method == "NONE"
                    ? null
                    : new HlsKey
                    {
                        Method = method,
                        Url = attributes.GetValueOrDefault("URI") is { } uri ? Resolve(baseUrl, uri) : null,
                        Iv = attributes.GetValueOrDefault("IV") is { } iv ? ParseIv(iv) : null,
                        KeyFormat = format,
                    };
            }
            else if (line.StartsWith("#EXT-X-MAP:", StringComparison.Ordinal))
            {
                var attributes = Attributes(line["#EXT-X-MAP:".Length..]);
                map = attributes.GetValueOrDefault("URI") is { } uri && Resolve(baseUrl, uri) is { } url
                    ? new HlsMap
                    {
                        Url = url,
                        Range = attributes.GetValueOrDefault("BYTERANGE") is { } r ? ParseRange(r) : null,
                        Key = key,
                    }
                    : null;
            }
            else if (line.StartsWith("#EXT-X-ENDLIST", StringComparison.Ordinal))
            {
                endList = true;
            }
            else if (line.StartsWith('#'))
            {
                continue;
            }
            else
            {
                if (Resolve(baseUrl, line) is { } url)
                {
                    HlsByteRange? segmentRange = null;
                    if (range is { } r)
                    {
                        var resource = url.OriginalString;
                        var offset = r.Offset >= 0 ? r.Offset : rangeEnds.GetValueOrDefault(resource);
                        segmentRange = new HlsByteRange(r.Length, offset);
                        rangeEnds[resource] = offset + r.Length;
                    }
                    segments.Add(new HlsSegment
                    {
                        Url = url, Duration = duration ?? 0, Sequence = sequence, Key = key, Range = segmentRange, Map = map,
                    });
                }
                sequence++;
                duration = null;
                range = null;
            }
        }
        return new HlsMediaPlaylist { Segments = segments, EndList = endList, TargetDuration = targetDuration };
    }

    /// <summary><c>length[@offset]</c>. An offset of -1 means "straight after the previous range".</summary>
    private static HlsByteRange? ParseRange(string text)
    {
        var parts = text.Trim('"').Split('@');
        if (!long.TryParse(parts[0], NumberStyles.None, CultureInfo.InvariantCulture, out var length)) return null;
        var offset = parts.Length > 1 && long.TryParse(parts[1], NumberStyles.None, CultureInfo.InvariantCulture, out var o) ? o : -1;
        return new HlsByteRange(length, offset);
    }

    private static byte[]? ParseIv(string text)
    {
        var hex = text.StartsWith("0x", StringComparison.OrdinalIgnoreCase) ? text[2..] : text;
        if (hex.Length == 0 || hex.Length > 32) return null;
        try
        {
            var bytes = Convert.FromHexString(hex.PadLeft(32, '0'));
            return bytes;
        }
        catch (FormatException)
        {
            return null;
        }
    }

    /// <summary>An attribute list: <c>KEY=VALUE,KEY="quoted, value"</c>.</summary>
    public static Dictionary<string, string> Attributes(string text)
    {
        var result = new Dictionary<string, string>(StringComparer.Ordinal);
        var i = 0;
        while (i < text.Length)
        {
            while (i < text.Length && (text[i] == ',' || text[i] == ' ')) i++;
            var eq = text.IndexOf('=', i);
            if (eq < 0) break;
            var name = text[i..eq].Trim();
            i = eq + 1;
            string value;
            if (i < text.Length && text[i] == '"')
            {
                var close = text.IndexOf('"', i + 1);
                if (close < 0) close = text.Length;
                value = text[(i + 1)..close];
                i = close + 1;
            }
            else
            {
                var comma = text.IndexOf(',', i);
                if (comma < 0) comma = text.Length;
                value = text[i..comma].Trim();
                i = comma;
            }
            result[name] = value;
        }
        return result;
    }

    /// <summary>
    /// A playlist line made into an address. Relative paths whose first part holds a colon, like
    /// HDRezka's <c>1080.mp4:hls:seg-1.ts</c>, are paths, not schemes.
    /// </summary>
    public static Uri? Resolve(Uri baseUrl, string reference)
    {
        if (reference.StartsWith("http://", StringComparison.OrdinalIgnoreCase) ||
            reference.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
        {
            return Urls.Parse(reference);
        }
        if (reference.StartsWith("//", StringComparison.Ordinal)) return Urls.Parse(baseUrl.Scheme + ":" + reference);
        if (reference.StartsWith("data:", StringComparison.OrdinalIgnoreCase) || reference.StartsWith("skd:", StringComparison.OrdinalIgnoreCase))
        {
            return Urls.Parse(reference);
        }
        var firstSlash = reference.IndexOfAny(['/', '?', '#']);
        var first = firstSlash < 0 ? reference : reference[..firstSlash];
        if (first.Contains(':')) reference = "./" + reference;
        return Uri.TryCreate(baseUrl, reference, out var url) ? url : null;
    }
}
