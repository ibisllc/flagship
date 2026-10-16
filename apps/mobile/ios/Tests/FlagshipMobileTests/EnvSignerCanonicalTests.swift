import XCTest
import FlagshipAPI
import FlagshipUI

/// The env-change signer signs exactly `ServiceEnvChange.canonicalBytes()`
/// (flagship/service-env-change/v1; the bytes themselves are pinned to the
/// shared vectors in FlagshipSharedTests/ServiceEnvChangeVectorTests). The
/// daemon re-derives these bytes to verify the owner-IRK signature.
final class EnvSignerCanonicalTests: XCTestCase {
    func testCanonicalBytesNameTheOneVariable() throws {
        let change = ServiceEnvChange(
            serverId: "srv1", serviceId: "alice--blog", op: "unset", name: "API_KEY",
            valueSha256: "", issuedAt: 1700000000, nonce: String(repeating: "ab", count: 16)
        )
        XCTAssertEqual(
            String(data: try change.canonicalBytes(), encoding: .utf8),
            "flagship/service-env-change/v1|srv1|alice--blog|unset|API_KEY||1700000000|" + String(repeating: "ab", count: 16)
        )
    }

    func testASetSignsTheValuesHashNotTheValue() throws {
        let change = ServiceEnvChange.make(serverId: "srv1", serviceId: "alice--blog", set: "API_KEY", value: "s|cret")
        let text = String(data: try change.canonicalBytes(), encoding: .utf8) ?? ""
        XCTAssertFalse(text.contains("s|cret"))
        XCTAssertTrue(text.contains(ServiceEnvChange.valueSha256("s|cret")))
    }
}
