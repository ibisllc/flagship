import XCTest
@testable import FlagshipBurnerCore

/// The honest-tiering badge: legible, never silently equivalent.
final class ServerTierTests: XCTestCase {

    func testDestinationDerivesTheTier() {
        XCTAssertEqual(ServerTier(destination: .burnToUSB), .hardware)
        XCTAssertEqual(ServerTier(destination: .hostHere), .hostedVM)
    }

    func testBadgeLabels() {
        XCTAssertEqual(ServerTier.hardware.badgeLabel, "Appliance (hardware)")
        XCTAssertEqual(ServerTier.hostedVM.badgeLabel, "Appliance (hosted VM)")
    }

    func testStableRawValuesForPersistence() {
        XCTAssertEqual(ServerTier.hardware.rawValue, "hardware")
        XCTAssertEqual(ServerTier.hostedVM.rawValue, "hosted-vm")
        XCTAssertEqual(ServerDestination.burnToUSB.rawValue, "usb")
        XCTAssertEqual(ServerDestination.hostHere.rawValue, "host-here")
    }
}
