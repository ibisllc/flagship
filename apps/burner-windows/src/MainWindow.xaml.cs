using System;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Data;
using System.Windows.Media;
using Flagship.Burner.VM;
using Microsoft.Win32;

namespace Flagship.Burner;

/// <summary>
/// Single-window Burner wizard. Three drop-rows (Recipe → ISO → USB
/// Drive) stacked vertically, a big Bake button below, and a collapsed
/// log drawer at the bottom. Mirrors apps/burner-mac's WizardView 1:1.
///
/// The wizard model (state + CLI invocation) lives in Wizard.cs and is
/// surfaced as DataContext; drag/drop + file picker glue stays here
/// because WPF couples those to the visual tree.
/// </summary>
public partial class MainWindow : Window
{
    private readonly Wizard _wizard;

    public MainWindow()
    {
        _wizard = new Wizard();
        DataContext = _wizard;
        InitializeComponent();
        // Kick off the initial disk scan once the window is up. We
        // intentionally do this after the constructor finishes so the
        // first frame paints with empty rows; the picker fills in as
        // WMIC returns.
        Loaded += async (_, _) => await _wizard.RefreshDisksAsync();
        // Auto-scroll the log when new lines arrive.
        _wizard.LogLines.CollectionChanged += (_, _) =>
        {
            Dispatcher.InvokeAsync(() => LogScroller?.ScrollToEnd());
        };
    }

    // ---- Recipe row ----

    private void RecipeRow_DragEnter(object sender, DragEventArgs e) => HandleDragEnter(RecipeRow, e);
    private void RecipeRow_DragOver(object sender, DragEventArgs e) => HandleDragOver(e);
    private void RecipeRow_DragLeave(object sender, DragEventArgs e) => HandleDragLeave(RecipeRow);
    private void RecipeRow_Drop(object sender, DragEventArgs e)
    {
        HandleDragLeave(RecipeRow);
        var path = ExtractDroppedFile(e);
        if (path != null) _wizard.AcceptRecipeFile(path);
    }

    private void RecipeRow_Click(object sender, System.Windows.Input.MouseButtonEventArgs e)
    {
        // Filter for .json — same as the Mac picker.
        var dialog = new OpenFileDialog
        {
            Title = "Pick recipe (.json)",
            Filter = "Recipe (*.json)|*.json|All files|*.*",
            CheckFileExists = true,
        };
        if (dialog.ShowDialog(this) == true)
        {
            _wizard.AcceptRecipeFile(dialog.FileName);
        }
    }

    // ---- ISO row ----

    private void IsoRow_DragEnter(object sender, DragEventArgs e) => HandleDragEnter(IsoRow, e);
    private void IsoRow_DragOver(object sender, DragEventArgs e) => HandleDragOver(e);
    private void IsoRow_DragLeave(object sender, DragEventArgs e) => HandleDragLeave(IsoRow);
    private void IsoRow_Drop(object sender, DragEventArgs e)
    {
        HandleDragLeave(IsoRow);
        var path = ExtractDroppedFile(e);
        if (path != null) _wizard.AcceptIsoFile(path);
    }

    private void IsoRow_Click(object sender, System.Windows.Input.MouseButtonEventArgs e)
    {
        var dialog = new OpenFileDialog
        {
            Title = "Pick Ubuntu Server ISO",
            Filter = "ISO image (*.iso)|*.iso|All files|*.*",
            CheckFileExists = true,
        };
        if (dialog.ShowDialog(this) == true)
        {
            _wizard.AcceptIsoFile(dialog.FileName);
        }
    }

    // ---- Disk row ----

    private async void RefreshDisks_Click(object sender, RoutedEventArgs e)
    {
        await _wizard.RefreshDisksAsync();
    }

    // ---- Bake ----

    private async void Bake_Click(object sender, RoutedEventArgs e)
    {
        if (_wizard.IsRunning)
        {
            _wizard.Cancel();
        }
        else
        {
            await _wizard.RunBakeAsync();
        }
    }

    private void ClearLog_Click(object sender, RoutedEventArgs e)
    {
        _wizard.ClearLog();
    }

    // ---- Phone pairing ----

    private void StartPairing_Click(object sender, RoutedEventArgs e)
        => _wizard.StartPairing();

    private void CancelPairing_Click(object sender, RoutedEventArgs e)
        => _wizard.CancelPairing();

    // ---- Destination chooser + Host here ----

    private void ChooseUsb_Click(object sender, RoutedEventArgs e)
        => _wizard.Destination = ServerDestination.BurnToUSB;

