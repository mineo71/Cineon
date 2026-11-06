using System.Text;
using System.Text.Json;
using Cineon.Core.Data;

namespace Cineon.Core.Tests.Data;

/// <summary>
/// The helpers in Models.swift. Expected values come from running the Swift code on a Mac, so they
/// pin the Mac's behaviour rather than what seems sensible; the URLKey, DomainName, Timecode,
/// MediaSource and file name cases from TitleParserTests and DownloadTests are included.
/// </summary>
public sealed class ModelsTests
{
    // MARK: URLKey

    [Theory]
    [InlineData("https://www.Site.example/watch/1?utm_source=x&id=5#t=10", "site.example/watch/1?id=5")]
    [InlineData("http://site.example/watch/1/?id=5", "site.example/watch/1?id=5")]
    [InlineData("https://rezka.example/series/1-name.html#t:238-s:2-e:3", "rezka.example/series/1-name.html#s:2-e:3")]
    [InlineData("https://rezka.example/series/1-name.html#t:111-s:2-e:3", "rezka.example/series/1-name.html#s:2-e:3")]
    [InlineData("https://x.example/%D1%84%D0%B8%D0%BB%D1%8C%D0%BC/", "x.example/%D1%84%D0%B8%D0%BB%D1%8C%D0%BC")]
    [InlineData("https://x.example/%D1%84%D0%B8%D0%BB%D1%8C%D0%BC", "x.example/%D1%84%D0%B8%D0%BB%D1%8C%D0%BC")]
    [InlineData("https://x.example/a%2Fb/", "x.example/a/b")]
    [InlineData("https://x.example/a?q=a%26b&z=1+2&b", "x.example/a?b&q=a%26b&z=1+2")]
    [InlineData("https://x.example/a?", "x.example/a")]
    [InlineData("https://x.example/a?b=&a=1", "x.example/a?a=1&b=")]
    [InlineData("https://user:pw@x.example:8080/a//", "x.example:8080/a")]
    [InlineData("https://x.example/", "x.example")]
    [InlineData("https://x.example", "x.example")]
    [InlineData("https://x.example/a?q=%20x%2B", "x.example/a?q=%20x+")]
    [InlineData("https://x.example/a?q=a%3Db", "x.example/a?q=a%3Db")]
    [InlineData("https://x.example/a?Ref=1&REF_x=2&id=3", "x.example/a?id=3")]
    [InlineData("https://x.example/a?q=%E2%9C%93&r=it's", "x.example/a?q=%E2%9C%93&r=it's")]
    [InlineData("https://x.example/a#S:1-E:2", "x.example/a")]
    [InlineData("https://x.example/a?z=1&a=2&a=1", "x.example/a?a=2&a=1&z=1")]
    [InlineData("https://x.example/a?q=a/b?c", "x.example/a?q=a/b?c")]
    [InlineData("https://x.example/a b", "x.example/a%20b")]
    [InlineData("http://127.0.0.1:8765/series/drama/1-mentalist-2008.html#t:238-s:3-e:6", "127.0.0.1:8765/series/drama/1-mentalist-2008.html#s:3-e:6")]
    [InlineData("https://XN--80AK6AA92E.com/путь/", "xn--80ak6aa92e.com/%D0%BF%D1%83%D1%82%D1%8C")]
    [InlineData("https://x.example/a?q=%25", "x.example/a?q=%25")]
    [InlineData("https://x.example/a?q=a;b", "x.example/a?q=a;b")]
    [InlineData("https://x.example/a?q=[1]", "x.example/a?q=%5B1%5D")]
    [InlineData("https://x.example/a?q=a@b:c!$'()*,", "x.example/a?q=a@b:c!$'()*,")]
    [InlineData("blob:https://site.test/x", "https%3A//site.test/x")]
    [InlineData("about:blank", "blank")]
    public void UrlKeyMatchesTheMac(string url, string key) => Assert.Equal(key, UrlKey.Make(new Uri(url)));

