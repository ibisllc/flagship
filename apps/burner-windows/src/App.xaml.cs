using System.Windows;

namespace Flagship.Burner;

/// <summary>
/// WPF entry. Owns the app lifetime + global resources from App.xaml.
/// Mirrors FlagshipBurnerApp.swift / flagship-burner.py. We create the
/// MainWindow explicitly in OnStartup so the XAML doesn't have to know
/// the relative path of the source file (StartupUri pack-URI gymnastics
/// are easy to get wrong when sources sit under src/).
/// </summary>
public partial class App : Application
{
    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);
        var window = new MainWindow();
        MainWindow = window;
        window.Show();
    }
}
