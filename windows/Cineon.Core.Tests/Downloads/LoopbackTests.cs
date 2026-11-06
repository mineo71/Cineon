using System.Collections.Concurrent;
using System.Globalization;
using System.Net;
using System.Net.Sockets;
using System.Text;
using Cineon.Core.Data;
using Cineon.Core.Downloads;
using Cineon.Core.Tests.Data;

namespace Cineon.Core.Tests.Downloads;

/// <summary>
/// A tiny HTTP/1.1 server on 127.0.0.1, so the real network stack (SocketsHttpHandler, no cookie jar)
/// is used end to end. Serves one file with Range support, and can drop the first connection midway.
/// </summary>
internal sealed class LoopbackServer : IDisposable
{
    private readonly TcpListener _listener = new(IPAddress.Loopback, 0);
    private readonly CancellationTokenSource _stop = new();
    private readonly byte[] _file;
    public ConcurrentQueue<string> Requests { get; } = new();
    public int DropAfter { get; set; } = -1;

    public LoopbackServer(byte[] file)
    {
        _file = file;
        _listener.Start();
        _ = AcceptLoop();
    }

    public Uri Url(string path) => new($"http://127.0.0.1:{((IPEndPoint)_listener.LocalEndpoint).Port}{path}");

    private async Task AcceptLoop()
    {
        while (!_stop.IsCancellationRequested)
        {
            TcpClient client;
            try
            {
                client = await _listener.AcceptTcpClientAsync(_stop.Token);
            }
            catch (Exception)
            {
                return;
            }
            _ = Serve(client);
        }
    }

    private async Task Serve(TcpClient client)
    {
        using var _ = client;
        var stream = client.GetStream();
        var head = new StringBuilder();
        var buffer = new byte[1];
        while (!head.ToString().EndsWith("\r\n\r\n", StringComparison.Ordinal))
        {
            if (await stream.ReadAsync(buffer) == 0) return;
            head.Append((char)buffer[0]);
        }
        var text = head.ToString();
        Requests.Enqueue(text);
        long from = 0;
        var range = text.Split("\r\n").FirstOrDefault(l => l.StartsWith("Range: bytes=", StringComparison.OrdinalIgnoreCase));
        if (range is not null) from = long.Parse(range["Range: bytes=".Length..].TrimEnd('-').Split('-')[0], CultureInfo.InvariantCulture);
        var body = _file.AsMemory((int)from);
        var status = range is null ? "200 OK" : "206 Partial Content";
        var headers = $"HTTP/1.1 {status}\r\nContent-Type: video/mp4\r\nContent-Length: {body.Length}\r\nAccept-Ranges: bytes\r\nConnection: close\r\n" +
            (range is null ? "" : $"Content-Range: bytes {from}-{_file.Length - 1}/{_file.Length}\r\n") + "\r\n";
        await stream.WriteAsync(Encoding.ASCII.GetBytes(headers));
        if (DropAfter >= 0)
        {
            var cut = DropAfter;
            DropAfter = -1;
            await stream.WriteAsync(body[..cut]);
            await stream.FlushAsync();
            client.Client.LingerState = new LingerOption(true, 0);
            return;
        }
        await stream.WriteAsync(body);
    }

    public void Dispose()
    {
        _stop.Cancel();
        _listener.Stop();
    }
}

public sealed class LoopbackTests : IDisposable
{
    private readonly TempFolder _folder = new();
    private readonly Database _db;

    public LoopbackTests() => _db = new Database(_folder.File("cineon.sqlite"));

    public void Dispose()
    {
        _db.Dispose();
        _folder.Dispose();
    }

    [Fact]
    public async Task ADroppedConnectionCarriesOnOverRealSockets()
    {
        var film = FakeServer.Random(2_000_000, 11);
        using var server = new LoopbackServer(film) { DropAfter = 700_000 };
        var context = new FakeRequestContext();
        context.Cookies.Add(new BrowserCookie("login", "yes", "127.0.0.1", "/", false));
        var downloads = _folder.File("Videos");
        var center = new DownloadCenter(_db, new LibraryStore(_db), () => new AppSettings { DownloadsFolder = downloads }, context, new FakeHost());

        var item = center.Enqueue(
            new MediaSource { Url = server.Url("/v/1080.mp4"), Kind = MediaSourceKind.File, IsCurrent = true },
            null, EpisodeRef.None, "Heat", null, "http://127.0.0.1/page", 0, null, [])!;
        await center.IdleAsync();
        Assert.Equal(DownloadStatus.Failed, center.Item(item.Id)!.Status);
        var kept = new FileInfo(center.PartialFile(item)).Length;
        Assert.True(kept > 0, "Something was saved before the connection dropped");

        center.Retry(item.Id);
        await center.IdleAsync();
        var done = center.Item(item.Id)!;
        Assert.Equal(DownloadStatus.Done, done.Status);
        Assert.Equal(film, File.ReadAllBytes(done.File!));
        var second = server.Requests.Last();
        Assert.Contains($"Range: bytes={kept}-", second, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("Cookie: login=yes", second, StringComparison.Ordinal);
        Assert.Contains("Referer: http://127.0.0.1/page", second, StringComparison.Ordinal);
        Assert.Equal(Path.Combine(downloads, "Heat [1080p].mp4"), done.File);
    }
}
