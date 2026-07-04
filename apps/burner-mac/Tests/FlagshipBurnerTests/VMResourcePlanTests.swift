import XCTest
@testable import FlagshipBurnerCore

/// Locks the resource-cap math from docs/desktop-vm-appliance.md: each VM +
/// the full data stack is several GB of RAM; single VM is the default; the
/// total is capped by host specs so a modest box isn't oversubscribed.
final class VMResourcePlanTests: XCTestCase {
    private let gib = VMResourcePlan.gib

    private func host(cpus: Int, ramGiB: UInt64) -> HostResources {
        HostResources(cpuCount: cpus, memoryBytes: ramGiB * gib)
    }

    // MARK: - Per-VM memory

    func testComfortableHostGetsTheDefaultVMMemory() {
        // 16 GiB host: 12 GiB spare over the reserve → the 6 GiB default.
        XCTAssertEqual(VMResourcePlan.vmMemoryBytes(host: host(cpus: 8, ramGiB: 16)), 6 * gib)
    }

    func testModestHostClampsDownToWhatItCanSpare() {
        // 8 GiB host: 4 GiB spare → clamped between floor (4) and default (6).
        XCTAssertEqual(VMResourcePlan.vmMemoryBytes(host: host(cpus: 4, ramGiB: 8)), 4 * gib)
        // 9 GiB host: 5 GiB spare → 5 GiB.
        XCTAssertEqual(VMResourcePlan.vmMemoryBytes(host: host(cpus: 4, ramGiB: 9)), 5 * gib)
    }

    func testTinyHostNeverGoesBelowTheViabilityFloor() {
        // The stack isn't viable below 4 GiB — the floor holds even when the
        // host can't spare it (maxVMCount is what says "no" on such a host).
        XCTAssertEqual(VMResourcePlan.vmMemoryBytes(host: host(cpus: 2, ramGiB: 4)), 4 * gib)
        XCTAssertEqual(VMResourcePlan.vmMemoryBytes(host: host(cpus: 2, ramGiB: 2)), 4 * gib)
    }

    // MARK: - Per-VM CPUs

    func testCPUCountLeavesTwoHostCoresAndCapsAtFour() {
        XCTAssertEqual(VMResourcePlan.vmCPUCount(host: host(cpus: 12, ramGiB: 32)), 4)
        XCTAssertEqual(VMResourcePlan.vmCPUCount(host: host(cpus: 8, ramGiB: 16)), 4)
        XCTAssertEqual(VMResourcePlan.vmCPUCount(host: host(cpus: 5, ramGiB: 16)), 3)
        XCTAssertEqual(VMResourcePlan.vmCPUCount(host: host(cpus: 4, ramGiB: 16)), 2)
    }

    func testCPUCountNeverExceedsTheHost() {
        XCTAssertEqual(VMResourcePlan.vmCPUCount(host: host(cpus: 2, ramGiB: 8)), 2)
        XCTAssertEqual(VMResourcePlan.vmCPUCount(host: host(cpus: 1, ramGiB: 8)), 1)
    }

    // MARK: - VM cap

    func testHostTooSmallForTheStackHostsZeroVMs() {
        XCTAssertEqual(VMResourcePlan.maxVMCount(host: host(cpus: 2, ramGiB: 4)), 0)
        XCTAssertEqual(VMResourcePlan.maxVMCount(host: host(cpus: 2, ramGiB: 7)), 0)
    }

    func testModestHostHostsExactlyOne() {
        // 8 GiB: one VM at the clamped floor — never oversubscribed to two.
        XCTAssertEqual(VMResourcePlan.maxVMCount(host: host(cpus: 4, ramGiB: 8)), 1)
        // 12 GiB: 8 GiB spare fits one comfortable VM, not two.
        XCTAssertEqual(VMResourcePlan.maxVMCount(host: host(cpus: 8, ramGiB: 12)), 1)
    }

    func testBiggerHostsScaleByTheComfortableDefault() {
        XCTAssertEqual(VMResourcePlan.maxVMCount(host: host(cpus: 8, ramGiB: 16)), 2)  // 12/6
        XCTAssertEqual(VMResourcePlan.maxVMCount(host: host(cpus: 10, ramGiB: 32)), 4) // 28/6
    }

    func testAbsoluteCeilingHolds() {
        XCTAssertEqual(VMResourcePlan.maxVMCount(host: host(cpus: 32, ramGiB: 128)), 8)
    }
}