    [Fact]
    public void UrlKeyKeepsEpisodesApart()
    {
        var a = UrlKey.Make(new Uri("https://rezka.example/series/1-name.html#t:238-s:2-e:3"));
        var c = UrlKey.Make(new Uri("https://rezka.example/series/1-name.html#t:238-s:2-e:4"));
        Assert.NotEqual(a, c);
    }

    // MARK: Title keys

    [Theory]
    [InlineData("Dune: Part Two", "duneparttwo")]
    [InlineData("Straße", "strasse")]
    [InlineData("Ёлки 2", "елки2")]
    [InlineData("Café Ｆｕｌｌ", "cafefull")]
    [InlineData("Ørsted", "ørsted")]
    [InlineData("ﬁlm", "film")]
    [InlineData("千と千尋の神隠し", "千と千尋の神隠し")]
    [InlineData("Ǆungla", "ǆungla")]
    [InlineData("Й", "и")]
    [InlineData("İstanbul", "istanbul")]
    [InlineData("Ⅻ", "ⅻ")]
    [InlineData("x²", "x²")]
    [InlineData("Łódź", "łodz")]
    [InlineData("Æon", "æon")]
    [InlineData("a\u0301", "a")]
    [InlineData("١٢٣", "١٢٣")]
    [InlineData("🎬Film", "film")]
    [InlineData("Ω", "ω")]
    [InlineData("ガンダム", "ガンダム")]
    [InlineData("ｶﾞﾝﾀﾞﾑ", "カﾞンタﾞム")]
    [InlineData("한국", "한국")]
    [InlineData("हिन्दी", "हिन्दी")]
    [InlineData("ς", "σ")]
    [InlineData("µ", "μ")]
    [InlineData("ſ", "s")]
    [InlineData("ﬆ", "st")]
    [InlineData("ŉ", "ʼn")]
    [InlineData("ǰ", "j")]
    [InlineData("ΐ", "ι")]
    [InlineData("ẞ", "ss")]
    [InlineData("ϐ", "β")]
    [InlineData("Ａ１", "a1")]
    [InlineData("\u3000x", "x")]
    [InlineData("Ꭰ", "ꭰ")]
    [InlineData("ﬓ", "մն")]
    [InlineData("ᾈ", "α")]
    [InlineData("Ç", "c")]
    [InlineData("Þ", "þ")]
    [InlineData("ﬃ", "ffi")]
    [InlineData("الْعَرَبِيَّة", "الْعَرَبِيَّة")]
    [InlineData("עִבְרִית", "עִבְרִית")]
    [InlineData("Việt Nam", "vietnam")]
    [InlineData("½", "½")]
    [InlineData("℃", "")]
    [InlineData("™", "")]
    [InlineData("Å", "a")]
    [InlineData("＄", "")]
    [InlineData("ⓐ", "")]
    public void NormalizeMatchesFoundation(string text, string key) => Assert.Equal(key, LibraryText.Normalize(text));

    [Fact]
    public void GenresGetOneName()
    {
        Assert.Equal("Sci-Fi", LibraryText.CanonicalGenre("Science Fiction"));
        Assert.Equal("Sci-Fi", LibraryText.CanonicalGenre(" sci-fi "));
        Assert.Equal("Film-Noir", LibraryText.CanonicalGenre("film noir"));
        Assert.Equal("TV Movie", LibraryText.CanonicalGenre("TV Movie"));
        Assert.Equal("Comedy", LibraryText.CanonicalGenre("comedy"));
        Assert.Equal("", LibraryText.CanonicalGenre(""));
    }

    // MARK: Domains, time, ratings

    [Fact]
    public void RegistrableDomain()
    {
        Assert.Equal("example.com", DomainName.Registrable("player.vod.example.com"));
        Assert.Equal("example.com.ua", DomainName.Registrable("kino.example.com.ua"));
        Assert.Equal("127.0.0.1", DomainName.Registrable("127.0.0.1"));
        Assert.Equal("example.co.uk", DomainName.Registrable("Player.Example.CO.UK."));
        Assert.True(DomainName.IsSameSite("a.example.com", "b.example.com"));
        Assert.False(DomainName.IsSameSite("example.com", "ads.net"));
        Assert.False(DomainName.IsSameSite(null, "ads.net"));
        Assert.Equal("Example", DomainName.DisplayName("www.example.co.uk"));
        Assert.True(DomainName.IsIPAddress("::1"));
    }

