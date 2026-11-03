using System.IO;
using System.Runtime.Versioning;
namespace Flagship.Builder;
public sealed class NativeBuildPipeline
{
 readonly NativePreseedEngine engine=new();
 public async Task PrepareAsync(string verifiedRecipePath,string sourceIso,string outputIso,string? ssid,string? password,CancellationToken ct,string? targetDisk=null){var bytes=await File.ReadAllBytesAsync(verifiedRecipePath,ct);_ = RecipeLoader.Load(bytes);var json=System.Text.Encoding.UTF8.GetString(bytes);try{var opts=new NativePreseedEngine.BurnOptions(WifiSSID:ssid,WifiPassword:password,BootHost:BootHostFromEnvironment(),TargetDisk:targetDisk);var preseed=engine.BuildPreseed(json,opts);await NativeIsoRemaster.RemasterAsync(sourceIso,outputIso,preseed,null,ct);}finally{Array.Clear(bytes);}}
 // A Studio pointed at another control plane (FLAGSHIP_CONTROL_HOST, e.g. the gym) bakes that plane's boot worker
 // into the stick, as hosting does (ApplianceHosting), or the installed disk asks prod for its unlock.
 internal static string? BootHostFromEnvironment(){var h=Environment.GetEnvironmentVariable("FLAGSHIP_CONTROL_HOST");return string.IsNullOrWhiteSpace(h)?null:$"https://boot.{h.Trim()}";}
 [SupportedOSPlatform("windows")]public async Task WriteAsync(string verifiedRecipePath,string sourceIso,string device,string? ssid,string? password,Action<double> progress,CancellationToken ct,string? targetDisk=null){var temp=Path.Combine(Path.GetTempPath(),"flagship-prepared-"+Guid.NewGuid().ToString("N")+".iso");try{await PrepareAsync(verifiedRecipePath,sourceIso,temp,ssid,password,ct,targetDisk);ct.ThrowIfCancellationRequested();await Task.Run(()=>DiskWrite.Write(temp,device,progress),ct);File.Delete(verifiedRecipePath);}finally{try{File.Delete(temp);}catch{}}}
}