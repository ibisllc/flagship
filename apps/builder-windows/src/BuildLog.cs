namespace Flagship.Builder;
public enum LogStream { Stdout, Stderr }
public readonly record struct LogLine(LogStream Stream, string Text)
{
    // Screen readers read an item's ToString: the line itself, not the record's type and fields.
    public override string ToString() => Text;
}
