using System.Windows.Markup;

namespace Flagship.Builder;

/// <summary>XAML: <c>Text="{local:Str someKey}"</c> reads the text from src/Strings.resx (see Strings.cs).</summary>
[MarkupExtensionReturnType(typeof(string))]
public sealed class StrExtension : MarkupExtension
{
    public StrExtension(string key) { Key = key; }

    [ConstructorArgument("key")]
    public string Key { get; set; }

    public override object ProvideValue(IServiceProvider serviceProvider) => Strings.T(Key);
}
