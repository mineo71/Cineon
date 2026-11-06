using System.Text.Json;
using Cineon.Core.Data;

namespace Cineon.Core.Together;

// The types at the top of Cineon/Core/TogetherClient.swift. Each FromJson reads a value the way Swift's
// JSONDecoder does for that type: required fields throw when missing, synthesized optionals accept a
// missing key or null, and the fields the Mac reads with `try?` fall back quietly. Numbers come back as
// floats (2022.0), so whole numbers are read as doubles and truncated, as the Mac does.

/// <summary>A film as it travels between friends: enough to show a poster and find it again.</summary>
public sealed record TitleCard
{
    public TitleCard(string name, int? year = null, string kind = "unknown", string? imdbId = null, string? posterUrl = null)
    {
        Name = name;
        Year = year;
        Kind = kind;
        ImdbId = imdbId;
        PosterUrl = posterUrl;
    }

    public string Name { get; init; }
    public int? Year { get; init; }
    /// <summary>A <see cref="Data.TitleKind"/> raw value: film, series, cartoon or unknown.</summary>
    public string Kind { get; init; }
    public string? ImdbId { get; init; }
    public string? PosterUrl { get; init; }
    /// <summary>A <see cref="TitleStatus"/> raw value, left out for titles in no list.</summary>
    public string? Status { get; init; }
    /// <summary>Half-star steps, 1 to 20.</summary>
    public int? Rating { get; init; }

    /// <summary>Swift's <c>TitleCard(title)</c>.</summary>
    public static TitleCard From(Title title) => new(title.Name, title.Year, title.Kind.ToRaw(), title.ImdbId,
        title.PosterUrl is { } poster ? Urls.Text(poster) : null)
    {
        Status = title.Status == TitleStatus.None ? null : title.Status.ToRaw(),
        Rating = title.RatingHalves,
    };

    /// <summary>Swift's <c>posterURL</c>.</summary>
    public Uri? PosterUri => Urls.Parse(PosterUrl);

    /// <summary>Swift's <c>titleKind</c>.</summary>
    public TitleKind TitleKind => Data.TitleKind.FromRaw(Kind) ?? Data.TitleKind.Unknown;

    /// <summary>Swift's <c>json</c>: what the server takes, with absent fields left out.</summary>
    public Dictionary<string, object?> ToJson()
    {
        var output = new Dictionary<string, object?> { ["name"] = Name, ["kind"] = Kind };
        if (Year is int year) output["year"] = year;
        if (ImdbId is not null) output["imdbId"] = ImdbId;
        if (PosterUrl is not null) output["posterUrl"] = PosterUrl;
        if (Status is not null) output["status"] = Status;
        if (Rating is int rating) output["rating"] = rating;
        return output;
    }

    public static TitleCard FromJson(JsonElement e)
    {
        JsonRead.RequireObject(e);
        return new TitleCard(
            JsonRead.String(e, "name"),
            JsonRead.LenientInt(e, "year"),
            JsonRead.LenientString(e, "kind") ?? "unknown",
            JsonRead.LenientString(e, "imdbId"),
            JsonRead.LenientString(e, "posterUrl"))
        {
            Status = JsonRead.LenientString(e, "status"),
            Rating = JsonRead.LenientInt(e, "rating"),
        };
    }
}

public sealed record ShareInfo(string Code, string Label, string OwnerName, IReadOnlyList<TitleCard> Titles, double CreatedAt)
{
    public static ShareInfo FromJson(JsonElement e)
    {
        JsonRead.RequireObject(e);
        return new ShareInfo(JsonRead.String(e, "code"), JsonRead.String(e, "label"), JsonRead.String(e, "ownerName"),
            JsonRead.Array(e, "titles", TitleCard.FromJson), JsonRead.Number(e, "createdAt"));
    }

    /// <summary>Swift's <c>ShareInfo?</c>: null when the server says there's no such share.</summary>
    public static ShareInfo? FromJsonOrNull(JsonElement e) => JsonRead.IsNull(e) ? null : FromJson(e);
}

