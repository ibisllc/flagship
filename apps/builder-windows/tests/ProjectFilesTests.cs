using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using Xunit;

namespace Flagship.Builder.Tests;

/// The app's project lists its sources by hand, and the test project compiles them on its own, so a file
/// missing from the app's list passes every test and only breaks the Windows publish.
public sealed class ProjectFilesTests
{
    private static string Dir([System.Runtime.CompilerServices.CallerFilePath] string f = "") => Path.GetDirectoryName(f)!;

    [Fact]
    public void EverySourceTheTestsCompileIsInTheAppProject()
    {
        var app = File.ReadAllText(Path.Combine(Dir(), "..", "FlagshipBuilder.csproj"));
        var tests = File.ReadAllText(Path.Combine(Dir(), "FlagshipBuilder.Tests.csproj"));
        var missing = Regex.Matches(tests, @"Compile Include=""\.\.\\(src\\[^""]+)""")
            .Select(m => m.Groups[1].Value)
            .Where(src => !app.Contains($"Include=\"{src}\""))
            .ToList();
        Assert.Empty(missing);
    }
}
