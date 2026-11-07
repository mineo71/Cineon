using System.Globalization;
using System.Security.Cryptography;
using System.Text;

namespace Cineon.Core.Downloads;

/// <summary>What a finished stream download left behind.</summary>
internal sealed record HlsOutcome(string File, string Extension, double Duration);

/// <summary>
/// Saves an HLS stream as one file: the quality the Mac would pick, its segments fetched a few at a
/// time, AES-128 decrypted, and joined in order. MPEG-TS segments make a <c>.ts</c> file, which the
/// Windows player opens; fragmented-MP4 segments make an <c>.mp4</c>. Segments already saved in the
/// staging folder are kept, so a download that failed or was stopped carries on where it was.
/// </summary>
internal sealed class HlsDownloader(DownloadHttp http)
{
    /// <summary>Segments fetched at the same time.</summary>
    public int Parallel { get; set; } = 4;
    /// <summary>Tries per segment before the download fails.</summary>
    public int Attempts { get; set; } = 4;
    /// <summary>The wait before the first retry, doubled for each one after.</summary>
    public TimeSpan RetryDelay { get; set; } = TimeSpan.FromSeconds(1);

    private const string FingerprintFile = "segments.txt";
    private const string OutputFile = "output.part";

    private static string SegmentFile(int index) => $"seg-{index.ToString("D6", CultureInfo.InvariantCulture)}";

    public async Task<HlsOutcome> DownloadAsync(Uri url, RequestHeaders headers, string staging, Action<double>? progress, CancellationToken ct)
    {
        var text = await GetTextAsync(url, headers, ct).ConfigureAwait(false);
        if (!HlsPlaylist.IsPlaylist(text)) throw new DownloadFailedException(DownloadErrors.Protected);
        var mediaUrl = url;
        if (HlsPlaylist.IsMaster(text))
        {
            var master = HlsPlaylist.ParseMaster(text, url);
            var variant = master.Best ?? throw new DownloadFailedException(DownloadErrors.Protected);
            if (master.NeedsSeparateAudio(variant)) throw new DownloadFailedException(DownloadErrors.SeparateAudio);
            mediaUrl = variant.Url;
            text = await GetTextAsync(mediaUrl, headers, ct).ConfigureAwait(false);
            if (!HlsPlaylist.IsPlaylist(text) || HlsPlaylist.IsMaster(text)) throw new DownloadFailedException(DownloadErrors.Protected);
        }
        var playlist = HlsPlaylist.ParseMedia(text, mediaUrl);
        var segments = playlist.Segments;
        if (segments.Count == 0) throw new DownloadFailedException(DownloadErrors.Protected);
        // SAMPLE-AES and the DRM systems need a licence; only plain AES-128 can be undone here.
        if (segments.Any(s => s.Key is { IsAes128: false } || s.Map?.Key is { IsAes128: false }))
        {
            throw new DownloadFailedException(DownloadErrors.Protected);
        }

        Directory.CreateDirectory(staging);
        KeepOnlyIfSameStream(staging, segments);

        var keys = new Dictionary<string, Task<byte[]>>();
        Task<byte[]> KeyAsync(HlsKey key)
        {
            var id = key.Url?.OriginalString ?? "";
            lock (keys)
            {
                if (!keys.TryGetValue(id, out var task))
                {
                    task = FetchKeyAsync(key, headers, ct);
                    keys[id] = task;
                }
                return task;
            }
        }

        var total = playlist.TotalDuration;
        double Weight(HlsSegment s) => total > 0 ? s.Duration : 1;
        var whole = total > 0 ? total : segments.Count;
        double done = 0;
        var gate = new Lock();
        for (var i = 0; i < segments.Count; i++)
        {
            if (File.Exists(Path.Combine(staging, SegmentFile(i)))) done += Weight(segments[i]);
        }
        progress?.Invoke(Math.Min(1, done / whole));

        // Initialisation sections, one file per distinct section, in the order they're first used.
        var maps = segments.Select(s => s.Map).OfType<HlsMap>().Distinct().ToList();
        for (var m = 0; m < maps.Count; m++)
        {
            var file = Path.Combine(staging, $"map-{m.ToString("D3", CultureInfo.InvariantCulture)}");
            if (File.Exists(file)) continue;
            var bytes = await WithRetriesAsync(() => http.GetBytesAsync(maps[m].Url, headers, maps[m].Range, ct), ct).ConfigureAwait(false);
            if (maps[m].Key is { } key) bytes = Decrypt(bytes, await KeyAsync(key).ConfigureAwait(false), key.Iv ?? SequenceIv(segments[0].Sequence));
            await WriteAtomicallyAsync(file, bytes, ct).ConfigureAwait(false);
        }

        var options = new ParallelOptions { MaxDegreeOfParallelism = Math.Max(1, Parallel), CancellationToken = ct };
        // When a segment fails for good, ForEachAsync stops starting new ones and cancels its own token.
        // The ones already on their way only stop when the person stops the download (`ct`), so what
        // they fetch is kept and a retry asks only for what's missing.
        await System.Threading.Tasks.Parallel.ForEachAsync(Enumerable.Range(0, segments.Count), options, async (index, _) =>
        {
            var token = ct;
            var file = Path.Combine(staging, SegmentFile(index));
            if (File.Exists(file)) return;
            var segment = segments[index];
            var bytes = await WithRetriesAsync(() => http.GetBytesAsync(segment.Url, headers, segment.Range, token), token).ConfigureAwait(false);
            if (segment.Key is { } key)
            {
                bytes = Decrypt(bytes, await KeyAsync(key).ConfigureAwait(false), key.Iv ?? SequenceIv(segment.Sequence));
            }
            await WriteAtomicallyAsync(file, bytes, token).ConfigureAwait(false);
            // Reported under the lock, so the fractions arrive in order.
            lock (gate)
            {
                done += Weight(segment);
                progress?.Invoke(Math.Min(1, done / whole));
            }
        }).ConfigureAwait(false);

        // One file, in order. A changed initialisation section goes in where it changes.
        var output = Path.Combine(staging, OutputFile);
        await using (var target = new FileStream(output, FileMode.Create, FileAccess.Write, FileShare.None, 1 << 16, useAsync: true))
        {
            HlsMap? current = null;
            for (var i = 0; i < segments.Count; i++)
            {
                if (segments[i].Map is { } map && !Equals(map, current))
                {
                    current = map;
                    await AppendAsync(target, Path.Combine(staging, $"map-{maps.IndexOf(map).ToString("D3", CultureInfo.InvariantCulture)}"), ct).ConfigureAwait(false);
                }
                await AppendAsync(target, Path.Combine(staging, SegmentFile(i)), ct).ConfigureAwait(false);
            }
        }
        return new HlsOutcome(output, playlist.IsFragmentedMp4 ? "mp4" : "ts", total);
    }

