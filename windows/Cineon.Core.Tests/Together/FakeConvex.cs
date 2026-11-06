using System.Globalization;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Cineon.Core.Tests.Together;

/// <summary>
/// A stand-in for the Convex deployment, behind an HttpMessageHandler. It speaks Convex's HTTP API
/// (/api/query and /api/mutation, {"status":"success","value":…} or {"status":"error",…}, numbers
/// as floats like 2022.0), checks arguments against the validators in server/convex/*.ts (extra
/// fields and wrong types are rejected, as Convex does), and runs ports of the functions there.
/// </summary>
internal sealed partial class FakeConvex : HttpMessageHandler
{
    private readonly object _lock = new();
    private readonly Random _random = new(7);
    private readonly Dictionary<string, Function> _functions;
    private int _nextId;

    public FakeConvex(TimeProvider clock)
    {
        Clock = clock;
        _functions = Functions();
    }

    public TimeProvider Clock { get; }

    /// <summary>Server time in milliseconds, like JavaScript's Date.now().</summary>
    public double Now => Clock.GetUtcNow().ToUnixTimeMilliseconds();

    /// <summary>When set, every request fails like a dropped connection.</summary>
    public bool Offline { get; set; }

    /// <summary>Codes handed out next, before random ones.</summary>
    public Queue<string> NextCodes { get; } = new();

    /// <summary>When it returns a body, that is sent instead of running the function.</summary>
    public Func<Call, string?>? Intercept { get; set; }

    public List<Call> Calls { get; } = [];

    public sealed record Call(string Kind, string Path, JsonElement Args, string Url);

