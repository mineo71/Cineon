using System.Text;
using System.Text.Json;
using Cineon.Core.Data;
using Cineon.Core.Downloads;

namespace Cineon.Core.Tests.Downloads;

/// <summary>Port of CineonTests/SeriesDownloadTests.swift, plus the job file's shape.</summary>
public sealed class SeriesDownloadTests
{
    private static SeasonGrabber.Job Job(SeasonGrabber.Scope scope, params (int Season, int Episode)[] episodes) => new()
    {
        Scope = scope, TitleId = 7, Name = "The Sopranos", Season = 1,
        Episodes = [.. episodes.Select(e => new EpisodeRef(e.Season, e.Episode))],
        PageUrl = new Uri("https://example.test/series/sopranos.html#t:1-s:1-e:1"),
        StartRef = new EpisodeRef(1, 1), PosterUrl = null, UsesPageList = true,
    };

    [Fact]
    public void LabelsSayHowMuchIsComing()
    {
        Assert.Equal("The Sopranos, season 1", Job(SeasonGrabber.Scope.Season, (1, 1), (1, 2)).Label);
        Assert.Equal("The Sopranos, all 3 seasons", Job(SeasonGrabber.Scope.Series, (1, 1), (2, 1), (3, 1)).Label);
        // A series that turns out to have one season says which.
        Assert.Equal("The Sopranos, season 4", Job(SeasonGrabber.Scope.Series, (4, 1), (4, 2)).Label);
    }

    [Fact]
    public void RemainingSkipsWhatsBeenHandledInOrder()
    {
        var series = Job(SeasonGrabber.Scope.Series, (1, 1), (1, 2), (2, 1), (2, 2)) with
        {
            Queued = [new EpisodeRef(1, 1)],
            Missed = [new EpisodeRef(2, 1)],
        };
        Assert.Equal([new EpisodeRef(1, 2), new EpisodeRef(2, 2)], series.Remaining);
        Assert.Equal(2, series.Handled);
        Assert.Equal([1, 2], series.Seasons);
    }

    [Fact]
    public void AJobSurvivesBeingSavedAndRead()
    {
        var series = Job(SeasonGrabber.Scope.Series, (1, 1), (2, 3)) with
        {
            Queued = [new EpisodeRef(1, 1)],
            Current = new EpisodeRef(2, 3),
        };
        var read = SeasonGrabber.Job.Decode(series.Encode());
        Assert.Equal(series, read);
    }

    [Fact]
    public void TheProposalAddsUpAndChecksTheRoom()
    {
        var series = Job(SeasonGrabber.Scope.Series, (1, 1), (1, 2), (2, 1));
        var proposal = new SeasonGrabber.Proposal { Job = series, BytesPerEpisode = 2_000, IsMeasured = true, FreeBytes = 10_000 };
        Assert.Equal(6_000, proposal.TotalBytes);
        Assert.True(proposal.Fits);
        Assert.Equal([1, 2], proposal.SeasonCounts.Select(c => c.Season));
        Assert.Equal([2, 1], proposal.SeasonCounts.Select(c => c.Count));
        proposal = proposal with { FreeBytes = 5_000 };
        Assert.False(proposal.Fits);
        proposal = proposal with { FreeBytes = null };
        Assert.True(proposal.Fits, "Unknown free space doesn't block anything");
    }

    [Fact]
    public void FreeSpaceIsFoundForAFolderThatDoesntExistYet()
    {
        var missing = Path.Combine(Path.GetTempPath(), "cineon-" + Guid.NewGuid().ToString("N"), "Movies", "Cineon");
        Assert.NotNull(SeasonGrabber.FreeSpace(missing));
    }

    // MARK: The job file

    /// <summary>What Swift's JSONEncoder writes for a job, slashes escaped and nils left out.</summary>
    private const string MacJob = """
        {"scope":"series","titleID":7,"name":"Клан Сопрано","season":1,"episodes":[{"season":1,"episode":1},{"season":2,"episode":3}],"queued":[{"season":1,"episode":1}],"missed":[],"current":{"season":2,"episode":3},"pageURL":"https:\/\/example.test\/series\/sopranos.html#t:1-s:1-e:1","startRef":{"season":1,"episode":1},"usesPageList":true,"isFinished":false,"isPaused":false}
        """;

    [Fact]
    public void AJobSavedOnAMacReadsHere()
    {
        var job = SeasonGrabber.Job.Decode(Encoding.UTF8.GetBytes(MacJob));
        Assert.NotNull(job);
        Assert.Equal(SeasonGrabber.Scope.Series, job.Scope);
        Assert.Equal(7, job.TitleId);
        Assert.Equal("Клан Сопрано", job.Name);
        Assert.Equal([new EpisodeRef(1, 1), new EpisodeRef(2, 3)], job.Episodes);
        Assert.Equal(new EpisodeRef(2, 3), job.Current);
        Assert.Equal("https://example.test/series/sopranos.html#t:1-s:1-e:1", job.PageUrl.OriginalString);
        Assert.Null(job.PosterUrl);
        Assert.Equal([new EpisodeRef(2, 3)], job.Remaining);
    }

    [Fact]
    public void AJobWrittenHereHasTheMacsKeys()
    {
        var job = SeasonGrabber.Job.Decode(Encoding.UTF8.GetBytes(MacJob))!;
        using var written = JsonDocument.Parse(job.Encode());
        using var mac = JsonDocument.Parse(MacJob);
        Assert.Equal(
            mac.RootElement.EnumerateObject().Select(p => (p.Name, p.Value.ValueKind)),
            written.RootElement.EnumerateObject().Select(p => (p.Name, p.Value.ValueKind)));
        Assert.Equal(MacJob.Replace(@"\/", "/"), Encoding.UTF8.GetString(job.Encode()));
    }

    [Fact]
    public void NilsAreLeftOutAndAMissingKeyIsNotAJob()
    {
        var job = Job(SeasonGrabber.Scope.Season, (1, 1)) with { TitleId = null, PosterUrl = new Uri("https://img.test/p.jpg") };
        using var doc = JsonDocument.Parse(job.Encode());
        Assert.False(doc.RootElement.TryGetProperty("titleID", out _));
        Assert.False(doc.RootElement.TryGetProperty("current", out _));
        Assert.Equal("https://img.test/p.jpg", doc.RootElement.GetProperty("posterURL").GetString());
        Assert.Null(SeasonGrabber.Job.Decode("""{"scope":"season","name":"x"}"""u8));
        Assert.Null(SeasonGrabber.Job.Decode("not json"u8));
    }
}
