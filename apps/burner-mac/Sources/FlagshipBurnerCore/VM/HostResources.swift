import Foundation

/// A snapshot of the host machine's capacity, used by the pure VM planning
/// math. Tests pass explicit values; the app uses `.current()`.
public struct HostResources: Sendable, Equatable {
    public let cpuCount: Int
    public let memoryBytes: UInt64

    public init(cpuCount: Int, memoryBytes: UInt64) {
        self.cpuCount = cpuCount
        self.memoryBytes = memoryBytes
    }

    /// The live host. The only non-deterministic entry point — everything
    /// downstream is a pure function of this value.
    public static func current() -> HostResources {
        HostResources(cpuCount: ProcessInfo.processInfo.activeProcessorCount,
                      memoryBytes: ProcessInfo.processInfo.physicalMemory)
    }
}