public sealed record PartyMember(string PersonId, string Name, double LastSeen, string? Pet = null)
{
    public static PartyMember FromJson(JsonElement e)
    {
        JsonRead.RequireObject(e);
        return new PartyMember(JsonRead.String(e, "personId"), JsonRead.String(e, "name"), JsonRead.Number(e, "lastSeen"),
            JsonRead.OptionalString(e, "pet"));
    }
}

public sealed record PartyReaction(string Name, string Emoji, double At, string? Pet = null)
{
    public static PartyReaction FromJson(JsonElement e)
    {
        JsonRead.RequireObject(e);
        return new PartyReaction(JsonRead.String(e, "name"), JsonRead.String(e, "emoji"), JsonRead.Number(e, "at"),
            JsonRead.OptionalString(e, "pet"));
    }
}

public sealed record PartyMessage(string PersonId, string Name, string? Pet, string Text, double At)
{
    /// <summary>Tells messages apart, for showing each once.</summary>
    public string Id => PersonId + "|" + JsonArgs.Number(At) + "|" + Text;

    public static PartyMessage FromJson(JsonElement e)
    {
        JsonRead.RequireObject(e);
        return new PartyMessage(JsonRead.String(e, "personId"), JsonRead.String(e, "name"), JsonRead.OptionalString(e, "pet"),
            JsonRead.String(e, "text"), JsonRead.Number(e, "at"));
    }
}

public sealed record PartyState
{
    public required string Code { get; init; }
    public bool Ended { get; init; }
    public required string HostId { get; init; }
    public required string HostName { get; init; }
    public TitleCard? Title { get; init; }
    public required string PageUrl { get; init; }
    public bool Playing { get; init; }
    /// <summary>Seconds into the film, as the host last said.</summary>
    public double Position { get; init; }
    public double Rate { get; init; }
    /// <summary>Server time of the host's last update, in milliseconds since 1970.</summary>
    public double UpdatedAt { get; init; }
    /// <summary>Server time of this answer, in milliseconds since 1970.</summary>
    public double Now { get; init; }
    public IReadOnlyList<PartyMember> Members { get; init; } = [];
    public IReadOnlyList<PartyReaction> Reactions { get; init; } = [];
    /// <summary>Chat, oldest first. Missing from servers older than chat.</summary>
    public IReadOnlyList<PartyMessage> Messages { get; init; } = [];
    public string? HostPet { get; init; }

    /// <summary>Where the host's film is right now, from the last thing the host said.</summary>
    public double ExpectedPosition => !Playing ? Position : Position + Math.Max(0, Now - UpdatedAt) / 1000 * Rate;

    public static PartyState FromJson(JsonElement e)
    {
        JsonRead.RequireObject(e);
        return new PartyState
        {
            Code = JsonRead.String(e, "code"),
            Ended = JsonRead.Bool(e, "ended"),
            HostId = JsonRead.String(e, "hostId"),
            HostName = JsonRead.String(e, "hostName"),
            Title = JsonRead.Optional(e, "title", TitleCard.FromJson),
            PageUrl = JsonRead.String(e, "pageUrl"),
            Playing = JsonRead.Bool(e, "playing"),
            Position = JsonRead.Number(e, "position"),
            Rate = JsonRead.Number(e, "rate"),
            UpdatedAt = JsonRead.Number(e, "updatedAt"),
            Now = JsonRead.Number(e, "now"),
            Members = JsonRead.Array(e, "members", PartyMember.FromJson),
            Reactions = JsonRead.Array(e, "reactions", PartyReaction.FromJson),
            Messages = JsonRead.LenientArray(e, "messages", PartyMessage.FromJson) ?? [],
            HostPet = JsonRead.LenientString(e, "hostPet"),
        };
    }

    /// <summary>Swift's <c>PartyState?</c>: null when there's no party with that code.</summary>
    public static PartyState? FromJsonOrNull(JsonElement e) => JsonRead.IsNull(e) ? null : FromJson(e);
}

