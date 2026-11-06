using System.Text;
using System.Text.Json;
using Cineon.Core.Data;

namespace Cineon.Core.Tests.Data;

public sealed class ProfileStoreTests : IDisposable
{
    private readonly TempFolder _folder = new();

    public void Dispose() => _folder.Dispose();

    // The shape the Mac writes: dates in seconds since 2001, escaped slashes, absent optionals left out.
    private const string MacProfiles = """
        {"askOnLaunch":true,"lastUsedID":"8415E693-96B8-40B2-9390-CDB1317C6598","profiles":[{"id":"190B6F43-16F2-4EE1-8E5C-7DDF3D54AB0D","createdAt":815607320.735974,"name":"Guest","lastPosterURL":"https:\/\/m.media-amazon.com\/images\/M\/MV5BMTQ5OTgzOTczM15BMl5BanBnXkFtZTcwMDM2OTY4MQ@@._V1_QL75_UX500_.jpg"},{"id":"8415E693-96B8-40B2-9390-CDB1317C6598","createdAt":815607454.151418,"name":"Кіно"}]}
        """;

    [Fact]
    public void FirstRunMakesOneProfile()
    {
        var store = new ProfileStore(_folder.Path);
        var only = Assert.Single(store.Profiles);
        Assert.Equal(only.Id, store.LastUsedId);
        Assert.False(store.AskOnLaunch);
        Assert.False(string.IsNullOrEmpty(only.Name));
        Assert.True(char.IsUpper(only.Name[0]) || !char.IsLetter(only.Name[0]));
        Assert.True(File.Exists(store.FilePath));

        var again = new ProfileStore(_folder.Path);
        Assert.Equal(only, Assert.Single(again.Profiles) with { CreatedAt = only.CreatedAt });
        Assert.True(Math.Abs((again.Profiles[0].CreatedAt - only.CreatedAt).TotalMilliseconds) < 1);
    }

    [Fact]
    public void ReadsTheMacsProfilesFile()
    {
        File.WriteAllText(Path.Combine(_folder.Path, "profiles.json"), MacProfiles);
        var store = new ProfileStore(_folder.Path);
        Assert.Equal(2, store.Profiles.Count);
        Assert.True(store.AskOnLaunch);
        Assert.Equal(Guid.Parse("8415E693-96B8-40B2-9390-CDB1317C6598"), store.LastUsedId);
        Assert.Equal("Кіно", store.LastUsed.Name);
        var guest = store.Profiles[0];
        Assert.Equal("Guest", guest.Name);
        Assert.Equal(815607320.735974, StoredDate.ToReference(guest.CreatedAt));
        Assert.Equal(new DateTimeOffset(2026, 11, 5, 21, 35, 20, TimeSpan.Zero), guest.CreatedAt.AddTicks(-(guest.CreatedAt.UtcTicks % TimeSpan.TicksPerSecond)));
        Assert.Equal("https://m.media-amazon.com/images/M/MV5BMTQ5OTgzOTczM15BMl5BanBnXkFtZTcwMDM2OTY4MQ@@._V1_QL75_UX500_.jpg", guest.LastPosterUrl?.OriginalString);
        Assert.Null(store.Profiles[1].LastPosterUrl);
    }

    [Fact]
    public void WritesTheMacsShape()
    {
        File.WriteAllText(Path.Combine(_folder.Path, "profiles.json"), MacProfiles);
        var store = new ProfileStore(_folder.Path);
        store.MarkUsed(store.Profiles[0].Id);

        using var document = JsonDocument.Parse(File.ReadAllBytes(store.FilePath));
        var root = document.RootElement;
        Assert.Equal(["profiles", "lastUsedID", "askOnLaunch"], root.EnumerateObject().Select(p => p.Name));
        Assert.Equal("190B6F43-16F2-4EE1-8E5C-7DDF3D54AB0D", root.GetProperty("lastUsedID").GetString());
        Assert.True(root.GetProperty("askOnLaunch").GetBoolean());
        var guest = root.GetProperty("profiles")[0];
        Assert.Equal(["id", "name", "createdAt", "lastPosterURL"], guest.EnumerateObject().Select(p => p.Name));
        Assert.Equal("815607320.735974", guest.GetProperty("createdAt").GetRawText());
        var second = root.GetProperty("profiles")[1];
        Assert.False(second.TryGetProperty("lastPosterURL", out _));
        Assert.Equal("Кіно", second.GetProperty("name").GetString());

        // And the Mac's strict reading accepts what was written.
        Assert.NotNull(ProfileStore.Decode(File.ReadAllBytes(store.FilePath)));
    }

    [Fact]
    public void AddingASecondPersonAsksWhoIsWatching()
    {
        var store = new ProfileStore(_folder.Path);
        var first = store.Profiles[0];
        var guest = store.Add("Guest");
        Assert.True(store.AskOnLaunch);
        store.AskOnLaunch = false;
        store.Add("Third");
        Assert.False(store.AskOnLaunch);

        store.Rename(guest.Id, "Visitor");
        store.SetPoster(guest.Id, new Uri("https://img.example/p.jpg"));
        var reloaded = new ProfileStore(_folder.Path);
        Assert.Equal(["Visitor", "Third"], reloaded.Profiles.Skip(1).Select(p => p.Name));
        Assert.Equal("https://img.example/p.jpg", reloaded.Profiles[1].LastPosterUrl?.OriginalString);
        Assert.False(reloaded.AskOnLaunch);
        Assert.Equal(first.Id, reloaded.LastUsedId);
    }

