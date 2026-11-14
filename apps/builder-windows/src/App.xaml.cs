using System.Windows;

namespace Flagship.Builder;

/// <summary>
/// WPF entry. Owns the app lifetime + global resources from App.xaml.
/// Mirrors FlagshipBuilderApp.swift / flagship-builder.py. We create the
/// MainWindow explicitly in OnStartup so the XAML doesn't have to know
/// the relative path of the source file (StartupUri pack-URI gymnastics
/// are easy to get wrong when sources sit under src/).
/// </summary>
public partial class App : Application
{
    protected override async void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);
        // Started by "Restart as administrator": the copy that asked is still shutting its servers down, and their
        // disks are in use until it exits (W10).
        var handoff = ElevationHandoff.Parse(e.Args);
        if (handoff is not null)
        {
            ShutdownMode = ShutdownMode.OnExplicitShutdown;
            await ElevationHandoff.WaitForExitAsync(handoff.Pid, ElevationHandoff.WaitForOldCopy);
            ShutdownMode = ShutdownMode.OnLastWindowClose;
        }
        var window = new MainWindow(handoff?.Resume);
        MainWindow = window;
        window.Show();
    }
}
