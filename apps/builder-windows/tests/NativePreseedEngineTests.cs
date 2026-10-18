using System.Text.Json;
using Flagship.Builder;
using Xunit;
namespace Flagship.Builder.Tests;
public sealed class NativePreseedEngineTests
{
 sealed record Fixture(int Version,Vector[] Vectors);sealed record Vector(string Name,string RecipeJson,string BurnOptsJson,string ExpectedPreseed,string ExpectedUserData);
 [Fact]public void EveryGoldenVectorIsByteIdentical(){var json=Read("Flagship.Builder.Tests.Resources.preseed-vectors.json");var fixture=JsonSerializer.Deserialize<Fixture>(json,new JsonSerializerOptions{PropertyNameCaseInsensitive=true})!;Assert.True(fixture.Vectors.Length>=6);var engine=new NativePreseedEngine();foreach(var v in fixture.Vectors){Assert.Equal(v.ExpectedPreseed,engine.BuildPreseedRaw(v.RecipeJson,v.BurnOptsJson));Assert.Equal(v.ExpectedUserData,engine.BuildUserDataRaw(v.RecipeJson,v.BurnOptsJson));}}
 [Fact]public void EmbeddedEngineExactlyMatchesCanonicalFile(){var embedded=Read("Flagship.Builder.Resources.preseed-engine.js");var canonical=File.ReadAllText(Path.GetFullPath(Path.Combine(AppContext.BaseDirectory,"../../../../../../packages/flagship-builder/engine/preseed-engine.js")));Assert.Equal(canonical,embedded);}
 [Fact]public void BurnOptionsOmitBlankValues(){var json=new NativePreseedEngine.BurnOptions(WifiSSID:" ",WifiPassword:"secret").ToJson();Assert.DoesNotContain("wifiSSID",json);Assert.Contains("wifiPassword",json);}
 static string Read(string name){using var s=typeof(NativePreseedEngineTests).Assembly.GetManifestResourceStream(name)!;using var r=new StreamReader(s);return r.ReadToEnd();}
}