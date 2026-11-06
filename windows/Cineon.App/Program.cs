using Cineon.App.Services;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Xaml;

namespace Cineon.App;

public static class Program
{
    [STAThread]
    public static void Main(string[] args)
    {
        // Velopack's install, update and uninstall hooks. Must run before anything else. They return
        // quickly and Velopack exits the process after them.
        Velopack.VelopackApp.Build()
            .OnAfterInstallFastCallback(_ => ProtocolRegistration.Register())
            .OnAfterUpdateFastCallback(_ => ProtocolRegistration.Register())
            .OnBeforeUninstallFastCallback(_ => ProtocolRegistration.Unregister())
            .Run();
        WinRT.ComWrappersSupport.InitializeComWrappers();
        // One Cineon at a time: a second launch hands its link to the running one and quits.
        if (SingleInstance.RedirectToRunning()) return;
        Application.Start(callback =>
        {
            var context = new DispatcherQueueSynchronizationContext(DispatcherQueue.GetForCurrentThread());
            SynchronizationContext.SetSynchronizationContext(context);
            _ = new App(args);
        });
    }
}
