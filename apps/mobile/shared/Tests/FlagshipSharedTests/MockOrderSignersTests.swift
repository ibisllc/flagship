import XCTest
import CryptoKit
@testable import FlagshipAPI
@testable import FlagshipCore

/// The gym's mocks check a signed order the way `.com` and the box do: an
/// admin-pinned account takes a sensitive order only under its admin root,
/// so a client that regressed to IRK signing is refused.
final class MockOrderSignersTests: XCTestCase {
    private let admin = try! Curve25519.Signing.PrivateKey(rawRepresentation: Data(repeating: 9, count: 32))
    private let irk = try! Curve25519.Signing.PrivateKey(rawRepresentation: Data(repeating: 0x47, count: 32))

    private func signers(adminPinned: Bool = true) -> MockOrderSigners {
        let s = MockOrderSigners()
        s.pin(adminRoot: adminPinned ? admin.publicKey : nil, irk: irk.publicKey)
        GymOrderCanonical.install(on: s)
        return s
    }

    private func order(_ key: Curve25519.Signing.PrivateKey) throws -> SignedServerOrderWire {
        let o = ServerOrder(user: "bright-maple", stks: [String(repeating: "ab", count: 32)], issuedAt: 1_760_000_000_000,
                            nonce: String(repeating: "cd", count: 32))
        return SignedServerOrderWire(order: .init(user: o.user, stks: o.stks, issuedAt: o.issuedAt, nonce: o.nonce),
                                     signature: try o.sign(with: key))
    }

    func test_adminPinnedAccount_takesTheAdminRootAndRefusesTheIrk() throws {
        let s = signers()
        let byAdmin = try order(admin)
        XCTAssertEqual(try s.require(.sensitive, kind: "server-order", signatureHex: byAdmin.signature, payload: byAdmin), .adminRoot)
        let byIrk = try order(irk)
        XCTAssertThrowsError(try s.require(.sensitive, kind: "server-order", signatureHex: byIrk.signature, payload: byIrk))
        XCTAssertEqual(s.seen, [.init(kind: "server-order", signer: .adminRoot)])
    }

    func test_accountWithoutAdminRoot_takesTheIrk() throws {
        let s = signers(adminPinned: false)
        let byIrk = try order(irk)
        XCTAssertEqual(try s.require(.sensitive, kind: "server-order", signatureHex: byIrk.signature, payload: byIrk), .irk)
    }

    func test_irkOrders_needTheIrkEvenWhenAnAdminRootIsPinned() throws {
        let s = signers()
        let bytes = ServerRevocationClaim.canonicalBytes(userId: "u", revokedServerId: "home.u.flagship.services",
                                                         reason: "lost", issuedAt: 1)
        let req = ServerRevocationRequest(request: .init(userId: "u", revokedServerId: "home.u.flagship.services",
                                                         reason: "lost", issuedAt: 1),
                                          signature: HexUtil.encode(try irk.signature(for: bytes)))
        XCTAssertEqual(try s.require(.irk, kind: "server-revoke", signatureHex: req.signature, payload: req), .irk)
        let byAdmin = HexUtil.encode(try admin.signature(for: bytes))
        XCTAssertThrowsError(try s.require(.irk, kind: "server-revoke", signatureHex: byAdmin, payload: req))
    }

    func test_dictOrders_buildTheirCanonicalBytes() throws {
        let s = signers()
        let power = PowerOffOrder(serverId: "home.u.flagship.services", mode: .restart, issuedAt: 5)
        let req: [String: Any] = ["type": "power-off", "serverId": power.serverId, "mode": "restart", "issuedAt": Int64(5)]
        let sig = HexUtil.encode(try power.sign(with: admin))
        XCTAssertEqual(try s.require(.sensitive, kind: "power-off", signatureHex: sig, payload: req), .adminRoot)
        let tampered: [String: Any] = ["serverId": power.serverId, "mode": "off", "issuedAt": Int64(5)]
        XCTAssertThrowsError(try s.require(.sensitive, kind: "power-off", signatureHex: sig, payload: tampered))
    }

    func test_nothingPinned_acceptsAnything() throws {
        let s = MockOrderSigners()
        XCTAssertNil(try s.require(.sensitive, kind: "server-order", signatureHex: "00", over: nil))
    }

    func test_shareOrders_needThatSharesKey() throws {
        let s = signers()
        let member = try Curve25519.Signing.PrivateKey(rawRepresentation: Data(repeating: 3, count: 32))
        s.pinShareKey(member.publicKey, shareId: "share-1")
        let bytes = Data("flagship/server-share-update/v1|x".utf8)
        XCTAssertEqual(try s.requireShare(shareId: "share-1", kind: "share-update",
                                          signatureHex: HexUtil.encode(try member.signature(for: bytes)), over: bytes), .share)
        XCTAssertThrowsError(try s.requireShare(shareId: "share-1", kind: "share-update",
                                                signatureHex: HexUtil.encode(try irk.signature(for: bytes)), over: bytes))
    }
}
