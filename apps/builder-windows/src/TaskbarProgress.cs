using System.Windows;
using System.Windows.Shell;

namespace Flagship.Builder;

/// <summary>Mirrors the wizard's progress bar on the taskbar button, like the
/// Mac's Dock progress: a long download or USB write shows while the window
/// is behind others.</summary>
internal static class TaskbarProgress
{
    public static void Show(bool running, double? fraction)
    {
        var window = Application.Current?.MainWindow;
        if (window is null) return;
        if (!window.Dispatcher.CheckAccess())
        {
            window.Dispatcher.BeginInvoke(() => Show(running, fraction));
            return;
        }
        var info = window.TaskbarItemInfo ??= new TaskbarItemInfo();
        if (!running)
        {
            info.ProgressState = TaskbarItemProgressState.None;
            return;
        }
        if (fraction is double f)
        {
            info.ProgressState = TaskbarItemProgressState.Normal;
            info.ProgressValue = f;
        }
        else
        {
            info.ProgressState = TaskbarItemProgressState.Indeterminate;
        }
    }
}
