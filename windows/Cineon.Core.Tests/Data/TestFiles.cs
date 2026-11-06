using System.Runtime.CompilerServices;

namespace Cineon.Core.Tests.Data;

/// <summary>A throwaway folder under the system temp folder, removed afterwards.</summary>
internal sealed class TempFolder : IDisposable
{
    public string Path { get; } = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "cineon-test-" + Guid.NewGuid().ToString("N"));

    public TempFolder() => Directory.CreateDirectory(Path);

    public string File(string name) => System.IO.Path.Combine(Path, name);

    public void Dispose()
    {
        try
        {
            Directory.Delete(Path, true);
        }
        catch (IOException)
        {
        }
    }
}

internal static class Fixtures
{
    /// <summary>
    /// A file in Cineon.Core.Tests/Fixtures. The project doesn't copy fixtures to the output, so they're
    /// found next to this source file, or by walking up from the test binaries.
    /// </summary>
    public static string PathOf(string name, [CallerFilePath] string sourceFile = "")
    {
        var nextToSource = Path.Combine(Path.GetDirectoryName(sourceFile) ?? "", "..", "Fixtures", name);
        if (File.Exists(nextToSource)) return Path.GetFullPath(nextToSource);
        for (var dir = new DirectoryInfo(AppContext.BaseDirectory); dir is not null; dir = dir.Parent)
        {
            var candidate = Path.Combine(dir.FullName, "Cineon.Core.Tests", "Fixtures", name);
            if (File.Exists(candidate)) return candidate;
            candidate = Path.Combine(dir.FullName, "Fixtures", name);
            if (File.Exists(candidate)) return candidate;
        }
        throw new FileNotFoundException($"Fixture {name} not found");
    }

    /// <summary>Copies a fixture into <paramref name="folder"/>, so opening it never changes the original.</summary>
    public static string CopyTo(TempFolder folder, string name, string targetName)
    {
        var target = folder.File(targetName);
        File.Copy(PathOf(name), target);
        return target;
    }
}