    [Fact]
    public void TimecodeReadsLikeTheMac()
    {
        Assert.Equal("42:10", Timecode.String(2530));
        Assert.Equal("1:02:03", Timecode.String(3723));
        Assert.Equal("0:00", Timecode.String(double.NaN));
        Assert.Equal("1 h 12 min", Timecode.Spoken(4320));
        Assert.Equal("2 min", Timecode.Spoken(90));
        Assert.Equal("1 h", Timecode.Spoken(3600));
        Assert.Equal("under a minute", Timecode.Spoken(20));
    }

    [Fact]
    public void ProgressAndTitleMath()
    {
        Assert.Equal(7.5, new Title { RatingHalves = 15 }.Rating);
        Assert.Null(new Title().Rating);
        var p = new WatchProgress { Position = 150, Duration = 100 };
        Assert.Equal(1, p.Fraction);
        Assert.Equal(0, p.Remaining);
        Assert.False(EpisodeRef.None.IsEpisode);
        Assert.True(new EpisodeRef(0, 3).IsEpisode);
    }

    [Fact]
    public void RecordsCompareByValue()
    {
        var a = new Title { Name = "Dune", Genres = ["Sci-Fi", "Drama"] };
        var b = new Title { Name = "Dune", Genres = new List<string> { "Sci-Fi", "Drama" } };
        Assert.Equal(a, b);
        Assert.Equal(a.GetHashCode(), b.GetHashCode());
        Assert.NotEqual(a, b with { Genres = ["Drama", "Sci-Fi"] });
        Assert.Equal(new AppSettings(), new AppSettings() with { EnabledLists = new HashSet<string>(new AppSettings().EnabledLists) });
    }

    // MARK: Media sources and downloads

    private static MediaSource Source(string url, MediaSourceKind kind = MediaSourceKind.File, double at = 0, bool current = true) =>
        new() { Url = new Uri(url), Kind = kind, FoundAt = at, IsCurrent = current };

    [Fact]
    public void PlainFileBeingPlayedWins()
    {
        MediaSource[] sources = [Source("https://cdn.test/a/1080.mp4", at: 1), Source("https://cdn.test/a/480.mp4", at: 2)];
        Assert.Equal("https://cdn.test/a/480.mp4", MediaSource.Best(sources, "https://cdn.test/a/480.mp4")?.Url.OriginalString);
    }

    [Fact]
    public void HighestQualityWhenPlayingFromAMediaSource()
    {
        MediaSource[] sources =
            [Source("https://cdn.test/a/480.mp4", at: 1), Source("https://cdn.test/a/1080.mp4", at: 2), Source("https://cdn.test/a/720.mp4", at: 3)];
        Assert.Equal("1080p", MediaSource.Best(sources, "blob:https://site.test/x")?.Quality);
    }

    [Fact]
    public void FilesFromTheVideoBeforeThisOneAreIgnored()
    {
        MediaSource[] sources = [Source("https://cdn.test/ep1/1080.mp4", current: false), Source("https://cdn.test/ep2/720.mp4", at: 5)];
        Assert.Equal("/ep2/720.mp4", MediaSource.Best(sources, null)?.Url.AbsolutePath);
    }

    [Fact]
    public void WholeFileBeatsPlaylist()
    {
        MediaSource[] sources = [Source("https://cdn.test/master.m3u8", MediaSourceKind.Hls, at: 1), Source("https://cdn.test/film.mp4", at: 2)];
        Assert.Equal(MediaSourceKind.File, MediaSource.Best(sources, null)?.Kind);
    }

