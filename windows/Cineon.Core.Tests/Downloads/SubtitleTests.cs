using System.Text;
using Cineon.Core.Downloads;
using Cineon.Core.Tests.Data;

namespace Cineon.Core.Tests.Downloads;

/// <summary>
/// The subtitle cases of CineonTests/DownloadTests.swift. Its MediaSource, file name and database
/// cases are in Data/ModelsTests and Data/DatabaseTests; its share code and party cases belong to Together.
/// </summary>
public sealed class SubtitleTests
{
    [Fact]
    public void ParsesWebVTT()
    {
        const string vtt = """
            WEBVTT

            1
            00:00:01.500 --> 00:00:04.000 align:center
            <i>Hello</i> there

            00:01:05.000 --> 00:01:07.250
            Second line
            and more
            """;
        var cues = SubtitleTrack.Parse(vtt);
        Assert.Equal(2, cues.Count);
        Assert.Equal(1.5, cues[0].Start, 3);
        Assert.Equal("Hello there", cues[0].Text);
        Assert.Equal(67.25, cues[1].End, 3);
        Assert.Equal("Second line\nand more", cues[1].Text);
    }

    [Fact]
    public void ParsesSubRipWithWindowsLineEnds()
    {
        const string srt = "1\r\n00:00:02,000 --> 00:00:03,000\r\nПривіт\r\n\r\n2\r\n00:00:05,000 --> 00:00:06,000\r\nDruhyi\r\n";
        var cues = SubtitleTrack.Parse(srt);
        Assert.Equal(2, cues.Count);
        Assert.Equal("Привіт", cues[0].Text);
        Assert.Equal(5, cues[1].Start, 3);
    }

    [Fact]
    public void FindsTheCueOnScreen()
    {
        var track = new SubtitleTrack
        {
            Id = "x", Label = "English",
            Cues = [new SubtitleCue(1, 3, "one"), new SubtitleCue(5, 8, "two"), new SubtitleCue(6, 7, "overlap")],
        };
        Assert.Null(track.Text(0.5));
        Assert.Equal("one", track.Text(2));
        Assert.Null(track.Text(4));
        Assert.Equal("two\noverlap", track.Text(6.5));
        Assert.Equal("two", track.Text(7.5));
    }

    [Fact]
    public void LanguageFromSubtitleAddress()
    {
        Assert.Equal("en", SubtitleTrack.LabelFor(new Uri("https://x.test/subs/film_eng.vtt"), 0));
        Assert.Equal("uk", SubtitleTrack.LabelFor(new Uri("https://x.test/subs/ukr/1.vtt"), 0));
        Assert.Equal("sub3", SubtitleTrack.LabelFor(new Uri("https://x.test/s/1234.vtt"), 2));
        Assert.Equal("ru", SubtitleTrack.LabelForFile(@"C:\Users\me\Downloads\Film.rus.srt", 0));
    }

    [Fact]
    public void LoadsCyrillicSubRipThatIsNotUtf8AndLabelsIt()
    {
        using var folder = new TempFolder();
        var path = folder.File("Film [1080p].uk.srt");
        Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);
        File.WriteAllBytes(path, Encoding.GetEncoding(1251).GetBytes("1\r\n00:00:01,000 --> 00:00:02,000\r\nПривіт, світе\r\n"));
        var track = SubtitleTrack.Load(path);
        Assert.NotNull(track);
        Assert.Equal("Привіт, світе", Assert.Single(track.Cues).Text);
        Assert.Equal(path, track.Id);
        Assert.Equal("Subtitles 2", SubtitleTrack.DisplayName("sub2"));
        Assert.Null(SubtitleTrack.Load(folder.File("missing.vtt")));
    }

    [Fact]
    public void TimesInEveryForm()
    {
        Assert.Equal(62.345, SubtitleTrack.Time("00:01:02.345")!.Value, 3);
        Assert.Equal(62.345, SubtitleTrack.Time("01:02.345")!.Value, 3);
        Assert.Equal(62.345, SubtitleTrack.Time(" 00:01:02,345 ")!.Value, 3);
        Assert.Null(SubtitleTrack.Time("12"));
        Assert.Null(SubtitleTrack.Time("a:b"));
    }
}
