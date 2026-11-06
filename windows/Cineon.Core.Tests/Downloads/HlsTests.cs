using System.Net;
using Cineon.Core.Data;
using Cineon.Core.Downloads;

namespace Cineon.Core.Tests.Downloads;

/// <summary>Streams saved as one file: playlists, quality, AES-128, byte ranges, carrying on after a failure.</summary>
public sealed class HlsTests : IDisposable
{
    private readonly DownloadRig _rig = new();

    public void Dispose() => _rig.Dispose();

    private DownloadCenter Center => _rig.Center;
    private FakeServer Server => _rig.Server;

    private static readonly byte[][] Segments = [.. Enumerable.Range(0, 6).Select(i => FakeServer.Random(1_000 + i * 37, 100 + i))];
    private static byte[] Joined => [.. Segments.SelectMany(s => s)];

    private void ServeMaster()
    {
        Server.Text("/hls/master.m3u8", """
            #EXTM3U
            #EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",URI="audio/en.m3u8"
            #EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=854x480
            480/index.m3u8
            #EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=90000,URI="iframes.m3u8"
            #EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2"
            720/index.m3u8
            #EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080,AUDIO="aud"
            1080/index.m3u8
            """);
    }

    private void ServeSegments(string folder, Func<int, byte[]>? body = null)
    {
        for (var i = 0; i < Segments.Length; i++)
        {
            Server.Bytes($"/hls/{folder}/1080.mp4:hls:seg-{i}.ts", body?.Invoke(i) ?? Segments[i], "video/mp2t");
        }
    }

    private static string MediaPlaylist(string extra = "", int sequence = 0) =>
        "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n" +
        $"#EXT-X-MEDIA-SEQUENCE:{sequence}\n" + extra +
        string.Concat(Enumerable.Range(0, Segments.Length).Select(i => $"#EXTINF:5.5,\n1080.mp4:hls:seg-{i}.ts\n")) +
        "#EXT-X-ENDLIST\n";

    [Fact]
    public void TheMacsQualityIsPicked()
    {
        var baseUrl = new Uri("https://cdn.test/hls/master.m3u8");
        var master = HlsPlaylist.ParseMaster("""
            #EXTM3U
            #EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=854x480
            480/index.m3u8
            #EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2"
            https://other.test/1080/index.m3u8?token=a,b
            #EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720
            720/index.m3u8
            """, baseUrl);
        Assert.Equal(3, master.Variants.Count);
        Assert.Equal("https://other.test/1080/index.m3u8?token=a,b", master.Best!.Url.OriginalString);
        Assert.Equal(1080, master.Best.Height);
        Assert.Equal("avc1.640028,mp4a.40.2", master.Best.Codecs);
        Assert.Equal("https://cdn.test/hls/480/index.m3u8", master.Variants[0].Url.OriginalString);
    }

    [Fact]
    public void QualitiesWithTheirOwnSoundComeFirst()
    {
        var master = HlsPlaylist.ParseMaster("""
            #EXTM3U
            #EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",URI="audio/en.m3u8"
            #EXT-X-STREAM-INF:BANDWIDTH=6000000,AUDIO="aud"
            1080.m3u8
            #EXT-X-STREAM-INF:BANDWIDTH=2500000
            720.m3u8
            """, new Uri("https://cdn.test/m.m3u8"));
        Assert.Equal("https://cdn.test/720.m3u8", master.Best!.Url.OriginalString);
    }

