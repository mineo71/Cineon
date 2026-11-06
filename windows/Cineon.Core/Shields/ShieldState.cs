using System.Globalization;

namespace Cineon.Core.Shields;

/// <summary>
/// Where ShieldState keeps its data: the profile database's <c>site_prefs</c> and <c>stats</c>
/// tables, through <c>Database.SitePrefs()</c>, <c>SaveSitePrefs</c>, <c>TotalStats()</c> and
/// <c>AddStats(delta, day)</c>. Plain values only, so Shields doesn't depend on the data layer's types.
/// Methods may throw; ShieldState ignores failures, as the Mac does with <c>try?</c>.
/// </summary>
public interface IShieldStore
{
    /// <summary>Every row of site_prefs.</summary>
    IEnumerable<(string Host, bool ShieldsOff, bool AllowPopups, bool AllowRedirects, bool TrackingOff)> LoadSitePrefs();

    /// <summary>INSERT OR REPLACE one row of site_prefs.</summary>
    void SaveSitePrefs(string host, bool shieldsOff, bool allowPopups, bool allowRedirects, bool trackingOff);

    /// <summary>The sums of the stats table's columns.</summary>
    (int Ads, int Popups, int Redirects, int Overlays) LoadTotalStats();

    /// <summary>Adds to the stats row for <paramref name="day"/> ("yyyy-MM-dd"), creating it if needed.</summary>
    void AddStats(string day, int ads, int popups, int redirects, int overlays);
}

/// <summary>
/// One profile's shield preferences per site and its running totals of what was blocked. Sites are
/// keyed by registrable domain, so a choice made on one subdomain holds across the site. Totals are
/// written to the store at most every five seconds.
/// </summary>
public sealed class ShieldState
{
    private readonly IShieldStore _store;
    private readonly TimeSpan _flushDelay;
    private readonly Func<DateTime> _now;
    private readonly Lock _lock = new();
    private readonly Dictionary<string, Prefs> _prefsByHost = new(StringComparer.Ordinal);
    private Counts _total;
    private Counts _pending;
    private Task? _flushTask;

    /// <param name="store">The profile database.</param>
    /// <param name="flushDelay">How long new counts wait before being written. Five seconds, as on the Mac.</param>
    /// <param name="now">The local clock, which decides the day counts are filed under.</param>
    public ShieldState(IShieldStore store, TimeSpan? flushDelay = null, Func<DateTime>? now = null)
    {
        _store = store;
        _flushDelay = flushDelay ?? TimeSpan.FromSeconds(5);
        _now = now ?? (() => DateTime.Now);
        try
        {
            foreach (var row in store.LoadSitePrefs())
            {
                _prefsByHost[row.Host] = new Prefs(row.ShieldsOff, row.AllowPopups, row.AllowRedirects, row.TrackingOff);
            }
        }
        catch (Exception)
        {
            _prefsByHost.Clear();
        }
        try
        {
            var total = store.LoadTotalStats();
            _total = new Counts(total.Ads, total.Popups, total.Redirects, total.Overlays);
        }
        catch (Exception)
        {
            _total = default;
        }
    }

    /// <summary>Raised when preferences or totals change.</summary>
    public event Action? Changed;

    /// <summary>The key preferences are stored under: the registrable domain, as DomainName.registrable gives it.</summary>
    public static string Key(string? host) => SiteDomain.Registrable(host ?? "");

    /// <summary>Preferences for a site, or the defaults (everything off) for one never changed.</summary>
    public (string Host, bool ShieldsOff, bool AllowPopups, bool AllowRedirects, bool TrackingOff) PrefsFor(string? host)
    {
        var key = Key(host);
        lock (_lock)
        {
            var prefs = _prefsByHost.GetValueOrDefault(key);
            return (key, prefs.ShieldsOff, prefs.AllowPopups, prefs.AllowRedirects, prefs.TrackingOff);
        }
    }

