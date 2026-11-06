using System.Globalization;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;

namespace Cineon.Core.Together;

// Port of Cineon/Core/TogetherClient.swift (the client, the error and ShareCode). The wire types are in
// TogetherTypes.cs and the identity file in TogetherIdentity.cs.

/// <summary>The <c>errorData.code</c> the server puts on errors it throws on purpose.</summary>
public enum TogetherErrorCode { None, InvalidArgument, UnknownDevice, NotFound, NotMember, NotHost, PartyEnded }

public static class TogetherErrorCodeExtensions
{
    extension(TogetherErrorCode code)
    {
        public string? ToRaw() => code switch
        {
            TogetherErrorCode.InvalidArgument => "INVALID_ARGUMENT",
            TogetherErrorCode.UnknownDevice => "UNKNOWN_DEVICE",
            TogetherErrorCode.NotFound => "NOT_FOUND",
            TogetherErrorCode.NotMember => "NOT_MEMBER",
            TogetherErrorCode.NotHost => "NOT_HOST",
            TogetherErrorCode.PartyEnded => "PARTY_ENDED",
            _ => null,
        };

        /// <summary>Unknown or missing codes are <see cref="TogetherErrorCode.None"/>.</summary>
        public static TogetherErrorCode FromRaw(string? raw) => raw switch
        {
            "INVALID_ARGUMENT" => TogetherErrorCode.InvalidArgument,
            "UNKNOWN_DEVICE" => TogetherErrorCode.UnknownDevice,
            "NOT_FOUND" => TogetherErrorCode.NotFound,
            "NOT_MEMBER" => TogetherErrorCode.NotMember,
            "NOT_HOST" => TogetherErrorCode.NotHost,
            "PARTY_ENDED" => TogetherErrorCode.PartyEnded,
            _ => TogetherErrorCode.None,
        };
    }
}

/// <summary>
/// Swift's <c>TogetherError</c>: a sentence meant for people, in <see cref="Exception.Message"/>. Network
/// failures and replies that can't be read arrive as this too, so callers catch one type.
/// </summary>
public sealed class TogetherError : Exception
{
    public TogetherError(string message, TogetherErrorCode code = TogetherErrorCode.None, string? rawCode = null, Exception? inner = null)
        : base(message, inner)
    {
        Code = code;
        RawCode = rawCode;
    }

    /// <summary>The server's <c>errorData.code</c>, or None when it sent none (or the call never got there).</summary>
    public TogetherErrorCode Code { get; }

    /// <summary>The code exactly as sent, including ones this build doesn't know.</summary>
    public string? RawCode { get; }

    /// <summary>The request didn't get an answer: no network, a timeout, a refused connection.</summary>
    public bool IsTransport => InnerException is HttpRequestException or OperationCanceledException;
}

/// <summary>Talks to the Together server through Convex's plain HTTP API, so the app needs no SDK.</summary>
public sealed class TogetherClient
{
    /// <summary>Overrides the build's server, as on the Mac.</summary>
    public const string UrlVariable = "CINEON_TOGETHER_URL";

    /// <summary>The dev deployment: Debug builds and tests.</summary>
    public const string DevelopmentUrl = "https://stoic-pelican-635.eu-west-1.convex.cloud";

    /// <summary>The production deployment: Release builds, which is what people install.</summary>
    public const string ProductionUrl = "https://admired-mouse-481.eu-west-1.convex.cloud";

    /// <summary>The Mac's <c>request.timeoutInterval</c>.</summary>
    public static readonly TimeSpan Timeout = TimeSpan.FromSeconds(12);

    private static readonly HttpClient SharedHttp = new() { Timeout = System.Threading.Timeout.InfiniteTimeSpan };

    private readonly HttpClient _http;

    public TogetherClient(Uri baseUrl, HttpClient? http = null)
    {
        BaseUrl = baseUrl;
        _http = http ?? SharedHttp;
    }

    public Uri BaseUrl { get; }

    /// <summary>How long one call may take: <see cref="Timeout"/>, shorter only in tests.</summary>
    internal TimeSpan RequestTimeout { get; init; } = Timeout;

    /// <summary>
    /// The server this build talks to: <c>CINEON_TOGETHER_URL</c> when it's set (even to nothing),
    /// otherwise <paramref name="buildUrl"/>, which the app's build passes in (the dev deployment for
    /// Debug, <see cref="ProductionUrl"/> for Release). Null when that isn't an http(s) address.
    /// </summary>
    public static TogetherClient? Configured(string? buildUrl, HttpClient? http = null) =>
        Configured(Environment.GetEnvironmentVariable(UrlVariable), buildUrl, http);

