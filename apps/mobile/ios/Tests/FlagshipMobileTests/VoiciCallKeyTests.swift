import XCTest
import CryptoKit
@testable import FlagshipAPI
@testable import FlagshipCore
@testable import FlagshipUI

/// Answering while locked (docs/voici-calls.md, owner decisions 2026-11-15): with only the call key, a device joins the
/// room, answers and ends a call; nothing else of the account is used. Mirrors Android VoiciAppTest.
final class VoiciCallKeyTests: XCTestCase {
    private let ownerSeed: [UInt8] = Array(repeating: 7, count: 32)
    private let deviceId = String(repeating: "d1", count: 16)

    private func key() throws -> VoiciCallKey {
        let priv = P256.Signing.PrivateKey()
        let pub = CanonicalJson.hex(Array(priv.publicKey.x963Representation))
        let proof = try VoiciCalls.signCallKeyBinding(username: "alice", deviceId: deviceId, callKeyPub: pub, createdAt: 1, ownerSignSeed: ownerSeed)
        let ownerPub = CanonicalJson.hex(try CanonicalJson.ed25519PublicKey(seed: ownerSeed))
        return VoiciCallKeyStore.key(username: "alice", deviceId: deviceId, pageId: String(repeating: "ab", count: 16), ownerSignPub: ownerPub,
                                     secret: priv.rawRepresentation, enclave: false, pubHex: pub, proof: proof)
    }

    func test_theBindingVerifiesUnderTheOwnerKeyOnly() throws {
        let k = try key()
        XCTAssertTrue(VoiciCalls.verifyCallKeyBinding(k.proof, ownerSignPub: k.ownerSignPub, username: "alice"))
        XCTAssertFalse(VoiciCalls.verifyCallKeyBinding(k.proof, ownerSignPub: k.ownerSignPub, username: "bob"))
        XCTAssertFalse(VoiciCalls.verifyCallKeyBinding(k.proof, ownerSignPub: String(repeating: "00", count: 32), username: "alice"))
    }

    func test_aLockedDeviceJoinsAnswersAndEndsWithTheCallKeyOnly() throws {
        let k = try key()
        let locked = VoiciCallKeys.locked(k, caKeys: [], origin: "https://voi.ci")
        XCTAssertNil(locked.ownerSignSeed)
        XCTAssertNil(locked.deviceKey)
        XCTAssertEqual(locked.deviceRef, try VoiciCalls.deviceRef(devicePubHex: k.pubHex))
        let callId = String(repeating: "ca", count: 16)
        let h = try XCTUnwrap(locked.roomHeaders(callId: callId, path: "/api/voici/calls/\(callId)/device"))
        let at = try XCTUnwrap(Int64(h["x-flagship-call-key-at"] ?? ""))
        XCTAssertNil(h["x-flagship-device-pub"])
        XCTAssertTrue(VoiciCalls.verifyCallJoin(username: "alice", callId: callId, deviceId: deviceId, callKeyPub: k.pubHex, issuedAt: at,
                                                signature: try XCTUnwrap(h["x-flagship-call-key-sig"]), now: at))
        XCTAssertFalse(VoiciCalls.verifyCallJoin(username: "alice", callId: String(repeating: "00", count: 16), deviceId: deviceId, callKeyPub: k.pubHex,
                                                 issuedAt: at, signature: try XCTUnwrap(h["x-flagship-call-key-sig"]), now: at))
        let end = try XCTUnwrap(locked.signEnd(callId: callId, reason: "hangup", issuedAt: 5))
        XCTAssertTrue(CanonicalJson.p256VerifyP1363(try XCTUnwrap(end["sig"]?.string),
                                                    try VoiciCalls.canonicalEnd(callId: callId, side: "owner", reason: "hangup", issuedAt: 5), k.pubHex))
        let r = try XCTUnwrap(k.selfRevoke(at: 9))
        XCTAssertTrue(VoiciCalls.verifyCallKeyRevoke(username: "alice", deviceId: deviceId, callKeyPub: k.pubHex, revokedAt: 9, signature: r.signature,
                                                     ownerSignPub: String(repeating: "00", count: 32)))
    }
}
