import XCTest
import CryptoKit
@testable import Flagship
@testable import FlagshipCore
@testable import FlagshipAPI

/// #28 — `AcmeAccountKeyGrant` canonical bytes + IRK signature + the
/// seal-to-box producer.
///
/// The signature KAT is the cross-platform lock: the same grant fields signed
/// by the same IRK seed MUST yield the exact 64-byte Ed25519 signature the TS
/// `signAcmeAccountKeyGrant` and the Android signer produce. Ed25519 (RFC
/// 8032) is deterministic, so this is a stable literal.
final class AcmeAccountKeyGrantTests: XCTestCase {

    private func hex(_ d: Data) -> String { HexUtil.encode(d) }
    private func bytes(_ h: String) -> Data { HexUtil.decode(h)! }

    /// IRK seed 32×0x03 → pubkey ed4928…37d1 (shared with the TS vector).
    private func irk() throws -> Curve25519.Signing.PrivateKey {
        try Curve25519.Signing.PrivateKey(rawRepresentation: Data(repeating: 0x03, count: 32))
    }

    /// The exact grant from the cross-platform KAT.
    private func katGrant() -> AcmeAccountKeyGrant {
        let recipientPub = bytes("ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c")
        // sealedAccountKey = bytes 0x01..0x30 (48 bytes).
        let sealed = Data((1...0x30).map { UInt8($0) })
        let issuedAt: Int64 = 1_700_000_000_000
        return AcmeAccountKeyGrant(
            grantId: "00000000-0000-4000-8000-000000000001",
            username: "demo1234",
            accountKeyId: "a9f300eb5960e89133af7362011a1e26f0e2ea2e36dc402a04af6c192b891a8c",
            recipientPubKey: recipientPub,
            sealedAccountKey: sealed,
            issuedAt: issuedAt,
            expiresAt: issuedAt + 90 * 86_400_000
        )
    }

    func test_irkSeed03_derivesExpectedPubkey() throws {
        XCTAssertEqual(
            hex(try irk().publicKey.rawRepresentation),
            "ed4928c628d1c2c6eae90338905995612959273a5c63f93636c14614ac8737d1"
        )
    }

    /// THE SIGNATURE KAT — cross-platform lock.
    ///
    /// IMPORTANT: this does NOT assert signature-BYTE equality against the TS
    /// vector. Apple's CryptoKit `Curve25519.Signing` produces RANDOMIZED
    /// (hedged) Ed25519 signatures — every `sign(...)` call yields a different,
    /// equally-valid 64-byte signature — whereas the TS `@flagship/protocol`
    /// (noble) and Android (libsodium-style) signers are deterministic per RFC
    /// 8032. A fixed-signature equality KAT is therefore IMPOSSIBLE to satisfy
    /// with CryptoKit and was confirmed RED for that reason. (This matches the
    /// established convention in `WatchDelegateKeyTests` et al., which pin
    /// canonical bytes + verification, never a signature literal.)
    ///
    /// The REAL cross-platform lock is byte-exact wire compatibility, which we
    /// prove two ways:
    ///   (1) our verifier ACCEPTS the deterministic TS KAT signature
    ///       `5e7f444d…` over the canonical bytes — so a grant signed by the
    ///       TS/Android signer is honored on iOS, and (by Ed25519 symmetry) a
    ///       grant we sign is honored by the Worker;
    ///   (2) a grant we sign verifies under the same IRK pubkey (round-trip).
    /// Combined with `test_canonicalBytes_layout` (exact signed-message bytes),
    /// this fully pins interop without depending on a non-deterministic nonce.
    func test_grantSignature_knownAnswerVector() throws {
        let grant = katGrant()
        let irkPub = try irk().publicKey.rawRepresentation

        // (1) The deterministic TS/Android KAT signature verifies on iOS.
        let tsKatSignature = bytes(
            "5e7f444d0dddb99c0427e655fa81dbc4e62e1fc74a91509b18a94db80a610e82" +
            "ab3a9f52475e5f4f5b0c09a7b9a016a7264278004540cf8171c83f8bd07c8b00"
        )
        XCTAssertTrue(
            grant.verify(signature: tsKatSignature, irkPub: irkPub),
            "iOS must accept the deterministic TS/Android grant signature — the cross-platform wire lock"
        )

        // (2) A signature we produce round-trips under the IRK pubkey.
        let mine = try grant.sign(with: irk())
        XCTAssertTrue(grant.verify(signature: mine, irkPub: irkPub))
    }

