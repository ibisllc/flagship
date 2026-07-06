import XCTest
@testable import FlagshipBurnerCore

final class HostArchTests: XCTestCase {

    /// The pure mapping: the kernel says the silicon is arm64 → arm64 base.
    /// false OR an absent sysctl (Intel Macs don't define hw.optional.arm64)
    /// → amd64.
    func testIsoArchMapping() {
        XCTAssertEqual(HostArch.isoArch(hwOptionalArm64: true), .arm64)
        XCTAssertEqual(HostArch.isoArch(hwOptionalArm64: false), .amd64)
        XCTAssertEqual(HostArch.isoArch(hwOptionalArm64: nil), .amd64)
    }

    /// `current()` is exactly the mapping applied to the live sysctl read —
    /// the Rosetta-safe seam: it must NOT consult the process architecture.
    func testCurrentMatchesLiveSysctl() {
        XCTAssertEqual(HostArch.current(),
                       HostArch.isoArch(hwOptionalArm64: HostArch.readHwOptionalArm64()))
    }
}