    [Fact]
    public void FirstPlaylistIsTheMaster()
    {
        MediaSource[] sources =
            [Source("https://cdn.test/master.m3u8", MediaSourceKind.Hls, at: 1), Source("https://cdn.test/v1/index.m3u8", MediaSourceKind.Hls, at: 2)];
        Assert.Equal("/master.m3u8", MediaSource.Best(sources, null)?.Url.AbsolutePath);
    }

    [Fact]
    public void SubtitlesAreNeverTheFilm() =>
        Assert.Null(MediaSource.Best([Source("https://cdn.test/en.vtt", MediaSourceKind.Subtitle)], null));

    [Fact]
    public void QualityFromAddresses()
    {
        Assert.Equal("720p", MediaSource.QualityIn("https://x.test/film_720p.mp4"));
        Assert.Equal("1080p", MediaSource.QualityIn("https://x.test/stream/1080.mp4"));
        Assert.Equal("2160p", MediaSource.QualityIn("https://x.test/stream/2160P/x"));
        Assert.Null(MediaSource.QualityIn("https://x.test/stream/abc.mp4"));
        Assert.Null(MediaSource.QualityIn("https://x.test/1080pa.mp4"));
        Assert.Equal(1080, Source("https://x.test/stream/1080.mp4").QualityRank);
    }

    private static DownloadItem Download(string name, EpisodeRef episode, string? quality) => new()
    {
        Id = 1, TitleId = null, Ref = episode, Name = name, SourceUrl = new Uri("https://x.test/a.mp4"), PageUrl = null,
        Referer = null, Host = "x.test", Kind = MediaSourceKind.File, Quality = quality, File = null, Subtitles = [], Bytes = 0,
        TotalBytes = 0, Status = DownloadStatus.Queued, Error = null, Position = 0, Duration = 0, PosterUrl = null,
        CreatedAt = DateTimeOffset.UtcNow,
    };

    [Fact]
    public void FileNameForAnEpisode() =>
        Assert.Equal("Severance S01E02 [1080p]", Download("Severance", new EpisodeRef(1, 2), "1080p").FileBaseName);

    [Fact]
    public void FileNameDropsCharactersFileSystemsRefuse()
    {
        var name = Download("Mission: Impossible / Dead Reckoning", EpisodeRef.None, null).FileBaseName;
        Assert.DoesNotContain("/", name);
        Assert.DoesNotContain(":", name);
        Assert.StartsWith("Mission", name);
        Assert.Equal("Mission Impossible  Dead Reckoning  x", Download("Mission: Impossible / Dead Reckoning   x", EpisodeRef.None, null).FileBaseName);
        Assert.Equal("Video", Download("::", EpisodeRef.None, null).FileBaseName);
        Assert.Equal(120, Download(new string('a', 300), EpisodeRef.None, null).FileBaseName.Length);
    }

    [Fact]
    public void DownloadFractions()
    {
        var item = Download("x", EpisodeRef.None, null) with { Bytes = 50, TotalBytes = 200, Position = 30, Duration = 60 };
        Assert.Equal(0.25, item.Fraction);
        Assert.Equal(0.5, item.WatchedFraction);
        Assert.Null(item.EpisodeBadge);
        Assert.True(DownloadStatus.Downloading.IsActive);
        Assert.False(DownloadStatus.Failed.IsActive);
    }

    // MARK: Search addresses

    [Theory]
    [InlineData("dune part", "https://duckduckgo.com/?q=dune%20part")]
    [InlineData("a&b+c", "https://duckduckgo.com/?q=a%26b+c")]
    [InlineData("Фільм 2", "https://duckduckgo.com/?q=%D0%A4%D1%96%D0%BB%D1%8C%D0%BC%202")]
    [InlineData("100%", "https://duckduckgo.com/?q=100%25")]
    [InlineData("a#b", "https://duckduckgo.com/?q=a%23b")]
    [InlineData("a=b;c/d?", "https://duckduckgo.com/?q=a%3Db;c/d?")]
    public void SearchEngineAddressesMatchTheMac(string query, string url) =>
        Assert.Equal(url, SearchEngine.DuckDuckGo.Url(query)?.OriginalString);

