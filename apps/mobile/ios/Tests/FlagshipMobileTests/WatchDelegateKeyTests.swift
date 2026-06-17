import XCTest
import CryptoKit
@testable import FlagshipCore
@testable import FlagshipAPI

/// Phase iOS-A — the watch-delegate crypto + wire surface. The canonical
/// bytes MUST stay byte-identical to the Worker (packages/protocol +
/// packages/control-plane), so these assert the exact `|`-joined string in
/// addition to the sign/verify round-trips.
final class WatchDelegateKeyTests: XCTestCase {

    private func hex(_ d: Data) -> String { d.map { String(format: "%02x", $0) }.joined() }

    func test_watchDelegateEnvelope_canonicalBytes_matchWorker() {
        let env = WatchDelegateKeyEnvelope(
            grantId: "g-1",
            username: "dani",
            delegatePubKeyHex: String(repeating: "ab", count: 32),
            scopes: ["boot-approval"],
            issuedAt: 1000,
            expiresAt: 2000
        )
        // SINGLE-scope vector — UNCHANGED by the fixed-index sort (the common case).
        let expected = "flagship/watch-delegate-key/v1|g-1|dani|"
            + String(repeating: "ab", count: 32)
            + "|boot-approval|1000|2000"
        XCTAssertEqual(String(data: env.canonicalBytes(), encoding: .utf8), expected)
    }

    /// AUTHORITATIVE cross-platform MULTI-SCOPE vector for DeviceCapabilityGrant
    /// — pinned in TS (packages/protocol/tests/deviceCapabilityGrant.test.ts)
    /// and Kotlin. The scopes include `add-device` + `admin` alongside `browse`
    /// — the set where a LEXICOGRAPHIC sort (the prior mobile bug) diverges
    /// from the DEVICE_SCOPES-index sort: alphabetical → "add-device,admin,browse",
    /// canonical → "browse,add-device,admin". Mobile MUST match canonical.
    func test_deviceCapabilityGrant_multiScope_canonicalBytes_matchWorker() {
        // FIXED_DEVICE_PUB from the shared TS fixture: byte[i] = (i*3 + 11) & 0xff.
        var pub = Data(count: 32)
        for i in 0..<32 { pub[i] = UInt8((i * 3 + 11) & 0xff) }
        let env = DeviceCapabilityGrantEnvelope(
            grantId: "550e8400-e29b-41d4-a716-446655440000",
            username: "trent",
            deviceLabel: "ipad",
            devicePubKeyHex: HexUtil.encode(pub),
            scopes: ["admin", "browse", "add-device"], // scrambled input on purpose
            issuedAt: 1_780_000_000_000,
            expiresAt: 1_787_776_000_000
        )
        let expected = "flagship/device-capability-grant/v1"
            + "|550e8400-e29b-41d4-a716-446655440000|trent|ipad|"
            + "0b0e1114171a1d202326292c2f3235383b3e4144474a4d505356595c5f626568"
            + "|browse,add-device,admin|1780000000000|1787776000000"
        let canon = String(data: env.canonicalBytes(), encoding: .utf8)
        XCTAssertEqual(canon, expected)
        // It must NOT be the alphabetical ordering.
        XCTAssertFalse(canon!.contains("add-device,admin,browse"))
        // And the SHA-256 must match the pinned id shared with TS + Kotlin.
        let digest = SHA256.hash(data: env.canonicalBytes())
        let idHex = digest.map { String(format: "%02x", $0) }.joined()
        XCTAssertEqual(idHex, "cdf24b718bec2cc7fda2d07abbdf57252b4b3f6de12ebe56a61ce65bd6ab9bf6")
    }

    func test_deviceCapabilityGrant_multiScope_signVerify_roundTrip() throws {
        let irk = Curve25519.Signing.PrivateKey()
        var pub = Data(count: 32)
        for i in 0..<32 { pub[i] = UInt8((i * 3 + 11) & 0xff) }
        let env = DeviceCapabilityGrantEnvelope(
            grantId: "550e8400-e29b-41d4-a716-446655440000",
            username: "trent",
            deviceLabel: "ipad",
            devicePubKeyHex: HexUtil.encode(pub),
            scopes: ["admin", "browse", "add-device"],
            issuedAt: 1_780_000_000_000,
            expiresAt: 1_787_776_000_000
        )
        let sig = try irk.signature(for: env.canonicalBytes())
        XCTAssertTrue(env.verify(signature: sig, irkPub: irk.publicKey.rawRepresentation))
        let other = Curve25519.Signing.PrivateKey()
        XCTAssertFalse(env.verify(signature: sig, irkPub: other.publicKey.rawRepresentation))
    }

    func test_watchDelegateEnvelope_signVerify_roundTrip() throws {
        let irk = Curve25519.Signing.PrivateKey()
        let delegate = Curve25519.Signing.PrivateKey()
        let env = WatchDelegateKeyEnvelope(
            grantId: "g-2",
            username: "dani",
            delegatePubKeyHex: hex(delegate.publicKey.rawRepresentation),
            scopes: ["boot-approval"],
            issuedAt: 1000,
            expiresAt: 1000 + 7 * 24 * 3_600_000
        )
        let sig = try env.sign(with: irk)
        XCTAssertTrue(env.verify(signature: sig, irkPub: irk.publicKey.rawRepresentation))
        // A different IRK must NOT verify.
        let other = Curve25519.Signing.PrivateKey()
        XCTAssertFalse(env.verify(signature: sig, irkPub: other.publicKey.rawRepresentation))
    }

