import XCTest
@testable import FlagshipCore
import FlagshipAPI

/// A server marked untrusted after the retail alarm (docs/retail-box-setup.md §7.7): no
/// connection, nothing sealed to it, no re-pin, until it is deleted.
final class UntrustedServersTests: XCTestCase {
    func testAnUntrustedServerIsBlockedEverywhere() throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "untrusted-\(UUID().uuidString)"))
        let keys = ServerKeyPins(defaults: defaults)
        let untrusted = UntrustedServers(defaults: defaults)
        let registry = CertPinRegistry(persistingIn: defaults, serverKeys: keys, untrusted: untrusted)
        let pins = BoxKeyPins(serverKeys: keys, untrusted: untrusted)
        let domain = "home.alice.flagship.services"
        let stk = String(repeating: "ab", count: 32)
        pins.repin(username: "alice", serverDomain: domain, stkHex: stk)
        XCTAssertEqual(try pins.require(username: "alice", serverDomain: domain, reportedHex: stk), stk)

        untrusted.mark("Home.Alice.flagship.services.")
        XCTAssertTrue(untrusted.contains(host: "blog.\(domain)"))
        XCTAssertFalse(untrusted.contains(host: "other.alice.flagship.services"))
        XCTAssertThrowsError(try pins.require(username: "alice", serverDomain: domain, reportedHex: stk)) {
            XCTAssertEqual($0 as? ServerUntrustedError, ServerUntrustedError(serverDomain: domain))
        }
        XCTAssertNil(keys.pinnedStk(domain), "Nothing is sealed to it.")
        XCTAssertFalse(keys.pin(Data(repeating: 0xcd, count: 32), for: domain), "It can't be re-pinned.")
        XCTAssertTrue(registry.isKnownBox(host: "blog.\(domain)"))
        XCTAssertNil(registry.pinFor(host: domain), "No pin: every connection is refused as a known box.")
        XCTAssertEqual(CertPinDecision.verdict(host: domain, leafDerSha256Hex: "00", pinFor: registry.pinFor, isKnownBox: registry.isKnownBox), .blocked)

        untrusted.forget(domain)
        XCTAssertEqual(keys.pinnedStkHex(domain), stk)
        XCTAssertTrue(UntrustedServers(defaults: defaults).all.isEmpty)
    }
}
