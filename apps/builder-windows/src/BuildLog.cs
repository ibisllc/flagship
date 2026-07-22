namespace Flagship.Builder;
public enum LogStream { Stdout, Stderr }
public readonly record struct LogLine(LogStream Stream, string Text);
