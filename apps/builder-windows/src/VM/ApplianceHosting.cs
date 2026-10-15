using System;
using System.Linq;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace Flagship.Builder.VM;

/// <summary>
/// "Host on this PC" from the published prebuilt appliance, kept free of WPF
/// so it is unit-tested: pick the image (or fall back to the installer ISO),
/// then turn it into one new server. The wizard only shows progress.
/// </summary>
public static class ApplianceHosting
{
    public const string Arch = "amd64";

    /// <summary>The verified base for this recipe's installer ref, or null
    /// when none fits (none published, or built for another ref) so hosting
    /// falls back to the Debian installer. Integrity, network and disk-space
    /// failures throw ApplianceCacheException and stop the run.</summary>
    public static async Task<string?> EnsurePublishedAsync(ApplianceCache cache, string installerGitRef,
                                                           Action<string, double?> progress, Action<string> log,
                                                           CancellationToken ct)
    {
        try
        {
            return await cache.EnsureAsync(installerGitRef, progress, ct);
        }
        catch (ApplianceCacheException e) when (e.FallsBackToInstaller)
        {
            log($"{e.Message} Using the Debian installer instead.");
            return null;
        }
    }

    public static ISet<string> BasesInUse(VMManager vm)
        => ApplianceProvisioner.BackingFilesInUse(vm.Servers.Select(s => vm.Store.Layout.DiskImagePath(s.Name)));

    public static string EffectiveInstallerGitRef(Recipe recipe)
        => string.IsNullOrWhiteSpace(recipe.InstallerGitRef) ? "main" : recipe.InstallerGitRef.Trim();

    /// <summary>Create the server's bundle, then its overlay and seed. On any
    /// failure the half-made server is removed and the error rethrown.</summary>
    public static async Task CreateServerAsync(VMManager vm, VMConfig config, string basePath,
                                               Recipe recipe, byte[] recipeJson, NativePreseedEngine engine,
                                               Func<string[], CancellationToken, Task> runQemuImg,
                                               CancellationToken ct)
    {
        var installerGitRef = EffectiveInstallerGitRef(recipe);
        vm.CreateServer(config);
        try
        {
            var manifest = await Task.Run(() => ApplianceProvisioner.Verify(basePath, Arch, installerGitRef), ct);
            vm.Log($"+ verified appliance {basePath} sha256={manifest.Sha256}");
            var json = Encoding.UTF8.GetString(recipeJson);
            var installBlob = Encoding.UTF8.GetBytes(engine.BuildInstallBlobJson(json));
            var bootstrap = engine.BuildBootstrap(json, new NativePreseedEngine.BurnOptions(
                EncryptRoot: recipe.EncryptsDisk, InstallerGitRef: installerGitRef));
            await ApplianceProvisioner.ProvisionAsync(config, vm.Store.Layout, basePath, manifest,
                                                      installBlob, bootstrap, runQemuImg, ct);
            vm.Log("+ created the server's disk on the prebuilt image and wrote its one-use setup seed");
        }
        catch
        {
            await vm.DeleteServerAsync(config.Name);
            throw;
        }
    }
}
