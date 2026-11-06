using System.ComponentModel;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace Cineon.App.UI;

/// Anything that says it changed. App models implement it; Core stores may use INotifyPropertyChanged
/// instead, and `Component.Watch` takes either.
public interface IChangeNotifier
{
    event Action? Changed;
}

/// A base for models in the app: call `Notify()` after changing state.
public abstract class Observable : IChangeNotifier
{
    public event Action? Changed;
    protected void Notify() => Changed?.Invoke();

    /// Sets a field and notifies when the value is different.
    protected bool Set<T>(ref T field, T value)
    {
        if (EqualityComparer<T>.Default.Equals(field, value)) return false;
        field = value;
        Notify();
        return true;
    }
}

/// A view that builds its content from state, like a SwiftUI view's `body`. It builds once when it's
/// loaded, and again (at most once per frame) when the theme or anything it watches changes.
///
///     sealed class Greeting : Component
///     {
///         private readonly AppModel _app;
///         public Greeting(AppModel app) { _app = app; Watch(app); }
///         protected override UIElement Render() => Ui.Text($"Hi, {_app.Session.Profile.Name}", Typeface.Title(20));
///     }
public abstract class Component : UserControl
{
    private readonly List<(Action subscribe, Action unsubscribe)> _watches = [];
    private bool _pending;
    private bool _attached;

    protected Component()
    {
        IsTabStop = false;
        HorizontalContentAlignment = HorizontalAlignment.Stretch;
        VerticalContentAlignment = VerticalAlignment.Stretch;
        Loaded += (_, _) =>
        {
            if (!_attached)
            {
                _attached = true;
                Theme.Changed += Invalidate;
                foreach (var watch in _watches) watch.subscribe();
                OnAppeared();
            }
            if (Content is null) RenderNow();
        };
        Unloaded += (_, _) =>
        {
            if (!_attached) return;
            _attached = false;
            Theme.Changed -= Invalidate;
            foreach (var watch in _watches) watch.unsubscribe();
            OnDisappeared();
        };
    }

    protected abstract UIElement Render();

    protected virtual void OnAppeared() { }
    protected virtual void OnDisappeared() { }

    /// Rebuilds on the next frame. Many changes in a row cost one rebuild.
    public void Invalidate()
    {
        if (_pending) return;
        _pending = true;
        var queue = DispatcherQueue;
        if (queue is null || !queue.TryEnqueue(() => { _pending = false; RenderNow(); }))
        {
            _pending = false;
            RenderNow();
        }
    }

    /// Rebuilds right away.
    public void RenderNow()
    {
        _pending = false;
        Content = Render();
    }

    /// Rebuilds whenever `source` changes, while this view is on screen.
    protected void Watch(IChangeNotifier source)
    {
        void Handler() => Invalidate();
        Add(() => source.Changed += Handler, () => source.Changed -= Handler);
    }

    protected void Watch(INotifyPropertyChanged source)
    {
        void Handler(object? sender, PropertyChangedEventArgs e) => Invalidate();
        Add(() => source.PropertyChanged += Handler, () => source.PropertyChanged -= Handler);
    }

    /// Any other event: pass how to subscribe and unsubscribe `Invalidate`.
    protected void Watch(Action<Action> subscribe, Action<Action> unsubscribe)
    {
        Action handler = Invalidate;
        Add(() => subscribe(handler), () => unsubscribe(handler));
    }

    private void Add(Action subscribe, Action unsubscribe)
    {
        _watches.Add((subscribe, unsubscribe));
        if (_attached) subscribe();
    }
}

/// A component built from a function, for small pieces that don't need their own class.
public sealed class Live : Component
{
    private readonly Func<UIElement> _render;

    public Live(Func<UIElement> render, params IChangeNotifier[] sources)
    {
        _render = render;
        foreach (var source in sources) Watch(source);
    }

    protected override UIElement Render() => _render();
}
