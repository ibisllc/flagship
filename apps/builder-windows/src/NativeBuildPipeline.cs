using System.IO;
using System.Runtime.Versioning;
namespace Flagship.Builder;
public sealed class NativeBuildPipeline
{
 readonly NativePreseedEngine engine=new();
 public async Task PrepareAsync(string verifiedRecipePath,string sourceIso,string outputIso,string? ssid,string? password,CancellationToken ct){var bytes=await File.ReadAllBytesAsync(verifiedRecipePath,ct);_ = RecipeLoader.Load(bytes);var json=System.Text.Encoding.UTF8.GetString(bytes);try{var opts=new NativePreseedEngine.BurnOptions(WifiSSID:ssid,WifiPassword:password);var preseed=engine.BuildPreseed(json,opts);var userData=engine.BuildUserData(json,opts);await NativeIsoRemaster.RemasterAsync(sourceIso,outputIso,preseed,userData,null,ct);}finally{Array.Clear(bytes);}}
 [SupportedOSPlatform("windows")]public async Task WriteAsync(string verifiedRecipePath,string sourceIso,string device,string? ssid,string? password,Action<double> progress,CancellationToken ct){var temp=Path.Combine(Path.GetTempPath(),"flagship-prepared-"+Guid.NewGuid().ToString("N")+".iso");try{await PrepareAsync(verifiedRecipePath,sourceIso,temp,ssid,password,ct);ct.ThrowIfCancellationRequested();await Task.Run(()=>DiskWrite.Write(temp,device,progress),ct);File.Delete(verifiedRecipePath);}finally{try{File.Delete(temp);}catch{}}}
}