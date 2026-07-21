import XCTest
@testable import FlagshipBuilderCore

final class VMInstallObservationTests: XCTestCase {
    func testDecodesOnlyAllowlistedPrivacySafeStatus() throws {
        let data = try JSONSerialization.data(withJSONObject: [
            "phase": "installing",
            "detail": "Installing Debian base system\n(12 min)",
            "updatedAt": 1_750_000_000_000,
        ])
        let observation = try XCTUnwrap(VMInstallObservation.decode(data))
        XCTAssertEqual(observation.phase, "installing")
        XCTAssertEqual(observation.detail, "Installing Debian base system(12 min)")
        XCTAssertEqual(observation.updatedAt.timeIntervalSince1970, 1_750_000_000)

        let rejected = try JSONSerialization.data(withJSONObject: [
            "phase": "raw-syslog", "updatedAt": 1_750_000_000_000,
        ])
        XCTAssertNil(VMInstallObservation.decode(rejected))
    }

    func testSerialIsConstrainedBeforeBuildingStatusURL() {
        XCTAssertNotNil(VMInstallObservation.statusURL(serial: "01VMTEST"))
        XCTAssertNil(VMInstallObservation.statusURL(serial: "../../secret"))
        XCTAssertNil(VMInstallObservation.statusURL(serial: "short"))
    }

    func testMarksMissingHeartbeatStaleAfterThreeMinutes() {
        let updated = Date(timeIntervalSince1970: 1_000)
        let observation = VMInstallObservation(phase: "installing", detail: nil, updatedAt: updated)
        XCTAssertFalse(observation.isStale(at: updated.addingTimeInterval(179)))
        XCTAssertTrue(observation.isStale(at: updated.addingTimeInterval(180)))
    }
}
