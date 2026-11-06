using System.Text;
using System.Text.Json;
using Cineon.Core.Data;
using Cineon.Core.Tests.Data;
using Cineon.Core.Together;

namespace Cineon.Core.Tests.Together;

public sealed class TogetherIdentityTests : IDisposable
{
    private readonly TempFolder _folder = new();

    public void Dispose() => _folder.Dispose();

    /// <summary>What Swift's JSONEncoder writes for TogetherIdentity: slashes escaped, keys in any order.</summary>
    private const string MacFile =
        """{"pet":"p1-Ab3_x9","openedShares":["K7Q2MX","ABCDEF"],"personId":"jd7f2k9q1x8w3m4n5b6v7c8x9z0a1s2d","name":"Oleh","secret":"q8Hk2v\/9+Zr1tYpQe3LmN0aBcDeFgHiJkLmNoPqRsTu="}""";

    [Fact]
    public void ANewProfileGetsASecretAndKeepsIt()
    {
        var file = _folder.File("together.json");
        var created = TogetherIdentity.Load(file, "Oleh");
        Assert.Equal(44, created.Secret.Length);
        Assert.Equal(32, Convert.FromBase64String(created.Secret).Length);
        Assert.True(TogetherIdentity.IsStrictBase64(created.Secret));
        Assert.Equal("Oleh", created.Name);
        Assert.Null(created.PersonId);
        Assert.True(File.Exists(file));

        var again = TogetherIdentity.Load(file, "Someone else");
        Assert.Equal(created.Secret, again.Secret);
        Assert.Equal("Oleh", again.Name);
        Assert.NotEqual(created.Secret, TogetherIdentity.Load(_folder.File("other.json"), "Oleh").Secret);
    }

    [Fact]
    public void EverythingRoundTrips()
    {
        var file = _folder.File("together.json");
        var identity = TogetherIdentity.Load(file, "Oleh");
        identity.PersonId = "people0001";
        identity.OpenedShares = ["K7Q2MX", "ABCDEF"];
        identity.PartyCode = "PARTY2";
        identity.Pet = "p1-Ab3_x9";
        identity.Save(file);

        var loaded = TogetherIdentity.Load(file, "ignored");
        Assert.Equal(identity.Secret, loaded.Secret);
        Assert.Equal("people0001", loaded.PersonId);
        Assert.Equal(["K7Q2MX", "ABCDEF"], loaded.OpenedShares);
        Assert.Equal("PARTY2", loaded.PartyCode);
        Assert.Equal("p1-Ab3_x9", loaded.Pet);
        // No temporary files left behind by the atomic write.
        Assert.Single(Directory.GetFiles(_folder.Path));
    }

    [Fact]
    public void AFileFromAMacLoads()
    {
        var file = _folder.File("together.json");
        File.WriteAllText(file, MacFile);
        var identity = TogetherIdentity.Load(file, "Someone else");
        Assert.Equal("q8Hk2v/9+Zr1tYpQe3LmN0aBcDeFgHiJkLmNoPqRsTu=", identity.Secret);
        Assert.Equal("Oleh", identity.Name);
        Assert.Equal("jd7f2k9q1x8w3m4n5b6v7c8x9z0a1s2d", identity.PersonId);
        Assert.Equal(["K7Q2MX", "ABCDEF"], identity.OpenedShares);
        Assert.Null(identity.PartyCode);
        Assert.Equal("p1-Ab3_x9", identity.Pet);
        // Loading doesn't rewrite it.
        Assert.Equal(MacFile, File.ReadAllText(file));
    }

    [Fact]
    public void WhatWindowsWritesIsWhatTheMacReads()
    {
        var identity = new TogetherIdentity { Secret = "a+b/c=", Name = "Оля", OpenedShares = [] };
        var json = Encoding.UTF8.GetString(identity.Encode());
        // Absent optionals are left out; openedShares is always there, since Swift's decoder requires it.
        Assert.Equal("""{"secret":"a+b/c=","name":"Оля","openedShares":[]}""", json);
        using var document = JsonDocument.Parse(json);
        Assert.False(document.RootElement.TryGetProperty("personId", out _));
    }

    [Fact]
    public void AMissingShareListIsForgivenButAMissingSecretIsNot()
    {
        var file = _folder.File("together.json");
        File.WriteAllText(file, """{"secret":"q8Hk2v\/9+Zr1tYpQe3LmN0aBcDeFgHiJkLmNoPqRsTu=","name":"Oleh"}""");
        Assert.Equal("q8Hk2v/9+Zr1tYpQe3LmN0aBcDeFgHiJkLmNoPqRsTu=", TogetherIdentity.Load(file, "x").Secret);

        // Like the Mac, a file that can't be read is replaced with a new identity.
        File.WriteAllText(file, """{"name":"Oleh"}""");
        var replaced = TogetherIdentity.Load(file, "Oleh");
        Assert.Equal(44, replaced.Secret.Length);
        Assert.Equal(replaced.Secret, TogetherIdentity.Load(file, "Oleh").Secret);

        File.WriteAllText(file, "not json");
        Assert.Equal(44, TogetherIdentity.Load(file, "Oleh").Secret.Length);
    }

    [Fact]
    public void TheFileLivesInTheProfileFolder()
    {
        var id = Guid.Parse("2F1E6C3A-4B5D-4E6F-8A9B-0C1D2E3F4A5B");
        var file = TogetherIdentity.FileFor(id);
        Assert.Equal(Path.Combine(AppPaths.Root, "Profiles", "2F1E6C3A-4B5D-4E6F-8A9B-0C1D2E3F4A5B", "together.json"), file);
        File.WriteAllText(file, MacFile);
        var identity = TogetherIdentity.Load(new Cineon.Core.Data.Profile { Id = id, Name = "Oleh" });
        Assert.Equal("jd7f2k9q1x8w3m4n5b6v7c8x9z0a1s2d", identity.PersonId);
    }

    [Theory]
    [InlineData("q8Hk2v/9+Zr1tYpQe3LmN0aBcDeFgHiJkLmNoPqRsTu=", true)]
    [InlineData("q8Hk2v/9+Zr1tYpQe3LmN0aBcDeFgHiJkLmNoPqRsTuv", true)]
    [InlineData("q8Hk2v/9+Zr1tYpQe3LmN0aBcDeFgHiJkLmNoPqRsT==", true)]
    [InlineData("q8Hk2v/9+Zr1tYpQe3LmN0aBcDeFgHiJkLmNoPqRsTu", false)]
    [InlineData("q8Hk2v/9+Zr1tYpQe3LmN0aBcDe gHiJkLmNoPqRsTu=", false)]
    [InlineData("q8Hk2v_9-Zr1tYpQe3LmN0aBcDeFgHiJkLmNoPqRsTu=", false)]
    [InlineData("q8Hk2v/9+Zr1tYpQe3LmN0aBcDeFgHiJkLmNoPqR=sTu", false)]
    public void RecoveryCodesMustBeStrictBase64(string code, bool valid) => Assert.Equal(valid, TogetherIdentity.IsStrictBase64(code));
}
