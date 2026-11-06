using System.Globalization;

namespace Cineon.App.UI;

/// Dates as the Mac's `DateText` writes them. `Day` and `Time` live with the library screens; this
/// half has `relative`, for the import sheet.
public static partial class DateText
{
    /// "3 days ago", "in 2 hours": Foundation's RelativeDateTimeFormatter, full units, numeric. It
    /// names the largest calendar unit that differs: years, months, weeks, days, hours, minutes, seconds.
    public static string Relative(DateTimeOffset date, DateTimeOffset? relativeTo = null)
    {
        var now = (relativeTo ?? DateTimeOffset.Now).LocalDateTime;
        var then = date.LocalDateTime;
        var future = then > now;
        var (from, to) = future ? (now, then) : (then, now);

        var months = (to.Year - from.Year) * 12 + to.Month - from.Month;
        if (from.AddMonths(months) > to) months--;
        var (count, unit) = months >= 12 ? (months / 12, "year")
            : months >= 1 ? (months, "month")
            : Smaller(to - from);
        var words = $"{count} {unit}{(count == 1 ? "" : "s")}";
        return future ? $"in {words}" : $"{words} ago";

        static (int, string) Smaller(TimeSpan span) =>
            span.TotalDays >= 7 ? ((int)(span.TotalDays / 7), "week")
            : span.TotalDays >= 1 ? ((int)span.TotalDays, "day")
            : span.TotalHours >= 1 ? ((int)span.TotalHours, "hour")
            : span.TotalMinutes >= 1 ? ((int)span.TotalMinutes, "minute")
            : ((int)span.TotalSeconds, "second");
    }
}

/// Sizes the way the Mac's `ByteCountFormatter.string(fromByteCount:countStyle: .file)` writes them:
/// powers of 1000, whole kilobytes, one decimal for megabytes and two above, no trailing zeros.
public static class ByteCount
{
    private static readonly string[] Units = ["KB", "MB", "GB", "TB", "PB", "EB"];
    private static readonly string[] Patterns = ["0", "0.#", "0.##", "0.##", "0.##", "0.##"];

    public static string File(long bytes)
    {
        if (bytes == 0) return "Zero KB";
        if (Math.Abs(bytes) < 1000) return Math.Abs(bytes) == 1 ? $"{bytes} byte" : $"{bytes} bytes";
        var value = bytes / 1000.0;
        var unit = 0;
        while (Math.Abs(value) >= 1000 && unit < Units.Length - 1)
        {
            value /= 1000;
            unit++;
        }
        // 999,999 bytes rounds to 1,000 KB, which reads better as 1 MB.
        if (Math.Abs(Math.Round(value, unit == 0 ? 0 : unit == 1 ? 1 : 2, MidpointRounding.AwayFromZero)) >= 1000 && unit < Units.Length - 1)
        {
            value /= 1000;
            unit++;
        }
        return value.ToString(Patterns[unit], CultureInfo.CurrentCulture) + " " + Units[unit];
    }
}
