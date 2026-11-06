namespace Cineon.Core.Tests;

public class SmokeTests
{
    [Fact]
    public void TheCoreLoads() => Assert.Equal("Cineon", AppInfo.Name);
}
