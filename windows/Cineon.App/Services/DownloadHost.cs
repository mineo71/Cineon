using System.Diagnostics;
using System.Runtime.InteropServices;
using Cineon.Core.Data;
using Cineon.Core.Downloads;

namespace Cineon.App.Services;

/// The app around the download queue: toasts, the player, the Recycle Bin and File Explorer.
/// DownloadCenter calls it on the UI thread.
public sealed class DownloadHost(ProfileSession session) : IDownloadHost
{
    public void ShowToast(string message, string? actionTitle = null, Action? action = null) =>
        session.Toasts.Show(message, actionTitle, action);

    public void PlayDownload(DownloadItem item) => session.App?.PlayDownload(item);

    public void RefreshDownloadPills()
    {
        foreach (var tab in session.Browser.Tabs) tab.RefreshDownloadPill();
    }

    public void EnrichTitle(long titleId, string? altName) => session.Metadata.Enrich(titleId, altName);

    public void MoveToRecycleBin(IReadOnlyList<string> paths)
    {
        var existing = paths.Where(p => File.Exists(p) || Directory.Exists(p)).ToList();
        if (existing.Count == 0) return;
        _ = Task.Run(() =>
        {
            try
            {
                var operation = new FileOperation
                {
                    Function = FoDelete,
                    From = string.Join("\0", existing) + "\0\0",
                    Flags = FofAllowUndo | FofNoConfirmation | FofSilent | FofNoErrorUi,
                };
                SHFileOperation(ref operation);
            }
            catch (Exception error)
            {
                CrashLog.Write("recycle bin", error);
            }
        });
    }

    public void ShowInFileExplorer(string path, bool select)
    {
        try
        {
            var arguments = select ? $"/select,\"{path}\"" : $"\"{path}\"";
            Process.Start(new ProcessStartInfo("explorer.exe", arguments) { UseShellExecute = true });
        }
        catch (Exception error)
        {
            CrashLog.Write("file explorer", error);
        }
    }

    public async Task<double?> MediaDurationAsync(string file)
    {
        try
        {
            var storage = await Windows.Storage.StorageFile.GetFileFromPathAsync(file);
            var properties = await storage.Properties.GetVideoPropertiesAsync();
            var seconds = properties.Duration.TotalSeconds;
            return seconds > 0 ? seconds : null;
        }
        catch (Exception)
        {
            return null;
        }
    }

    private const uint FoDelete = 0x0003;
    private const ushort FofAllowUndo = 0x0040;
    private const ushort FofNoConfirmation = 0x0010;
    private const ushort FofSilent = 0x0004;
    private const ushort FofNoErrorUi = 0x0400;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct FileOperation
    {
        public IntPtr Window;
        public uint Function;
        [MarshalAs(UnmanagedType.LPWStr)] public string From;
        [MarshalAs(UnmanagedType.LPWStr)] public string? To;
        public ushort Flags;
        [MarshalAs(UnmanagedType.Bool)] public bool AnyOperationsAborted;
        public IntPtr NameMappings;
        [MarshalAs(UnmanagedType.LPWStr)] public string? ProgressTitle;
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    private static extern int SHFileOperation(ref FileOperation operation);
}
