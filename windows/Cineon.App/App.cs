using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace Cineon.App;

public sealed class App : Application
{
    private readonly string[] _args;
    private Window? _window;

    public App(string[] args)
    {
        _args = args;
    }

    protected override void OnLaunched(LaunchActivatedEventArgs args)
    {
        Resources.MergedDictionaries.Add(new XamlControlsResources());
        _window = new Window { Title = "Cineon", Content = new TextBlock { Text = "Cineon" } };
        _window.Activate();
    }
}
