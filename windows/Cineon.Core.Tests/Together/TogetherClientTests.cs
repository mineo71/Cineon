// Every call here ends within the client's own 12 s timeout, so no test cancellation token is passed.
#pragma warning disable xUnit1051

using System.Net;
using System.Text;
using System.Text.Json;
using Cineon.Core.Data;
using Cineon.Core.Together;

namespace Cineon.Core.Tests.Together;

public sealed class TogetherClientTests : IDisposable
{
    private readonly ManualClock _clock = new(new DateTimeOffset(2026, 11, 6, 20, 0, 0, TimeSpan.Zero));
    private readonly FakeConvex _server;
    private readonly TogetherClient _client;
    private const string Secret = "c2VjcmV0LXNlY3JldC1zZWNyZXQtc2VjcmV0LXNlY3I=";

    public TogetherClientTests()
    {
        _server = new FakeConvex(_clock);
        _client = new TogetherClient(new Uri("https://fake-deployment.convex.cloud/"), new HttpClient(_server));
    }

    public void Dispose() => _server.Dispose();

    private static Dictionary<string, object?> Args(params (string Key, object? Value)[] pairs) => pairs.ToDictionary(p => p.Key, p => p.Value);

    private Task<Registered> Register(string name = "Oleh", string secret = Secret) =>
        _client.MutationAsync("people:register", Args(("deviceSecret", secret), ("name", name), ("pet", "")), Registered.FromJson);

    // MARK: Codes and positions (ported from CineonTests/DownloadTests.swift)

    [Fact]
    public void CodesAreTypedAnyWay()
    {
        Assert.Equal("K7Q2MX", ShareCode.Normalize(" k7q-2mx "));
        Assert.Equal("K7Q-2MX", ShareCode.Display("k7q2mx"));
        Assert.Equal("K7Q2M", ShareCode.Display("k7q-2m"));
    }

    [Fact]
    public void PartyPositionMovesOnWhilePlaying()
    {
        var state = new PartyState
        {
            Code = "ABCDEF", Ended = false, HostId = "h", HostName = "Host", Title = null, PageUrl = "", Playing = true,
            Position = 100, Rate = 1.5, UpdatedAt = 1_000, Now = 5_000,
        };
        Assert.Equal(106, state.ExpectedPosition, 3);
        Assert.Equal(100, (state with { Playing = false }).ExpectedPosition, 3);
        // The server's clock running behind the last update never moves the film backwards.
        Assert.Equal(100, (state with { Now = 500 }).ExpectedPosition, 3);
    }

    // MARK: The HTTP API

    [Fact]
    public async Task CallsGoToConvexHttpApiAsJson()
    {
        var reply = await Register();
        Assert.StartsWith("people", reply.PersonId);
        Assert.Equal("Oleh", reply.Name);

        var resolved = await _client.QueryAsync("codes:resolve", Args(("code", "K7Q-2MX")), CodeKind.FromJsonOrNull);
        Assert.Null(resolved);

        var calls = _server.Calls;
        Assert.Equal("mutation", calls[0].Kind);
        Assert.Equal("https://fake-deployment.convex.cloud/api/mutation", calls[0].Url);
        Assert.Equal("query", calls[1].Kind);
        Assert.Equal("https://fake-deployment.convex.cloud/api/query", calls[1].Url);
        Assert.Equal("K7Q-2MX", calls[1].Args.GetProperty("code").GetString());
    }

    [Fact]
    public void EndpointKeepsOneSlashWhateverTheBase()
    {
        Assert.Equal("https://x.convex.cloud/api/query", new TogetherClient(new Uri("https://x.convex.cloud")).Endpoint("query").OriginalString);
        Assert.Equal("https://x.convex.cloud/api/query", new TogetherClient(new Uri("https://x.convex.cloud/")).Endpoint("query").OriginalString);
        Assert.Equal("http://localhost:3210/base/api/mutation", new TogetherClient(new Uri("http://localhost:3210/base")).Endpoint("mutation").OriginalString);
    }

