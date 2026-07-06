import XCTest
import CryptoKit
@testable import FlagshipAPI
@testable import FlagshipCore

/// Pins the SECRET-FREE pairing contract (the first recipe carries ZERO pairing
/// secrets): the create-time order JSON the phone builds must be byte-identical
/// to the cross-platform vector in `packages/protocol/tests/pairingOrder.test.ts`,
/// and routed by mode — EMBEDDED plaintext (offline) or SEALED to the box
/// identity + deposited (default online). No pairing keypair, no
/// `pairingKeyPrivHex`.
final class CreateTimePairingTests: XCTestCase {
    private let host = "kitchen.alice.flagship.services"
    private let issuedAt: Int64 = 1_750_000_000_000

    // The pinned UMK seed → IRK + the pinned (deterministic-noble) order
    // signature + envelope JSON from the protocol vector.
    private let pinnedIrkPub =
        "3e4a50e7afdfae54c86e1ccd70a8691d48155e9613cbdbf4d17bad5b6ba68045"
    private let pinnedSignature =
        "6e63a086d673fa6e5dd8010aba6367a2aba1861210d21a63bce5dc1331b02f64" +
        "566120c1647b355a51b10a334e01203d48c4d4c279d21d135203d415a70fe109"
    private let pinnedJson =
        "{\"request\":{\"type\":\"add-paired-session\"," +
        "\"serverId\":\"kitchen.alice.flagship.services\"," +
        "\"token\":\"" + String(repeating: "a", count: 64) + "\"," +
        "\"label\":\"Alice's iPhone\",\"issuedAt\":1750000000000}," +
        "\"signature\":\"6e63a086d673fa6e5dd8010aba6367a2aba1861210d21a63bce5dc1331b02f64" +
        "566120c1647b355a51b10a334e01203d48c4d4c279d21d135203d415a70fe109\"}"

    /// HKDF-SHA256 with an EMPTY salt — the protocol `deriveIRK` (info
    /// "flagship.irk.v1").
    private func vectorIrk() -> Curve25519.Signing.PrivateKey {
        let umk = Data(repeating: 0x07, count: 32)
        let seed = HKDF<SHA256>.deriveKey(
            inputKeyMaterial: SymmetricKey(data: umk),
            salt: Data(), info: Data("flagship.irk.v1".utf8), outputByteCount: 32
        ).withUnsafeBytes { Data($0) }
        return try! Curve25519.Signing.PrivateKey(rawRepresentation: seed)
    }

    /// PINNED VECTOR: `PairingOrderEnvelope.toJson` reproduces the protocol's
    /// `pairingOrderToJson` bytes EXACTLY (key order, no whitespace, bare number).
    func testPairingOrderJsonMatchesPinnedVector() {
        XCTAssertEqual(HexUtil.encode(vectorIrk().publicKey.rawRepresentation), pinnedIrkPub)
        let order = AddPairedSessionOrder(
            serverId: host, token: String(repeating: "a", count: 64),
            label: "Alice's iPhone", issuedAt: issuedAt
        )
        let json = PairingOrderEnvelope.toJson(order: order, signatureHex: pinnedSignature)
        XCTAssertEqual(json, pinnedJson)
        // The pinned signature verifies under the pinned IRK pub over the order's
        // canonical bytes (proves the canonical layer is byte-identical to TS).
        let sig = HexUtil.decode(pinnedSignature)!
        XCTAssertTrue(vectorIrk().publicKey.isValidSignature(sig, for: order.canonicalBytes()))
    }

