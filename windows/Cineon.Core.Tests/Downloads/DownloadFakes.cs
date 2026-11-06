using System.Collections.Concurrent;
using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using Cineon.Core.Data;
using Cineon.Core.Downloads;
using Cineon.Core.Tests.Data;

namespace Cineon.Core.Tests.Downloads;

/// <summary>An in-process web server: routes by path, logs every request, honours Range.</summary>
internal sealed class FakeServer : HttpMessageHandler
{
    private readonly ConcurrentDictionary<string, Func<HttpRequestMessage, Task<HttpResponseMessage>>> _routes = new();
    public ConcurrentQueue<HttpRequestMessage> Requests { get; } = new();

    public void Route(string path, Func<HttpRequestMessage, Task<HttpResponseMessage>> handler) => _routes[path] = handler;
    public void Route(string path, Func<HttpRequestMessage, HttpResponseMessage> handler) => _routes[path] = r => Task.FromResult(handler(r));
    public void Bytes(string path, byte[] data, string type = "application/octet-stream") => Route(path, r => Serve(r, data, type));
    public void Text(string path, string text, string type = "application/vnd.apple.mpegurl") => Bytes(path, Encoding.UTF8.GetBytes(text), type);
    public void Status(string path, HttpStatusCode status) => Route(path, _ => new HttpResponseMessage(status) { Content = new ByteArrayContent([]) });

    public int Count(string path) => Requests.Count(r => r.RequestUri!.AbsolutePath == path);
    public HttpRequestMessage Last(string path) => Requests.Last(r => r.RequestUri!.AbsolutePath == path);

    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        Requests.Enqueue(request);
        var path = request.RequestUri!.AbsolutePath;
        if (!_routes.TryGetValue(path, out var handler))
        {
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.NotFound) { Content = new ByteArrayContent([]), RequestMessage = request });
        }
        return Respond(handler, request).WaitAsync(cancellationToken);
    }

    private static async Task<HttpResponseMessage> Respond(Func<HttpRequestMessage, Task<HttpResponseMessage>> handler, HttpRequestMessage request)
    {
        var response = await handler(request);
        response.RequestMessage ??= request;
        return response;
    }

    /// <summary>The whole body, or the range asked for as a 206.</summary>
    public static HttpResponseMessage Serve(HttpRequestMessage request, byte[] data, string type = "application/octet-stream", Stream? body = null)
    {
        if (request.Headers.Range?.Ranges.FirstOrDefault() is { } range)
        {
            var from = range.From ?? 0;
            if (from >= data.Length)
            {
                var refused = new HttpResponseMessage(HttpStatusCode.RequestedRangeNotSatisfiable) { Content = new ByteArrayContent([]) };
                refused.Content.Headers.ContentRange = new ContentRangeHeaderValue(data.Length);
                return refused;
            }
            var to = Math.Min(range.To ?? data.Length - 1, data.Length - 1);
            var part = data[(int)from..((int)to + 1)];
            var partial = new HttpResponseMessage(HttpStatusCode.PartialContent) { Content = new ByteArrayContent(part) };
            partial.Content.Headers.ContentRange = new ContentRangeHeaderValue(from, to, data.Length);
            partial.Content.Headers.ContentType = new MediaTypeHeaderValue(type);
            return partial;
        }
        var response = new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = body is null ? new ByteArrayContent(data) : new StreamContent(body),
        };
        response.Content.Headers.ContentLength = data.Length;
        response.Content.Headers.ContentType = new MediaTypeHeaderValue(type);
        return response;
    }

    public static byte[] Random(int length, int seed)
    {
        var data = new byte[length];
        new Random(seed).NextBytes(data);
        return data;
    }

    public static byte[] Encrypt(byte[] data, byte[] key, byte[] iv)
    {
        using var aes = Aes.Create();
        aes.Key = key;
        return aes.EncryptCbc(data, iv, PaddingMode.PKCS7);
    }
}

/// <summary>A body that breaks off after some bytes, like a connection dropping.</summary>
internal sealed class BrokenStream(byte[] data, int breakAfter) : Stream
{
    private int _position;

    public override bool CanRead => true;
    public override bool CanSeek => false;
    public override bool CanWrite => false;
    public override long Length => data.Length;
    public override long Position { get => _position; set => throw new NotSupportedException(); }

    public override int Read(byte[] buffer, int offset, int count)
    {
        if (_position >= breakAfter) throw new IOException("The connection dropped");
        var n = Math.Min(count, breakAfter - _position);
        Array.Copy(data, _position, buffer, offset, n);
        _position += n;
        return n;
    }

