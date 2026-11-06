using Cineon.Core.Data;
using Cineon.Core.Shields;

namespace Cineon.App.Services;

/// Keeps a profile's shield preferences and blocked counts in its database (the `site_prefs` and
/// `stats` tables), the store the Mac's ShieldState writes to directly.
public sealed class DatabaseShieldStore(Database db) : IShieldStore
{
    public IEnumerable<(string Host, bool ShieldsOff, bool AllowPopups, bool AllowRedirects, bool TrackingOff)> LoadSitePrefs() =>
        [.. db.SitePrefs().Values.Select(p => (p.Host, p.ShieldsOff, p.AllowPopups, p.AllowRedirects, p.TrackingOff))];

    public void SaveSitePrefs(string host, bool shieldsOff, bool allowPopups, bool allowRedirects, bool trackingOff) =>
        db.SaveSitePrefs(new SitePrefs(host)
        {
            ShieldsOff = shieldsOff,
            AllowPopups = allowPopups,
            AllowRedirects = allowRedirects,
            TrackingOff = trackingOff,
        });

    public (int Ads, int Popups, int Redirects, int Overlays) LoadTotalStats()
    {
        var total = db.TotalStats();
        return (total.Ads, total.Popups, total.Redirects, total.Overlays);
    }

    public void AddStats(string day, int ads, int popups, int redirects, int overlays) =>
        db.AddStats(new ShieldStats { Ads = ads, Popups = popups, Redirects = redirects, Overlays = overlays }, day);
}