    internal static TogetherClient? Configured(string? environment, string? buildUrl, HttpClient? http)
    {
        var raw = environment ?? buildUrl ?? "";
        if (raw.Length == 0 || !Uri.TryCreate(raw, UriKind.Absolute, out var url)) return null;
        if (!url.Scheme.StartsWith("http", StringComparison.Ordinal)) return null;
        return new TogetherClient(url, http);
    }

    /// <summary>Runs a Convex query, such as <c>parties:get</c>, and decodes its value.</summary>
    public Task<T> QueryAsync<T>(string path, IReadOnlyDictionary<string, object?> args, Func<JsonElement, T> decode,
        CancellationToken cancellationToken = default) => CallAsync("query", path, args, decode, cancellationToken);

    /// <summary>Runs a Convex mutation, such as <c>parties:update</c>, and decodes its value.</summary>
    public Task<T> MutationAsync<T>(string path, IReadOnlyDictionary<string, object?> args, Func<JsonElement, T> decode,
        CancellationToken cancellationToken = default) => CallAsync("mutation", path, args, decode, cancellationToken);

    /// <summary>A mutation whose answer is just <c>null</c>, or doesn't matter (Swift's <c>NullReply</c>).</summary>
    public Task MutationAsync(string path, IReadOnlyDictionary<string, object?> args, CancellationToken cancellationToken = default) =>
        CallAsync("mutation", path, args, static _ => true, cancellationToken);

    /// <summary>The value as sent, for anything without a decoder. The element outlives the reply.</summary>
    public Task<JsonElement> QueryRawAsync(string path, IReadOnlyDictionary<string, object?> args, CancellationToken cancellationToken = default) =>
        CallAsync("query", path, args, static e => e.Clone(), cancellationToken);

    internal Uri Endpoint(string kind)
    {
        // Swift's appendingPathComponent: one slash between the base and "api/<kind>".
        var text = BaseUrl.OriginalString.TrimEnd('/');
        return new Uri(text + "/api/" + kind);
    }

