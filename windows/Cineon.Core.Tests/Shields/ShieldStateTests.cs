using Cineon.Core.Shields;

namespace Cineon.Core.Tests.Shields;

public class ShieldStateTests
{
    private sealed class MemoryStore : IShieldStore
    {
        public Dictionary<string, (bool, bool, bool, bool)> Prefs { get; } = [];
        public Dictionary<string, (int Ads, int Popups, int Redirects, int Overlays)> Stats { get; } = [];
        public int Writes { get; private set; }

        public IEnumerable<(string Host, bool ShieldsOff, bool AllowPopups, bool AllowRedirects, bool TrackingOff)> LoadSitePrefs() =>
            Prefs.Select(p => (p.Key, p.Value.Item1, p.Value.Item2, p.Value.Item3, p.Value.Item4));

        public void SaveSitePrefs(string host, bool shieldsOff, bool allowPopups, bool allowRedirects, bool trackingOff) =>
            Prefs[host] = (shieldsOff, allowPopups, allowRedirects, trackingOff);

        public (int Ads, int Popups, int Redirects, int Overlays) LoadTotalStats() =>
            (Stats.Values.Sum(s => s.Ads), Stats.Values.Sum(s => s.Popups), Stats.Values.Sum(s => s.Redirects), Stats.Values.Sum(s => s.Overlays));

        public void AddStats(string day, int ads, int popups, int redirects, int overlays)
        {
            lock (Stats)
            {
                Writes++;
                var s = Stats.GetValueOrDefault(day);
                Stats[day] = (s.Ads + ads, s.Popups + popups, s.Redirects + redirects, s.Overlays + overlays);
            }
        }
    }

    [Fact]
    public void PrefsAreKeptPerSite()
    {
        var store = new MemoryStore();
        var state = new ShieldState(store);
        Assert.False(state.ShieldsOff("player.vod.example.co.uk"));

        state.Update("player.vod.example.co.uk", shieldsOff: true);
        Assert.True(state.ShieldsOff("www.example.co.uk"));
        Assert.True(state.ShieldsOff("EXAMPLE.CO.UK."));
        Assert.False(state.ShieldsOff("example.com"));
        Assert.Equal((true, false, false, false), store.Prefs["example.co.uk"]);

        state.Update("www.example.co.uk", allowPopups: true);
        var prefs = state.PrefsFor("example.co.uk");
        Assert.Equal("example.co.uk", prefs.Host);
        Assert.True(prefs.ShieldsOff);
        Assert.True(prefs.AllowPopups);

        state.Update(null, trackingOff: true);
        Assert.Single(store.Prefs);

        var reopened = new ShieldState(store);
        Assert.True(reopened.AllowPopups("cdn.example.co.uk"));
        Assert.Single(reopened.AllPrefs);
    }

    [Fact]
    public void KeysAreRegistrableDomains()
    {
        Assert.Equal("example.com", ShieldState.Key("a.b.example.com"));
        Assert.Equal("example.com.ua", ShieldState.Key("www.example.com.ua"));
        Assert.Equal("192.168.0.1", ShieldState.Key("192.168.0.1"));
        Assert.Equal("localhost", ShieldState.Key("localhost"));
        Assert.Equal("", ShieldState.Key(null));
    }

    [Fact]
    public async Task CountsAreSavedTogetherAfterADelay()
    {
        var store = new MemoryStore();
        store.Stats["2026-11-01"] = (10, 1, 2, 3);
        var day = new DateTime(2026, 11, 6, 21, 30, 0);
        var state = new ShieldState(store, TimeSpan.FromMilliseconds(100), () => day);
        Assert.Equal((10, 1, 2, 3), state.Total);

        state.Record(ads: 1);
        state.Record(ads: 2, popups: 1);
        state.Record(overlays: 1);
        Assert.Equal((13, 2, 2, 4), state.Total);
        Assert.Equal(0, store.Writes);

        for (int i = 0; i < 100 && store.Writes == 0; i++) await Task.Delay(20, TestContext.Current.CancellationToken);
        Assert.Equal(1, store.Writes);
        Assert.Equal((3, 1, 0, 1), store.Stats["2026-11-06"]);

        state.Record(redirects: 1);
        state.Flush();
        Assert.Equal((3, 1, 1, 1), store.Stats["2026-11-06"]);
        state.Flush();
        Assert.Equal(2, store.Writes);
    }

    [Fact]
    public void StoreFailuresAreIgnored()
    {
        var state = new ShieldState(new FailingStore());
        Assert.Equal((0, 0, 0, 0), state.Total);
        state.Update("example.com", shieldsOff: true);
        Assert.True(state.ShieldsOff("example.com"));
        state.Record(ads: 1);
        state.Flush();
    }

    private sealed class FailingStore : IShieldStore
    {
        public IEnumerable<(string Host, bool ShieldsOff, bool AllowPopups, bool AllowRedirects, bool TrackingOff)> LoadSitePrefs() => throw new IOException();
        public void SaveSitePrefs(string host, bool shieldsOff, bool allowPopups, bool allowRedirects, bool trackingOff) => throw new IOException();
        public (int Ads, int Popups, int Redirects, int Overlays) LoadTotalStats() => throw new IOException();
        public void AddStats(string day, int ads, int popups, int redirects, int overlays) => throw new IOException();
    }
}