    [Fact]
    public void EachSearchEngineHasItsAddress()
    {
        Assert.Equal("https://www.google.com/search?q=x", SearchEngine.Google.Url("x")?.OriginalString);
        Assert.Equal("https://search.brave.com/search?q=x", SearchEngine.Brave.Url("x")?.OriginalString);
        Assert.Equal("https://kagi.com/search?q=x", SearchEngine.Kagi.Url("x")?.OriginalString);
    }

    [Theory]
    [InlineData("dune part", "https://s.example/?q=dune%20part")]
    [InlineData("a&b+c", "https://s.example/?q=a%26b%2Bc")]
    [InlineData("Фільм 2", "https://s.example/?q=%D0%A4%D1%96%D0%BB%D1%8C%D0%BC%202")]
    [InlineData("100%", "https://s.example/?q=100%25")]
    [InlineData("a#b", "https://s.example/?q=a%23b")]
    [InlineData("a/b?c=d", "https://s.example/?q=a/b?c=d")]
    public void SiteSearchAddressesMatchTheMac(string query, string url)
    {
        var site = new Site { HomeUrl = new Uri("https://s.example"), SearchTemplate = "https://s.example/?q=%s" };
        Assert.Equal(url, site.SearchUrl(query)?.OriginalString);
        Assert.Null((site with { SearchTemplate = null }).SearchUrl(query));
    }

    // MARK: Raw values

    [Fact]
    public void RawValuesRoundTrip()
    {
        foreach (var v in Enum.GetValues<TitleKind>()) Assert.Equal(v, TitleKind.FromRaw(v.ToRaw()));
        foreach (var v in Enum.GetValues<TitleStatus>()) Assert.Equal(v, TitleStatus.FromRaw(v.ToRaw()));
        foreach (var v in Enum.GetValues<SkipRuleKind>()) Assert.Equal(v, SkipRuleKind.FromRaw(v.ToRaw()));
        foreach (var v in Enum.GetValues<MediaSourceKind>()) Assert.Equal(v, MediaSourceKind.FromRaw(v.ToRaw()));
        foreach (var v in Enum.GetValues<VoiceBoostState>()) Assert.Equal(v, VoiceBoostState.FromRaw(v.ToRaw()));
        foreach (var v in Enum.GetValues<DownloadStatus>()) Assert.Equal(v, DownloadStatus.FromRaw(v.ToRaw()));
        foreach (var v in Enum.GetValues<CaptionStyle>()) Assert.Equal(v, CaptionStyle.FromRaw(v.ToRaw()));
        foreach (var v in Enum.GetValues<LibraryEventKind>()) Assert.Equal(v, LibraryEventKind.FromRaw(v.ToRaw()));
        foreach (var v in Enum.GetValues<AppTheme>()) Assert.Equal(v, AppTheme.FromRaw(v.ToRaw()));
        foreach (var v in Enum.GetValues<SearchEngine>()) Assert.Equal(v, SearchEngine.FromRaw(v.ToRaw()));
        foreach (var v in Enum.GetValues<LibraryList>()) Assert.Equal(v, LibraryList.FromRaw(v.ToRaw()));
        foreach (var v in Enum.GetValues<LibraryKind>()) Assert.Equal(v, LibraryKind.FromRaw(v.ToRaw()));
        foreach (var v in Enum.GetValues<LibrarySort>()) Assert.Equal(v, LibrarySort.FromRaw(v.ToRaw()));
        Assert.Equal(
            ["film", "series", "cartoon", "unknown", "none", "backlog", "watching", "watched", "addedToBacklog", "markedWatched",
             "markedWatching", "removed", "duckDuckGo", "hls", "subtitle", "site", "large", "huge", "dark", "white", "ratingHigh"],
            [TitleKind.Film.ToRaw(), TitleKind.Series.ToRaw(), TitleKind.Cartoon.ToRaw(), TitleKind.Unknown.ToRaw(),
             TitleStatus.None.ToRaw(), TitleStatus.Backlog.ToRaw(), TitleStatus.Watching.ToRaw(), TitleStatus.Watched.ToRaw(),
             LibraryEventKind.AddedToBacklog.ToRaw(), LibraryEventKind.MarkedWatched.ToRaw(), LibraryEventKind.MarkedWatching.ToRaw(),
             LibraryEventKind.Removed.ToRaw(), SearchEngine.DuckDuckGo.ToRaw(), MediaSourceKind.Hls.ToRaw(), MediaSourceKind.Subtitle.ToRaw(),
             CaptionStyle.Site.ToRaw(), CaptionStyle.Large.ToRaw(), CaptionStyle.Huge.ToRaw(), AppTheme.Dark.ToRaw(), AppTheme.White.ToRaw(),
             LibrarySort.RatingHigh.ToRaw()]);
        Assert.Null(TitleKind.FromRaw("Film"));
        Assert.Equal("Unsorted", TitleKind.Unknown.Label);
        Assert.Equal("Not in a list", TitleStatus.None.Label);
        Assert.Equal("Click the video once to turn it on", VoiceBoostState.Waiting.Note);
        Assert.Null(CaptionStyle.Site.Css);
        Assert.StartsWith("font-size: 135% !important;", CaptionStyle.Large.Css);
        Assert.Equal(42, CaptionStyle.Huge.NativeSize);
    }

