using System.Globalization;
using System.Text.Json;
using Windows.Foundation;

namespace Cineon.App.Browser;

/// Every WebView2 callback and every piece of fire-and-forget work in the browser runs through
/// here, so a bug in one handler ends up in crash.log instead of ending the app.
internal static class Safe
{
    public static void Run(string where, Action body)
    {
        try
        {
            body();
        }
        catch (Exception error)
        {
            CrashLog.Write(where, error);
        }
    }

    public static T Run<T>(string where, Func<T> body, T fallback)
    {
        try
        {
            return body();
        }
        catch (Exception error)
        {
            CrashLog.Write(where, error);
            return fallback;
        }
    }

    /// Starts async work without waiting for it. Started on the UI thread, its awaits come back there.
    public static void Fire(string where, Func<Task> body) => _ = Guard(where, body);

    private static async Task Guard(string where, Func<Task> body)
    {
        try
        {
            await body();
        }
        catch (OperationCanceledException)
        {
        }
        catch (Exception error)
        {
            CrashLog.Write(where, error);
        }
    }

    /// A WebView2 event handler whose exceptions are logged.
    public static TypedEventHandler<TSender, TArgs> On<TSender, TArgs>(string where, Action<TSender, TArgs> body) =>
        (sender, args) => Run(where, () => body(sender, args));
}

/// Reading what page scripts send, the way Swift reads `[String: Any]` with `as? NSNumber`.
internal static class Json
{
    public static JsonElement? Get(this JsonElement element, string name) =>
        element.ValueKind == JsonValueKind.Object && element.TryGetProperty(name, out var value) ? value : null;

    /// A number, or a Boolean as 1 or 0, as NSNumber bridges both.
    public static double? Number(this JsonElement element, string name) => element.Get(name) switch
    {
        { ValueKind: JsonValueKind.Number } n => n.GetDouble(),
        { ValueKind: JsonValueKind.True } => 1,
        { ValueKind: JsonValueKind.False } => 0,
        _ => null,
    };

    public static bool? Bool(this JsonElement element, string name) => element.Number(name) is { } n ? n != 0 : null;

    public static string? Text(this JsonElement element, string name) =>
        element.Get(name) is { ValueKind: JsonValueKind.String } s ? s.GetString() : null;

    /// Parses what `ExecuteScriptAsync` returned. Null for no result, `null`, or anything unreadable.
    public static JsonElement? Parse(string? json)
    {
        if (string.IsNullOrEmpty(json) || json == "null") return null;
        try
        {
            using var document = JsonDocument.Parse(json);
            return document.RootElement.Clone();
        }
        catch (JsonException)
        {
            return null;
        }
    }

    /// A value as a JavaScript literal, for building scripts.
    public static string Literal(object? value) => JsonSerializer.Serialize(value);

    /// A number as JavaScript reads it: invariant, shortest form.
    public static string Num(double value) =>
        double.IsFinite(value) ? value.ToString("R", CultureInfo.InvariantCulture) : "0";
}
