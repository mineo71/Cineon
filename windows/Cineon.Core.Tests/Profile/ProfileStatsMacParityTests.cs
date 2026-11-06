using Cineon.Core.Profile;
using Cineon.Core.Tests.Profile.MacParity;

namespace Cineon.Core.Tests.Profile;

/// <summary>
/// Agreement with the Mac's ProfileStats: 300 generated libraries (titles, sessions, progress) per time zone,
/// every field printed, compared by FNV-1a hash with what MacParity/StatsDump.swift printed when compiled with
/// the Mac's Models.swift, ProfileStats.swift and PixelPet.swift. Set CINEON_PET_DUMP to a folder to get the
/// text for a diff.
/// </summary>
public class ProfileStatsMacParityTests
{
    [Theory]
    [InlineData("UTC", "fb51d6992ef89170")]
    [InlineData("Europe/Berlin", "23ff2a41ad5d37e0")]
    [InlineData("America/Los_Angeles", "b69424fa84642e0e")]
    [InlineData("Asia/Kolkata", "c3e0d3ea213d214f")]
    [InlineData("Pacific/Chatham", "58e241675cf684f7")]
    public void MatchesTheMac(string zone, string expected)
    {
        var text = StatsDump.Zone(zone);
        if (Environment.GetEnvironmentVariable("CINEON_PET_DUMP") is { Length: > 0 } dir)
        {
            Directory.CreateDirectory(dir);
            File.WriteAllText(Path.Combine(dir, "stats-" + zone.Replace('/', '-') + ".txt"), text);
        }
        Assert.Equal(expected, PixelPet.StableHash(text).ToString("x"));
    }
}
