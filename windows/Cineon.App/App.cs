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
    private Window? _window;
    public static AppModel Model { get; } = new();

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
        _window = new UI.MainWindow(Model);
        _window.Activate();
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
