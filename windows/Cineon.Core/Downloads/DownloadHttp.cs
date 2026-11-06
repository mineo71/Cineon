using System.Net;
using System.Net.Http.Headers;
using System.Net.Sockets;

namespace Cineon.Core.Downloads;

/// <summary>The site answered with an HTTP error.</summary>
public sealed class DownloadHttpException(int status) : Exception(DownloadErrors.Explain(status))
{
    public int Status { get; } = status;
}

/// <summary>A download that can't go on, with the message the Downloads page shows.</summary>
public sealed class DownloadFailedException(string message) : Exception(message);

public static class DownloadErrors
{
    public const string Protected = "The stream couldn't be saved. It may be protected.";
    public const string SeparateAudio = "The stream keeps its sound apart from the picture, which Cineon can't save as one file yet.";
    public const string TimedOut = "The request timed out.";
    public const string ConnectionLost = "The network connection was lost.";
    public const string CannotFindHost = "A server with the specified hostname could not be found.";
    public const string CannotConnect = "Could not connect to the server.";

    /// <summary>What an HTTP error means for the person downloading. 401 and 403 are a refusal.</summary>
    public static string Explain(int status) => status switch
    {
        401 or 403 => "The site refused. The link may have expired: open the page and download again.",
        404 or 410 => "The file is gone from the site.",
        _ => $"The site answered with an error ({status}).",
    };

    /// <summary>An error as the Mac words it (Foundation's <c>localizedDescription</c> for network failures).</summary>
    public static string Describe(Exception error) => error switch
    {
        DownloadHttpException or DownloadFailedException => error.Message,
        TimeoutException => TimedOut,
        HttpRequestException { InnerException: SocketException { SocketErrorCode: SocketError.HostNotFound or SocketError.NoData or SocketError.TryAgain } } => CannotFindHost,
        HttpRequestException { InnerException: SocketException { SocketErrorCode: SocketError.ConnectionRefused or SocketError.HostUnreachable or SocketError.NetworkUnreachable } } => CannotConnect,
        HttpRequestException { HttpRequestError: HttpRequestError.NameResolutionError } => CannotFindHost,
        HttpRequestException { HttpRequestError: HttpRequestError.ConnectionError } => CannotConnect,
        HttpRequestException or IOException => ConnectionLost,
        _ => error.Message,
    };

    /// <summary>Worth trying again: the network, a timeout, or a server that's busy rather than refusing.</summary>
    internal static bool IsTransient(Exception error) => error switch
    {
        DownloadHttpException http => http.Status is 408 or 429 or >= 500,
        DownloadFailedException => false,
        TimeoutException or HttpRequestException or IOException => true,
        _ => false,
    };
}

/// <summary>The headers a request carries, and the cookies for each address it goes to.</summary>
internal sealed class RequestHeaders(IReadOnlyDictionary<string, string> fixedHeaders, Func<Uri, Task<string?>> cookieFor)
{
    public IReadOnlyDictionary<string, string> Fixed { get; } = fixedHeaders;
    public Func<Uri, Task<string?>> CookieFor { get; } = cookieFor;

    public static readonly RequestHeaders None = new(new Dictionary<string, string>(), _ => Task.FromResult<string?>(null));
}

/// <summary>
/// HTTP for downloads. No cookie jar (the page's cookies are added by hand), no total timeout but
/// 60 seconds without any data fails a request, like the Mac's <c>timeoutIntervalForRequest</c>.
/// </summary>
internal sealed class DownloadHttp(HttpClient client)
{
    public HttpClient Client { get; } = client;
    public TimeSpan IdleTimeout { get; set; } = TimeSpan.FromSeconds(60);

    public static HttpClient MakeClient(HttpMessageHandler? handler = null)
    {
        handler ??= new SocketsHttpHandler
        {
            UseCookies = false,
            AllowAutoRedirect = true,
            MaxAutomaticRedirections = 10,
            AutomaticDecompression = DecompressionMethods.None,
            ConnectTimeout = TimeSpan.FromSeconds(60),
            PooledConnectionLifetime = TimeSpan.FromMinutes(5),
        };
        return new HttpClient(handler) { Timeout = Timeout.InfiniteTimeSpan };
    }