    // MARK: Settings

    [Fact]
    public void SettingsWrittenByTheMacLoad()
    {
        const string mac = """
            {"hibernateMinutes":20,"sidebarWidth":300,"playNextDownload":true,"redirectShield":true,"pauseOtherTabs":true,"fetchMetadata":true,"theme":"white","launchAnimation":true,"downloadsFolder":"\/Volumes\/Films","popupShield":true,"autoResume":true,"enabledLists":["ublock","easylist"],"voiceBoost":true,"binWatchedDownloads":true,"autoNextEpisode":true,"captionStyle":"huge","cloudBackup":true,"downloadShield":true,"learnSkips":true,"ambientStrength":0.3,"showDownloadButton":true,"newEpisodeAlerts":true,"sidebarHidden":false,"finishThreshold":0.92,"searchEngine":"kagi","keepFrames":true,"overlaySweeper":true,"ambientLight":true,"saveBrowsingHistory":true,"networkBlocking":true,"minimumSecondsToTrack":5,"autoRescue":true,"sharePet":true}
            """;
        var settings = AppSettings.Decode(Encoding.UTF8.GetBytes(mac));
        Assert.NotNull(settings);
        Assert.Equal(AppTheme.White, settings.Theme);
        Assert.Equal(300, settings.SidebarWidth);
        Assert.Equal("/Volumes/Films", settings.DownloadsFolder);
        Assert.Equal(new HashSet<string> { "ublock", "easylist" }, settings.EnabledLists);
        Assert.True(settings.VoiceBoost);
        Assert.Equal(CaptionStyle.Huge, settings.CaptionStyle);
        Assert.Equal(SearchEngine.Kagi, settings.SearchEngine);
        Assert.Equal(0.3, settings.AmbientStrength);
        Assert.Equal(5, settings.MinimumSecondsToTrack);
    }

    [Fact]
    public void BadSettingsFallBackOneByOne()
    {
        var settings = AppSettings.Decode(Encoding.UTF8.GetBytes(
            """{"theme":"purple","ambientLight":1,"sidebarWidth":"wide","enabledLists":["a",2],"searchEngine":"google","keepFrames":false}"""));
        Assert.NotNull(settings);
        Assert.Equal(new AppSettings() with { SearchEngine = SearchEngine.Google, KeepFrames = false }, settings);
        Assert.Null(AppSettings.Decode(Encoding.UTF8.GetBytes("[1,2]")));
        Assert.Null(AppSettings.Decode(Encoding.UTF8.GetBytes("not json")));
        Assert.Null(AppSettings.Decode([]));
    }