    /// Canonical bytes match the documented `|`-joined layout exactly.
    func test_canonicalBytes_layout() throws {
        let grant = katGrant()
        let expected =
            "flagship/acme-account-key-grant/v1" +
            "|00000000-0000-4000-8000-000000000001" +
            "|demo1234" +
            "|a9f300eb5960e89133af7362011a1e26f0e2ea2e36dc402a04af6c192b891a8c" +
            "|ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c" +
            "|" + hex(Data((1...0x30).map { UInt8($0) })) +
            "|1700000000000" +
            "|1707776000000"
        XCTAssertEqual(String(data: try grant.canonicalBytes(), encoding: .utf8), expected)
    }

    func test_verify_rejectsTamperedSignature() throws {
        let grant = katGrant()
        var sig = try grant.sign(with: irk())
        sig[0] ^= 0x01
        XCTAssertFalse(grant.verify(signature: sig, irkPub: try irk().publicKey.rawRepresentation))
    }

    func test_verify_rejectsWrongIrk() throws {
        let grant = katGrant()
        let sig = try grant.sign(with: irk())
        let otherPub = Curve25519.Signing.PrivateKey().publicKey.rawRepresentation
        XCTAssertFalse(grant.verify(signature: sig, irkPub: otherPub))
    }

    func test_validate_rejectsSeparatorInField() throws {
        let bad = AcmeAccountKeyGrant(
            grantId: "has|pipe",
            username: "demo1234",
            accountKeyId: "a9f300eb5960e89133af7362011a1e26f0e2ea2e36dc402a04af6c192b891a8c",
            recipientPubKey: Data(repeating: 0xaa, count: 32),
            sealedAccountKey: Data([0x01]),
            issuedAt: 1,
            expiresAt: 2
        )
        XCTAssertThrowsError(try bad.canonicalBytes())
    }

    func test_validate_rejectsBadFields() {
        let base = katGrant()
        // recipientPubKey not 32 bytes.
        let shortPub = AcmeAccountKeyGrant(
            grantId: base.grantId, username: base.username, accountKeyId: base.accountKeyId,
            recipientPubKey: Data(repeating: 0xaa, count: 31),
            sealedAccountKey: base.sealedAccountKey, issuedAt: base.issuedAt, expiresAt: base.expiresAt
        )
        XCTAssertThrowsError(try shortPub.canonicalBytes())
        // empty sealedAccountKey.
        let emptySealed = AcmeAccountKeyGrant(
            grantId: base.grantId, username: base.username, accountKeyId: base.accountKeyId,
            recipientPubKey: base.recipientPubKey,
            sealedAccountKey: Data(), issuedAt: base.issuedAt, expiresAt: base.expiresAt
        )
        XCTAssertThrowsError(try emptySealed.canonicalBytes())
        // expiresAt not after issuedAt.
        let badExpiry = AcmeAccountKeyGrant(
            grantId: base.grantId, username: base.username, accountKeyId: base.accountKeyId,
            recipientPubKey: base.recipientPubKey, sealedAccountKey: base.sealedAccountKey,
            issuedAt: 5, expiresAt: 5
        )
        XCTAssertThrowsError(try badExpiry.canonicalBytes())
    }

    // MARK: - Producer