    /// <summary>Sends a GET and waits for the headers. <paramref name="from"/> asks for the rest of a file from that byte.</summary>
    public async Task<HttpResponseMessage> SendAsync(Uri url, RequestHeaders headers, HlsByteRange? range, long from, CancellationToken ct)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, url);
        foreach (var (name, value) in headers.Fixed) request.Headers.TryAddWithoutValidation(name, value);
        if (await headers.CookieFor(url).ConfigureAwait(false) is { Length: > 0 } cookie) request.Headers.TryAddWithoutValidation("Cookie", cookie);
        if (range is { } r) request.Headers.Range = new RangeHeaderValue(r.Offset, r.Offset + r.Length - 1);
        else if (from > 0) request.Headers.Range = new RangeHeaderValue(from, null);

        using var idle = CancellationTokenSource.CreateLinkedTokenSource(ct);
        idle.CancelAfter(IdleTimeout);
        try
        {
            return await Client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, idle.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            throw new TimeoutException();
        }
    }

    /// <summary>A whole response, or the range asked for. Throws <see cref="DownloadHttpException"/> for errors.</summary>
    public async Task<byte[]> GetBytesAsync(Uri url, RequestHeaders headers, HlsByteRange? range, CancellationToken ct)
    {
        using var response = await SendAsync(url, headers, range, 0, ct).ConfigureAwait(false);
        var status = (int)response.StatusCode;
        if (status >= 400) throw new DownloadHttpException(status);
        using var body = new MemoryStream();
        await using (var stream = await response.Content.ReadAsStreamAsync(ct).ConfigureAwait(false))
        {
            await CopyAsync(stream, body, null, ct).ConfigureAwait(false);
        }
        var bytes = body.ToArray();
        // A server that ignores Range sends the whole resource: cut the part that was asked for.
        if (range is { } r && status == 200 && bytes.LongLength >= r.Offset + r.Length)
        {
            bytes = bytes.AsSpan((int)r.Offset, (int)r.Length).ToArray();
        }
        return bytes;
    }

    /// <summary>Copies a response body, failing when no data arrives for <see cref="IdleTimeout"/>.</summary>
    public async Task CopyAsync(Stream source, Stream target, Action<long>? wrote, CancellationToken ct)
    {
        var buffer = new byte[1 << 17];
        long total = 0;
        using var idle = CancellationTokenSource.CreateLinkedTokenSource(ct);
        while (true)
        {
            idle.CancelAfter(IdleTimeout);
            int read;
            try
            {
                read = await source.ReadAsync(buffer, idle.Token).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (!ct.IsCancellationRequested)
            {
                throw new TimeoutException();
            }
            if (read == 0) break;
            await target.WriteAsync(buffer.AsMemory(0, read), ct).ConfigureAwait(false);
            total += read;
            wrote?.Invoke(total);
        }
    }

    /// <summary>The <c>Cookie</c> header for a list of cookies, like <c>HTTPCookie.requestHeaderFields(with:)</c>.</summary>
    public static string? CookieHeader(IEnumerable<BrowserCookie> cookies)
    {
        var text = string.Join("; ", cookies.Select(c => $"{c.Name}={c.Value}"));
        return text.Length == 0 ? null : text;
    }

    /// <summary>The cookies a request to this address would be sent, logins included, by the Mac's rule.</summary>
    public static IEnumerable<BrowserCookie> CookiesFor(Uri url, IEnumerable<BrowserCookie> all)
    {
        var host = Import.SwiftUrl.Host(url)?.ToLowerInvariant();
        if (host is null) return [];
        var path = Import.SwiftUrl.Path(url);
        var isHttps = url.Scheme == "https";
        return all.Where(cookie =>
        {
            var domain = cookie.Domain.ToLowerInvariant();
            var bare = domain.StartsWith('.') ? domain[1..] : domain;
            var domainMatches = host == bare || host.EndsWith("." + bare, StringComparison.Ordinal);
            var pathMatches = path.Length == 0 || path.StartsWith(cookie.Path, StringComparison.Ordinal);
            return domainMatches && pathMatches && (!cookie.IsSecure || isHttps);
        });
    }
}
