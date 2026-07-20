import Foundation

/// Pure resource-cap math for hosted VMs (docs/desktop-vm-appliance.md
/// "Multi-server hosting"): each VM + the full data stack
/// (postgres/minio/redis/forgejo/chromium) is several GB of RAM, so the plan
/// keeps the cost legible and caps the total by host specs — a modest box must
/// never be oversubscribed by the default path.
public enum VMResourcePlan {
    public static let gib: UInt64 = 1 << 30

    /// Comfortable per-VM allotment for the full data stack.
    public static let defaultVMMemoryBytes: UInt64 = 6 * gib
    /// The floor below which the stack isn't viable — a host that can't spare
    /// this hosts zero VMs.
    public static let minimumVMMemoryBytes: UInt64 = 4 * gib
    /// RAM always left to macOS + the user's own apps.
    public static let hostReserveBytes: UInt64 = 4 * gib
    /// Sparse main-disk size (the guest LUKS/ext4 root grows into it).
    public static let defaultMainDiskSizeBytes: UInt64 = 64 * gib
    /// Hard ceiling regardless of host size — family hosting, not a datacenter.
    public static let absoluteMaxVMs = 8

    /// Memory for ONE VM on this host: the comfortable default, clamped down
    /// to what the host can spare above the reserve, never below the floor.
    public static func vmMemoryBytes(host: HostResources) -> UInt64 {
        let spare = host.memoryBytes > hostReserveBytes ? host.memoryBytes - hostReserveBytes : 0
        return max(minimumVMMemoryBytes, min(defaultVMMemoryBytes, spare))
    }

    /// vCPUs for one VM: 2–4, leaving two host cores free, never more than the
    /// host actually has.
    public static func vmCPUCount(host: HostResources) -> Int {
        max(1, min(host.cpuCount, max(2, min(4, host.cpuCount - 2))))
    }

    /// How many VMs this host may run at once. Single is the default and the
    /// encouraged posture; this is the cap for the power-user/family case.
    /// 0 ⇒ the host can't spare even the minimum for one VM.
    public static func maxVMCount(host: HostResources) -> Int {
        let spare = host.memoryBytes > hostReserveBytes ? host.memoryBytes - hostReserveBytes : 0
        guard spare >= minimumVMMemoryBytes else { return 0 }
        // At least one fits (at the clamped floor); beyond that, count at the
        // comfortable per-VM default so N VMs are never squeezed below it.
        let byMemory = max(1, Int(spare / defaultVMMemoryBytes))
        return min(absoluteMaxVMs, byMemory)
    }
}