    /// scalar → PKCS#8 PEM → reparse round-trip. The PEM the producer seals
    /// re-hydrates to the same P-256 key (same accountKeyId).
    func test_scalar_toPem_reparses() throws {
        let scalar = Data(repeating: 0x00, count: 31) + Data([0x02])
        let key = try P256.Signing.PrivateKey(rawRepresentation: scalar)
        let pem = key.pemRepresentation
        XCTAssertTrue(pem.contains("-----BEGIN PRIVATE KEY-----"))
        let reparsed = try P256.Signing.PrivateKey(pemRepresentation: pem)
        XCTAssertEqual(reparsed.rawRepresentation, scalar)
        XCTAssertEqual(
            AcmeAccountKey.accountKeyId(publicKey: reparsed.publicKey),
            "a9f300eb5960e89133af7362011a1e26f0e2ea2e36dc402a04af6c192b891a8c"
        )
    }

    /// End-to-end producer: build + IRK-sign a grant sealing the account key
    /// to a box STK, then prove (a) the signature verifies under the IRK and
    /// (b) the box opens the sealed PEM with its STK seed and re-hydrates the
    /// SAME P-256 key. This is the whole seal-to-box contract in one test.
    func test_producer_endToEnd_sealsAndSigns() throws {
        // Box STK: seed 32×0x07 → Ed25519 pub ea4a6c63…
        let stkSeed = Data(repeating: 0x07, count: 32)
        let stkSigning = try Curve25519.Signing.PrivateKey(rawRepresentation: stkSeed)
        let stkPub = stkSigning.publicKey.rawRepresentation

        let scalar = Data(repeating: 0x00, count: 31) + Data([0x02])
        let issuedAt: Int64 = 1_700_000_000_000

        let signed = try AcmeAccountKeyGrantProducer.makeGrant(
            accountKeyScalar: scalar,
            boxStkEd25519Pub: stkPub,
            username: "demo1234",
            irk: try irk(),
            grantId: "00000000-0000-4000-8000-000000000001",
            issuedAt: issuedAt
        )

        // recipientPubKey is the box STK Ed25519 pub; accountKeyId is derived.
        XCTAssertEqual(signed.grant.recipientPubKey, stkPub)
        XCTAssertEqual(
            signed.grant.accountKeyId,
            "a9f300eb5960e89133af7362011a1e26f0e2ea2e36dc402a04af6c192b891a8c"
        )
        XCTAssertEqual(signed.grant.expiresAt, issuedAt + 90 * 86_400_000)

        // (a) IRK signature verifies.
        XCTAssertTrue(
            signed.grant.verify(signature: signed.signature, irkPub: try irk().publicKey.rawRepresentation)
        )

        // (b) The box opens the sealed PEM with its STK seed and re-hydrates
        //     the identical account key.
        let openedPem = try SecretSeal.openWithEd25519Seed(
            blob: signed.grant.sealedAccountKey,
            recipientEd25519Seed: stkSeed
        )
        let pemString = String(data: openedPem, encoding: .utf8)!
        let recovered = try P256.Signing.PrivateKey(pemRepresentation: pemString)
        XCTAssertEqual(recovered.rawRepresentation, scalar)
    }

    func test_producer_rejectsBadStkPub() throws {
        XCTAssertThrowsError(
            try AcmeAccountKeyGrantProducer.makeGrant(
                accountKeyScalar: Data(repeating: 0x00, count: 31) + Data([0x02]),
                boxStkEd25519Pub: Data(repeating: 0xaa, count: 31), // wrong length
                username: "demo1234",
                irk: try irk()
            )
        )
    }

    // MARK: - Mint POST (FlagshipServerClient+AcmeGrants)