    [Fact]
    public void ConfiguredPrefersTheEnvironmentAndWantsHttp()
    {
        Assert.Equal("https://env.example", TogetherClient.Configured("https://env.example", TogetherClient.DevelopmentUrl, null)!.BaseUrl.OriginalString);
        Assert.Equal(TogetherClient.DevelopmentUrl, TogetherClient.Configured(null, TogetherClient.DevelopmentUrl, null)!.BaseUrl.OriginalString);
        // Set but empty switches Together off, as on the Mac.
        Assert.Null(TogetherClient.Configured("", TogetherClient.DevelopmentUrl, null));
        Assert.Null(TogetherClient.Configured(null, null, null));
        Assert.Null(TogetherClient.Configured("ftp://example.com", null, null));
        Assert.Null(TogetherClient.Configured("not a url", null, null));
        Assert.Equal("http://localhost:3210", TogetherClient.Configured("http://localhost:3210", null, null)!.BaseUrl.OriginalString);
    }

    [Fact]
    public async Task NumbersComeBackAsFloats()
    {
        await Register();
        var created = await _client.MutationAsync("shares:create", Args(("deviceSecret", Secret), ("label", "One"),
            ("titles", new List<object?> { new TitleCard("Heat", 1995, "film", "tt0113277") { Rating = 17, Status = "watched" }.ToJson() })),
            CodeReply.FromJson);
        // The raw reply has 1995.0; the card reads it as a whole number.
        var raw = await _client.QueryRawAsync("shares:get", Args(("code", created.Code)));
        Assert.Contains("1995.0", raw.GetRawText());
        var share = await _client.QueryAsync("shares:get", Args(("code", created.Code)), ShareInfo.FromJsonOrNull);
        var card = Assert.Single(share!.Titles);
        Assert.Equal(1995, card.Year);
        Assert.Equal(17, card.Rating);
        Assert.Equal(TitleKind.Film, card.TitleKind);
        Assert.Equal("Oleh", share.OwnerName);
        Assert.Equal("One", share.Label);
    }

    [Theory]
    [InlineData("INVALID_ARGUMENT", TogetherErrorCode.InvalidArgument)]
    [InlineData("UNKNOWN_DEVICE", TogetherErrorCode.UnknownDevice)]
    [InlineData("NOT_FOUND", TogetherErrorCode.NotFound)]
    [InlineData("NOT_MEMBER", TogetherErrorCode.NotMember)]
    [InlineData("NOT_HOST", TogetherErrorCode.NotHost)]
    [InlineData("PARTY_ENDED", TogetherErrorCode.PartyEnded)]
    [InlineData("SOMETHING_NEW", TogetherErrorCode.None)]
    public void ErrorCodesMap(string raw, TogetherErrorCode code)
    {
        Assert.Equal(code, TogetherErrorCode.FromRaw(raw));
        if (code != TogetherErrorCode.None) Assert.Equal(raw, code.ToRaw());
    }

    [Fact]
    public async Task ServerErrorsCarryTheirSentenceAndCode()
    {
        var unknown = await Assert.ThrowsAsync<TogetherError>(() =>
            _client.QueryAsync("challenges:mine", Args(("deviceSecret", Secret)), ChallengeSummary.ListFromJson));
        Assert.Equal("Unknown device. Call people:register first.", unknown.Message);
        Assert.Equal(TogetherErrorCode.UnknownDevice, unknown.Code);
        Assert.Equal("UNKNOWN_DEVICE", unknown.RawCode);

        var invalid = await Assert.ThrowsAsync<TogetherError>(() => Register(secret: "short"));
        Assert.Equal("deviceSecret must be 16 to 256 characters (32 random bytes, base64).", invalid.Message);
        Assert.Equal(TogetherErrorCode.InvalidArgument, invalid.Code);

        await Register();
        var missing = await Assert.ThrowsAsync<TogetherError>(() =>
            _client.MutationAsync("parties:join", Args(("deviceSecret", Secret), ("code", "abc-def")), PartyState.FromJson));
        Assert.Equal(TogetherErrorCode.NotFound, missing.Code);
        Assert.Equal("No watch party with code abc-def.", missing.Message);
        Assert.False(missing.IsTransport);
    }

