using System;

namespace Flagship.Burner.VM;

/// <summary>
/// Pure resource-cap math for hosted VMs (docs/desktop-vm-appliance.md
/// "Multi-server hosting"): each VM + the full data stack
/// (postgres/minio/redis/forgejo/chromium) is several GB of RAM, so the plan
/// keeps the cost legible and caps the total by host specs — a modest box must
/// never be oversubscribed by the default path.
/// Mirrors apps/burner-mac FlagshipBurnerCore/VM/VMResourcePlan.swift; pinned
/// by the shared golden vectors.
/// </summary>
public static class VMResourcePlan
{
    public const ulong GiB = 1UL << 30;

    /// <summary>Comfortable per-VM allotment for the full data stack.</summary>
    public const ulong DefaultVMMemoryBytes = 6 * GiB;
    /// <summary>The floor below which the stack isn't viable — a host that
    /// can't spare this hosts zero VMs.</summary>
    public const ulong MinimumVMMemoryBytes = 4 * GiB;
    /// <summary>RAM always left to Windows + the user's own apps.</summary>
    public const ulong HostReserveBytes = 4 * GiB;
    /// <summary>Sparse main-disk size (the guest LUKS/ext4 root grows into it).</summary>
    public const ulong DefaultMainDiskSizeBytes = 64 * GiB;
    /// <summary>Hard ceiling regardless of host size — family hosting, not a datacenter.</summary>
    public const int AbsoluteMaxVMs = 8;

    /// <summary>
    /// Memory for ONE VM on this host: the comfortable default, clamped down
    /// to what the host can spare above the reserve, never below the floor.
    /// </summary>
    public static ulong VmMemoryBytes(HostResources host)
    {
        ulong spare = host.MemoryBytes > HostReserveBytes ? host.MemoryBytes - HostReserveBytes : 0;
        return Math.Max(MinimumVMMemoryBytes, Math.Min(DefaultVMMemoryBytes, spare));
    }

    /// <summary>
    /// vCPUs for one VM: 2–4, leaving two host cores free, never more than the
    /// host actually has.
    /// </summary>
    public static int VmCpuCount(HostResources host)
        => Math.Max(1, Math.Min(host.CpuCount, Math.Max(2, Math.Min(4, host.CpuCount - 2))));

    /// <summary>
    /// How many VMs this host may run at once. Single is the default and the
    /// encouraged posture; this is the cap for the power-user/family case.
    /// 0 ⇒ the host can't spare even the minimum for one VM.
    /// </summary>
    public static int MaxVMCount(HostResources host)
    {
        ulong spare = host.MemoryBytes > HostReserveBytes ? host.MemoryBytes - HostReserveBytes : 0;
        if (spare < MinimumVMMemoryBytes) return 0;
        // At least one fits (at the clamped floor); beyond that, count at the
        // comfortable per-VM default so N VMs are never squeezed below it.
        int byMemory = Math.Max(1, (int)(spare / DefaultVMMemoryBytes));
        return Math.Min(AbsoluteMaxVMs, byMemory);
    }
}