    public IReadOnlyList<Call> CallsTo(string path)
    {
        lock (_lock) return [.. Calls.Where(c => c.Path == path)];
    }

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        if (Offline) throw new HttpRequestException("The Internet connection appears to be offline.");
        var body = request.Content is null ? "" : await request.Content.ReadAsStringAsync(cancellationToken);
        var (status, reply) = Handle(request, body);
        return new HttpResponseMessage(status) { Content = new StringContent(reply, Encoding.UTF8, "application/json") };
    }

    private (HttpStatusCode, string) Handle(HttpRequestMessage request, string body)
    {
        var path = request.RequestUri!.AbsolutePath;
        var kind = path switch
        {
            "/api/query" => "query",
            "/api/mutation" => "mutation",
            _ => null,
        };
        if (request.Method != HttpMethod.Post || kind is null) return (HttpStatusCode.NotFound, "{\"code\":\"NotFound\",\"message\":\"Not found\"}");
        if (request.Content?.Headers.ContentType?.MediaType != "application/json")
        {
            return (HttpStatusCode.BadRequest, "{\"code\":\"BadJsonBody\",\"message\":\"Expected JSON\"}");
        }
        JsonElement root;
        try
        {
            root = JsonDocument.Parse(body).RootElement.Clone();
        }
        catch (JsonException)
        {
            return (HttpStatusCode.BadRequest, "{\"code\":\"BadJsonBody\",\"message\":\"Failed to parse the request body as JSON\"}");
        }
        var name = root.GetProperty("path").GetString()!;
        var args = root.TryGetProperty("args", out var a) ? a : JsonDocument.Parse("{}").RootElement;
        Assert.Equal("json", root.GetProperty("format").GetString());

        var call = new Call(kind, name, args, request.RequestUri.OriginalString);
        lock (_lock)
        {
            Calls.Add(call);
            if (Intercept?.Invoke(call) is { } canned) return (HttpStatusCode.OK, canned);
            if (!_functions.TryGetValue(name, out var function))
            {
                return (HttpStatusCode.OK, Error($"Could not find public function for '{name}'."));
            }
            if (function.Kind != kind)
            {
                var want = function.Kind == "query" ? "Query" : "Mutation";
                var got = kind == "query" ? "Query" : "Mutation";
                return (HttpStatusCode.OK, Error($"Trying to execute {name} as {got}, but it is defined as {want}."));
            }
            if (Validate(args, function.Args, "") is { } invalid)
            {
                return (HttpStatusCode.OK, Error($"ArgumentValidationError: {invalid}\n\nObject: {args.GetRawText()}\n"));
            }
            try
            {
                var value = function.Run(args);
                return (HttpStatusCode.OK, "{\"status\":\"success\",\"value\":" + Json(value) + "}");
            }
            catch (Fail f)
            {
                var data = new Dictionary<string, object?> { ["code"] = f.Code, ["message"] = f.Message };
                return (HttpStatusCode.OK,
                    $"{{\"status\":\"error\",\"errorMessage\":{Json($"[Request ID: fake] Server Error\nUncaught ConvexError: {Json(data)}\n    at fail (../../convex/lib.ts:18:0)\n")},\"errorData\":{Json(data)}}}");
            }
            catch (InvalidOperationException e)
            {
                return (HttpStatusCode.OK, Error($"Uncaught Error: {e.Message}\n    at handler (../convex/lib.ts:1:0)"));
            }
        }
    }

    private static string Error(string message) =>
        "{\"status\":\"error\",\"errorMessage\":" + Json("[Request ID: fake] Server Error\n" + message + "\n") + "}";

    // MARK: Convex JSON out: every number is a float64, written like 2022.0

    public static string Json(object? value)
    {
        var builder = new StringBuilder();
        Write(builder, value);
        return builder.ToString();
    }

    private static void Write(StringBuilder b, object? value)
    {
        switch (value)
        {
            case null:
                b.Append("null");
                break;
            case string s:
                b.Append(JsonSerializer.Serialize(s));
                break;
            case bool flag:
                b.Append(flag ? "true" : "false");
                break;
            case int or long or double:
                var text = Convert.ToDouble(value, CultureInfo.InvariantCulture).ToString("R", CultureInfo.InvariantCulture);
                if (!text.Contains('.') && !text.Contains('E')) text += ".0";
                b.Append(text);
                break;
            case IDictionary<string, object?> map:
                b.Append('{');
                var first = true;
                foreach (var (k, v) in map)
                {
                    if (!first) b.Append(',');
                    first = false;
                    b.Append(JsonSerializer.Serialize(k)).Append(':');
                    Write(b, v);
                }
                b.Append('}');
                break;
            case System.Collections.IEnumerable list:
                b.Append('[');
                var firstItem = true;
                foreach (var item in list)
                {
                    if (!firstItem) b.Append(',');
                    firstItem = false;
                    Write(b, item);
                }
                b.Append(']');
                break;
            default:
                throw new ArgumentException(value.GetType().Name);
        }
    }

    // MARK: Validators (convex/values), enough for the functions here

    private abstract record V;
    private sealed record VString : V;
    private sealed record VNumber : V;
    private sealed record VBool : V;
    private sealed record VNull : V;
    private sealed record VLiteral(string Value) : V;
    private sealed record VArray(V Item) : V;
    private sealed record VUnion(params V[] Options) : V;
    private sealed record VObject(params (string Name, V Validator, bool Optional)[] Fields) : V;

    private static readonly V Str = new VString();
    private static readonly V Num = new VNumber();
    private static readonly V Bool = new VBool();
    private static (string, V, bool) Req(string name, V v) => (name, v, false);
    private static (string, V, bool) Opt(string name, V v) => (name, v, true);
    private static V OrNull(V v) => new VUnion(v, new VNull());

    private static readonly V TitleCardInput = new VObject(
        Req("name", Str),
        Opt("year", OrNull(Num)),
        Req("kind", new VUnion(new VLiteral("film"), new VLiteral("series"), new VLiteral("cartoon"), new VLiteral("unknown"))),
        Opt("imdbId", OrNull(Str)),
        Opt("posterUrl", OrNull(Str)),
        Opt("status", OrNull(Str)),
        Opt("rating", OrNull(Num)));

    private static readonly V LibraryItemInput = new VObject(
        Req("key", Str), Req("name", Str), Opt("year", OrNull(Num)), Opt("kind", OrNull(Str)), Opt("rating", OrNull(Num)),
        Opt("ratedAt", OrNull(Num)), Opt("status", OrNull(Str)), Opt("statusAt", OrNull(Num)), Opt("finishedAt", OrNull(Num)));

    private static string? Validate(JsonElement value, V v, string at)
    {
        switch (v)
        {
            case VString:
                return value.ValueKind == JsonValueKind.String ? null : $"Value at {at} must be a string";
            case VNumber:
                return value.ValueKind == JsonValueKind.Number ? null : $"Value at {at} must be a number";
            case VBool:
                return value.ValueKind is JsonValueKind.True or JsonValueKind.False ? null : $"Value at {at} must be a boolean";
            case VNull:
                return value.ValueKind == JsonValueKind.Null ? null : $"Value at {at} must be null";
            case VLiteral literal:
                return value.ValueKind == JsonValueKind.String && value.GetString() == literal.Value ? null : $"Value at {at} must be \"{literal.Value}\"";
            case VArray array:
                if (value.ValueKind != JsonValueKind.Array) return $"Value at {at} must be an array";
                var i = 0;
                foreach (var item in value.EnumerateArray())
                {
                    if (Validate(item, array.Item, $"{at}[{i++}]") is { } bad) return bad;
                }
                return null;
            case VUnion union:
                return union.Options.Any(o => Validate(value, o, at) is null) ? null : $"Value does not match validator at {at}";
            case VObject obj:
                if (value.ValueKind != JsonValueKind.Object) return $"Value at {at} must be an object";
                foreach (var property in value.EnumerateObject())
                {
                    if (!obj.Fields.Any(f => f.Name == property.Name)) return $"Object contains extra field `{property.Name}` that is not in the validator.";
                }
                foreach (var (name, validator, optional) in obj.Fields)
                {
                    if (!value.TryGetProperty(name, out var field))
                    {
                        if (!optional) return $"Object is missing the required field `{name}`.";
                        continue;
                    }
                    if (Validate(field, validator, $"{at}.{name}") is { } bad) return bad;
                }
                return null;
            default:
                return "unknown validator";
        }
    }

    private sealed record Function(string Kind, V Args, Func<JsonElement, object?> Run);

    // MARK: Tables

    internal sealed class Person
    {
        public required string Id;
        public required string SecretHash;
        public required string Name;
        public string? Pet;
        public double CreatedAt, UpdatedAt;
    }

    private sealed record CodeRow(string Code, string Kind, string RefId);

    private sealed class ShareRow
    {
        public required string Id, Code, OwnerId, Label;
        public required List<Dictionary<string, object?>> Titles;
        public double CreatedAt;
    }

    internal sealed class PartyRow
    {
        public required string Id, Code, HostId, PageUrl;
        public Dictionary<string, object?>? Title;
        public double Position, Rate, UpdatedAt, CreatedAt;
        public bool Playing, Ended;
    }

    private sealed class MemberRow
    {
        public required string PartyId, PersonId;
        public double JoinedAt, LastSeen;
        public int Order;
    }

    private sealed record ReactionRow(string PartyId, string PersonId, string Name, string Emoji, double At);

    private sealed record MessageRow(string PartyId, string PersonId, string Name, string Text, double At);

    private sealed class ChallengeRow
    {
        public required string Id, Code, CreatorId;
        public required Dictionary<string, object?> Title;
        public double TotalEpisodes, CreatedAt;
        public string? WinnerId;
        public double? FinishedAt;
    }

    private sealed class ChallengeMemberRow
    {
        public required string ChallengeId, PersonId;
        public double Fraction, WatchedEpisodes, UpdatedAt, ProgressAt, JoinedAt;
        public string Label = "";
        public double? FinishedAt;
    }

    internal sealed record LibraryFields
    {
        public required string Key { get; init; }
        public required string Name { get; init; }
        public double? Year { get; init; }
        public string? Kind { get; init; }
        public double? Rating { get; init; }
        public double? RatedAt { get; init; }
        public string? Status { get; init; }
        public double? StatusAt { get; init; }
        public double? FinishedAt { get; init; }
    }

    private sealed class LibraryRow
    {
        public required string PersonId;
        public required LibraryFields Fields;
        public double UpdatedAt;
    }

    internal readonly List<Person> People = [];
    private readonly List<CodeRow> _codes = [];
    private readonly List<ShareRow> _shares = [];
    internal readonly List<PartyRow> Parties = [];
    private readonly List<MemberRow> _partyMembers = [];
    private readonly List<ReactionRow> _reactions = [];
    private readonly List<MessageRow> _messages = [];
    private readonly List<ChallengeRow> _challenges = [];
    private readonly List<ChallengeMemberRow> _challengeMembers = [];
    private readonly List<LibraryRow> _library = [];

    /// <summary>The backed-up library of whoever holds this secret.</summary>
    internal IReadOnlyList<LibraryFields> LibraryOf(string secret)
    {
        lock (_lock)
        {
            var person = People.FirstOrDefault(p => p.SecretHash == HashSecret(secret));
            return person is null ? [] : [.. _library.Where(r => r.PersonId == person.Id).Select(r => r.Fields)];
        }
    }

    internal void SeedLibrary(string secret, LibraryFields fields)
    {
        lock (_lock)
        {
            var person = People.First(p => p.SecretHash == HashSecret(secret));
            _library.Add(new LibraryRow { PersonId = person.Id, Fields = fields, UpdatedAt = Now });
        }
    }

    private string NewId(string table) => $"{table}{++_nextId:D4}";

    // MARK: lib.ts

    private sealed class Fail(string code, string message) : Exception(message)
    {
        public string Code { get; } = code;
    }

    private const string CodeAlphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

    [GeneratedRegex("[\u0000-\u001F\u007F]+")]
    private static partial Regex ControlCharacters();

    [GeneratedRegex(@"[\s\-–—_.]")]
    private static partial Regex CodeSeparators();

    [GeneratedRegex("^[A-Za-z0-9_-]+$")]
    private static partial Regex PetPattern();

    private static string Cap(string input, int max)
    {
        var cleaned = ControlCharacters().Replace(input, " ").Trim();
        var points = cleaned.EnumerateRunes().ToList();
        return points.Count <= max ? cleaned : string.Concat(points.Take(max).Select(r => r.ToString())).Trim();
    }

    private static string CapName(string input)
    {
        var name = Cap(input, 40);
        if (name.Length == 0) throw new Fail("INVALID_ARGUMENT", "Name must not be empty.");
        return name;
    }

    private static string CheckPet(string input)
    {
        var pet = input.Trim();
        if (pet.Length == 0 || pet.Length > 48 || !PetPattern().IsMatch(pet))
        {
            throw new Fail("INVALID_ARGUMENT", "pet must be 1 to 48 characters of A-Z, a-z, 0-9, \"_\" or \"-\".");
        }
        return pet;
    }

    private static bool IsHttpUrl(string s) =>
        Regex.IsMatch(s, "^https?://", RegexOptions.IgnoreCase) && Uri.TryCreate(s, UriKind.Absolute, out _);

    private static string RequireUrl(string input, string what)
    {
        var url = input.Trim();
        if (url.Length > 2000) throw new Fail("INVALID_ARGUMENT", $"{what} is longer than 2000 characters.");
        if (!IsHttpUrl(url)) throw new Fail("INVALID_ARGUMENT", $"{what} must be an http(s) URL.");
        return url;
    }

    private static double Finite(double n, double fallback) => double.IsFinite(n) ? n : fallback;

    private static double Clamp(double n, double lo, double hi) => Math.Min(hi, Math.Max(lo, n));

    private static Dictionary<string, object?> CleanTitleCard(JsonElement t)
    {
        var name = Cap(t.GetProperty("name").GetString()!, 200);
        if (name.Length == 0) throw new Fail("INVALID_ARGUMENT", "Every title needs a name.");
        var card = new Dictionary<string, object?> { ["name"] = name, ["kind"] = t.GetProperty("kind").GetString() };
        if (NumberOrNull(t, "year") is double year) card["year"] = Math.Truncate(year);
        if (StringOrNull(t, "imdbId") is { } imdb && Cap(imdb, 40) is { Length: > 0 } cleanImdb) card["imdbId"] = cleanImdb;
        if (StringOrNull(t, "posterUrl") is { } poster && poster.Trim() is var p && p.Length <= 2000 && IsHttpUrl(p)) card["posterUrl"] = p;
        if (StringOrNull(t, "status") is { } status && Cap(status, 200) is { Length: > 0 } cleanStatus) card["status"] = cleanStatus;
        if (NumberOrNull(t, "rating") is double rating) card["rating"] = rating;
        return card;
    }

    private static string? StringOrNull(JsonElement o, string key) =>
        o.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    private static double? NumberOrNull(JsonElement o, string key) =>
        o.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.Number ? v.GetDouble() : null;

    private static bool Has(JsonElement o, string key) => o.TryGetProperty(key, out _);

    private static string S(JsonElement o, string key) => o.GetProperty(key).GetString()!;

    private static double N(JsonElement o, string key) => o.GetProperty(key).GetDouble();

    internal static string HashSecret(string secret) => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(secret)));

    private static string CheckSecret(string secret)
    {
        var s = secret.Trim();
        if (s.Length < 16 || s.Length > 256)
        {
            throw new Fail("INVALID_ARGUMENT", "deviceSecret must be 16 to 256 characters (32 random bytes, base64).");
        }
        return s;
    }

    private Person? FindPerson(string deviceSecret)
    {
        var hash = HashSecret(CheckSecret(deviceSecret));
        return People.SingleOrDefault(p => p.SecretHash == hash);
    }

    private Person RequirePerson(JsonElement args) =>
        FindPerson(S(args, "deviceSecret")) ?? throw new Fail("UNKNOWN_DEVICE", "Unknown device. Call people:register first.");

    private Person? PersonById(string? id) => id is null ? null : People.FirstOrDefault(p => p.Id == id);

    private string? NameOf(string? id) => PersonById(id)?.Name;

    private string PeopleName(string id) => PersonById(id)?.Name ?? "";

    private string? PeoplePet(string id) => PersonById(id)?.Pet;

    private static string? NormalizeCode(string input)
    {
        var code = CodeSeparators().Replace(input.ToUpperInvariant(), "");
        if (code.Length != 6) return null;
        return code.All(c => CodeAlphabet.Contains(c)) ? code : null;
    }

    private string FreshCode()
    {
        for (var attempt = 0; attempt < 20; attempt++)
        {
            var code = NextCodes.Count > 0
                ? NextCodes.Dequeue()
                : new string([.. Enumerable.Range(0, 6).Select(_ => CodeAlphabet[_random.Next(CodeAlphabet.Length)])]);
            if (NormalizeCode(code) != code) throw new ArgumentException($"{code} isn't a code the server could hand out");
            if (!_codes.Any(c => c.Code == code)) return code;
        }
        throw new InvalidOperationException("Could not allocate a unique code.");
    }

    private void ClaimCode(string code, string kind, string refId) => _codes.Add(new CodeRow(code, kind, refId));

    // MARK: The functions

    private Dictionary<string, Function> Functions() => new()
    {
        ["people:register"] = new("mutation", new VObject(Req("deviceSecret", Str), Req("name", Str), Opt("pet", OrNull(Str))), Register),
        ["codes:resolve"] = new("query", new VObject(Req("code", Str)), args =>
        {
            var code = NormalizeCode(S(args, "code"));
            var row = code is null ? null : _codes.FirstOrDefault(c => c.Code == code);
            return row is null ? null : new Dictionary<string, object?> { ["kind"] = row.Kind };
        }),
        ["shares:create"] = new("mutation", new VObject(Req("deviceSecret", Str), Req("label", Str), Req("titles", new VArray(TitleCardInput))), CreateShare),
        ["shares:get"] = new("query", new VObject(Req("code", Str)), GetShare),
        ["parties:create"] = new("mutation", new VObject(Req("deviceSecret", Str), Opt("title", OrNull(TitleCardInput)), Req("pageUrl", Str),
            Req("position", Num), Req("playing", Bool), Req("rate", Num)), CreateParty),
        ["parties:join"] = new("mutation", new VObject(Req("deviceSecret", Str), Req("code", Str)), JoinParty),
        ["parties:leave"] = new("mutation", new VObject(Req("deviceSecret", Str), Req("code", Str)), LeaveParty),
        ["parties:update"] = new("mutation", new VObject(Req("deviceSecret", Str), Req("code", Str), Req("position", Num), Req("playing", Bool),
            Req("rate", Num), Opt("pageUrl", OrNull(Str))), UpdateParty),
        ["parties:heartbeat"] = new("mutation", new VObject(Req("deviceSecret", Str), Req("code", Str)), Heartbeat),
        ["parties:react"] = new("mutation", new VObject(Req("deviceSecret", Str), Req("code", Str), Req("emoji", Str)), React),
        ["parties:say"] = new("mutation", new VObject(Req("deviceSecret", Str), Req("code", Str), Req("text", Str)), Say),
        ["parties:get"] = new("query", new VObject(Req("code", Str), Opt("t", Num)), args =>
        {
            var party = FindParty(S(args, "code"));
            return party is null ? null : PartyView(party, Now);
        }),
        ["challenges:create"] = new("mutation", new VObject(Req("deviceSecret", Str), Req("title", TitleCardInput), Req("totalEpisodes", Num)), CreateChallenge),
        ["challenges:join"] = new("mutation", new VObject(Req("deviceSecret", Str), Req("code", Str)), JoinChallenge),
        ["challenges:leave"] = new("mutation", new VObject(Req("deviceSecret", Str), Req("code", Str)), LeaveChallenge),
        ["challenges:report"] = new("mutation", new VObject(Req("deviceSecret", Str), Req("code", Str), Req("fraction", Num),
            Req("watchedEpisodes", Num), Req("label", Str), Req("finished", Bool)), Report),
        ["challenges:get"] = new("query", new VObject(Req("code", Str), Opt("t", Num)), args =>
        {
            var challenge = FindChallenge(S(args, "code"));
            return challenge is null ? null : ChallengeView(challenge);
        }),
        ["challenges:mine"] = new("query", new VObject(Req("deviceSecret", Str)), Mine),
        ["library:put"] = new("mutation", new VObject(Req("deviceSecret", Str), Req("items", new VArray(LibraryItemInput))), PutLibrary),
        ["library:all"] = new("query", new VObject(Req("deviceSecret", Str), Opt("t", Num)), AllLibrary),
    };

    // people.ts
    private object? Register(JsonElement args)
    {
        var secretHash = HashSecret(CheckSecret(S(args, "deviceSecret")));
        var cleanName = CapName(S(args, "name"));
        // keep: no change; clear: remove; otherwise the new pet.
        var pet = StringOrNull(args, "pet");
        var keep = pet is null;
        var wanted = keep ? null : pet!.Trim().Length == 0 ? null : CheckPet(pet);
        var now = Now;
        var existing = People.SingleOrDefault(p => p.SecretHash == secretHash);
        if (existing is not null)
        {
            var nextPet = keep ? existing.Pet : wanted;
            if (existing.Name != cleanName || nextPet != existing.Pet)
            {
                existing.Name = cleanName;
                existing.Pet = nextPet;
                existing.UpdatedAt = now;
            }
            return new Dictionary<string, object?> { ["personId"] = existing.Id, ["name"] = cleanName, ["pet"] = nextPet };
        }
        var person = new Person { Id = NewId("people"), SecretHash = secretHash, Name = cleanName, Pet = wanted, CreatedAt = now, UpdatedAt = now };
        People.Add(person);
        return new Dictionary<string, object?> { ["personId"] = person.Id, ["name"] = cleanName, ["pet"] = wanted };
    }

    // shares.ts
    private object? CreateShare(JsonElement args)
    {
        var person = RequirePerson(args);
        var raw = args.GetProperty("titles");
        if (raw.GetArrayLength() > 500) throw new Fail("INVALID_ARGUMENT", $"A share holds at most 500 titles (got {raw.GetArrayLength()}).");
        var titles = raw.EnumerateArray().Select(CleanTitleCard).ToList();
        var code = FreshCode();
        var share = new ShareRow { Id = NewId("shares"), Code = code, OwnerId = person.Id, Label = Cap(S(args, "label"), 200), Titles = titles, CreatedAt = Now };
        _shares.Add(share);
        ClaimCode(code, "share", share.Id);
        return new Dictionary<string, object?> { ["code"] = code };
    }

    private object? GetShare(JsonElement args)
    {
        var code = NormalizeCode(S(args, "code"));
        if (code is null) return null;
        var share = _shares.SingleOrDefault(s => s.Code == code);
        if (share is null) return null;
        return new Dictionary<string, object?>
        {
            ["code"] = share.Code,
            ["label"] = share.Label,
            ["ownerName"] = NameOf(share.OwnerId) ?? "",
            ["titles"] = share.Titles.Take(500).ToList(),
            ["createdAt"] = share.CreatedAt,
        };
    }

    // parties.ts
    private PartyRow? FindParty(string rawCode)
    {
        var code = NormalizeCode(rawCode);
        return code is null ? null : Parties.SingleOrDefault(p => p.Code == code);
    }

    private PartyRow RequireParty(JsonElement args)
    {
        var raw = S(args, "code");
        return FindParty(raw) ?? throw new Fail("NOT_FOUND", $"No watch party with code {raw.Trim()}.");
    }

    private MemberRow? PartyMember(string partyId, string personId) =>
        _partyMembers.SingleOrDefault(m => m.PartyId == partyId && m.PersonId == personId);

    private void TouchMember(string partyId, string personId, double now)
    {
        if (PartyMember(partyId, personId) is { } row) row.LastSeen = now;
        else _partyMembers.Add(new MemberRow { PartyId = partyId, PersonId = personId, JoinedAt = now, LastSeen = now, Order = ++_nextId });
    }

    private static double CleanPosition(double n) => Clamp(Finite(n, 0), 0, 1e7);

    private static double CleanRate(double n) => Clamp(Finite(n, 1), 0, 16);

    private Dictionary<string, object?> PartyView(PartyRow party, double now)
    {
        var members = _partyMembers
            .Where(m => m.PartyId == party.Id && m.LastSeen >= now - 30_000)
            .OrderBy(m => m.LastSeen).ThenBy(m => m.Order)
            .OrderBy(m => m.PersonId == party.HostId ? 0 : 1).ThenBy(m => m.JoinedAt)
            .Select(m => (object?)new Dictionary<string, object?>
            {
                ["personId"] = m.PersonId, ["name"] = PeopleName(m.PersonId), ["lastSeen"] = m.LastSeen, ["pet"] = PeoplePet(m.PersonId),
            }).ToList();
        var reactions = _reactions.Where(r => r.PartyId == party.Id && r.At >= now - 10_000).Take(40)
            .Select(r => (object?)new Dictionary<string, object?> { ["name"] = r.Name, ["emoji"] = r.Emoji, ["at"] = r.At, ["pet"] = PeoplePet(r.PersonId) })
            .ToList();
        var messages = _messages.Where(m => m.PartyId == party.Id).Reverse().Take(50).Reverse()
            .Select(m => (object?)new Dictionary<string, object?>
            {
                ["personId"] = m.PersonId, ["name"] = m.Name, ["pet"] = PeoplePet(m.PersonId), ["text"] = m.Text, ["at"] = m.At,
            }).ToList();
        return new Dictionary<string, object?>
        {
            ["code"] = party.Code,
            ["ended"] = party.Ended,
            ["hostId"] = party.HostId,
            ["hostName"] = PeopleName(party.HostId),
            ["hostPet"] = PeoplePet(party.HostId),
            ["title"] = party.Title,
            ["pageUrl"] = party.PageUrl,
            ["playing"] = party.Playing,
            ["position"] = party.Position,
            ["rate"] = party.Rate,
            ["updatedAt"] = party.UpdatedAt,
            ["now"] = now,
            ["members"] = members,
            ["reactions"] = reactions,
            ["messages"] = messages,
        };
    }

    private object? CreateParty(JsonElement args)
    {
        var person = RequirePerson(args);
        var now = Now;
        var code = FreshCode();
        var party = new PartyRow
        {
            Id = NewId("parties"), Code = code, HostId = person.Id,
            Title = args.TryGetProperty("title", out var t) && t.ValueKind == JsonValueKind.Object ? CleanTitleCard(t) : null,
            PageUrl = RequireUrl(S(args, "pageUrl"), "pageUrl"), Position = CleanPosition(N(args, "position")),
            Playing = args.GetProperty("playing").GetBoolean(), Rate = CleanRate(N(args, "rate")), UpdatedAt = now, Ended = false, CreatedAt = now,
        };
        Parties.Add(party);
        _partyMembers.Add(new MemberRow { PartyId = party.Id, PersonId = person.Id, JoinedAt = now, LastSeen = now, Order = ++_nextId });
        ClaimCode(code, "party", party.Id);
        return new Dictionary<string, object?> { ["code"] = code };
    }

    private object? JoinParty(JsonElement args)
    {
        var person = RequirePerson(args);
        var party = RequireParty(args);
        if (party.Ended) throw new Fail("PARTY_ENDED", "This watch party has ended.");
        var now = Now;
        TouchMember(party.Id, person.Id, now);
        return PartyView(party, now);
    }

    private object? LeaveParty(JsonElement args)
    {
        var person = RequirePerson(args);
        var party = RequireParty(args);
        if (PartyMember(party.Id, person.Id) is { } row) _partyMembers.Remove(row);
        if (party.HostId == person.Id && !party.Ended)
        {
            party.Ended = true;
            party.UpdatedAt = Now;
        }
        return null;
    }

    private object? UpdateParty(JsonElement args)
    {
        var person = RequirePerson(args);
        var party = RequireParty(args);
        if (party.HostId != person.Id) throw new Fail("NOT_HOST", "Only the host can control this watch party.");
        if (party.Ended) throw new Fail("PARTY_ENDED", "This watch party has ended.");
        var now = Now;
        party.Position = CleanPosition(N(args, "position"));
        party.Playing = args.GetProperty("playing").GetBoolean();
        party.Rate = CleanRate(N(args, "rate"));
        if (StringOrNull(args, "pageUrl") is { } url) party.PageUrl = RequireUrl(url, "pageUrl");
        party.UpdatedAt = now;
        TouchMember(party.Id, person.Id, now);
        return null;
    }

    private object? Heartbeat(JsonElement args)
    {
        var person = RequirePerson(args);
        var party = RequireParty(args);
        if (party.Ended) return null;
        var row = PartyMember(party.Id, person.Id) ?? throw new Fail("NOT_MEMBER", "Join the watch party first.");
        row.LastSeen = Now;
        return null;
    }

    private object? React(JsonElement args)
    {
        var person = RequirePerson(args);
        var party = RequireParty(args);
        if (party.Ended) throw new Fail("PARTY_ENDED", "This watch party has ended.");
        var row = PartyMember(party.Id, person.Id) ?? throw new Fail("NOT_MEMBER", "Join the watch party first.");
        var emoji = Cap(S(args, "emoji"), 8);
        if (emoji.Length == 0) throw new Fail("INVALID_ARGUMENT", "emoji must not be empty.");
        var now = Now;
        row.LastSeen = now;
        _reactions.Add(new ReactionRow(party.Id, person.Id, person.Name, emoji, now));
        var newest = _reactions.Where(r => r.PartyId == party.Id).Reverse().Take(70).ToList();
        foreach (var old in newest.Skip(20)) _reactions.Remove(old);
        return null;
    }

    private object? Say(JsonElement args)
    {
        var person = RequirePerson(args);
        var party = RequireParty(args);
        if (party.Ended) throw new Fail("PARTY_ENDED", "This watch party has ended.");
        var row = PartyMember(party.Id, person.Id);
        if (row is null && party.HostId != person.Id) throw new Fail("NOT_MEMBER", "Join the watch party first.");
        var text = Cap(S(args, "text"), 280);
        if (text.Length == 0) throw new Fail("INVALID_ARGUMENT", "Message must not be empty.");
        var now = Now;
        var recent = _messages.Count(m => m.PersonId == person.Id && m.At > now - 5_000);
        if (recent >= 5) throw new Fail("INVALID_ARGUMENT", "Slow down. At most 5 messages every 5 seconds.");
        _messages.Add(new MessageRow(party.Id, person.Id, person.Name, text, now));
        if (row is not null) row.LastSeen = now;
        else _partyMembers.Add(new MemberRow { PartyId = party.Id, PersonId = person.Id, JoinedAt = now, LastSeen = now, Order = ++_nextId });
        return null;
    }

    // challenges.ts
    private ChallengeRow? FindChallenge(string rawCode)
    {
        var code = NormalizeCode(rawCode);
        return code is null ? null : _challenges.SingleOrDefault(c => c.Code == code);
    }

    private ChallengeRow RequireChallenge(JsonElement args)
    {
        var raw = S(args, "code");
        return FindChallenge(raw) ?? throw new Fail("NOT_FOUND", $"No challenge with code {raw.Trim()}.");
    }

    private ChallengeMemberRow? ChallengeMember(string challengeId, string personId) =>
        _challengeMembers.SingleOrDefault(m => m.ChallengeId == challengeId && m.PersonId == personId);

    private static int ByProgress(ChallengeMemberRow a, ChallengeMemberRow b)
    {
        if (a.Fraction != b.Fraction) return b.Fraction.CompareTo(a.Fraction);
        if ((a.FinishedAt is null) != (b.FinishedAt is null)) return a.FinishedAt is null ? 1 : -1;
        return (a.FinishedAt ?? a.ProgressAt).CompareTo(b.FinishedAt ?? b.ProgressAt);
    }

    private List<ChallengeMemberRow> SortedMembers(string challengeId)
    {
        var rows = _challengeMembers.Where(m => m.ChallengeId == challengeId).Take(500).ToList();
        // Stable, as JavaScript's sort is.
        return [.. rows.Select((row, index) => (row, index)).OrderBy(x => x, Comparer<(ChallengeMemberRow row, int index)>.Create((x, y) =>
        {
            var c = ByProgress(x.row, y.row);
            return c != 0 ? c : x.index.CompareTo(y.index);
        })).Select(x => x.row)];
    }

    private Dictionary<string, object?> ChallengeView(ChallengeRow challenge) => new()
    {
        ["code"] = challenge.Code,
        ["title"] = challenge.Title,
        ["totalEpisodes"] = challenge.TotalEpisodes,
        ["createdAt"] = challenge.CreatedAt,
        ["creatorId"] = challenge.CreatorId,
        ["winnerId"] = challenge.WinnerId,
        ["winnerName"] = NameOf(challenge.WinnerId),
        ["now"] = Now,
        ["members"] = SortedMembers(challenge.Id).Select(m => (object?)new Dictionary<string, object?>
        {
            ["personId"] = m.PersonId, ["name"] = PeopleName(m.PersonId), ["fraction"] = m.Fraction, ["watchedEpisodes"] = m.WatchedEpisodes,
            ["label"] = m.Label, ["finishedAt"] = m.FinishedAt, ["updatedAt"] = m.UpdatedAt, ["pet"] = PeoplePet(m.PersonId),
        }).ToList(),
    };

    private static double CleanCount(double n) => Clamp(Math.Truncate(Finite(n, 0)), 0, 100_000);

    private object? CreateChallenge(JsonElement args)
    {
        var person = RequirePerson(args);
        var now = Now;
        var code = FreshCode();
        var challenge = new ChallengeRow
        {
            Id = NewId("challenges"), Code = code, CreatorId = person.Id, Title = CleanTitleCard(args.GetProperty("title")),
            TotalEpisodes = CleanCount(N(args, "totalEpisodes")), CreatedAt = now,
        };
        _challenges.Add(challenge);
        _challengeMembers.Add(new ChallengeMemberRow
        {
            ChallengeId = challenge.Id, PersonId = person.Id, UpdatedAt = now, ProgressAt = now, JoinedAt = now,
        });
        ClaimCode(code, "challenge", challenge.Id);
        return new Dictionary<string, object?> { ["code"] = code };
    }

    private object? JoinChallenge(JsonElement args)
    {
        var person = RequirePerson(args);
        var challenge = RequireChallenge(args);
        if (ChallengeMember(challenge.Id, person.Id) is null)
        {
            var now = Now;
            _challengeMembers.Add(new ChallengeMemberRow
            {
                ChallengeId = challenge.Id, PersonId = person.Id, UpdatedAt = now, ProgressAt = now, JoinedAt = now,
            });
        }
        return ChallengeView(challenge);
    }

    private object? LeaveChallenge(JsonElement args)
    {
        var person = RequirePerson(args);
        var challenge = RequireChallenge(args);
        if (ChallengeMember(challenge.Id, person.Id) is { } row) _challengeMembers.Remove(row);
        return null;
    }

    private object? Report(JsonElement args)
    {
        var person = RequirePerson(args);
        var challenge = RequireChallenge(args);
        var now = Now;
        var row = ChallengeMember(challenge.Id, person.Id);
        // Finishing is sticky.
        var finishedAt = row?.FinishedAt ?? (args.GetProperty("finished").GetBoolean() ? now : null);
        var fraction = finishedAt is not null ? 1 : Clamp(Finite(N(args, "fraction"), 0), 0, 1);
        if (row is null)
        {
            row = new ChallengeMemberRow { ChallengeId = challenge.Id, PersonId = person.Id, ProgressAt = now, JoinedAt = now };
            _challengeMembers.Add(row);
        }
        else if (row.Fraction != fraction)
        {
            row.ProgressAt = now;
        }
        row.Fraction = fraction;
        row.WatchedEpisodes = CleanCount(N(args, "watchedEpisodes"));
        row.Label = Cap(S(args, "label"), 200);
        row.FinishedAt = finishedAt;
        row.UpdatedAt = now;
        if (finishedAt is not null && challenge.WinnerId is null)
        {
            challenge.WinnerId = person.Id;
            challenge.FinishedAt = finishedAt;
        }
        return null;
    }

    private object? Mine(JsonElement args)
    {
        var person = RequirePerson(args);
        return _challengeMembers.Where(m => m.PersonId == person.Id).Take(200).ToList()
            .Select(mine =>
            {
                var challenge = _challenges.FirstOrDefault(c => c.Id == mine.ChallengeId);
                if (challenge is null) return null;
                var rows = SortedMembers(challenge.Id);
                var leader = rows.FirstOrDefault() ?? mine;
                return new
                {
                    challenge.CreatedAt,
                    Item = new Dictionary<string, object?>
                    {
                        ["code"] = challenge.Code,
                        ["title"] = challenge.Title,
                        ["totalEpisodes"] = challenge.TotalEpisodes,
                        ["winnerName"] = NameOf(challenge.WinnerId),
                        ["memberCount"] = rows.Count,
                        ["myFraction"] = mine.Fraction,
                        ["leaderName"] = NameOf(leader.PersonId) ?? "",
                        ["leaderFraction"] = leader.Fraction,
                    },
                };
            })
            .Where(x => x is not null)
            .OrderByDescending(x => x!.CreatedAt)
            .Select(x => (object?)x!.Item)
            .ToList();
    }

    // library.ts
    private static readonly string[] LibraryStatuses = ["none", "backlog", "watching", "watched"];

    /// <summary>A field as sent: left out (keep), null (clear), or a value.</summary>
    private readonly record struct In<T>(bool Sent, T Value);

    private static In<double?> InNumber(JsonElement o, string key) =>
        o.TryGetProperty(key, out var v) ? new(true, v.ValueKind == JsonValueKind.Number ? v.GetDouble() : null) : default;

    private static In<string?> InString(JsonElement o, string key) =>
        o.TryGetProperty(key, out var v) ? new(true, v.ValueKind == JsonValueKind.String ? v.GetString() : null) : default;

    private static In<double?> Time(In<double?> n, string what, double now, bool clampToNow)
    {
        if (n.Value is not double ms) return n;
        if (!double.IsFinite(ms) || ms < 0) throw new Fail("INVALID_ARGUMENT", $"{what} must be a time in milliseconds.");
        ms = Math.Truncate(ms);
        return new(true, clampToNow ? Math.Min(ms, now) : ms);
    }

    private static T MergeField<T>(In<T> incoming, T stored) => incoming.Sent ? incoming.Value : stored;

    private static bool NewerOrSame(double? incomingAt, double? storedAt) =>
        (incomingAt ?? double.NegativeInfinity) >= (storedAt ?? double.NegativeInfinity);

    private object? PutLibrary(JsonElement args)
    {
        var person = RequirePerson(args);
        var raw = args.GetProperty("items");
        if (raw.GetArrayLength() > 200) throw new Fail("INVALID_ARGUMENT", $"At most 200 items per call (got {raw.GetArrayLength()}).");
        var now = Now;
        var items = raw.EnumerateArray().Select((item, i) =>
        {
            var at = $"items[{i}]";
            var key = S(item, "key").Trim();
            if (key.Length == 0 || key.EnumerateRunes().Count() > 160) throw new Fail("INVALID_ARGUMENT", $"{at}.key must be 1 to 160 characters.");
            var name = Cap(S(item, "name"), 200);
            if (name.Length == 0) throw new Fail("INVALID_ARGUMENT", $"{at}.name must not be empty.");
            var year = InNumber(item, "year");
            if (year.Value is double y) year = new(true, Math.Truncate(y));
            var kind = InString(item, "kind");
            if (kind.Value is { } k)
            {
                k = k.Trim();
                if (k.EnumerateRunes().Count() > 16) throw new Fail("INVALID_ARGUMENT", $"{at}.kind must be at most 16 characters.");
                kind = new(true, k.Length == 0 ? null : k);
            }
            var rating = InNumber(item, "rating");
            if (rating.Value is double r && !(r == Math.Floor(r) && r >= 1 && r <= 20))
            {
                throw new Fail("INVALID_ARGUMENT", $"{at}.rating must be a whole number from 1 to 20 (half-star steps), or null.");
            }
            var status = InString(item, "status");
            if (status.Value is { } s && !LibraryStatuses.Contains(s))
            {
                throw new Fail("INVALID_ARGUMENT", $"{at}.status must be one of none, backlog, watching, watched, or null.");
            }
            return (key, name, year, kind, rating, ratedAt: Time(InNumber(item, "ratedAt"), $"{at}.ratedAt", now, true), status,
                statusAt: Time(InNumber(item, "statusAt"), $"{at}.statusAt", now, true),
                finishedAt: Time(InNumber(item, "finishedAt"), $"{at}.finishedAt", now, false));
        }).ToList();

        foreach (var item in items)
        {
            var row = _library.SingleOrDefault(r => r.PersonId == person.Id && r.Fields.Key == item.key);
            var s = row?.Fields;
            var fields = new LibraryFields
            {
                Key = item.key,
                Name = item.name,
                Year = MergeField(item.year, s?.Year),
                Kind = MergeField(item.kind, s?.Kind),
                FinishedAt = MergeField(item.finishedAt, s?.FinishedAt),
                Rating = s?.Rating,
                RatedAt = s?.RatedAt,
                Status = s?.Status,
                StatusAt = s?.StatusAt,
            };
            if (item.rating.Sent && NewerOrSame(item.ratedAt.Value, s?.RatedAt))
            {
                fields = fields with { Rating = item.rating.Value, RatedAt = item.ratedAt.Value };
            }
            if (item.status.Sent && NewerOrSame(item.statusAt.Value, s?.StatusAt))
            {
                fields = fields with { Status = item.status.Value, StatusAt = item.statusAt.Value };
            }
            if (row is null) _library.Add(new LibraryRow { PersonId = person.Id, Fields = fields, UpdatedAt = now });
            else if (row.Fields != fields)
            {
                row.Fields = fields;
                row.UpdatedAt = now;
            }
        }
        return new Dictionary<string, object?> { ["saved"] = items.Count };
    }

    private object? AllLibrary(JsonElement args)
    {
        var person = RequirePerson(args);
        return _library.Where(r => r.PersonId == person.Id).OrderBy(r => r.Fields.Key, StringComparer.Ordinal)
            .Select(r => (object?)new Dictionary<string, object?>
            {
                ["key"] = r.Fields.Key,
                ["name"] = r.Fields.Name,
                ["year"] = r.Fields.Year,
                ["kind"] = r.Fields.Kind,
                ["rating"] = r.Fields.Rating,
                ["ratedAt"] = r.Fields.RatedAt,
                ["status"] = r.Fields.Status,
                ["statusAt"] = r.Fields.StatusAt,
                ["finishedAt"] = r.Fields.FinishedAt,
                ["updatedAt"] = r.UpdatedAt,
            }).ToList();
    }
}
