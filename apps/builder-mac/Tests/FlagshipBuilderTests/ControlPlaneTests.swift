import XCTest
@testable import FlagshipBuilderCore

final class ControlPlaneTests: XCTestCase {
    private let gym = ["FLAGSHIP_CONTROL_HOST": "gym.flagshipserver.com"]

    func testDefaultsToProduction() {
        XCTAssertEqual(ControlPlane.host(environment: [:]), "flagshipserver.com")
        XCTAssertEqual(ControlPlane.bootHost(environment: [:]), UserData.defaultBootHost)
    }

    func testFollowsFlagshipControlHost() {
        XCTAssertEqual(ControlPlane.host(environment: gym), "gym.flagshipserver.com")
        XCTAssertEqual(ControlPlane.bootHost(environment: gym), "https://boot.gym.flagshipserver.com")
        XCTAssertEqual(ControlPlane.host(environment: ["FLAGSHIP_CONTROL_HOST": " localhost:8787 "]), "localhost:8787")
    }

    func testIgnoresAValueThatIsNotAPlainHost() {
        for bad in ["", "  ", "evil.example/x", "a b", "https://gym.example", "x@y", "a:b", "host:123456", ".x", "x-"] {
            XCTAssertEqual(ControlPlane.host(environment: ["FLAGSHIP_CONTROL_HOST": bad]),
                           "flagshipserver.com", bad)
        }
    }

    func testStatusAndHealthPollsFollowTheControlHost() {
        XCTAssertEqual(VMInstallObservation.statusURL(serial: "01VMTEST", environment: gym)?.absoluteString,
                       "https://gym.flagshipserver.com/api/order/01VMTEST/status")
        XCTAssertEqual(VMServerHealth.orderHealthURL(serial: "AB12_cd-34", environment: gym)?.absoluteString,
                       "https://gym.flagshipserver.com/api/order/AB12_cd-34/health")
        XCTAssertNil(VMInstallObservation.statusURL(serial: "../../secret", environment: gym))
    }
}
