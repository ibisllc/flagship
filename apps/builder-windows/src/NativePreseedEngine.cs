using System.IO;
using System.Reflection;
using System.Text.Json;
using Jint;
namespace Flagship.Builder;
public sealed class NativePreseedEngine
{
 public sealed record BurnOptions(bool? EncryptRoot=null,string? WifiSSID=null,string? WifiPassword=null,string? InstallerGitRef=null,string? FlagshipRepoUrl=null,string? BootHost=null)
 {
  internal string ToJson(){var d=new Dictionary<string,object>();if(EncryptRoot is not null)d["encryptRoot"]=EncryptRoot.Value;if(!string.IsNullOrWhiteSpace(WifiSSID))d["wifiSSID"]=WifiSSID;if(!string.IsNullOrEmpty(WifiPassword))d["wifiPassword"]=WifiPassword;if(!string.IsNullOrEmpty(InstallerGitRef))d["installerGitRef"]=InstallerGitRef;if(!string.IsNullOrEmpty(FlagshipRepoUrl))d["flagshipRepoUrl"]=FlagshipRepoUrl;if(!string.IsNullOrEmpty(BootHost))d["bootHost"]=BootHost;return JsonSerializer.Serialize(d);}
 }
 readonly Engine engine;
 public NativePreseedEngine():this(LoadResource("Flagship.Builder.Resources.preseed-engine.js")){}
 internal NativePreseedEngine(string source){engine=new Engine(o=>o.LimitMemory(32_000_000).TimeoutInterval(TimeSpan.FromSeconds(10)).MaxStatements(2_000_000).Strict());engine.Execute(source);var api=engine.GetValue("FlagshipPreseed");if(api.IsUndefined()||api.IsNull())throw new InvalidDataException("embedded preseed engine did not install its API");}
 public string BuildPreseed(string verifiedRecipeJson,BurnOptions? options=null)=>Invoke("buildPreseedFromRecipe",verifiedRecipeJson,(options??new()).ToJson());
 public string BuildUserData(string verifiedRecipeJson,BurnOptions? options=null)=>Invoke("buildUserDataFromRecipe",verifiedRecipeJson,(options??new()).ToJson());
 public string BuildBootstrap(string verifiedRecipeJson,BurnOptions? options=null)=>Invoke("buildBootstrapFromRecipe",verifiedRecipeJson,(options??new()).ToJson());
 internal string BuildPreseedRaw(string recipe,string opts)=>Invoke("buildPreseedFromRecipe",recipe,opts);
 internal string BuildUserDataRaw(string recipe,string opts)=>Invoke("buildUserDataFromRecipe",recipe,opts);
 string Invoke(string method,string recipe,string opts){if(string.IsNullOrWhiteSpace(recipe))throw new InvalidDataException("verified recipe JSON is empty");var fn=engine.GetValue("FlagshipPreseed").AsObject().Get(method);var result=engine.Invoke(fn,recipe,opts);if(!result.IsString())throw new InvalidDataException("embedded preseed engine returned a non-string result");return result.AsString();}
 static string LoadResource(string name){using var stream=Assembly.GetExecutingAssembly().GetManifestResourceStream(name)??throw new FileNotFoundException("embedded preseed engine resource missing");using var reader=new StreamReader(stream);return reader.ReadToEnd();}
}