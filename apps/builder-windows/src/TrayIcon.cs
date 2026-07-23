using System;
using System.Drawing;
using System.Linq;
using System.Threading.Tasks;
using System.Windows;
using Flagship.Builder.VM;
using Forms = System.Windows.Forms;

namespace Flagship.Builder;

/// <summary>Native Windows notification-area controls for locally hosted servers.</summary>
internal sealed class TrayIcon : IDisposable
{
    private readonly MainWindow _window;
    private readonly VMManager _vm;
    private readonly Forms.NotifyIcon _icon;
    private readonly Forms.ContextMenuStrip _menu = new();

    public TrayIcon(MainWindow window, VMManager vm)
    {
        _window = window;
        _vm = vm;
        _menu.Opening += (_, _) => RebuildMenu();

        _icon = new Forms.NotifyIcon
        {
            Text = "Flagship Studio",
            Icon = LoadIcon(),
            ContextMenuStrip = _menu,
            Visible = true,
        };
        _icon.DoubleClick += (_, _) => OpenWindow();
    }

    private static Icon LoadIcon()
    {
        try
        {
            var resource = System.Windows.Application.GetResourceStream(
                new Uri("pack://application:,,,/assets/Flagship.ico"));
            if (resource?.Stream is not null)
            {
                using var source = new Icon(resource.Stream);
                return (Icon)source.Clone();
            }
        }
        catch { }
        return (Icon)SystemIcons.Application.Clone();
    }

    private void RebuildMenu()
    {
        _menu.Items.Clear();
        _menu.Items.Add(Item("Open Flagship Studio", OpenWindow));
        _menu.Items.Add(new Forms.ToolStripSeparator());

        foreach (var server in _vm.Servers.OrderBy(s => s.Fqdn, StringComparer.OrdinalIgnoreCase))
        {
            var serverMenu = new Forms.ToolStripMenuItem(server.Fqdn);
            if (server.CanStart)
                serverMenu.DropDownItems.Add(Item("Start", () => RunAsync(() => _vm.PowerOnAsync(server.Name))));
            if (server.CanStop)
            {
                serverMenu.DropDownItems.Add(Item("Stop", () => RunAsync(() => _vm.PowerOffAsync(server.Name))));
                serverMenu.DropDownItems.Add(Item("Restart", () => RunAsync(() => RestartAsync(server.Name))));
            }
            if (serverMenu.DropDownItems.Count == 0)
            {
                var status = new Forms.ToolStripMenuItem(server.StateLabel) { Enabled = false };
                serverMenu.DropDownItems.Add(status);
            }
            _menu.Items.Add(serverMenu);
        }

        if (_vm.Servers.Count == 0)
            _menu.Items.Add(new Forms.ToolStripMenuItem("No servers hosted yet") { Enabled = false });

        var running = _vm.Servers.Where(s => s.CanStop).Select(s => s.Name).ToArray();
        _menu.Items.Add(new Forms.ToolStripSeparator());
        var stopAll = Item("Stop all running servers", () =>
            RunAsync(() => Task.WhenAll(running.Select(_vm.PowerOffAsync))));
        stopAll.Enabled = running.Length > 0;
        _menu.Items.Add(stopAll);
        _menu.Items.Add(new Forms.ToolStripSeparator());
        _menu.Items.Add(Item("Quit Flagship Studio", () => _window.Close()));
    }

    private async Task RestartAsync(string name)
    {
        await _vm.PowerOffAsync(name);
        if (_vm.Server(name)?.CanStart == true)
            await _vm.PowerOnAsync(name);
    }

    private void RunAsync(Func<Task> action)
    {
        _window.Dispatcher.InvokeAsync(async () =>
        {
            try { await action(); }
            catch (Exception error)
            {
                System.Windows.MessageBox.Show(_window, error.Message, "Flagship Studio",
                    MessageBoxButton.OK, MessageBoxImage.Error);
            }
        });
    }

    private Forms.ToolStripMenuItem Item(string text, Action action)
    {
        var item = new Forms.ToolStripMenuItem(text);
        item.Click += (_, _) => _window.Dispatcher.Invoke(action);
        return item;
    }

    private void OpenWindow()
    {
        _window.Dispatcher.Invoke(() =>
        {
            if (!_window.IsVisible) _window.Show();
            if (_window.WindowState == WindowState.Minimized)
                _window.WindowState = WindowState.Normal;
            _window.Activate();
            _window.Topmost = true;
            _window.Topmost = false;
            _window.Focus();
        });
    }

    public void Dispose()
    {
        _icon.Visible = false;
        _icon.Dispose();
        _menu.Dispose();
    }
}
