using System.Reflection;

namespace Cineon.Core.Data;

// Port of AppPaths at the bottom of Cineon/Shields/FilterEngine.swift.

/// <summary>Where Cineon keeps its files: <c>%LOCALAPPDATA%\Cineon</c>, or a throwaway folder.</summary>
public static class AppPaths
{
    public const string DataDirVariable = "CINEON_DATA_DIR";

    // Static initialisers run in order: IsTestRun has to come before IsScratch.

    /// <summary>Running inside a unit test host, like the Mac's <c>XCTestConfigurationFilePath</c> check.</summary>
    public static bool IsTestRun { get; } = DetectTestRun();

    /// <summary>
    /// A test run with throwaway data. It mustn't ask for permissions that would stick to the real
    /// app. True when <c>CINEON_DATA_DIR</c> is set or the code runs inside a test host.
    /// </summary>
    public static bool IsScratch { get; } = Environment.GetEnvironmentVariable(DataDirVariable) is not null || IsTestRun;

    private static readonly Lazy<string> RootDirectory = new(() =>
    {
        var dir = ResolveRoot(
            Environment.GetEnvironmentVariable(DataDirVariable),
            IsTestRun,
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData, Environment.SpecialFolderOption.DoNotVerify),
            Path.GetTempPath());
        try
        {
            Directory.CreateDirectory(dir);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
        }
        return dir;
    });

    /// <summary>The data folder, created on first use.</summary>
    public static string Root => RootDirectory.Value;

    /// <summary>The rule that picks <see cref="Root"/>, apart so it can be tested without touching real data.</summary>
    internal static string ResolveRoot(string? overrideDir, bool isTestRun, string localAppData, string tempDir)
    {
        // Lets test runs use a throwaway folder and leave real data alone.
        if (overrideDir is not null) return Path.GetFullPath(overrideDir);
        if (isTestRun) return Path.Combine(tempDir, "CineonTests-" + Guid.NewGuid().ToString("D").ToUpperInvariant());
        return Path.Combine(localAppData, "Cineon");
    }

    /// <summary>One person's folder, <c>Profiles\&lt;UUID&gt;</c>, created on first use. Holds their database.</summary>
    public static string Profile(Guid id) => ProfileDirectory(Root, id);

    internal static string ProfileDirectory(string root, Guid id)
    {
        var dir = Path.Combine(root, "Profiles", Database.UuidString(id));
        try
        {
            Directory.CreateDirectory(dir);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
        }
        return dir;
    }

    /// <summary>
    /// Where downloads go when the settings name no folder: a Cineon folder in Videos, or, for test
    /// runs with <c>CINEON_DATA_DIR</c>, a Movies folder with the rest of their throwaway data.
    /// </summary>
    public static string DefaultDownloadsFolder
    {
        get
        {
            if (Environment.GetEnvironmentVariable(DataDirVariable) is not null) return Path.Combine(Root, "Movies");
            var videos = Environment.GetFolderPath(Environment.SpecialFolder.MyVideos, Environment.SpecialFolderOption.DoNotVerify);
            if (string.IsNullOrEmpty(videos))
            {
                videos = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Videos");
            }
            return Path.Combine(videos, "Cineon");
        }
    }

    /// <summary>The Mac's <c>DownloadCenter.folder(settings:)</c>: the chosen folder, or the default.</summary>
    public static string DownloadsFolder(AppSettings settings)
    {
        var custom = settings.DownloadsFolder.Trim(' ', '\t', ' ', '　');
        return custom.Length > 0 ? custom : DefaultDownloadsFolder;
    }

    private static bool DetectTestRun()
    {
        var entry = Assembly.GetEntryAssembly()?.GetName().Name ?? "";
        if (entry.EndsWith(".Tests", StringComparison.OrdinalIgnoreCase) || entry.StartsWith("testhost", StringComparison.OrdinalIgnoreCase))
        {
            return true;
        }
        return AppDomain.CurrentDomain.GetAssemblies().Any(a =>
            a.GetName().Name is { } name &&
            (name.StartsWith("xunit", StringComparison.OrdinalIgnoreCase) || name.StartsWith("Microsoft.Testing.Platform", StringComparison.Ordinal)));
    }
}