public sealed record ChallengeMember(
    string PersonId, string Name, double Fraction, double WatchedEpisodes, string Label, double? FinishedAt, double UpdatedAt, string? Pet = null)
{
    public static ChallengeMember FromJson(JsonElement e)
    {
        JsonRead.RequireObject(e);
        return new ChallengeMember(JsonRead.String(e, "personId"), JsonRead.String(e, "name"), JsonRead.Number(e, "fraction"),
            JsonRead.Number(e, "watchedEpisodes"), JsonRead.String(e, "label"), JsonRead.OptionalNumber(e, "finishedAt"),
            JsonRead.Number(e, "updatedAt"), JsonRead.OptionalString(e, "pet"));
    }
}

public sealed record ChallengeState
{
    public required string Code { get; init; }
    public required TitleCard Title { get; init; }
    public double TotalEpisodes { get; init; }
    public double CreatedAt { get; init; }
    public required string CreatorId { get; init; }
    public string? WinnerId { get; init; }
    public string? WinnerName { get; init; }
    public double Now { get; init; }
    /// <summary>Furthest first; at equal progress, whoever finished or got there first.</summary>
    public IReadOnlyList<ChallengeMember> Members { get; init; } = [];

    public static ChallengeState FromJson(JsonElement e)
    {
        JsonRead.RequireObject(e);
        return new ChallengeState
        {
            Code = JsonRead.String(e, "code"),
            Title = TitleCard.FromJson(JsonRead.Required(e, "title")),
            TotalEpisodes = JsonRead.Number(e, "totalEpisodes"),
            CreatedAt = JsonRead.Number(e, "createdAt"),
            CreatorId = JsonRead.String(e, "creatorId"),
            WinnerId = JsonRead.OptionalString(e, "winnerId"),
            WinnerName = JsonRead.OptionalString(e, "winnerName"),
            Now = JsonRead.Number(e, "now"),
            Members = JsonRead.Array(e, "members", ChallengeMember.FromJson),
        };
    }

    public static ChallengeState? FromJsonOrNull(JsonElement e) => JsonRead.IsNull(e) ? null : FromJson(e);
}

public sealed record ChallengeSummary
{
    public required string Code { get; init; }
    public required TitleCard Title { get; init; }
    public double TotalEpisodes { get; init; }
    public string? WinnerName { get; init; }
    public double MemberCount { get; init; }
    public double MyFraction { get; init; }
    public string? LeaderName { get; init; }
    public double LeaderFraction { get; init; }

    public static ChallengeSummary FromJson(JsonElement e)
    {
        JsonRead.RequireObject(e);
        return new ChallengeSummary
        {
            Code = JsonRead.String(e, "code"),
            Title = TitleCard.FromJson(JsonRead.Required(e, "title")),
            TotalEpisodes = JsonRead.Number(e, "totalEpisodes"),
            WinnerName = JsonRead.OptionalString(e, "winnerName"),
            MemberCount = JsonRead.Number(e, "memberCount"),
            MyFraction = JsonRead.Number(e, "myFraction"),
            LeaderName = JsonRead.OptionalString(e, "leaderName"),
            LeaderFraction = JsonRead.Number(e, "leaderFraction"),
        };
    }

    public static IReadOnlyList<ChallengeSummary> ListFromJson(JsonElement e) => JsonRead.ArrayOf(e, FromJson);
}

/// <summary>What <c>codes:resolve</c> says a code points at: share, party or challenge.</summary>
public sealed record CodeKind(string Kind)
{
    public static CodeKind? FromJsonOrNull(JsonElement e)
    {
        if (JsonRead.IsNull(e)) return null;
        JsonRead.RequireObject(e);
        return new CodeKind(JsonRead.String(e, "kind"));
    }
}

/// <summary><c>people:register</c>'s answer.</summary>
public sealed record Registered(string PersonId, string Name)
{
    public static Registered FromJson(JsonElement e)
    {
        JsonRead.RequireObject(e);
        return new Registered(JsonRead.String(e, "personId"), JsonRead.String(e, "name"));
    }
}

/// <summary>The new code from <c>shares:create</c>, <c>parties:create</c> and <c>challenges:create</c>.</summary>
public sealed record CodeReply(string Code)
{
    public static CodeReply FromJson(JsonElement e)
    {
        JsonRead.RequireObject(e);
        return new CodeReply(JsonRead.String(e, "code"));
    }
}