    [Fact]
    public async Task ErrorsWithoutDataKeepTheSentenceForPeople()
    {
        // Convex's own text around a plain `throw new Error(...)`.
        _server.Intercept = _ => """{"status":"error","errorMessage":"[Request ID: 1] Server Error\nUncaught Error: Could not allocate a unique code.\n    at freshCode (../convex/lib.ts:1:0)\n"}""";
        var thrown = await Assert.ThrowsAsync<TogetherError>(() => _client.QueryRawAsync("codes:resolve", Args(("code", "x"))));
        Assert.Equal("Could not allocate a unique code.", thrown.Message);
        Assert.Equal(TogetherErrorCode.None, thrown.Code);

        // Anything else: its first line.
        _server.Intercept = null;
        var unknownFunction = await Assert.ThrowsAsync<TogetherError>(() => _client.QueryRawAsync("nope:nope", Args()));
        Assert.Equal("[Request ID: fake] Server Error", unknownFunction.Message);

        // A query sent as a mutation, and arguments the validator refuses.
        var wrongKind = await Assert.ThrowsAsync<TogetherError>(() => _client.MutationAsync("codes:resolve", Args(("code", "x"))));
        Assert.Equal("[Request ID: fake] Server Error", wrongKind.Message);
        var extra = await Assert.ThrowsAsync<TogetherError>(() => _client.QueryRawAsync("codes:resolve", Args(("code", "x"), ("t", 1.0))));
        Assert.Equal("[Request ID: fake] Server Error", extra.Message);
    }

    [Theory]
    [InlineData("Uncaught Error: Boom\n    at x", "Boom")]
    [InlineData("prefix Uncaught Error: Boom    at handler (x.ts:1)", "Boom")]
    [InlineData("Uncaught Error: \nSecond line", "Second line")]
    [InlineData("\nFirst real line\nsecond", "First real line")]
    [InlineData("Plain", "Plain")]
    [InlineData("", "")]
    public void CleanKeepsOneSentence(string raw, string clean) => Assert.Equal(clean, TogetherClient.Clean(raw));

    [Fact]
    public void CleanWithNothingSaysTheServerDidNotAnswer() =>
        Assert.Equal("The Together server didn't answer", TogetherClient.Clean(null));

    [Fact]
    public async Task OddRepliesAreErrorsPeopleCanRead()
    {
        _server.Intercept = _ => "[1,2]";
        Assert.Equal("The Together server sent something unexpected",
            (await Assert.ThrowsAsync<TogetherError>(() => _client.QueryRawAsync("codes:resolve", Args(("code", "x"))))).Message);

        _server.Intercept = _ => "<html>";
        Assert.Equal("The Together server sent something unexpected",
            (await Assert.ThrowsAsync<TogetherError>(() => _client.QueryRawAsync("codes:resolve", Args(("code", "x"))))).Message);

        _server.Intercept = _ => """{"status":"error"}""";
        Assert.Equal("The Together server didn't answer",
            (await Assert.ThrowsAsync<TogetherError>(() => _client.QueryRawAsync("codes:resolve", Args(("code", "x"))))).Message);

        // A value of the wrong shape: Swift's DecodingError text.
        _server.Intercept = _ => """{"status":"success","value":{"code":5}}""";
        var bad = await Assert.ThrowsAsync<TogetherError>(() => _client.MutationAsync("shares:create", Args(), CodeReply.FromJson));
        Assert.Equal("The data couldn't be read because it isn't in the correct format.", bad.Message);
        Assert.IsType<JsonException>(bad.InnerException);

        _server.Intercept = null;
        _server.Offline = true;
        var offline = await Assert.ThrowsAsync<TogetherError>(() => _client.QueryRawAsync("codes:resolve", Args(("code", "x"))));
        Assert.True(offline.IsTransport);
        Assert.Equal("The Internet connection appears to be offline.", offline.Message);
    }