    /// The live client POSTs to `/api/users/<u>/acme-account-keys` with the
    /// hexified grant body and decodes the public-fields-only reply. Mirrors
    /// `handleMintAcmeAccountKeyGrant`'s wire contract.
    func test_mintAcmeAccountKeyGrant_postsCorrectPathAndDecodesReply() async throws {
        let signed = try AcmeAccountKeyGrantProducer.makeGrant(
            accountKeyScalar: Data(repeating: 0x00, count: 31) + Data([0x02]),
            boxStkEd25519Pub: try Curve25519.Signing.PrivateKey(
                rawRepresentation: Data(repeating: 0x07, count: 32)
            ).publicKey.rawRepresentation,
            username: "demo1234",
            irk: try irk(),
            grantId: "00000000-0000-4000-8000-000000000001",
            issuedAt: 1_700_000_000_000
        )
        let body = AcmeAccountKeyGrantMintRequest(
            grant: .init(
                grantId: signed.grant.grantId,
                username: signed.grant.username,
                accountKeyId: signed.grant.accountKeyId,
                recipientPubKey: hex(signed.grant.recipientPubKey),
                sealedAccountKey: hex(signed.grant.sealedAccountKey),
                issuedAt: signed.grant.issuedAt,
                expiresAt: signed.grant.expiresAt
            ),
            signature: hex(signed.signature)
        )

        StubURLProtocol.handler = { req in
            XCTAssertEqual(req.httpMethod, "POST")
            XCTAssertEqual(req.url?.path, "/api/users/demo1234/acme-account-keys")
            let resp = HTTPURLResponse(
                url: req.url!, statusCode: 200, httpVersion: "HTTP/2", headerFields: nil
            )!
            let reply = try JSONEncoder().encode(AcmeAccountKeyGrantMintResponse(
                ok: true,
                grantId: "00000000-0000-4000-8000-000000000001",
                username: "demo1234",
                accountKeyId: "a9f300eb5960e89133af7362011a1e26f0e2ea2e36dc402a04af6c192b891a8c",
                recipientPubKey: "ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c",
                expiresAt: signed.grant.expiresAt
            ))
            return (resp, reply)
        }
        defer { StubURLProtocol.handler = nil }

        let cfg = URLSessionConfiguration.ephemeral
        cfg.protocolClasses = [StubURLProtocol.self]
        let session = URLSession(configuration: cfg)
        let client = LiveFlagshipServerClient(urlSession: session)

        let r = try await client.mintAcmeAccountKeyGrant(
            username: "demo1234",
            body: body,
            urlSession: session
        )
        XCTAssertTrue(r.ok)
        XCTAssertEqual(r.grantId, "00000000-0000-4000-8000-000000000001")
        XCTAssertEqual(r.accountKeyId, "a9f300eb5960e89133af7362011a1e26f0e2ea2e36dc402a04af6c192b891a8c")
    }

    /// A 403 (bad signature OR bad envelope — the Worker never distinguishes)
    /// surfaces as `ScreensClientError.http`.
    func test_mintAcmeAccountKeyGrant_surfaces403() async throws {
        StubURLProtocol.handler = { req in
            let resp = HTTPURLResponse(
                url: req.url!, statusCode: 403, httpVersion: "HTTP/2", headerFields: nil
            )!
            return (resp, Data("{\"error\":\"invalid signature\"}".utf8))
        }
        defer { StubURLProtocol.handler = nil }

        let cfg = URLSessionConfiguration.ephemeral
        cfg.protocolClasses = [StubURLProtocol.self]
        let session = URLSession(configuration: cfg)
        let client = LiveFlagshipServerClient(urlSession: session)

        let body = AcmeAccountKeyGrantMintRequest(
            grant: .init(
                grantId: "g", username: "demo1234", accountKeyId: "a",
                recipientPubKey: String(repeating: "aa", count: 32),
                sealedAccountKey: "01", issuedAt: 1, expiresAt: 2
            ),
            signature: String(repeating: "00", count: 64)
        )
        do {
            _ = try await client.mintAcmeAccountKeyGrant(username: "demo1234", body: body, urlSession: session)
            XCTFail("expected http error")
        } catch let ScreensClientError.http(status, _) {
            XCTAssertEqual(status, 403)
        }
    }
}
