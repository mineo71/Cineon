using System.Text.Json;

namespace Cineon.Core.Parsing;

/// <summary>
/// Reads JSON the way Swift's synthesised <c>Decodable</c> does: a missing optional is nil, a missing
/// required value or a value of the wrong type fails the whole document. Integers may be written
/// as 2024.0 or 1e3, as <c>JSONDecoder</c> allows, but not as 2024.5 or "2024".
/// </summary>
internal static class StrictJson
{
    public sealed class Mismatch(string message) : Exception(message);

    public static JsonElement Object(JsonElement e) =>
        e.ValueKind == JsonValueKind.Object ? e : throw new Mismatch($"Expected an object, found {e.ValueKind}");

    private static JsonElement? Value(JsonElement o, string key) =>
        o.TryGetProperty(key, out var value) && value.ValueKind != JsonValueKind.Null ? value : null;

    public static string RequiredString(JsonElement o, string key) =>
        String(o, key) ?? throw new Mismatch($"Missing {key}");

    public static string? String(JsonElement o, string key) => Value(o, key) switch
    {
        null => null,
        { ValueKind: JsonValueKind.String } v => v.GetString(),
        var v => throw new Mismatch($"{key} is {v.Value.ValueKind}, not a string"),
    };

    public static int? Int(JsonElement o, string key) => Value(o, key) is { } v ? WholeNumber(v, key) : null;

    private static int WholeNumber(JsonElement v, string key)
    {
        if (v.ValueKind != JsonValueKind.Number) throw new Mismatch($"{key} is {v.ValueKind}, not a number");
        if (v.TryGetInt32(out var exact)) return exact;
        if (v.TryGetDouble(out var d) && double.IsFinite(d) && Math.Floor(d) == d && d is >= int.MinValue and <= int.MaxValue)
        {
            return (int)d;
        }
        throw new Mismatch($"{key} is not a whole number that fits");
    }

    public static IEnumerable<JsonElement> RequiredArray(JsonElement o, string key) =>
        Array(o, key) ?? throw new Mismatch($"Missing {key}");

    public static IEnumerable<JsonElement>? Array(JsonElement o, string key) => Value(o, key) switch
    {
        null => null,
        { ValueKind: JsonValueKind.Array } v => v.EnumerateArray().ToList(),
        var v => throw new Mismatch($"{key} is {v.Value.ValueKind}, not an array"),
    };

    public static JsonElement? OptionalObject(JsonElement o, string key) => Value(o, key) is { } v ? Object(v) : null;

    public static List<string>? StringArray(JsonElement o, string key) =>
        Array(o, key)?.Select(item => item.ValueKind == JsonValueKind.String
            ? item.GetString()!
            : throw new Mismatch($"{key} holds {item.ValueKind}, not strings")).ToList();
}
