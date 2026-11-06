// Every call here ends within the client's own 12 s timeout, so no test cancellation token is passed.
#pragma warning disable xUnit1051

using Cineon.Core.Together;

namespace Cineon.Core.Tests.Together;

/// <summary>
/// Against the real dev deployment, only with <c>CINEON_TOGETHER_LIVE=1</c>. Never the production URL.
/// It leaves a throwaway person, a one-title share and an ended party behind on dev.
/// </summary>
public sealed class TogetherLiveTests
{
    [Fact]
    public async Task TheDevDeploymentAnswersLikeTheFake()
    {
        Assert.SkipUnless(Environment.GetEnvironmentVariable("CINEON_TOGETHER_LIVE") == "1", "Set CINEON_TOGETHER_LIVE=1 to talk to the dev deployment.");
        var url = new Uri(TogetherClient.DevelopmentUrl);
        Assert.DoesNotContain("admired-mouse", url.Host, StringComparison.Ordinal);
        var client = new TogetherClient(url);
        var secret = TogetherIdentity.NewSecret();
        Dictionary<string, object?> Args(params (string Key, object? Value)[] pairs) => pairs.ToDictionary(p => p.Key, p => p.Value);

        var me = await client.MutationAsync("people:register", Args(("deviceSecret", secret), ("name", "Cineon Windows test"), ("pet", "")),
            Registered.FromJson);
        Assert.False(string.IsNullOrEmpty(me.PersonId));

        var share = await client.MutationAsync("shares:create", Args(("deviceSecret", secret), ("label", "Live test"),
            ("titles", new List<object?> { new TitleCard("Heat", 1995, "film", "tt0113277").ToJson() })), CodeReply.FromJson);
        Assert.Equal("share", (await client.QueryAsync("codes:resolve", Args(("code", ShareCode.Display(share.Code))), CodeKind.FromJsonOrNull))!.Kind);
        var shared = await client.QueryAsync("shares:get", Args(("code", share.Code)), ShareInfo.FromJsonOrNull);
        Assert.Equal(1995, Assert.Single(shared!.Titles).Year);
        Assert.Equal("Cineon Windows test", shared.OwnerName);

        var party = await client.MutationAsync("parties:create", Args(("deviceSecret", secret), ("pageUrl", "https://example.com/film"),
            ("position", 12.5), ("playing", true), ("rate", 1.0)), CodeReply.FromJson);
        var state = await client.QueryAsync("parties:get", Args(("code", party.Code), ("t", JsonArgs.Milliseconds(DateTimeOffset.UtcNow))),
            PartyState.FromJsonOrNull);
        Assert.Equal(me.PersonId, state!.HostId);
        Assert.True(state.ExpectedPosition >= 12.5);
        await client.MutationAsync("parties:say", Args(("deviceSecret", secret), ("code", party.Code), ("text", "hello")));
        await client.MutationAsync("parties:leave", Args(("deviceSecret", secret), ("code", party.Code)));
        var ended = await Assert.ThrowsAsync<TogetherError>(() =>
            client.MutationAsync("parties:react", Args(("deviceSecret", secret), ("code", party.Code), ("emoji", "🎉"))));
        Assert.Equal(TogetherErrorCode.PartyEnded, ended.Code);

        var unknown = await Assert.ThrowsAsync<TogetherError>(() =>
            client.QueryAsync("challenges:mine", Args(("deviceSecret", TogetherIdentity.NewSecret())), ChallengeSummary.ListFromJson));
        Assert.Equal(TogetherErrorCode.UnknownDevice, unknown.Code);
    }
}
