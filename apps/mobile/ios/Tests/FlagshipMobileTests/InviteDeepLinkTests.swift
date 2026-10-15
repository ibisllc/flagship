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
        // Canonical: a bare leading secret followed by other params.
        XCTAssertEqual(DeepLink.secretFromFragment("\(secret)&a=\(authorAid)"), secret)
        XCTAssertNil(DeepLink.secretFromFragment(""))
        XCTAssertNil(DeepLink.secretFromFragment("abc"))
        XCTAssertNil(DeepLink.secretFromFragment(nil))
    }

    // MARK: v2 — authorAID + inviteId on the link; the accept reply.

    private let authorAid = String(repeating: "b4", count: 32) // 64-hex
    private let inviteId = String(repeating: "ea", count: 32)   // 64-hex

    func testUniversalLinkCarriesAuthorAidAndInviteId() {
        // Canonical: BARE leading secret, then &a=/&i=.
        let url = URL(string: "https://home.alice.flagship.services/invite#\(secret)&a=\(authorAid)&i=\(inviteId)")!
        XCTAssertEqual(
            DeepLink.parse(url),
            .inviteRedeem(serverDomain: "home.alice.flagship.services", secretHex: secret, authorAidHex: authorAid, inviteId: inviteId))
    }

    func testUniversalLinkLegacyKAndIidStillParse() {
        // Backward-compat: a pre-reconcile `#k=…&a=…&iid=…` link must still parse.
        let url = URL(string: "https://home.alice.flagship.services/invite#k=\(secret)&a=\(authorAid)&iid=\(inviteId)")!
        XCTAssertEqual(
            DeepLink.parse(url),
            .inviteRedeem(serverDomain: "home.alice.flagship.services", secretHex: secret, authorAidHex: authorAid, inviteId: inviteId))
    }

    func testCustomSchemeCarriesAuthorAidAndInviteId() {
        let url = URL(string: "flagship://invite?server=home.alice.flagship.services&k=\(secret)&a=\(authorAid)&i=\(inviteId)")!
        XCTAssertEqual(
            DeepLink.parse(url),
            .inviteRedeem(serverDomain: "home.alice.flagship.services", secretHex: secret, authorAidHex: authorAid, inviteId: inviteId))
    }

    func testInviteLinkBuilderRoundTrips() {
        // A v2 link the create screen builds must parse back to the same fields.
        let link = ServiceInviteLinks.inviteLink(serverDomain: "home.alice.flagship.services", secretHex: secret, authorAidHex: authorAid, inviteId: inviteId)
        XCTAssertEqual(link, "https://home.alice.flagship.services/invite#\(secret)&a=\(authorAid)&i=\(inviteId)")
        XCTAssertEqual(
            DeepLink.parse(URL(string: link)!),
            .inviteRedeem(serverDomain: "home.alice.flagship.services", secretHex: secret, authorAidHex: authorAid, inviteId: inviteId))
        // A bare link (auto, no manual) still round-trips to nil author/i.
        let bare = ServiceInviteLinks.inviteLink(serverDomain: "home.alice.flagship.services", secretHex: secret)
        XCTAssertEqual(bare, "https://home.alice.flagship.services/invite#\(secret)")
    }

    /// FROZEN cross-client canonical fragment (interop lock — the IDENTICAL
    /// string is pinned on the webapp serviceInvite test + Android InviteLink).
    func testFrozenCanonicalFragmentInterop() {
        let s = String(repeating: "a", count: 64)
        let a = "b4b357bf622c86ea3b6c3e2440e2bf9e344ac3cf5f61236da8e6f280f93db640"
        let i = "ea4ab8be66710610842cf6ef0d7e56bd91a4f03c7a5633fde4a66482cc292890"
        let frag = "\(s)&a=\(a)&i=\(i)"
        // build(secret,a,i) === the frozen fragment.
        let link = ServiceInviteLinks.inviteLink(serverDomain: "home.alice.flagship.services", secretHex: s, authorAidHex: a, inviteId: i)
        XCTAssertEqual(link, "https://home.alice.flagship.services/invite#\(frag)")
        // parse(frozen) === { secret, a, i }.
        XCTAssertEqual(
            DeepLink.parse(URL(string: "https://home.alice.flagship.services/invite#\(frag)")!),
            .inviteRedeem(serverDomain: "home.alice.flagship.services", secretHex: s, authorAidHex: a, inviteId: i))
        // parse(bare secret) === { secret only }.
        XCTAssertEqual(
            DeepLink.parse(URL(string: "https://home.alice.flagship.services/invite#\(s)")!),
            .inviteRedeem(serverDomain: "home.alice.flagship.services", secretHex: s, authorAidHex: nil, inviteId: nil))
        // The current form also names the app (frozen the same on webapp + Android).
        let fragApp = "\(frag)&s=alice-notes"
        XCTAssertEqual(
            ServiceInviteLinks.inviteLink(serverDomain: "home.alice.flagship.services", secretHex: s, authorAidHex: a,
                                          inviteId: i, serviceRef: "alice-notes"),
            "https://home.alice.flagship.services/invite#\(fragApp)")
        XCTAssertEqual(
            DeepLink.parse(URL(string: "https://home.alice.flagship.services/invite#\(fragApp)")!),
            .inviteRedeem(serverDomain: "home.alice.flagship.services", secretHex: s, authorAidHex: a, inviteId: i,
                          serviceRef: "alice-notes"))
        // The app-open hand-off carries it as `s`; a malformed one is dropped.
        XCTAssertEqual(
            DeepLink.parse(URL(string: "flagship://invite?server=home.alice.flagship.services&k=\(s)&a=\(a)&s=alice-notes")!),
            .inviteRedeem(serverDomain: "home.alice.flagship.services", secretHex: s, authorAidHex: a, inviteId: nil,
                          serviceRef: "alice-notes"))
        XCTAssertEqual(
            DeepLink.parse(URL(string: "https://home.alice.flagship.services/invite#\(frag)&s=Bad%20Ref")!),
            .inviteRedeem(serverDomain: "home.alice.flagship.services", secretHex: s, authorAidHex: a, inviteId: i))
    }

    func testAcceptReplyLinkRoundTrips() {
        let sig = String(repeating: "1c", count: 64) // 128-hex
        let link = ServiceInviteLinks.acceptReplyLink(
            serverDomain: "home.alice.flagship.services", inviteId: inviteId, serviceRef: "alice--notes",
            contactAidHex: authorAid, acceptSigHex: sig, acceptedAt: 1_700_000_000_000)!
        XCTAssertEqual(
            DeepLink.parse(URL(string: link)!),
            .inviteAccept(serverDomain: "home.alice.flagship.services", inviteId: inviteId, serviceRef: "alice--notes", contactAidHex: authorAid, acceptSigHex: sig, acceptedAt: 1_700_000_000_000))
    }

    func testLegacySchemeAcceptReplyStillParses() {
        let server = "home.alice.flagship.services"
        let sig = String(repeating: "1f", count: 64)
        let legacy = "flagship://invite-accept?server=\(server)&iid=\(inviteId)&ref=alice-notes&aid=\(authorAid)&sig=\(sig)&at=1700006000000"
        let expected = DeepLink.inviteAccept(serverDomain: server, inviteId: inviteId, serviceRef: "alice-notes", contactAidHex: authorAid, acceptSigHex: sig, acceptedAt: 1_700_006_000_000)
        XCTAssertEqual(DeepLink.parse(URL(string: legacy)!), expected)
        let universal = "https://www.flagshipserver.com/invite-accept/?server=\(server)&iid=\(inviteId)&ref=alice-notes&aid=\(authorAid)&sig=\(sig)&at=1700006000000"
        XCTAssertEqual(DeepLink.parse(URL(string: universal)!), expected)
        XCTAssertNil(DeepLink.parse(URL(string: "https://example.com/invite-accept?server=\(server)&iid=\(inviteId)&ref=alice-notes&aid=\(authorAid)&sig=\(sig)&at=1")!))
        XCTAssertNil(DeepLink.parse(URL(string: "https://flagshipserver.com/invite-accept?server=\(server)&iid=\(inviteId)&ref=alice-notes&aid=\(authorAid)&sig=tooShort&at=1")!))
    }

    func testFragmentAcceptReplyParses() {
        let server = "home.alice.flagship.services"
        let sig = String(repeating: "1f", count: 64)
        let expected = DeepLink.inviteAccept(serverDomain: server, inviteId: inviteId, serviceRef: "alice-notes", contactAidHex: authorAid, acceptSigHex: sig, acceptedAt: 1_700_006_000_000)
        let frag = "server=\(server)&iid=\(inviteId)&ref=alice-notes&aid=\(authorAid)&sig=\(sig)&at=1700006000000"
        XCTAssertEqual(DeepLink.parse(URL(string: "https://flagshipserver.com/invite-accept#\(frag)")!), expected)
        XCTAssertEqual(DeepLink.parse(URL(string: "https://www.flagshipserver.com/invite-accept/#\(frag)")!), expected)
        XCTAssertEqual(DeepLink.parsePastedString("  https://flagshipserver.com/invite-accept#\(frag)\n"), expected)
        let encoded = "server=home%2Ealice.flagship.services&iid=\(inviteId)&ref=alice%2Dnotes&aid=\(authorAid)&sig=\(sig)&at=1700006000000"
        XCTAssertEqual(DeepLink.parse(URL(string: "https://flagshipserver.com/invite-accept#\(encoded)")!), expected)
        // The fragment wins over a query; an empty fragment falls back to it.
        XCTAssertEqual(DeepLink.parse(URL(string: "https://flagshipserver.com/invite-accept?server=other.example&iid=x#\(frag)")!), expected)
        XCTAssertEqual(DeepLink.parse(URL(string: "https://flagshipserver.com/invite-accept?\(frag)#")!), expected)
        XCTAssertNil(DeepLink.parse(URL(string: "https://flagshipserver.com/invite-accept#server=\(server)&iid=\(inviteId)&ref=alice-notes&aid=\(authorAid)&sig=tooShort&at=1")!))
        XCTAssertNil(DeepLink.parse(URL(string: "https://example.com/invite-accept#\(frag)")!))
    }

    func testAcceptReplyLinkKeepsItsParamsOutOfTheQuery() {
        let link = ServiceInviteLinks.acceptReplyLink(
            serverDomain: "home.alice.flagship.services", inviteId: inviteId, serviceRef: "alice--notes",
            contactAidHex: authorAid, acceptSigHex: String(repeating: "1c", count: 64), acceptedAt: 1)!
        let url = URL(string: link)!
        XCTAssertNil(url.query)
        XCTAssertNotNil(url.fragment)
    }

    func testAcceptReplyBadSigIsNil() {
        let url = URL(string: "flagship://invite-accept?server=home.alice.flagship.services&iid=\(inviteId)&ref=alice--notes&aid=\(authorAid)&sig=tooShort&at=1")!
        XCTAssertNil(DeepLink.parse(url))
    }

    /// FROZEN cross-client acceptance reply (interop lock — the IDENTICAL string
    /// is pinned on the webapp serviceInvite test + Android InviteLink). The
    /// canonical reply is `https://flagshipserver.com/invite-accept#server=&iid=&ref=&aid=&sig=&at=`
    /// (fragment, so a browser never sends it to `.com`), carrying ONLY {accept, acceptSig} (the box fetches the create from .com).
    func testFrozenAcceptReplyInterop() {
        let server = "home.alice.flagship.services"
        let iid = "ea4ab8be66710610842cf6ef0d7e56bd91a4f03c7a5633fde4a66482cc292890"
        let ref = "alice-notes"
        let aid = "086abb1c191c86e7cb68d4736f73c68f8b0c55c2a3fafa6a2c770fc308ab242a"
        let sig = String(repeating: "1f", count: 64) // 128-hex
        let at: Int64 = 1_700_006_000_000
        let frozen = "https://flagshipserver.com/invite-accept#server=home.alice.flagship.services&iid=ea4ab8be66710610842cf6ef0d7e56bd91a4f03c7a5633fde4a66482cc292890&ref=alice-notes&aid=086abb1c191c86e7cb68d4736f73c68f8b0c55c2a3fafa6a2c770fc308ab242a&sig=\(sig)&at=1700006000000"
        // build === the frozen string.
        XCTAssertEqual(
            ServiceInviteLinks.acceptReplyLink(serverDomain: server, inviteId: iid, serviceRef: ref, contactAidHex: aid, acceptSigHex: sig, acceptedAt: at),
            frozen)
        // parse(frozen) === the structured acceptance.
        XCTAssertEqual(
            DeepLink.parse(URL(string: frozen)!),
            .inviteAccept(serverDomain: server, inviteId: iid, serviceRef: ref, contactAidHex: aid, acceptSigHex: sig, acceptedAt: at))
    }
}
