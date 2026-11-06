namespace Cineon.Core.Data;

/// <summary>
/// Dates the way the Mac app stores them. The database keeps seconds since 1970 as a REAL
/// (<c>timeIntervalSince1970</c>); JSON written by Swift's default <c>JSONEncoder</c>, such as
/// <c>profiles.json</c>, keeps seconds since 1 January 2001 (<c>timeIntervalSinceReferenceDate</c>).
/// Conversions round-trip a Mac-written value exactly.
/// </summary>
public static class StoredDate
{
    /// <summary>Swift's reference date, 2001-01-01 00:00 UTC, in seconds since 1970.</summary>
    public const double ReferenceDateUnixSeconds = 978_307_200;

    /// <summary>Swift's <c>Date.distantFuture</c> in seconds since 1970.</summary>
    public const double DistantFutureUnixSeconds = 64_092_211_200;

    private static readonly long UnixEpochTicks = DateTimeOffset.UnixEpoch.UtcTicks;
    private static readonly long ReferenceTicks = UnixEpochTicks + 978_307_200L * TimeSpan.TicksPerSecond;

    /// <summary>Seconds since 1970, as the database keeps them.</summary>
    public static double ToUnix(DateTimeOffset date) => ToSeconds(date, UnixEpochTicks);

    public static DateTimeOffset FromUnix(double seconds) => FromSeconds(seconds, UnixEpochTicks);

    /// <summary>Seconds since 2001, as Swift's <c>JSONEncoder</c> writes a <c>Date</c>.</summary>
    public static double ToReference(DateTimeOffset date) => ToSeconds(date, ReferenceTicks);

    public static DateTimeOffset FromReference(double seconds) => FromSeconds(seconds, ReferenceTicks);

    private static double ToSeconds(DateTimeOffset date, long epochTicks)
    {
        // Whole seconds and the remainder separately, so no precision is lost on the way to a double.
        var ticks = date.UtcTicks - epochTicks;
        var whole = ticks / TimeSpan.TicksPerSecond;
        var rest = ticks % TimeSpan.TicksPerSecond;
        return whole + rest / (double)TimeSpan.TicksPerSecond;
    }

    private static DateTimeOffset FromSeconds(double seconds, long epochTicks)
    {
        if (double.IsNaN(seconds)) return new DateTimeOffset(epochTicks, TimeSpan.Zero);
        var minSeconds = (DateTimeOffset.MinValue.UtcTicks - epochTicks) / (double)TimeSpan.TicksPerSecond;
        var maxSeconds = (DateTimeOffset.MaxValue.UtcTicks - epochTicks) / (double)TimeSpan.TicksPerSecond;
        if (seconds <= minSeconds) return DateTimeOffset.MinValue;
        if (seconds >= maxSeconds) return DateTimeOffset.MaxValue;
        var whole = Math.Floor(seconds);
        var fraction = seconds - whole;
        var ticks = epochTicks + (long)whole * TimeSpan.TicksPerSecond + (long)Math.Round(fraction * TimeSpan.TicksPerSecond);
        ticks = Math.Clamp(ticks, DateTimeOffset.MinValue.UtcTicks, DateTimeOffset.MaxValue.UtcTicks);
        return new DateTimeOffset(ticks, TimeSpan.Zero);
    }
}