    [Fact]
    public void DeletingRemovesTheFolderButNeverTheLastPerson()
    {
        var store = new ProfileStore(_folder.Path);
        var first = store.Profiles[0];
        var guest = store.Add("Guest");
        var folder = store.ProfileDirectory(guest.Id);
        Assert.Equal(Path.Combine(_folder.Path, "Profiles", guest.Id.ToString().ToUpperInvariant()), folder);
        File.WriteAllText(Path.Combine(folder, "cineon.sqlite"), "x");

        store.MarkUsed(guest.Id);
        store.Delete(guest.Id);
        Assert.False(Directory.Exists(folder));
        Assert.Equal(first.Id, store.LastUsedId);
        store.Delete(first.Id);
        Assert.Single(store.Profiles);
    }

    [Theory]
    [InlineData("")]
    [InlineData("{}")]
    [InlineData("""{"profiles":[],"askOnLaunch":false}""")]
    [InlineData("""{"profiles":[{"id":"nope","name":"A","createdAt":1}],"askOnLaunch":false}""")]
    [InlineData("""{"profiles":[{"id":"190B6F43-16F2-4EE1-8E5C-7DDF3D54AB0D","name":"A","createdAt":1}]}""")]
    public void AnUnreadableFileStartsOver(string json)
    {
        File.WriteAllText(Path.Combine(_folder.Path, "profiles.json"), json);
        var store = new ProfileStore(_folder.Path);
        var only = Assert.Single(store.Profiles);
        Assert.NotEqual("A", only.Name);
    }

    [Fact]
    public void DecodeIsAsStrictAsSwift()
    {
        Assert.NotNull(ProfileStore.Decode(Encoding.UTF8.GetBytes(
            """{"profiles":[{"id":"190b6f43-16f2-4ee1-8e5c-7ddf3d54ab0d","name":"A","createdAt":1}],"askOnLaunch":false}""")));
        Assert.Null(ProfileStore.Decode(Encoding.UTF8.GetBytes(
            """{"profiles":[{"id":"190B6F43-16F2-4EE1-8E5C-7DDF3D54AB0D","name":"A","createdAt":"1"}],"askOnLaunch":false}""")));
    }
}

public sealed class AppPathsTests
{
    [Fact]
    public void TestRunsNeverTouchRealData()
    {
        Assert.True(AppPaths.IsTestRun);
        Assert.True(AppPaths.IsScratch);
        // Checked on the rule first, so a broken detection fails here without creating anything.
        var real = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Cineon");
        if (Environment.GetEnvironmentVariable(AppPaths.DataDirVariable) is { } overridden)
        {
            Assert.Equal(Path.GetFullPath(overridden), Path.GetFullPath(AppPaths.Root));
            return;
        }
        Assert.StartsWith(Path.GetTempPath(), AppPaths.ResolveRoot(null, AppPaths.IsTestRun, real, Path.GetTempPath()));
        Assert.NotEqual(Path.GetFullPath(real), Path.GetFullPath(AppPaths.Root));
        Assert.StartsWith(Path.GetFullPath(Path.GetTempPath()), Path.GetFullPath(AppPaths.Root));
    }

    [Fact]
    public void RootFollowsTheMacsRules()
    {
        Assert.Equal(Path.GetFullPath("/data/cineon"), AppPaths.ResolveRoot("/data/cineon", isTestRun: true, "/local", "/tmp"));
        Assert.StartsWith(Path.Combine("/tmp", "CineonTests-"), AppPaths.ResolveRoot(null, isTestRun: true, "/local", "/tmp"));
        Assert.Equal(Path.Combine("/local", "Cineon"), AppPaths.ResolveRoot(null, isTestRun: false, "/local", "/tmp"));
    }

    [Fact]
    public void DownloadsGoToTheChosenFolderOrVideos()
    {
        Assert.Equal("/Volumes/Films", AppPaths.DownloadsFolder(new AppSettings { DownloadsFolder = " /Volumes/Films " }));
        var fallback = AppPaths.DownloadsFolder(new AppSettings());
        Assert.Equal(AppPaths.DefaultDownloadsFolder, fallback);
        Assert.True(fallback.EndsWith("Cineon", StringComparison.Ordinal) || fallback.EndsWith("Movies", StringComparison.Ordinal));
    }

    [Fact]
    public void ProfileFoldersAreNamedByUpperCaseId()
    {
        var id = Guid.NewGuid();
        var folder = AppPaths.Profile(id);
        try
        {
            Assert.True(Directory.Exists(folder));
            Assert.Equal(id.ToString("D").ToUpperInvariant(), Path.GetFileName(folder));
            Assert.Equal(Path.Combine(AppPaths.Root, "Profiles"), Path.GetDirectoryName(folder));
        }
        finally
        {
            Directory.Delete(folder, true);
        }
    }
}