    [Fact]
    public void SettingsRoundTripWithTheMacsKeys()
    {
        var settings = new AppSettings() with
        {
            Theme = AppTheme.White, AmbientStrength = 0.4, EnabledLists = new HashSet<string> { "easylist" }, DownloadsFolder = @"D:\Films",
            CaptionStyle = CaptionStyle.Large, SearchEngine = SearchEngine.Brave, CloudBackup = false,
        };
        var json = settings.Encode();
        Assert.Equal(settings, AppSettings.Decode(json));

        using var document = JsonDocument.Parse(json);
        var keys = document.RootElement.EnumerateObject().Select(p => p.Name).Order(StringComparer.Ordinal).ToArray();
        string[] macKeys =
        [
            "ambientLight", "ambientStrength", "autoNextEpisode", "autoRescue", "autoResume", "binWatchedDownloads", "captionStyle",
            "cloudBackup", "downloadShield", "downloadsFolder", "enabledLists", "fetchMetadata", "finishThreshold", "hibernateMinutes",
            "keepFrames", "launchAnimation", "learnSkips", "minimumSecondsToTrack", "networkBlocking", "newEpisodeAlerts",
            "overlaySweeper", "pauseOtherTabs", "playNextDownload", "popupShield", "redirectShield", "saveBrowsingHistory",
            "searchEngine", "sharePet", "showDownloadButton", "sidebarHidden", "sidebarWidth", "theme", "voiceBoost",
        ];
        Assert.Equal(macKeys, keys);
        Assert.Contains("\"sidebarWidth\":252", Encoding.UTF8.GetString(new AppSettings().Encode()));
        Assert.Contains("\"ambientStrength\":0.55", Encoding.UTF8.GetString(new AppSettings().Encode()));
    }

    [Fact]
    public void DefaultSettingsMatchTheMac()
    {
        var s = new AppSettings();
        Assert.Equal(
            (AppTheme.Dark, true, 0.55, true, 252.0, false),
            (s.Theme, s.AmbientLight, s.AmbientStrength, s.LaunchAnimation, s.SidebarWidth, s.SidebarHidden));
        Assert.Equal(
            (true, 0.92, 15.0, 20.0, true, true, true, true, true),
            (s.AutoResume, s.FinishThreshold, s.MinimumSecondsToTrack, s.HibernateMinutes, s.PauseOtherTabs, s.AutoRescue,
                s.LearnSkips, s.AutoNextEpisode, s.KeepFrames));
        Assert.Equal((true, true, true, true, true), (s.NetworkBlocking, s.PopupShield, s.RedirectShield, s.OverlaySweeper, s.DownloadShield));
        Assert.Equal(new HashSet<string> { "easylist", "easyprivacy", "ublock", "peterlowe", "cineon-streaming" }, s.EnabledLists);
        Assert.Equal((true, true, SearchEngine.DuckDuckGo, true, "", CaptionStyle.Site),
            (s.FetchMetadata, s.SaveBrowsingHistory, s.SearchEngine, s.ShowDownloadButton, s.DownloadsFolder, s.CaptionStyle));
        Assert.Equal((false, true, true, true, true, true),
            (s.VoiceBoost, s.BinWatchedDownloads, s.PlayNextDownload, s.NewEpisodeAlerts, s.SharePet, s.CloudBackup));
    }

    // MARK: Stored dates

    [Fact]
    public void StoredDatesUseTheMacsEpochs()
    {
        Assert.Equal(DateTimeOffset.UnixEpoch, StoredDate.FromUnix(0));
        Assert.Equal(new DateTimeOffset(2001, 1, 1, 0, 0, 0, TimeSpan.Zero), StoredDate.FromReference(0));
        Assert.Equal(815607320.735974, StoredDate.ToReference(StoredDate.FromReference(815607320.735974)));
        Assert.Equal(1793914535.142225, StoredDate.ToUnix(StoredDate.FromUnix(1793914535.142225)));
        Assert.Equal(StoredDate.FromUnix(StoredDate.ReferenceDateUnixSeconds + 100), StoredDate.FromReference(100));
        Assert.Equal(DateTimeOffset.MaxValue, StoredDate.FromUnix(1e300));
        Assert.Equal(DateTimeOffset.MinValue, StoredDate.FromUnix(-1e300));
    }
}