/// <summary>Reads JSON the way Swift's JSONDecoder would, throwing <see cref="JsonException"/> on a wrong shape.</summary>
internal static class JsonRead
{
    /// <summary>A JSON null, for a reply without a value.</summary>
    public static readonly JsonElement Null = JsonDocument.Parse("null").RootElement.Clone();

    public static bool IsNull(JsonElement e) => e.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined;

    public static void RequireObject(JsonElement e)
    {
        if (e.ValueKind != JsonValueKind.Object) throw new JsonException($"Expected an object, found {e.ValueKind}");
    }

    public static JsonElement Required(JsonElement o, string key) =>
        o.TryGetProperty(key, out var value) ? value : throw new JsonException($"Missing \"{key}\"");

    private static bool Present(JsonElement o, string key, out JsonElement value) =>
        o.TryGetProperty(key, out value) && value.ValueKind != JsonValueKind.Null;

    public static string String(JsonElement o, string key)
    {
        var value = Required(o, key);
        return value.ValueKind == JsonValueKind.String ? value.GetString()! : throw new JsonException($"\"{key}\" isn't text");
    }

    public static double Number(JsonElement o, string key)
    {
        var value = Required(o, key);
        return value.ValueKind == JsonValueKind.Number ? value.GetDouble() : throw new JsonException($"\"{key}\" isn't a number");
    }

    public static bool Bool(JsonElement o, string key)
    {
        var value = Required(o, key);
        return value.ValueKind switch
        {
            JsonValueKind.True => true,
            JsonValueKind.False => false,
            _ => throw new JsonException($"\"{key}\" isn't true or false"),
        };
    }

    /// <summary>A synthesized Swift optional: missing or null is null, anything else must be text.</summary>
    public static string? OptionalString(JsonElement o, string key)
    {
        if (!Present(o, key, out var value)) return null;
        return value.ValueKind == JsonValueKind.String ? value.GetString() : throw new JsonException($"\"{key}\" isn't text");
    }

    public static double? OptionalNumber(JsonElement o, string key)
    {
        if (!Present(o, key, out var value)) return null;
        return value.ValueKind == JsonValueKind.Number ? value.GetDouble() : throw new JsonException($"\"{key}\" isn't a number");
    }

    public static T? Optional<T>(JsonElement o, string key, Func<JsonElement, T> read) where T : class =>
        Present(o, key, out var value) ? read(value) : null;

    /// <summary>Swift's <c>try? decodeIfPresent(String.self)</c>: anything that isn't text is null.</summary>
    public static string? LenientString(JsonElement o, string key) =>
        Present(o, key, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;

    public static double? LenientNumber(JsonElement o, string key) =>
        Present(o, key, out var value) && value.ValueKind == JsonValueKind.Number ? value.GetDouble() : null;

    /// <summary>Read as a double and truncated, as the Mac does with <c>Int(double)</c>.</summary>
    public static int? LenientInt(JsonElement o, string key) =>
        LenientNumber(o, key) is double d && double.IsFinite(d) && Math.Abs(d) < int.MaxValue ? (int)d : null;

    public static IReadOnlyList<T> Array<T>(JsonElement o, string key, Func<JsonElement, T> read) => ArrayOf(Required(o, key), read);

    public static IReadOnlyList<T> ArrayOf<T>(JsonElement e, Func<JsonElement, T> read)
    {
        if (e.ValueKind != JsonValueKind.Array) throw new JsonException($"Expected a list, found {e.ValueKind}");
        var list = new List<T>(e.GetArrayLength());
        foreach (var item in e.EnumerateArray()) list.Add(read(item));
        return list;
    }

    /// <summary>Swift's <c>try? decodeIfPresent([T].self)</c>: a list that can't be read is null.</summary>
    public static IReadOnlyList<T>? LenientArray<T>(JsonElement o, string key, Func<JsonElement, T> read)
    {
        if (!Present(o, key, out var value)) return null;
        try
        {
            return ArrayOf(value, read);
        }
        catch (Exception e) when (e is JsonException or InvalidOperationException)
        {
            return null;
        }
    }
}