    private void ChooseHostHere_Click(object sender, RoutedEventArgs e)
        => _wizard.Destination = ServerDestination.HostHere;

    private void BackToChooser_Click(object sender, RoutedEventArgs e)
        => _wizard.Destination = null;

    private async void CreateHostHere_Click(object sender, RoutedEventArgs e)
        => await _wizard.RunHostHereAsync();

    // ---- Hosted-server sidebar + detail ----

    private void AddServer_Click(object sender, RoutedEventArgs e)
    {
        CloseConsole();
        _wizard.ResetToNewServer();
    }

    private void ServerList_SelectionChanged(object sender, SelectionChangedEventArgs e)
        => CloseConsole();

    private async void StartServer_Click(object sender, RoutedEventArgs e)
    {
        if (_wizard.SelectedServerName is string name)
            await _wizard.Vm.PowerOnAsync(name);
    }

    private async void StopServer_Click(object sender, RoutedEventArgs e)
    {
        CloseConsole();
        if (_wizard.SelectedServerName is string name)
            await _wizard.Vm.PowerOffAsync(name);
    }

    private async void RetryInstall_Click(object sender, RoutedEventArgs e)
    {
        if (_wizard.SelectedServerName is string name)
            await _wizard.Vm.BeginInstallAsync(name);
    }

    private async void DeleteServer_Click(object sender, RoutedEventArgs e)
    {
        if (_wizard.SelectedServerName is not string name) return;
        var fqdn = _wizard.SelectedServer?.Fqdn ?? name;
        var choice = MessageBox.Show(
            this,
            $"Delete {fqdn}?\n\nThe VM and its encrypted disk image are removed from this PC. " +
            "The server's identity and any backups live with your phone/account, not here.",
            "Delete this server",
            MessageBoxButton.YesNo,
            MessageBoxImage.Warning);
        if (choice != MessageBoxResult.Yes) return;
        CloseConsole();
        await _wizard.Vm.DeleteServerAsync(name);
        _wizard.SelectedServerName = null;
    }

    // ---- Debug serial console (only reachable for debug-grant recipes:
    //      a production VM has no console device, so the toggle itself is
    //      collapsed and there is nothing to connect to) ----

    private SerialConsoleSession? _console;

    private void ConsoleToggle_Checked(object sender, RoutedEventArgs e)
    {
        if (_wizard.SelectedServerName is not string name) return;
        var host = _wizard.Vm.Host(name);
        if (host is null || host.SerialPort == 0)
        {
            ConsoleHint.Visibility = Visibility.Visible;
            ConsoleToggle.IsChecked = false;
            return;
        }
        ConsoleHint.Visibility = Visibility.Collapsed;
        ConsolePanel.Visibility = Visibility.Visible;
        ConsoleOutput.Clear();
        var session = new SerialConsoleSession();
        session.Output += text => Dispatcher.InvokeAsync(() =>
        {
            ConsoleOutput.AppendText(text);
            // Keep the buffer bounded.
            if (ConsoleOutput.Text.Length > 200_000)
                ConsoleOutput.Text = ConsoleOutput.Text[^150_000..];
            ConsoleScroller.ScrollToEnd();
        });
        _console = session;
        _ = session.ConnectAsync(host.SerialPort);
        ConsoleInput.Focus();
    }

    private void ConsoleToggle_Unchecked(object sender, RoutedEventArgs e) => CloseConsole();

    private void OpenSsh_Click(object sender, RoutedEventArgs e)
    {
        if (_wizard.SelectedServerName is not string name) return;
        var host = _wizard.Vm.Host(name);
        if (host is null || host.SshPort == 0)
        {
            MessageBox.Show(this,
                "SSH is available once the server is running (a debug-enabled VM forwards a local port to the guest).",
                "Open in SSH", MessageBoxButton.OK, MessageBoxImage.Information);
            return;
        }
        try
        {
            // Open a new console window running the OpenSSH client at the guest's
            // forwarded loopback port. The guest's own debug gate still governs
            // whether the login is accepted (debug/flagship on a granted box).
            Process.Start(new ProcessStartInfo
            {
                FileName = "cmd.exe",
                Arguments = SshLaunch.CmdKArguments(host.SshPort),
                UseShellExecute = true,
            });
        }
        catch (Exception ex)
        {
            MessageBox.Show(this, $"Couldn't launch SSH: {ex.Message}",
                "Open in SSH", MessageBoxButton.OK, MessageBoxImage.Warning);
        }
    }

