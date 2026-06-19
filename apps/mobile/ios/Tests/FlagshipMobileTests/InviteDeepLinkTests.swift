import XCTest
@testable import FlagshipCore

/// Parsing of the service-access redeem deep link (docs/service-access-gating.md):
/// the box universal link `https://<server>.<user>.flagship.services/invite#<secret>`
/// and the `flagship://invite?server=…&k=…` custom-scheme hand-off.
final class InviteDeepLinkTests: XCTestCase {
    private let secret = String(repeating: "ab", count: 32) // 64-hex

    func testUniversalLinkFragmentSecret() {
        let url = URL(string: "https://home.alice.flagship.services/invite#\(secret)")!
        XCTAssertEqual(DeepLink.parse(url), .inviteRedeem(serverDomain: "home.alice.flagship.services", secretHex: secret, authorAidHex: nil, inviteId: nil))
    }

    func testUniversalLinkKEqualsFragment() {
        let url = URL(string: "https://home.alice.flagship.services/invite#k=\(secret)")!
        XCTAssertEqual(DeepLink.parse(url), .inviteRedeem(serverDomain: "home.alice.flagship.services", secretHex: secret, authorAidHex: nil, inviteId: nil))
    }

    func testUniversalLinkUppercaseSecretLowercased() {
        let up = secret.uppercased()
        let url = URL(string: "https://home.alice.flagship.services/invite#\(up)")!
        XCTAssertEqual(DeepLink.parse(url), .inviteRedeem(serverDomain: "home.alice.flagship.services", secretHex: secret, authorAidHex: nil, inviteId: nil))
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
        XCTAssertEqual(DeepLink.parse(url), .inviteRedeem(serverDomain: "home.alice.flagship.services", secretHex: secret, authorAidHex: nil, inviteId: nil))
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

    // MARK: v2 — authorAID + inviteId on the link; the accept reply.

    private let authorAid = String(repeating: "b4", count: 32) // 64-hex
    private let inviteId = String(repeating: "ea", count: 32)   // 64-hex

    func testUniversalLinkCarriesAuthorAidAndInviteId() {
        let url = URL(string: "https://home.alice.flagship.services/invite#k=\(secret)&a=\(authorAid)&iid=\(inviteId)")!
        XCTAssertEqual(
            DeepLink.parse(url),
            .inviteRedeem(serverDomain: "home.alice.flagship.services", secretHex: secret, authorAidHex: authorAid, inviteId: inviteId))
    }

    func testCustomSchemeCarriesAuthorAidAndInviteId() {
        let url = URL(string: "flagship://invite?server=home.alice.flagship.services&k=\(secret)&a=\(authorAid)&iid=\(inviteId)")!
        XCTAssertEqual(
            DeepLink.parse(url),
            .inviteRedeem(serverDomain: "home.alice.flagship.services", secretHex: secret, authorAidHex: authorAid, inviteId: inviteId))
    }

    func testInviteLinkBuilderRoundTrips() {
        // A v2 link the create screen builds must parse back to the same fields.
        let link = ServiceInviteLinks.inviteLink(serverDomain: "home.alice.flagship.services", secretHex: secret, authorAidHex: authorAid, inviteId: inviteId)
        XCTAssertEqual(
            DeepLink.parse(URL(string: link)!),
            .inviteRedeem(serverDomain: "home.alice.flagship.services", secretHex: secret, authorAidHex: authorAid, inviteId: inviteId))
        // A bare link (auto, no manual) still round-trips to nil author/iid.
        let bare = ServiceInviteLinks.inviteLink(serverDomain: "home.alice.flagship.services", secretHex: secret)
        XCTAssertEqual(bare, "https://home.alice.flagship.services/invite#\(secret)")
    }

    func testAcceptReplyLinkRoundTrips() {
        let sig = String(repeating: "1c", count: 64) // 128-hex
        let link = ServiceInviteLinks.acceptReplyLink(
            serverDomain: "home.alice.flagship.services", inviteId: inviteId, serviceRef: "alice-notes",
            contactAidHex: authorAid, acceptSigHex: sig, acceptedAt: 1_700_000_000_000)!
        XCTAssertEqual(
            DeepLink.parse(URL(string: link)!),
            .inviteAccept(serverDomain: "home.alice.flagship.services", inviteId: inviteId, serviceRef: "alice-notes", contactAidHex: authorAid, acceptSigHex: sig, acceptedAt: 1_700_000_000_000))
    }

    func testAcceptReplyBadSigIsNil() {
        let url = URL(string: "flagship://invite-accept?server=home.alice.flagship.services&iid=\(inviteId)&ref=alice-notes&aid=\(authorAid)&sig=tooShort&at=1")!
        XCTAssertNil(DeepLink.parse(url))
    }
}