    public override void Flush() { }
    public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
    public override void SetLength(long value) => throw new NotSupportedException();
    public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
}

internal sealed class FakeRequestContext : IRequestContext
{
    public string? UserAgent { get; set; } = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Cineon-Test";
    public List<BrowserCookie> Cookies { get; } = [];

    public Task<string?> UserAgentAsync() => Task.FromResult(UserAgent);
    public Task<IReadOnlyList<BrowserCookie>> CookiesAsync(Uri url) => Task.FromResult<IReadOnlyList<BrowserCookie>>([.. Cookies]);
}

internal sealed class FakeHost : IDownloadHost
{
    public ConcurrentQueue<string> Toasts { get; } = new();
    public ConcurrentQueue<(string Message, string? Title, Action? Action)> Actions { get; } = new();
    public List<DownloadItem> Played { get; } = [];
    public List<string> Recycled { get; } = [];
    public List<(long Id, string? AltName)> Enriched { get; } = [];
    public int PillRefreshes;
    public double? Duration { get; set; }

    public void ShowToast(string message, string? actionTitle = null, Action? action = null)
    {
        Toasts.Enqueue(message);
        Actions.Enqueue((message, actionTitle, action));
    }

    public void PlayDownload(DownloadItem item)
    {
        lock (Played) Played.Add(item);
    }

    public void RefreshDownloadPills() => Interlocked.Increment(ref PillRefreshes);

    public void EnrichTitle(long titleId, string? altName)
    {
        lock (Enriched) Enriched.Add((titleId, altName));
    }

    public void MoveToRecycleBin(IReadOnlyList<string> paths)
    {
        lock (Recycled)
        {
            Recycled.AddRange(paths);
            foreach (var path in paths) File.Delete(path);
        }
    }

    public void ShowInFileExplorer(string path, bool select) { }

    public Task<double?> MediaDurationAsync(string file) => Task.FromResult(Duration);
}

internal sealed class FakeTab : IDownloadTab
{
    public Uri? Url { get; set; }
    public string DisplayTitle { get; set; } = "Tab";
    public long? LinkedTitleId { get; set; }
    public EpisodeRef? TrackRef { get; set; }
    public PageTitle? Parsed { get; set; }
    public List<MediaSource> SourceList { get; } = [];
    public IReadOnlyList<MediaSource> Sources => SourceList;
    public MediaSource? BestSource => MediaSource.Best(SourceList, null);
    public string? SourcesFrameUrl { get; set; }
    public double MediaDuration { get; set; }
    public Func<string, string?> Script { get; set; } = _ => null;
    public List<string> Scripts { get; } = [];

    public Task<string?> EvaluateInPageAsync(string script)
    {
        lock (Scripts) Scripts.Add(script);
        return Task.FromResult(Script(script));
    }
}

/// <summary>A profile with a database, a library, a downloads folder and a center wired to fakes.</summary>
internal sealed class DownloadRig : IDisposable
{
    public TempFolder Folder { get; } = new();
    public Database Db { get; }
    public LibraryStore Library { get; }
    public FakeServer Server { get; } = new();
    public FakeRequestContext Context { get; } = new();
    public FakeHost Host { get; } = new();
    public string Downloads { get; }
    private DownloadCenter? _center;

    public DownloadRig()
    {
        Db = new Database(Folder.File("cineon.sqlite"));
        Library = new LibraryStore(Db);
        Downloads = Folder.File("Videos");
    }

    public DownloadCenter Center => _center ??= Make();

    public DownloadCenter Make()
    {
        var center = new DownloadCenter(Db, Library, () => new AppSettings { DownloadsFolder = Downloads }, Context, Host, Server)
        {
            ProgressInterval = TimeSpan.Zero,
        };
        center.Hls.RetryDelay = TimeSpan.FromMilliseconds(1);
        return center;
    }

    public static MediaSource Source(string url, MediaSourceKind kind = MediaSourceKind.File) =>
        new() { Url = new Uri(url), Kind = kind, FoundAt = 1, IsCurrent = true };

    public DownloadItem Enqueue(string url, string name = "Arrival", EpisodeRef? episode = null, MediaSourceKind kind = MediaSourceKind.File,
        string? referer = "https://site.test/film/arrival", IReadOnlyList<Uri>? subtitles = null, long? titleId = null) =>
        Center.Enqueue(Source(url, kind), titleId, episode ?? EpisodeRef.None, name, new Uri("https://site.test/film/arrival"), referer, 0, null, subtitles ?? [])!;

    public void Dispose()
    {
        _center?.SuspendAll();
        Db.Dispose();
        Folder.Dispose();
    }
}