    /// <summary>Every site with saved preferences.</summary>
    public IReadOnlyList<(string Host, bool ShieldsOff, bool AllowPopups, bool AllowRedirects, bool TrackingOff)> AllPrefs
    {
        get
        {
            lock (_lock)
            {
                return [.. _prefsByHost.Select(pair => (pair.Key, pair.Value.ShieldsOff, pair.Value.AllowPopups, pair.Value.AllowRedirects, pair.Value.TrackingOff))];
            }
        }
    }

    /// <summary>All shields are off on this site, the per-site switch in the shield panel.</summary>
    public bool ShieldsOff(string? host) => PrefsFor(host).ShieldsOff;

    public bool AllowPopups(string? host) => PrefsFor(host).AllowPopups;

    public bool AllowRedirects(string? host) => PrefsFor(host).AllowRedirects;

    /// <summary>For sites that aren't about films, like YouTube: nothing here goes on the timeline.</summary>
    public bool TrackingOff(string? host) => PrefsFor(host).TrackingOff;

    /// <summary>Changes the given preferences for a site and saves them. Does nothing without a host.</summary>
    public void Update(string? host, bool? shieldsOff = null, bool? allowPopups = null, bool? allowRedirects = null, bool? trackingOff = null)
    {
        if (host is null) return;
        var key = Key(host);
        Prefs prefs;
        lock (_lock)
        {
            prefs = _prefsByHost.GetValueOrDefault(key);
            prefs = new Prefs(
                shieldsOff ?? prefs.ShieldsOff,
                allowPopups ?? prefs.AllowPopups,
                allowRedirects ?? prefs.AllowRedirects,
                trackingOff ?? prefs.TrackingOff);
            _prefsByHost[key] = prefs;
        }
        try
        {
            _store.SaveSitePrefs(key, prefs.ShieldsOff, prefs.AllowPopups, prefs.AllowRedirects, prefs.TrackingOff);
        }
        catch (Exception)
        {
        }
        Changed?.Invoke();
    }

    /// <summary>Everything blocked so far, across all days.</summary>
    public (int Ads, int Popups, int Redirects, int Overlays) Total
    {
        get
        {
            lock (_lock) return (_total.Ads, _total.Popups, _total.Redirects, _total.Overlays);
        }
    }

    /// <summary>Counts newly blocked things. They reach the store within the flush delay.</summary>
    public void Record(int ads = 0, int popups = 0, int redirects = 0, int overlays = 0)
    {
        var delta = new Counts(ads, popups, redirects, overlays);
        lock (_lock)
        {
            _total += delta;
            _pending += delta;
            if (_flushTask is null) _flushTask = FlushLater();
        }
        Changed?.Invoke();
    }

    private async Task FlushLater()
    {
        // Resumes on the caller's context, the UI thread in the app, where the database is used.
        await Task.Delay(_flushDelay);
        Flush();
    }

    /// <summary>Writes pending counts now. Called on close, so nothing is lost.</summary>
    public void Flush()
    {
        Counts pending;
        lock (_lock)
        {
            _flushTask = null;
            if (_pending.Sum <= 0) return;
            pending = _pending;
            _pending = default;
        }
        try
        {
            _store.AddStats(_now().ToString("yyyy-MM-dd", CultureInfo.InvariantCulture), pending.Ads, pending.Popups, pending.Redirects, pending.Overlays);
        }
        catch (Exception)
        {
        }
    }

    private readonly record struct Prefs(bool ShieldsOff, bool AllowPopups, bool AllowRedirects, bool TrackingOff);

    private readonly record struct Counts(int Ads, int Popups, int Redirects, int Overlays)
    {
        public int Sum => Ads + Popups + Redirects + Overlays;

        public static Counts operator +(Counts a, Counts b) =>
            new(a.Ads + b.Ads, a.Popups + b.Popups, a.Redirects + b.Redirects, a.Overlays + b.Overlays);
    }
}