    [Fact]
    public void PlaylistLinesBecomeAddresses()
    {
        var baseUrl = new Uri("https://cdn.test/a/b/index.m3u8?t=1");
        Assert.Equal("https://cdn.test/a/b/1080.mp4:hls:seg-1.ts", HlsPlaylist.Resolve(baseUrl, "1080.mp4:hls:seg-1.ts")!.OriginalString);
        Assert.Equal("https://cdn.test/x/seg.ts", HlsPlaylist.Resolve(baseUrl, "/x/seg.ts")!.OriginalString);
        Assert.Equal("https://cdn.test/a/seg.ts", HlsPlaylist.Resolve(baseUrl, "../seg.ts")!.OriginalString);
        Assert.Equal("https://edge.test/s.ts", HlsPlaylist.Resolve(baseUrl, "//edge.test/s.ts")!.OriginalString);
        Assert.Equal("http://edge.test/s.ts?a=1", HlsPlaylist.Resolve(baseUrl, "http://edge.test/s.ts?a=1")!.OriginalString);
        var attributes = HlsPlaylist.Attributes("""METHOD=AES-128,URI="https://k.test/key?id=1,2",IV=0x0000000000000000000000000000000A""");
        Assert.Equal("https://k.test/key?id=1,2", attributes["URI"]);
        Assert.Equal("0x0000000000000000000000000000000A", attributes["IV"]);
    }

    [Fact]
    public async Task AStreamIsSavedAsOneTsFile()
    {
        ServeMaster();
        Server.Text("/hls/720/index.m3u8", MediaPlaylist());
        ServeSegments("720");
        var item = _rig.Enqueue("https://cdn.test/hls/master.m3u8", kind: MediaSourceKind.Hls);
        Assert.Equal(MediaSourceKind.Hls, item.Kind);
        await Center.IdleAsync();

        var saved = Center.Item(item.Id)!;
        Assert.Equal(DownloadStatus.Done, saved.Status);
        Assert.Equal(Path.Combine(_rig.Downloads, "Arrival.ts"), saved.File);
        Assert.Equal(Joined, File.ReadAllBytes(saved.File!));
        Assert.Equal(33, saved.Duration, 3);
        Assert.Equal(Joined.Length, saved.TotalBytes);
        Assert.Equal(MediaSourceKind.Hls, _rig.Db.AllDownloads().Single().Kind);
        // Nothing asked for the other qualities.
        Assert.Equal(0, Server.Count("/hls/480/index.m3u8") + Server.Count("/hls/1080/index.m3u8"));
        Assert.All(Server.Requests, r => Assert.Equal("https://site.test/film/arrival", r.Headers.Referrer?.OriginalString));
        Assert.False(Directory.Exists(Center.PartialPlaylist(saved)));
    }

    [Fact]
    public async Task Aes128SegmentsAreDecrypted()
    {
        var key = FakeServer.Random(16, 7);
        var iv = FakeServer.Random(16, 8);
        Server.Bytes("/keys/k1", key);
        // The first two carry their IV; the rest use their sequence number, from 10.
        var playlist = "#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:10\n" +
            $"#EXT-X-KEY:METHOD=AES-128,URI=\"/keys/k1?t=abc\",IV=0x{Convert.ToHexString(iv)}\n" +
            "#EXTINF:5,\n1080.mp4:hls:seg-0.ts\n#EXTINF:5,\n1080.mp4:hls:seg-1.ts\n" +
            "#EXT-X-KEY:METHOD=AES-128,URI=\"/keys/k1?t=abc\"\n" +
            string.Concat(Enumerable.Range(2, 3).Select(i => $"#EXTINF:5,\n1080.mp4:hls:seg-{i}.ts\n")) +
            "#EXT-X-KEY:METHOD=NONE\n#EXTINF:5,\n1080.mp4:hls:seg-5.ts\n#EXT-X-ENDLIST\n";
        Server.Text("/hls/enc/index.m3u8", playlist);
        ServeSegments("enc", i => i switch
        {
            < 2 => FakeServer.Encrypt(Segments[i], key, iv),
            < 5 => FakeServer.Encrypt(Segments[i], key, HlsDownloader.SequenceIv(10 + i)),
            _ => Segments[i],
        });
        var item = _rig.Enqueue("https://cdn.test/hls/enc/index.m3u8", kind: MediaSourceKind.Hls);
        await Center.IdleAsync();

        var saved = Center.Item(item.Id)!;
        Assert.Equal(DownloadStatus.Done, saved.Status);
        Assert.Equal(Joined, File.ReadAllBytes(saved.File!));
        // The key is fetched once, with the page's headers.
        Assert.Equal(1, Server.Count("/keys/k1"));
        Assert.Equal("https://site.test/film/arrival", Server.Last("/keys/k1").Headers.Referrer?.OriginalString);
    }

