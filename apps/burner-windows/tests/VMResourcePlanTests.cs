using Xunit;
using Flagship.Burner.VM;

namespace Flagship.Burner.Tests;

/// <summary>
/// Direct port of apps/burner-mac VMResourcePlanTests.swift: locks the
/// resource-cap math from docs/desktop-vm-appliance.md. Also pinned by the
/// shared vectors (VMCoreVectorTests).
/// </summary>
public class VMResourcePlanTests
{
    private const ulong GiB = VMResourcePlan.GiB;

    private static HostResources Host(int cpus, ulong ramGiB) => new(cpus, ramGiB * GiB);

    // ---- Per-VM memory ----

    [Fact]
    public void ComfortableHostGetsTheDefaultVMMemory()
    {
        // 16 GiB host: 12 GiB spare over the reserve → the 6 GiB default.
        Assert.Equal(6 * GiB, VMResourcePlan.VmMemoryBytes(Host(8, 16)));
    }

    [Fact]
    public void ModestHostClampsDownToWhatItCanSpare()
    {
        // 8 GiB host: 4 GiB spare → clamped between floor (4) and default (6).
        Assert.Equal(4 * GiB, VMResourcePlan.VmMemoryBytes(Host(4, 8)));
        // 9 GiB host: 5 GiB spare → 5 GiB.
        Assert.Equal(5 * GiB, VMResourcePlan.VmMemoryBytes(Host(4, 9)));
    }

    [Fact]
    public void TinyHostNeverGoesBelowTheViabilityFloor()
    {
        // The stack isn't viable below 4 GiB — the floor holds even when the
        // host can't spare it (MaxVMCount is what says "no" on such a host).
        Assert.Equal(4 * GiB, VMResourcePlan.VmMemoryBytes(Host(2, 4)));
        Assert.Equal(4 * GiB, VMResourcePlan.VmMemoryBytes(Host(2, 2)));
    }

    // ---- Per-VM CPUs ----

    [Fact]
    public void CpuCountLeavesTwoHostCoresAndCapsAtFour()
    {
        Assert.Equal(4, VMResourcePlan.VmCpuCount(Host(12, 32)));
        Assert.Equal(4, VMResourcePlan.VmCpuCount(Host(8, 16)));
        Assert.Equal(3, VMResourcePlan.VmCpuCount(Host(5, 16)));
        Assert.Equal(2, VMResourcePlan.VmCpuCount(Host(4, 16)));
    }

    [Fact]
    public void CpuCountNeverExceedsTheHost()
    {
        Assert.Equal(2, VMResourcePlan.VmCpuCount(Host(2, 8)));
        Assert.Equal(1, VMResourcePlan.VmCpuCount(Host(1, 8)));
    }

    // ---- VM cap ----

    [Fact]
    public void HostTooSmallForTheStackHostsZeroVMs()
    {
        Assert.Equal(0, VMResourcePlan.MaxVMCount(Host(2, 4)));
        Assert.Equal(0, VMResourcePlan.MaxVMCount(Host(2, 7)));
    }

    [Fact]
    public void ModestHostHostsExactlyOne()
    {
        // 8 GiB: one VM at the clamped floor — never oversubscribed to two.
        Assert.Equal(1, VMResourcePlan.MaxVMCount(Host(4, 8)));
        // 12 GiB: 8 GiB spare fits one comfortable VM, not two.
        Assert.Equal(1, VMResourcePlan.MaxVMCount(Host(8, 12)));
    }

    [Fact]
    public void BiggerHostsScaleByTheComfortableDefault()
    {
        Assert.Equal(2, VMResourcePlan.MaxVMCount(Host(8, 16)));   // 12/6
        Assert.Equal(4, VMResourcePlan.MaxVMCount(Host(10, 32)));  // 28/6
    }

    [Fact]
    public void AbsoluteCeilingHolds()
    {
        Assert.Equal(8, VMResourcePlan.MaxVMCount(Host(32, 128)));
    }
}