    private void ConsoleInput_KeyDown(object sender, System.Windows.Input.KeyEventArgs e)
    {
        if (e.Key != System.Windows.Input.Key.Enter) return;
        _console?.Send(ConsoleInput.Text + "\n");
        ConsoleInput.Clear();
        e.Handled = true;
    }

    private void CloseConsole()
    {
        _console?.Dispose();
        _console = null;
        if (ConsolePanel != null) ConsolePanel.Visibility = Visibility.Collapsed;
        if (ConsoleHint != null) ConsoleHint.Visibility = Visibility.Collapsed;
        if (ConsoleToggle != null) ConsoleToggle.IsChecked = false;
    }

    // ---- Mode toggle ----

    private void ModeToggle_Click(object sender, RoutedEventArgs e)
    {
        // Flip between Simple (server-manifest base) and Advanced (user ISO).
        _wizard.Mode = _wizard.Mode == BurnerMode.Simple ? BurnerMode.Advanced : BurnerMode.Simple;
    }

    // ---- Drag-drop helpers ----

    private static void HandleDragEnter(Border row, DragEventArgs e)
    {
        if (e.Data.GetDataPresent(DataFormats.FileDrop))
        {
            DragHelper.SetIsDragOver(row, true);
            e.Effects = DragDropEffects.Copy;
        }
        else
        {
            e.Effects = DragDropEffects.None;
        }
        e.Handled = true;
    }

    private static void HandleDragOver(DragEventArgs e)
    {
        e.Effects = e.Data.GetDataPresent(DataFormats.FileDrop)
            ? DragDropEffects.Copy
            : DragDropEffects.None;
        e.Handled = true;
    }

    private void HandleDragLeave(Border row)
    {
        DragHelper.SetIsDragOver(row, false);
    }

    private static string? ExtractDroppedFile(DragEventArgs e)
    {
        if (!e.Data.GetDataPresent(DataFormats.FileDrop)) return null;
        var paths = e.Data.GetData(DataFormats.FileDrop) as string[];
        return paths?.FirstOrDefault();
    }
}

/// <summary>
/// Attached property carrying the transient "drag-over" state for a
/// drop-row Border. Styles in App.xaml trigger on this without
/// stomping on Tag (which carries the bound ready/error visual).
/// </summary>
public static class DragHelper
{
    public static readonly DependencyProperty IsDragOverProperty =
        DependencyProperty.RegisterAttached(
            "IsDragOver", typeof(bool), typeof(DragHelper),
            new PropertyMetadata(false));

    public static bool GetIsDragOver(DependencyObject d) => (bool)d.GetValue(IsDragOverProperty);
    public static void SetIsDragOver(DependencyObject d, bool value) => d.SetValue(IsDragOverProperty, value);
}

// ---- Tiny converters used by MainWindow.xaml ----

/// <summary>
/// Bool → Visibility. Pass ConverterParameter="invert" to flip.
/// </summary>
public sealed class BoolToVisibilityConverter : IValueConverter
{
    public object Convert(object value, Type targetType, object parameter, CultureInfo culture)
    {
        var v = value is bool b && b;
        if (parameter is string s && s.Equals("invert", StringComparison.OrdinalIgnoreCase)) v = !v;
        return v ? Visibility.Visible : Visibility.Collapsed;
    }

    public object ConvertBack(object value, Type targetType, object parameter, CultureInfo culture)
        => throw new NotImplementedException();
}

/// <summary>null → Visible, non-null → Collapsed.</summary>
public sealed class NullToVisibilityConverter : IValueConverter
{
    public object Convert(object value, Type targetType, object parameter, CultureInfo culture)
        => value is null ? Visibility.Visible : Visibility.Collapsed;
    public object ConvertBack(object value, Type targetType, object parameter, CultureInfo culture)
        => throw new NotImplementedException();
}

/// <summary>non-null → Visible, null/empty → Collapsed.</summary>
public sealed class NotNullToVisibilityConverter : IValueConverter
{
    public object Convert(object value, Type targetType, object parameter, CultureInfo culture)
    {
        if (value is null) return Visibility.Collapsed;
        if (value is string s && string.IsNullOrEmpty(s)) return Visibility.Collapsed;
        return Visibility.Visible;
    }
    public object ConvertBack(object value, Type targetType, object parameter, CultureInfo culture)
        => throw new NotImplementedException();
}