    [Fact]
    public async Task AFailedStreamCarriesOnWhereItStopped()
    {
        Server.Text("/hls/720/index.m3u8", MediaPlaylist());
        ServeSegments("720");
        var failing = true;
        Server.Route("/hls/720/1080.mp4:hls:seg-3.ts", async request =>
        {
            await Task.Delay(20);
            return failing
                ? new HttpResponseMessage(HttpStatusCode.InternalServerError) { Content = new ByteArrayContent([]) }
                : FakeServer.Serve(request, Segments[3]);
        });
        var item = _rig.Enqueue("https://cdn.test/hls/720/index.m3u8", kind: MediaSourceKind.Hls);
        await Center.IdleAsync();

        var failed = Center.Item(item.Id)!;
        Assert.Equal(DownloadStatus.Failed, failed.Status);
        Assert.Equal("The site answered with an error (500).", failed.Error);
        Assert.Equal(Center.Hls.Attempts, Server.Count("/hls/720/1080.mp4:hls:seg-3.ts"));
        var before = Enumerable.Range(0, Segments.Length).Select(i => Server.Count($"/hls/720/1080.mp4:hls:seg-{i}.ts")).ToList();

        failing = false;
        Center.Retry(item.Id);
        await Center.IdleAsync();

        var done = Center.Item(item.Id)!;
        Assert.Equal(DownloadStatus.Done, done.Status);
        Assert.Equal(Joined, File.ReadAllBytes(done.File!));
        for (var i = 0; i < Segments.Length; i++)
        {
            var asked = Server.Count($"/hls/720/1080.mp4:hls:seg-{i}.ts") - before[i];
            // Only the segment that failed is fetched again.
            Assert.Equal(i == 3 ? 1 : 0, asked);
        }
    }

    [Fact]
    public async Task StoppingAStreamKeepsItsSegments()
    {
        Server.Text("/hls/720/index.m3u8", MediaPlaylist());
        ServeSegments("720");
        var release = new TaskCompletionSource();
        Server.Route("/hls/720/1080.mp4:hls:seg-5.ts", async request =>
        {
            await release.Task;
            return FakeServer.Serve(request, Segments[5]);
        });
        var item = _rig.Enqueue("https://cdn.test/hls/720/index.m3u8", kind: MediaSourceKind.Hls);
        var deadline = DateTime.UtcNow.AddSeconds(10);
        while (Server.Count("/hls/720/1080.mp4:hls:seg-5.ts") == 0 && DateTime.UtcNow < deadline) await Task.Delay(10, TestContext.Current.CancellationToken);
        await Task.Delay(50, TestContext.Current.CancellationToken);
        Center.Cancel(item.Id);
        await Center.IdleAsync();
        Assert.Equal("Stopped", Center.Item(item.Id)!.Error);
        Assert.True(Directory.EnumerateFiles(Center.PartialPlaylist(item), "seg-*").Count() >= 4);

        release.SetResult();
        Center.Retry(item.Id);
        await Center.IdleAsync();
        Assert.Equal(Joined, File.ReadAllBytes(Center.Item(item.Id)!.File!));
        Assert.Equal(1, Server.Count("/hls/720/1080.mp4:hls:seg-0.ts"));
    }

    [Fact]
    public async Task FragmentedMp4BecomesAnMp4()
    {
        var init = FakeServer.Random(300, 50);
        Server.Bytes("/f/init.mp4", init);
        Server.Text("/f/index.m3u8", "#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:6\n#EXT-X-MAP:URI=\"init.mp4\"\n" +
            "#EXTINF:6,\nseg-1.m4s\n#EXTINF:6,\nseg-2.m4s\n#EXT-X-ENDLIST\n");
        Server.Bytes("/f/seg-1.m4s", Segments[0]);
        Server.Bytes("/f/seg-2.m4s", Segments[1]);
        var item = _rig.Enqueue("https://cdn.test/f/index.m3u8", kind: MediaSourceKind.Hls);
        await Center.IdleAsync();
        var saved = Center.Item(item.Id)!;
        Assert.Equal(Path.Combine(_rig.Downloads, "Arrival.mp4"), saved.File);
        Assert.Equal([.. init, .. Segments[0], .. Segments[1]], File.ReadAllBytes(saved.File!));
    }