    [Fact]
    public async Task ASilentServerTimesOut()
    {
        var client = new TogetherClient(new Uri("https://x.convex.cloud"), new HttpClient(new SilentHandler()))
        {
            RequestTimeout = TimeSpan.FromMilliseconds(50),
        };
        var thrown = await Assert.ThrowsAsync<TogetherError>(() => client.QueryRawAsync("codes:resolve", Args(("code", "x"))));
        Assert.Equal("The request timed out.", thrown.Message);
        Assert.True(thrown.IsTransport);

        // Cancelling isn't a timeout: it stays a cancellation.
        var patient = new TogetherClient(new Uri("https://x.convex.cloud"), new HttpClient(new SilentHandler()));
        using var cancel = new CancellationTokenSource();
        var call = patient.QueryRawAsync("codes:resolve", Args(("code", "x")), cancel.Token);
        await cancel.CancelAsync();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => call);
    }

    private sealed class SilentHandler : HttpMessageHandler
    {
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            await Task.Delay(Timeout.Infinite, cancellationToken);
            throw new InvalidOperationException("unreachable");
        }
    }

    [Fact]
    public async Task StatusLineDoesNotMatterOnlyTheBody()
    {
        var handler = new CannedHandler(HttpStatusCode.BadRequest, """{"status":"success","value":{"kind":"party"}}""");
        var client = new TogetherClient(new Uri("https://x.convex.cloud"), new HttpClient(handler));
        Assert.Equal("party", (await client.QueryAsync("codes:resolve", Args(("code", "x")), CodeKind.FromJsonOrNull))!.Kind);
    }

    [Fact]
    public async Task ArgumentsAreWrittenAsTheMacWritesThem()
    {
        var handler = new CannedHandler(HttpStatusCode.OK, """{"status":"success","value":null}""");
        var client = new TogetherClient(new Uri("https://x.convex.cloud"), new HttpClient(handler));
        await client.MutationAsync("library:put", Args(("deviceSecret", "a+b/c="), ("items", new List<object?>
        {
            new Dictionary<string, object?> { ["rating"] = null, ["year"] = 1995, ["ratedAt"] = 1762459200123.0, ["position"] = 12.5 },
        })));
        Assert.Equal(
            """{"path":"library:put","args":{"deviceSecret":"a+b/c=","items":[{"rating":null,"year":1995,"ratedAt":1762459200123,"position":12.5}]},"format":"json"}""",
            handler.LastBody);
        Assert.Equal("application/json", handler.LastContentType);
    }

    [Fact]
    public void PartyStateReadsOlderServersAndMissingPieces()
    {
        // Before chat and pets: no messages, no hostPet.
        using var old = JsonDocument.Parse("""
            {"code":"ABCDEF","ended":false,"hostId":"h","hostName":"Ann","title":null,"pageUrl":"https://example.com/film",
             "playing":true,"position":12.0,"rate":1.0,"updatedAt":1000.0,"now":2000.0,
             "members":[{"personId":"h","name":"Ann","lastSeen":1000.0}],"reactions":[]}
            """);
        var state = PartyState.FromJson(old.RootElement);
        Assert.Empty(state.Messages);
        Assert.Null(state.HostPet);
        Assert.Null(state.Title);
        Assert.Null(Assert.Single(state.Members).Pet);

        // A required field missing fails, as Swift's decoder does.
        using var broken = JsonDocument.Parse("""{"code":"ABCDEF","ended":false}""");
        Assert.Throws<JsonException>(() => PartyState.FromJson(broken.RootElement));

        // Fields the Mac reads with `try?` fall back instead of failing.
        using var odd = JsonDocument.Parse("""{"name":"Heat","year":"1995","kind":7,"rating":"x"}""");
        var card = TitleCard.FromJson(odd.RootElement);
        Assert.Null(card.Year);
        Assert.Equal("unknown", card.Kind);
        Assert.Null(card.Rating);
    }

    [Fact]
    public void TitleCardsGoOutWithoutEmptyFields()
    {
        var title = new Title
        {
            Id = 1, Name = "Heat", NormName = "heat", Year = 1995, Kind = TitleKind.Film, Status = TitleStatus.None,
            PosterUrl = new Uri("https://img.example/heat%20poster.jpg"), RatingHalves = 15,
        };
        var json = TitleCard.From(title).ToJson();
        Assert.Equal(["name", "kind", "year", "posterUrl", "rating"], json.Keys);
        Assert.Equal("https://img.example/heat%20poster.jpg", json["posterUrl"]);
        Assert.Equal("watched", TitleCard.From(title with { Status = TitleStatus.Watched }).ToJson()["status"]);
    }

    private sealed class CannedHandler(HttpStatusCode status, string body) : HttpMessageHandler
    {
        public string? LastBody { get; private set; }
        public string? LastContentType { get; private set; }

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            LastBody = await request.Content!.ReadAsStringAsync(cancellationToken);
            LastContentType = request.Content.Headers.ContentType?.MediaType;
            return new HttpResponseMessage(status) { Content = new StringContent(body, Encoding.UTF8, "application/json") };
        }
    }
}