    private async Task<string> GetTextAsync(Uri url, RequestHeaders headers, CancellationToken ct)
    {
        var bytes = await WithRetriesAsync(() => http.GetBytesAsync(url, headers, null, ct), ct).ConfigureAwait(false);
        return Encoding.UTF8.GetString(bytes);
    }

    private async Task<byte[]> FetchKeyAsync(HlsKey key, RequestHeaders headers, CancellationToken ct)
    {
        if (key.Url is null) throw new DownloadFailedException(DownloadErrors.Protected);
        var bytes = await WithRetriesAsync(() => http.GetBytesAsync(key.Url, headers, null, ct), ct).ConfigureAwait(false);
        if (bytes.Length != 16) throw new DownloadFailedException(DownloadErrors.Protected);
        return bytes;
    }

    private async Task<T> WithRetriesAsync<T>(Func<Task<T>> body, CancellationToken ct)
    {
        var delay = RetryDelay;
        for (var attempt = 1; ; attempt++)
        {
            try
            {
                return await body().ConfigureAwait(false);
            }
            catch (Exception e) when (attempt < Attempts && !ct.IsCancellationRequested && DownloadErrors.IsTransient(e))
            {
                await Task.Delay(delay, ct).ConfigureAwait(false);
                delay *= 2;
            }
        }
    }

    /// <summary>Without its own IV, a segment's IV is its sequence number, big-endian in 16 bytes.</summary>
    internal static byte[] SequenceIv(long sequence)
    {
        var iv = new byte[16];
        for (var i = 15; i >= 8; i--)
        {
            iv[i] = (byte)(sequence & 0xFF);
            sequence >>= 8;
        }
        return iv;
    }

    internal static byte[] Decrypt(byte[] data, byte[] key, byte[] iv)
    {
        try
        {
            using var aes = Aes.Create();
            aes.Key = key;
            return aes.DecryptCbc(data, iv, PaddingMode.PKCS7);
        }
        catch (CryptographicException)
        {
            throw new DownloadFailedException(DownloadErrors.Protected);
        }
    }

    /// <summary>Segments saved earlier only count if they're from the same stream, cut the same way.</summary>
    private static void KeepOnlyIfSameStream(string staging, IReadOnlyList<HlsSegment> segments)
    {
        var fingerprint = new StringBuilder();
        fingerprint.Append(segments.Count.ToString(CultureInfo.InvariantCulture)).Append('\n');
        foreach (var segment in segments)
        {
            // Query strings carry tokens that change each time the page is opened.
            var url = segment.Url.OriginalString;
            var query = url.IndexOfAny(['?', '#']);
            fingerprint.Append(query < 0 ? url : url[..query]);
            if (segment.Range is { } r) fingerprint.Append(CultureInfo.InvariantCulture, $"@{r.Offset}+{r.Length}");
            fingerprint.Append('\n');
        }
        var path = Path.Combine(staging, FingerprintFile);
        var text = fingerprint.ToString();
        string? saved = null;
        try
        {
            if (File.Exists(path)) saved = File.ReadAllText(path);
        }
        catch (IOException)
        {
        }
        if (saved == text) return;
        foreach (var file in Directory.EnumerateFiles(staging)) TryDelete(file);
        File.WriteAllText(path, text);
    }

    private static async Task WriteAtomicallyAsync(string file, byte[] bytes, CancellationToken ct)
    {
        var part = file + ".part";
        await File.WriteAllBytesAsync(part, bytes, ct).ConfigureAwait(false);
        File.Move(part, file, overwrite: true);
    }

    private static async Task AppendAsync(Stream target, string file, CancellationToken ct)
    {
        await using var source = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.Read, 1 << 16, useAsync: true);
        await source.CopyToAsync(target, ct).ConfigureAwait(false);
    }

    private static void TryDelete(string file)
    {
        try
        {
            File.Delete(file);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
        }
    }
}