/// <summary>
/// Label for the mode-switch link: it names the OTHER mode (the one a click
/// switches TO), so it reads like an action. Simple ⇒ "Advanced…", and
/// vice-versa.
/// </summary>
public sealed class ModeToggleLabelConverter : IValueConverter
{
    public object Convert(object value, Type targetType, object parameter, CultureInfo culture)
        => value is BurnerMode m && m == BurnerMode.Simple ? "Advanced…" : "Simple…";
    public object ConvertBack(object value, Type targetType, object parameter, CultureInfo culture)
        => throw new NotImplementedException();
}

/// <summary>
/// Map log-line stream to a foreground brush — stdout/text-default, stderr/red.
/// </summary>
public sealed class StreamToBrushConverter : IValueConverter
{
    public object Convert(object value, Type targetType, object parameter, CultureInfo culture)
    {
        var isErr = value is LogStream s && s == LogStream.Stderr;
        var key = isErr ? "FB.Danger" : "FB.Text";
        return Application.Current.TryFindResource(key) as Brush ?? Brushes.Black;
    }
    public object ConvertBack(object value, Type targetType, object parameter, CultureInfo culture)
        => throw new NotImplementedException();
}

/// <summary>bool → !bool (for IsEnabled bindings).</summary>
public sealed class InverseBoolConverter : IValueConverter
{
    public object Convert(object value, Type targetType, object parameter, CultureInfo culture)
        => value is not bool b || !b;
    public object ConvertBack(object value, Type targetType, object parameter, CultureInfo culture)
        => throw new NotImplementedException();
}

/// <summary>
/// VM state → status brush, matching the Mac sidebar's stateColor: running
/// green, installing/sealed amber, failed red, everything else muted.
/// </summary>
public sealed class StateKindToBrushConverter : IValueConverter
{
    public object Convert(object value, Type targetType, object parameter, CultureInfo culture)
    {
        var key = value is VMStateKind kind ? kind switch
        {
            VMStateKind.Running => "FB.Success",
            VMStateKind.AwaitingPhoneUnlock or VMStateKind.Installing => "FB.Warning",
            VMStateKind.Failed => "FB.Danger",
            _ => "FB.TextMuted",
        } : "FB.TextMuted";
        return Application.Current.TryFindResource(key) as Brush ?? Brushes.Gray;
    }
    public object ConvertBack(object value, Type targetType, object parameter, CultureInfo culture)
        => throw new NotImplementedException();
}

/// <summary>VM state → status-card glyph.</summary>
public sealed class StateKindToGlyphConverter : IValueConverter
{
    public object Convert(object value, Type targetType, object parameter, CultureInfo culture)
        => value is VMStateKind kind ? kind switch
        {
            VMStateKind.Running => "✓",              // check
            VMStateKind.AwaitingPhoneUnlock => "\U0001F512", // lock
            VMStateKind.Installing => "⚙",           // gear
            VMStateKind.Failed => "⚠",               // warning
            _ => "\U0001F5A5",                            // server/screen
        } : "";
    public object ConvertBack(object value, Type targetType, object parameter, CultureInfo culture)
        => throw new NotImplementedException();
}

/// <summary>
/// Minimal interactive serial console over the QEMU chardev's loopback TCP
/// socket: a read loop raising Output, plus Send for line input. Debug-enabled
/// VMs only — a production VM has no serial device to connect to.
/// </summary>
public sealed class SerialConsoleSession : IDisposable
{
    private readonly TcpClient _tcp = new();
    private readonly CancellationTokenSource _cts = new();
    private NetworkStream? _stream;

    public event Action<string>? Output;

    public async Task ConnectAsync(int port)
    {
        try
        {
            await _tcp.ConnectAsync("127.0.0.1", port, _cts.Token);
            _stream = _tcp.GetStream();
            var buffer = new byte[4096];
            while (!_cts.IsCancellationRequested)
            {
                var n = await _stream.ReadAsync(buffer, _cts.Token);
                if (n == 0) break;
                Output?.Invoke(Encoding.UTF8.GetString(buffer, 0, n));
            }
        }
        catch (Exception e) when (!_cts.IsCancellationRequested)
        {
            Output?.Invoke($"\n[console disconnected: {e.Message}]\n");
        }
        catch { }
    }

    public void Send(string text)
    {
        try { _stream?.Write(Encoding.UTF8.GetBytes(text)); } catch { }
    }

    public void Dispose()
    {
        _cts.Cancel();
        try { _tcp.Dispose(); } catch { }
        _cts.Dispose();
    }
}