    func test_revokeEnvelope_canonicalBytes_andRoundTrip() throws {
        let irk = Curve25519.Signing.PrivateKey()
        let env = RevokeWatchDelegateEnvelope(grantId: "g-3", username: "dani", issuedAt: 1500)
        XCTAssertEqual(
            String(data: env.canonicalBytes(), encoding: .utf8),
            "flagship/revoke-watch-delegate/v1|g-3|dani|1500"
        )
        let sig = try env.sign(with: irk)
        XCTAssertTrue(env.verify(signature: sig, irkPub: irk.publicKey.rawRepresentation))
    }

    func test_bootAuth_delegateHeader_carriesDelegateRole_andVerifies() throws {
        let delegate = Curve25519.Signing.PrivateKey()
        let nonce = Data(repeating: 7, count: 32)
        let header = try BootAuth.delegateHeader(
            serverDomain: "home.dani.flagship.services",
            method: "POST",
            path: "/api/boot/response",
            delegateKey: delegate,
            now: 1_700_000,
            nonce: nonce
        )
        // Decode the base64url envelope and check the role + signature.
        let parts = header.split(separator: " ")
        XCTAssertEqual(String(parts[0]), "Flagship-Boot-v1")
        var b64 = String(parts[1]).replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while b64.count % 4 != 0 { b64 += "=" }
        let json = Data(base64Encoded: b64)!
        let obj = try JSONSerialization.jsonObject(with: json) as! [String: Any]
        XCTAssertEqual(obj["role"] as? String, "delegate")
        XCTAssertEqual(obj["pubKeyHex"] as? String, hex(delegate.publicKey.rawRepresentation))

        // The signature must verify under the delegate key over the canonical bytes.
        let canon = BootAuth.canonicalBytes(
            role: "delegate",
            serverDomain: "home.dani.flagship.services",
            method: "POST",
            path: "/api/boot/response",
            pubKeyHex: hex(delegate.publicKey.rawRepresentation),
            nonceHex: hex(nonce),
            issuedAt: 1_700_000
        )
        let sig = HexUtil.decode(obj["signatureHex"] as! String)!
        XCTAssertTrue(delegate.publicKey.isValidSignature(sig, for: canon))
    }

    // MARK: - Mock server client

    private func makeMock() -> MockFlagshipServerClient {
        let s = MockFlagshipServerClient()
        s.simulatedLatency = 0
        return s
    }

    func test_mock_mint_then_list_showsDelegate() async throws {
        let s = makeMock()
        let req = WatchDelegateMintRequest(
            grant: .init(grantId: "g1", username: "dani", delegatePubKey: String(repeating: "aa", count: 32),
                         scopes: ["boot-approval"], issuedAt: 0, expiresAt: 9_000_000_000_000),
            signature: String(repeating: "bb", count: 64)
        )
        let res = try await s.mintWatchDelegate(username: "dani", body: req)
        XCTAssertEqual(res.grantId, "g1")
        XCTAssertNil(res.replacedGrantId)
        let list = try await s.listWatchDelegates(username: "DANI")
        XCTAssertEqual(list.delegates.count, 1)
        XCTAssertEqual(list.delegates.first?.grantId, "g1")
    }

    func test_mock_remint_replacesPrior() async throws {
        let s = makeMock()
        func mk(_ id: String) -> WatchDelegateMintRequest {
            .init(grant: .init(grantId: id, username: "dani", delegatePubKey: String(repeating: "aa", count: 32),
                               scopes: ["boot-approval"], issuedAt: 0, expiresAt: 9_000_000_000_000),
                  signature: String(repeating: "bb", count: 64))
        }
        _ = try await s.mintWatchDelegate(username: "dani", body: mk("g1"))
        let second = try await s.mintWatchDelegate(username: "dani", body: mk("g2"))
        XCTAssertEqual(second.replacedGrantId, "g1")
        let list = try await s.listWatchDelegates(username: "dani")
        XCTAssertEqual(list.delegates.map(\.grantId), ["g2"])
    }

    func test_mock_revoke_removes() async throws {
        let s = makeMock()
        let req = WatchDelegateMintRequest(
            grant: .init(grantId: "g1", username: "dani", delegatePubKey: String(repeating: "aa", count: 32),
                         scopes: ["boot-approval"], issuedAt: 0, expiresAt: 9_000_000_000_000),
            signature: String(repeating: "bb", count: 64)
        )
        _ = try await s.mintWatchDelegate(username: "dani", body: req)
        try await s.revokeWatchDelegate(username: "dani", body: .init(
            request: .init(grantId: "g1", username: "dani", issuedAt: 1), signature: String(repeating: "cc", count: 64)))
        let list = try await s.listWatchDelegates(username: "dani")
        XCTAssertEqual(list.delegates.count, 0)
    }

    func test_mock_rejectsBadScopes() async throws {
        let s = makeMock()
        let req = WatchDelegateMintRequest(
            grant: .init(grantId: "g1", username: "dani", delegatePubKey: String(repeating: "aa", count: 32),
                         scopes: ["install-service"], issuedAt: 0, expiresAt: 9_000_000_000_000),
            signature: String(repeating: "bb", count: 64)
        )
        do {
            _ = try await s.mintWatchDelegate(username: "dani", body: req)
            XCTFail("expected invalid scopes to throw")
        } catch {
            // expected
        }
    }
}
