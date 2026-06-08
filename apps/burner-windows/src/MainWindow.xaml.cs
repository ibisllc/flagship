using System;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Data;
using System.Windows.Media;
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
