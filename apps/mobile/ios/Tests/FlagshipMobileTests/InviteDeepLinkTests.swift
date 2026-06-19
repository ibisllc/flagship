import XCTest
@testable import FlagshipCore

/// Parsing of the service-access redeem deep link (docs/service-access-gating.md):
/// the box universal link `https://<server>.<user>.flagship.services/invite#<secret>`
/// and the `flagship://invite?server=…&k=…` custom-scheme hand-off.
final class InviteDeepLinkTests: XCTestCase {
    private let secret = String(repeating: "ab", count: 32) // 64-hex

    func testUniversalLinkFragmentSecret() {
        let url = URL(string: "https://home.alice.flagship.services/invite#\(secret)")!
        XCTAssertEqual(DeepLink.parse(url), .inviteRedeem(serverDomain: "home.alice.flagship.services", secretHex: secret))
    }

    func testUniversalLinkKEqualsFragment() {
        let url = URL(string: "https://home.alice.flagship.services/invite#k=\(secret)")!
        XCTAssertEqual(DeepLink.parse(url), .inviteRedeem(serverDomain: "home.alice.flagship.services", secretHex: secret))
    }

    func testUniversalLinkUppercaseSecretLowercased() {
        let up = secret.uppercased()
        let url = URL(string: "https://home.alice.flagship.services/invite#\(up)")!
        XCTAssertEqual(DeepLink.parse(url), .inviteRedeem(serverDomain: "home.alice.flagship.services", secretHex: secret))
    }

    func testUniversalLinkWithoutFragmentIsNil() {
        let url = URL(string: "https://home.alice.flagship.services/invite")!
        XCTAssertNil(DeepLink.parse(url))
    }

    func testUniversalLinkWrongPathIsNil() {
        let url = URL(string: "https://home.alice.flagship.services/other#\(secret)")!
        XCTAssertNil(DeepLink.parse(url))
    }

    func testUniversalLinkNonBoxHostIsNil() {
        // flagshipserver.com is NOT under the data apex → not a box invite.
        let url = URL(string: "https://flagshipserver.com/invite#\(secret)")!
        XCTAssertNil(DeepLink.parse(url))
    }

    func testCustomSchemeServerAndK() {
        let url = URL(string: "flagship://invite?server=home.alice.flagship.services&k=\(secret)")!
        XCTAssertEqual(DeepLink.parse(url), .inviteRedeem(serverDomain: "home.alice.flagship.services", secretHex: secret))
    }

    func testCustomSchemeMissingServerIsNil() {
        let url = URL(string: "flagship://invite?k=\(secret)")!
        XCTAssertNil(DeepLink.parse(url))
    }

    func testCustomSchemeBadSecretIsNil() {
        let url = URL(string: "flagship://invite?server=home.alice.flagship.services&k=notahexsecret")!
        XCTAssertNil(DeepLink.parse(url))
    }

    func testSecretFromFragmentHelper() {
        XCTAssertEqual(DeepLink.secretFromFragment(secret), secret)
        XCTAssertEqual(DeepLink.secretFromFragment("#\(secret)"), secret)
        XCTAssertEqual(DeepLink.secretFromFragment("k=\(secret)"), secret)
        XCTAssertEqual(DeepLink.secretFromFragment("a=1&k=\(secret)&b=2"), secret)
        XCTAssertNil(DeepLink.secretFromFragment(""))
        XCTAssertNil(DeepLink.secretFromFragment("abc"))
        XCTAssertNil(DeepLink.secretFromFragment(nil))
    }
}