    private async Task<T> CallAsync<T>(string kind, string path, IReadOnlyDictionary<string, object?> args, Func<JsonElement, T> decode,
        CancellationToken cancellationToken)
    {
        var body = JsonArgs.Serialize(new Dictionary<string, object?> { ["path"] = path, ["args"] = args, ["format"] = "json" });
        using var request = new HttpRequestMessage(HttpMethod.Post, Endpoint(kind));
        request.Content = new ByteArrayContent(body);
        request.Content.Headers.ContentType = new MediaTypeHeaderValue("application/json");

        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(RequestTimeout);
        byte[] data;
        try
        {
            using var response = await _http.SendAsync(request, HttpCompletionOption.ResponseContentRead, timeout.Token).ConfigureAwait(false);
            // Like the Mac, the status line doesn't matter: Convex says what happened in the body.
            data = await response.Content.ReadAsByteArrayAsync(timeout.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException e) when (!cancellationToken.IsCancellationRequested)
        {
            throw new TogetherError("The request timed out.", inner: e);
        }
        catch (HttpRequestException e)
        {
            throw new TogetherError(e.Message, inner: e);
        }

        JsonDocument document;
        try
        {
            document = JsonDocument.Parse(data);
        }
        catch (JsonException e)
        {
            throw new TogetherError("The Together server sent something unexpected", inner: e);
        }
        using (document)
        {
            var reply = document.RootElement;
            if (reply.ValueKind != JsonValueKind.Object) throw new TogetherError("The Together server sent something unexpected");
            if (!(reply.TryGetProperty("status", out var status) && status.ValueKind == JsonValueKind.String && status.GetString() == "success"))
            {
                throw ErrorFrom(reply);
            }
            var value = reply.TryGetProperty("value", out var v) ? v : default;
            try
            {
                return decode(value.ValueKind == JsonValueKind.Undefined ? JsonRead.Null : value);
            }
            catch (Exception e) when (e is JsonException or InvalidOperationException or FormatException or KeyNotFoundException)
            {
                // Swift's DecodingError, as people would see it.
                throw new TogetherError("The data couldn't be read because it isn't in the correct format.", inner: e);
            }
        }
    }

    private static TogetherError ErrorFrom(JsonElement reply)
    {
        // The server's own sentence for people, when it sent one.
        if (reply.TryGetProperty("errorData", out var data) && data.ValueKind == JsonValueKind.Object &&
            data.TryGetProperty("message", out var message) && message.ValueKind == JsonValueKind.String)
        {
            var raw = data.TryGetProperty("code", out var code) && code.ValueKind == JsonValueKind.String ? code.GetString() : null;
            return new TogetherError(message.GetString()!, TogetherErrorCode.FromRaw(raw), raw);
        }
        var text = reply.TryGetProperty("errorMessage", out var m) && m.ValueKind == JsonValueKind.String ? m.GetString() : null;
        return new TogetherError(Clean(text));
    }

    /// <summary>Convex wraps thrown errors in its own text. Keep the sentence meant for people.</summary>
    internal static string Clean(string? message)
    {
        if (message is null) return "The Together server didn't answer";
        const string marker = "Uncaught Error: ";
        var at = message.IndexOf(marker, StringComparison.Ordinal);
        if (at >= 0)
        {
            var rest = message[(at + marker.Length)..];
            // Swift's split drops empty pieces, so a leading newline doesn't make the line empty.
            var line = rest.Split('\n', StringSplitOptions.RemoveEmptyEntries).FirstOrDefault() ?? rest;
            var beforeStack = line.Split("    at ")[0];
            return beforeStack.Trim(' ', '\t');
        }
        return message.Split('\n', StringSplitOptions.RemoveEmptyEntries).FirstOrDefault() ?? message;
    }
}

/// <summary>Codes show as <c>K7Q-2MX</c>, and are typed however people like.</summary>
public static class ShareCode
{
    public static string Normalize(string raw)
    {
        var upper = raw.ToUpperInvariant();
        var builder = new StringBuilder(upper.Length);
        for (var i = 0; i < upper.Length; i++)
        {
            if (char.IsLetter(upper, i) || char.IsNumber(upper, i))
            {
                builder.Append(upper[i]);
                if (char.IsHighSurrogate(upper[i]) && i + 1 < upper.Length) builder.Append(upper[++i]);
            }
            else if (char.IsHighSurrogate(upper[i]) && i + 1 < upper.Length)
            {
                i++;
            }
        }
        return builder.ToString();
    }

    public static string Display(string code)
    {
        var clean = Normalize(code);
        if (clean.Length != 6) return clean;
        return clean[..3] + "-" + clean[3..];
    }
}

/// <summary>Writes the arguments the Mac builds as <c>[String: Any]</c>.</summary>
internal static class JsonArgs
{
    public static byte[] Serialize(object? value)
    {
        using var stream = new MemoryStream();
        using (var writer = new Utf8JsonWriter(stream, new JsonWriterOptions { Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping }))
        {
            Write(writer, value);
        }
        return stream.ToArray();
    }

    public static void Write(Utf8JsonWriter writer, object? value)
    {
        switch (value)
        {
            case null:
                writer.WriteNullValue();
                break;
            case string s:
                writer.WriteStringValue(s);
                break;
            case bool b:
                writer.WriteBooleanValue(b);
                break;
            case int i:
                writer.WriteNumberValue(i);
                break;
            case long l:
                writer.WriteNumberValue(l);
                break;
            case double d:
                if (!double.IsFinite(d)) throw new TogetherError("Invalid number in the request");
                writer.WriteNumberValue(d);
                break;
            case float f:
                Write(writer, (double)f);
                break;
            case JsonElement e:
                e.WriteTo(writer);
                break;
            case IReadOnlyDictionary<string, object?> map:
                writer.WriteStartObject();
                foreach (var (key, item) in map)
                {
                    writer.WritePropertyName(key);
                    Write(writer, item);
                }
                writer.WriteEndObject();
                break;
            case System.Collections.IEnumerable list:
                writer.WriteStartArray();
                foreach (var item in list) Write(writer, item);
                writer.WriteEndArray();
                break;
            default:
                throw new ArgumentException($"Can't send a {value.GetType().Name} to the Together server");
        }
    }

    /// <summary>Milliseconds since 1970, like Swift's <c>timeIntervalSince1970 * 1000</c> (not rounded).</summary>
    public static double Milliseconds(DateTimeOffset date) => Data.StoredDate.ToUnix(date) * 1000;

    public static string Number(double value) => value.ToString("R", CultureInfo.InvariantCulture);
}
