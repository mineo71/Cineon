using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using Cineon.Core.Data;
using Microsoft.Win32;
using Microsoft.Windows.AppLifecycle;
using Microsoft.Windows.AppNotifications;
using Windows.ApplicationModel.Activation;

namespace Cineon.App.Services;

/// One Cineon at a time, like the Mac app. A second launch (a `cineon://` link, a Jump List task,
/// the Start menu) hands what it was asked to do to the running copy and quits.
///
/// Each data folder gets its own instance, so a test run on scratch data never talks to the real app.
public static class SingleInstance
{
    private static readonly object Gate = new();
    private static readonly List<AppActivationArguments> Pending = [];
    private static Action<AppActivationArguments>? _handler;

    /// How this copy was started.
    public static AppActivationArguments? Launch { get; private set; }

    private static string Key
    {
        get
        {
            var root = AppPaths.Root.TrimEnd('\\', '/').ToLowerInvariant();
            var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(root)));
            return "Cineon-" + hash[..16];
        }
    }

    /// True when another copy is running and now has this launch: the caller should exit.
    /// Called from Main before the UI starts.
    public static bool RedirectToRunning()
    {
        try
        {
            var current = AppInstance.GetCurrent();
            Launch = current.GetActivatedEventArgs();
            var main = AppInstance.FindOrRegisterForKey(Key);
            if (main.IsCurrent)
            {
                main.Activated += (_, args) => Deliver(args);
                return false;
            }
            // Lets the running copy bring its window to the front.
            AllowSetForegroundWindow(main.ProcessId);
            Redirect(Launch, main);
            return true;
        }
        catch (Exception error)
        {
            CrashLog.Write("single instance", error);
            return false;
        }
    }

    /// Where later launches go once the app is ready. They arrive on a background thread.
    public static void OnActivated(Action<AppActivationArguments> handler)
    {
        List<AppActivationArguments> waiting;
        lock (Gate)
        {
            _handler = handler;
            waiting = [.. Pending];
            Pending.Clear();
        }
        foreach (var args in waiting) handler(args);
    }

    private static void Deliver(AppActivationArguments args)
    {
        Action<AppActivationArguments>? handler;
        lock (Gate)
        {
            handler = _handler;
            if (handler is null) Pending.Add(args);
        }
        handler?.Invoke(args);
    }

    /// Waits for the hand-over while letting COM calls through, as an STA thread must.
    private static void Redirect(AppActivationArguments args, AppInstance target)
    {
        using var done = new ManualResetEvent(false);
        _ = Task.Run(() =>
        {
            try { target.RedirectActivationToAsync(args).AsTask().Wait(TimeSpan.FromSeconds(10)); }
            catch (Exception) { }
            finally { done.Set(); }
        });
        CoWaitForMultipleObjects(0, 15_000, 1, [done.SafeWaitHandle.DangerousGetHandle()], out _);
    }

    [DllImport("ole32.dll")]
    private static extern int CoWaitForMultipleObjects(uint flags, uint timeout, uint count, IntPtr[] handles, out uint index);

    [DllImport("user32.dll")]
    private static extern bool AllowSetForegroundWindow(uint processId);
}

/// What a launch asked for: `cineon://` links on the command line or from the protocol, and
/// clicked notifications.
public static class Activation
{
    public static void Handle(AppActivationArguments? args, AppModel app, IEnumerable<string>? commandLine = null)
    {
        var links = new List<Uri>();
        if (commandLine is not null) links.AddRange(commandLine.SelectMany(DeepLink.Find));
        if (args is not null)
        {
            switch (args.Kind)
            {
                case ExtendedActivationKind.Launch when args.Data is ILaunchActivatedEventArgs launch:
                    links.AddRange(DeepLink.Find(launch.Arguments));
                    break;
                case ExtendedActivationKind.Protocol when args.Data is IProtocolActivatedEventArgs protocol:
                    links.Add(protocol.Uri);
                    break;
                case ExtendedActivationKind.AppNotification when args.Data is AppNotificationActivatedEventArgs notification:
                    Notifications.Open(notification);
                    break;
            }
        }
        foreach (var link in links.DistinctBy(l => l.OriginalString)) DeepLink.Handle(link, app);
    }
}

/// Registers `cineon://` for this user under HKCU\Software\Classes, pointing at this copy of Cineon.
/// Runs from Velopack's install and update hooks, and on launch in case the install moved.
public static class ProtocolRegistration
{
    private const string KeyPath = @"Software\Classes\" + DeepLink.Scheme;

    private static string Command(string exe) => $"\"{exe}\" \"%1\"";

    /// Writes the registration when it's missing or names another copy. Not for test runs, which
    /// mustn't take links away from the installed app.
    public static void EnsureRegistered()
    {
        if (AppPaths.IsScratch || Environment.ProcessPath is not { } exe) return;
        try
        {
            using var command = Registry.CurrentUser.OpenSubKey(KeyPath + @"\shell\open\command");
            if (command?.GetValue(null) as string == Command(exe)) return;
        }
        catch (Exception)
        {
        }
        Register();
    }

    public static void Register()
    {
        if (Environment.ProcessPath is not { } exe) return;
        try
        {
            using var key = Registry.CurrentUser.CreateSubKey(KeyPath);
            key.SetValue(null, "URL:Cineon");
            key.SetValue("URL Protocol", "");
            using (var icon = key.CreateSubKey("DefaultIcon")) icon.SetValue(null, $"\"{exe}\",0");
            using var command = key.CreateSubKey(@"shell\open\command");
            command.SetValue(null, Command(exe));
        }
        catch (Exception error)
        {
            CrashLog.Write("protocol", error);
        }
    }

    public static void Unregister()
    {
        try { Registry.CurrentUser.DeleteSubKeyTree(KeyPath, throwOnMissingSubKey: false); }
        catch (Exception) { }
    }
}
