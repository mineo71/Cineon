using Cineon.App.Services;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Markup;
using Microsoft.UI.Xaml.XamlTypeInfo;

namespace Cineon.App;

/// The app has no XAML files, so it hands WinUI the control library's type information itself.
/// The XAML compiler would otherwise generate this.
public sealed class App : Application, IXamlMetadataProvider
{
    private readonly XamlControlsXamlMetaDataProvider _types = new();
    private readonly string[] _args;
    private UI.MainWindow? _window;

    /// The app's state. Made in OnLaunched, on the UI thread, before the window.
    public static AppModel Model { get; private set; } = null!;

    public App(string[] args)
    {
        _args = args;
        UnhandledException += (_, e) => CrashLog.Write("UI thread", e.Exception);
        AppDomain.CurrentDomain.UnhandledException += (_, e) => CrashLog.Write("domain", e.ExceptionObject as Exception);
        TaskScheduler.UnobservedTaskException += (_, e) => { CrashLog.Write("task", e.Exception); e.SetObserved(); };
    }

    protected override void OnLaunched(LaunchActivatedEventArgs args)
    {
        Resources.MergedDictionaries.Add(new XamlControlsResources());
        Model = new AppModel();
        var window = new UI.MainWindow(Model);
        _window = window;
        window.Closed += (_, _) => Quit();
        window.Activate();
        Model.AttachWindow(window, window.Handle);

        // What the Mac's app delegate and CineonApp set up: notifications, the updater, links. None
        // of them is worth failing the launch over.
        Notifications.Install(window.DispatcherQueue);
        JumpList.Install();
        ProtocolRegistration.EnsureRegistered();
        Guard("updater", () => UI.UpdatePrompt.Attach(window, Model));

        // Later launches hand over their links; this one may have come with some too.
        SingleInstance.OnActivated(activation => window.DispatcherQueue.TryEnqueue(() =>
        {
            window.BringToFront();
            Guard("activation", () => Activation.Handle(activation, Model));
        }));
        Guard("launch", () => Activation.Handle(LaunchActivation(), Model, _args));
    }

    private static void Guard(string what, Action action)
    {
        try { action(); }
        catch (Exception error) { CrashLog.Write(what, error); }
    }

    /// How this copy was started. A click on a notification while Cineon was closed only reads as
    /// one once notifications are registered, so it's asked again after that.
    private static Microsoft.Windows.AppLifecycle.AppActivationArguments? LaunchActivation()
    {
        if (!Notifications.IsRegistered) return SingleInstance.Launch;
        try { return Microsoft.Windows.AppLifecycle.AppInstance.GetCurrent().GetActivatedEventArgs(); }
        catch (Exception) { return SingleInstance.Launch; }
    }

    /// The Mac's applicationWillTerminate.
    private static void Quit()
    {
        Model.PrepareToQuit();
        Notifications.Uninstall();
    }

    public IXamlType GetXamlType(Type type) => _types.GetXamlType(type);
    public IXamlType GetXamlType(string fullName) => _types.GetXamlType(fullName);
    public XmlnsDefinition[] GetXmlnsDefinitions() => _types.GetXmlnsDefinitions();
}

/// Writes what crashed to `crash.log` in the data folder, so a crash on a test machine says why.
public static class CrashLog
{
    public static void Write(string where, Exception? error)
    {
        try
        {
            var folder = Environment.GetEnvironmentVariable("CINEON_DATA_DIR")
                ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Cineon");
            Directory.CreateDirectory(folder);
            File.AppendAllText(Path.Combine(folder, "crash.log"), $"{DateTime.Now:O} [{where}] {error}\n\n");
        }
        catch
        {
            // Nothing more to do if even this fails.
        }
    }
}