    [Fact]
    public async Task ByteRangesAreCutFromOneFile()
    {
        var whole = Joined;
        Server.Bytes("/r/all.ts", whole, "video/mp2t");
        var lines = new List<string> { "#EXTM3U", "#EXT-X-TARGETDURATION:6", "#EXT-X-VERSION:4" };
        var offset = 0;
        foreach (var segment in Segments)
        {
            lines.Add("#EXTINF:5,");
            // The first names its offset; the rest follow on.
            lines.Add(offset == 0 ? $"#EXT-X-BYTERANGE:{segment.Length}@0" : $"#EXT-X-BYTERANGE:{segment.Length}");
            lines.Add("all.ts");
            offset += segment.Length;
        }
        lines.Add("#EXT-X-ENDLIST");
        Server.Text("/r/index.m3u8", string.Join("\n", lines));
        var item = _rig.Enqueue("https://cdn.test/r/index.m3u8", kind: MediaSourceKind.Hls);
        await Center.IdleAsync();
        Assert.Equal(whole, File.ReadAllBytes(Center.Item(item.Id)!.File!));
        Assert.Equal(Segments.Length, Server.Count("/r/all.ts"));
    }

    [Theory]
    [InlineData("#EXT-X-KEY:METHOD=SAMPLE-AES,URI=\"skd://key\",KEYFORMAT=\"com.apple.streamingkeydelivery\"\n", DownloadErrors.Protected)]
    [InlineData("#EXT-X-KEY:METHOD=SAMPLE-AES,URI=\"/k\"\n", DownloadErrors.Protected)]
    public async Task ProtectedStreamsSaySo(string key, string message)
    {
        Server.Text("/p/index.m3u8", MediaPlaylist(key));
        var item = _rig.Enqueue("https://cdn.test/p/index.m3u8", kind: MediaSourceKind.Hls);
        await Center.IdleAsync();
        Assert.Equal(message, Center.Item(item.Id)!.Error);
    }

    [Fact]
    public async Task SoundKeptApartIsExplained()
    {
        Server.Text("/s/master.m3u8", """
            #EXTM3U
            #EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",URI="audio/en.m3u8"
            #EXT-X-STREAM-INF:BANDWIDTH=6000000,AUDIO="aud"
            1080.m3u8
            """);
        var item = _rig.Enqueue("https://cdn.test/s/master.m3u8", kind: MediaSourceKind.Hls);
        await Center.IdleAsync();
        Assert.Equal(DownloadErrors.SeparateAudio, Center.Item(item.Id)!.Error);
    }

    [Fact]
    public async Task AnExpiredStreamIsARefusal()
    {
        Server.Status("/gone/index.m3u8", HttpStatusCode.Forbidden);
        var item = _rig.Enqueue("https://cdn.test/gone/index.m3u8", kind: MediaSourceKind.Hls);
        await Center.IdleAsync();
        Assert.Equal("The site refused. The link may have expired: open the page and download again.", Center.Item(item.Id)!.Error);
    }

    [Fact]
    public async Task ProgressFollowsTheSegments()
    {
        Server.Text("/hls/720/index.m3u8", MediaPlaylist());
        ServeSegments("720");
        var fractions = new List<double>();
        Center.Changed += (_, _) =>
        {
            foreach (var value in Center.Progress.Values)
            {
                lock (fractions) fractions.Add(value);
            }
        };
        _rig.Enqueue("https://cdn.test/hls/720/index.m3u8", kind: MediaSourceKind.Hls);
        await Center.IdleAsync();
        lock (fractions)
        {
            Assert.Contains(fractions, f => f > 0 && f < 1);
            Assert.Equal(fractions.Order(), fractions);
        }
    }
}