    /// CreateTimePairing.build emits the token + an order JSON the box's open
    /// chain accepts under the owner IRK — no keypair, no deposit at create.
    func testBuildEmitsTokenAndVerifiableOrder() throws {
        let irk = Curve25519.Signing.PrivateKey()
        let token = "ab".repeated(32)
        let built = try CreateTimePairing.build(
            username: "alice", serverDomain: host, label: "Alice's iPhone",
            irk: irk, now: issuedAt, token: token
        )
        XCTAssertEqual(built.token, token)

        // Parse the JSON the box reads, re-derive canonical bytes, verify the sig.
        let env = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(built.pairingOrderJson.utf8)) as? [String: Any])
        let request = try XCTUnwrap(env["request"] as? [String: Any])
        XCTAssertEqual(request["type"] as? String, "add-paired-session")
        XCTAssertEqual(request["serverId"] as? String, host)
        XCTAssertEqual(request["token"] as? String, token)
        let order = AddPairedSessionOrder(
            serverId: try XCTUnwrap(request["serverId"] as? String),
            token: try XCTUnwrap(request["token"] as? String),
            label: try XCTUnwrap(request["label"] as? String),
            issuedAt: try XCTUnwrap((request["issuedAt"] as? NSNumber)?.int64Value)
        )
        let sig = try XCTUnwrap(HexUtil.decode(try XCTUnwrap(env["signature"] as? String)))
        XCTAssertTrue(irk.publicKey.isValidSignature(sig, for: order.canonicalBytes()))
    }

    /// DEFAULT online: `PairingOrderDeposit.buildDeposit` seals the order JSON to
    /// the box identity; the box opens `deposit.sealed` with its identity seed and
    /// recovers the EXACT JSON (the daemon's pairing-deposit-consumer move).
    func testDefaultDepositSealsOrderToBoxIdentity() throws {
        let irk = Curve25519.Signing.PrivateKey()
        let built = try CreateTimePairing.build(
            username: "alice", serverDomain: host, label: "iPhone",
            irk: irk, now: issuedAt, token: "cd".repeated(32)
        )
        let boxSeed = Curve25519.Signing.PrivateKey()
        let boxPub = boxSeed.publicKey.rawRepresentation

        let body = try PairingOrderDeposit.buildDeposit(
            username: "alice", serverDomain: host,
            pairingOrderJson: built.pairingOrderJson,
            boxIdentityPub: boxPub, irk: irk, now: issuedAt
        )
        // I2: the deposit binds the box's REGISTERED identity pub.
        XCTAssertEqual(body.deposit.stkPub, HexUtil.encode(boxPub))
        XCTAssertEqual(body.deposit.serverDomain, host)
        XCTAssertEqual(body.auth.phoneIrkPub, HexUtil.encode(irk.publicKey.rawRepresentation))

        // Box opens the sealed blob with its identity seed → the EXACT order JSON.
        let sealed = try XCTUnwrap(HexUtil.decode(body.deposit.sealed))
        let plain = try SecretSeal.openWithEd25519Seed(
            blob: sealed, recipientEd25519Seed: boxSeed.rawRepresentation
        )
        XCTAssertEqual(String(data: plain, encoding: .utf8), built.pairingOrderJson)

        // The mailbox-auth signature verifies under the same IRK.
        let claim = DeviceEndpointClaim(
            username: body.auth.username, endpointLabel: body.auth.endpointLabel,
            phoneIrkPub: try XCTUnwrap(HexUtil.decode(body.auth.phoneIrkPub)),
            issuedAt: body.auth.issuedAt, expiresAt: body.auth.expiresAt,
            nonce: try XCTUnwrap(HexUtil.decode(body.auth.nonce))
        )
        XCTAssertTrue(DeviceEndpointClaim.verify(
            claim, signature: try XCTUnwrap(HexUtil.decode(body.authSignature)), irkPub: irk.publicKey
        ))
    }

    /// A WRONG identity key must NOT open the deposit (the seal is the binding).
    func testWrongIdentityCannotOpenDeposit() throws {
        let irk = Curve25519.Signing.PrivateKey()
        let built = try CreateTimePairing.build(
            username: "alice", serverDomain: host, label: "iPhone", irk: irk,
            now: issuedAt, token: "ef".repeated(32)
        )
        let boxPub = Curve25519.Signing.PrivateKey().publicKey.rawRepresentation
        let body = try PairingOrderDeposit.buildDeposit(
            username: "alice", serverDomain: host,
            pairingOrderJson: built.pairingOrderJson, boxIdentityPub: boxPub, irk: irk
        )
        let sealed = try XCTUnwrap(HexUtil.decode(body.deposit.sealed))
        let stranger = Curve25519.Signing.PrivateKey()
        XCTAssertThrowsError(
            try SecretSeal.openWithEd25519Seed(blob: sealed, recipientEd25519Seed: stranger.rawRepresentation)
        )
    }
}

private extension String {
    func repeated(_ n: Int) -> String { String(repeating: self, count: n) }
}
