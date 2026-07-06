import XCTest
import CryptoKit
@testable import Flagship
@testable import FlagshipCore

/// Slice D Phase 2 (CORE) — the admin master root: generation/seal round-trip,
/// device-local (non-synced) custody, the escrow wrap, and the sensitive-order
/// signing GATE (admin root when present, owner IRK when absent).
final class AdminRootTests: XCTestCase {

    override func setUp() async throws {
        Keystore.setActiveProfile(nil)
        Keystore.wipe()
    }
    override func tearDown() async throws {
        Keystore.setActiveProfile(nil)
        Keystore.wipe()
    }

    // MARK: - Generation / seal round-trip

    func test_openAccountRoots_sealsAdminRoot_andRoundTrips() async throws {
        XCTAssertFalse(Keystore.hasAdminRoot)

        let roots = try await Keystore.openAccountRoots(reason: "test")
        XCTAssertTrue(Keystore.hasAdminRoot)
        XCTAssertTrue(Keystore.hasWrappedUMK)

        // The published pubHex equals the (biometric-free) stored pub AND the
        // unsealed private key's public half.
        XCTAssertEqual(Keystore.adminRootPubHex(), roots.adminRootPubHex)
        let adminKey = try await Keystore.adminRootKey(reason: "test")
        XCTAssertEqual(HexUtil.encode(adminKey.publicKey.rawRepresentation), roots.adminRootPubHex)

        // The admin root actually signs (operational contract).
        let msg = Data("flagship/admin-test/v1|hello".utf8)
        let sig = try adminKey.signature(for: msg)
        XCTAssertTrue(adminKey.publicKey.isValidSignature(sig, for: msg))

        // It is a DISTINCT key from the account IRK (authority ≠ membership).
        let irk = try await Keystore.deriveIRK(reason: "test")
        XCTAssertNotEqual(adminKey.publicKey.rawRepresentation, irk.publicKey.rawRepresentation)
        // And NOT UMK-derived: the returned IRK is the account IRK.
        XCTAssertEqual(roots.irk.publicKey.rawRepresentation, irk.publicKey.rawRepresentation)
    }

    func test_adminRootKey_isStableAcrossLoads() async throws {
        _ = try await Keystore.openAccountRoots(reason: "test")
        let k1 = try await Keystore.adminRootKey(reason: "test")
        let k2 = try await Keystore.adminRootKey(reason: "test")
        XCTAssertEqual(k1.rawRepresentation, k2.rawRepresentation,
                       "the sealed admin root must unseal to the SAME key each load")
    }

    func test_generateAdminRoot_standalone_mintsFreshRandom() async throws {
        let a = try await Keystore.generateAdminRoot(reason: "test")
        XCTAssertTrue(Keystore.hasAdminRoot)
        // Re-generating overwrites with a DIFFERENT random root (not derived).
        let b = try await Keystore.generateAdminRoot(reason: "test")
        XCTAssertNotEqual(a, b, "the admin root is fresh random, not deterministic")
    }

    func test_wipe_clearsAdminRoot() async throws {
        _ = try await Keystore.openAccountRoots(reason: "test")
        XCTAssertTrue(Keystore.hasAdminRoot)
        Keystore.wipe()
        XCTAssertFalse(Keystore.hasAdminRoot)
        XCTAssertNil(Keystore.adminRootPubHex())
    }

    // MARK: - Device-local custody (must NOT iCloud-sync — residual-risk #6)

    func test_adminRootSlots_areStoredDeviceLocal_notSynced() async throws {
        _ = try await Keystore.openAccountRoots(reason: "test")
        // On the default profile the account strings are the un-suffixed bases.
        XCTAssertEqual(
            KeystoreTestSupport.lastWrittenSyncClass(account: "com.flagship.adminroot.wrapped"),
            .deviceLocal,
            "the sealed admin root MUST be device-local — syncing it would hand authority to every device")
        XCTAssertEqual(
            KeystoreTestSupport.lastWrittenSyncClass(account: "com.flagship.adminroot.pub"),
            .deviceLocal)
        // Contrast: the UMK IS the cloud root identity and syncs.
        XCTAssertEqual(
            KeystoreTestSupport.lastWrittenSyncClass(account: "com.flagship.umk.wrapped"),
            .cloudRoot)
    }

    // MARK: - Escrow (D-3) round-trip

    func test_adminRootEscrow_roundTrips() throws {
        let seed = Data((0..<32).map { _ in UInt8.random(in: 0...255) })
        let prf = Data((0..<32).map { _ in UInt8.random(in: 0...255) })
        let wrapped = try AdminRootEscrow.wrapForEscrow(seed: seed, prfSecret: prf)
        let unwrapped = try AdminRootEscrow.unwrapFromEscrow(base64: wrapped, prfSecret: prf)
        XCTAssertEqual(unwrapped, seed)
    }

    func test_adminRootEscrow_wrongPrfSecret_fails() throws {
        let seed = Data(repeating: 0xAB, count: 32)
        let wrapped = try AdminRootEscrow.wrapForEscrow(seed: seed, prfSecret: Data(repeating: 0x01, count: 32))
        XCTAssertThrowsError(
            try AdminRootEscrow.unwrapFromEscrow(base64: wrapped, prfSecret: Data(repeating: 0x02, count: 32)))
    }

    // MARK: - Cross-platform escrow KAT (Issue 2 anti-drift guard)

    /// A FIXED (prfSecret, seeds, nonce) → pinned ciphertext, SHARED verbatim
    /// with the webapp (apps/web/tests/fixtures/recoveryWrapGolden.json +
    /// recoveryWrapKat.test.ts) and Android (RecoveryWrapTest). This is the
    /// guard that would have caught the webapp raw-PRF / concat divergence:
    /// only random-nonce round-trips existed, so no platform pinned the wire
    /// bytes. Each of the three escrow secrets (UMK, ACME account key, admin
    /// root) rides its own domain salt.
    func test_escrowWrap_crossPlatformGoldenKAT() throws {
        let prf = hexData("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f")
        let umk = hexData("202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f")
        let acme = hexData("404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f")
        let admin = hexData("606162636465666768696a6b6c6d6e6f707172737475767778797a7b7c7d7e7f")
        let nonce = hexData("a0a1a2a3a4a5a6a7a8a9aaab")
        let umkBlob = "oKGio6SlpqeoqaqrhgoulhbK4Hw5GnZ/Eg3p2tE8znE4LEH4VNFNiZqUWTG1AJh5e1ANGjervCj+CdE/"
        let acmeBlob = "oKGio6SlpqeoqaqrYhwcBqIf+sPx7eZDHRsCyYYye+B4JJtN4LoVBzGOndkEPhG4pToPWRTfw7TS+I3I"
        let adminBlob = "oKGio6SlpqeoqaqrrTVhM+39nuBWm85By/ZoC+0FhIEMWdL4J2aBSr+wcO3RBVAkuZ8NANC3dtXp0j84"

        // (a) DECRYPT parity — the SHIPPED unwrap opens the pinned webapp blobs.
        //     This also anchors the production salts: a wrong salt fails here.
        let recoveredUmk = try Recovery.unwrap(wrappedUmkBase64: umkBlob, prfSecret: prf)
            .withUnsafeBytes { Data($0) }
        XCTAssertEqual(recoveredUmk, umk, "web-enrolled UMK blob must unwrap on iOS")
        XCTAssertEqual(try AcmeAccountKey.unwrapFromEscrow(base64: acmeBlob, prfSecret: prf), acme)
        XCTAssertEqual(try AdminRootEscrow.unwrapFromEscrow(base64: adminBlob, prfSecret: prf), admin)

        // (b) ENCRYPT parity — HKDF-SHA256 + AES-256-GCM with the fixed nonce
        //     reproduces the pinned ciphertext byte-for-byte.
        XCTAssertEqual(try sealWithFixedNonce(umk, prf, "flagship/recovery-wrap/v1", nonce), umkBlob)
        XCTAssertEqual(try sealWithFixedNonce(acme, prf, "flagship/recovery-acme-wrap/v1", nonce), acmeBlob)
        XCTAssertEqual(try sealWithFixedNonce(admin, prf, "flagship/recovery-admin-root-wrap/v1", nonce), adminBlob)
    }

    private func hexData(_ s: String) -> Data { HexUtil.decode(s)! }

    private func sealWithFixedNonce(_ plaintext: Data, _ prf: Data, _ salt: String, _ nonce: Data) throws -> String {
        let key = HKDF<SHA256>.deriveKey(
            inputKeyMaterial: SymmetricKey(data: prf),
            salt: Data(salt.utf8), info: Data(), outputByteCount: 32)
        let sealed = try AES.GCM.seal(plaintext, using: key, nonce: try AES.GCM.Nonce(data: nonce))
        return sealed.combined!.base64EncodedString()
    }

    // MARK: - The gate: admin root when present, owner IRK when absent

    func test_sensitiveOrderSigningKey_usesAdminRoot_whenPresent() async throws {
        _ = try await Keystore.openAccountRoots(reason: "test")
        let signingKey = try await Keystore.sensitiveOrderSigningKey(reason: "test")
        let adminKey = try await Keystore.adminRootKey(reason: "test")
        let irk = try await Keystore.deriveIRK(reason: "test")
        XCTAssertEqual(signingKey.publicKey.rawRepresentation, adminKey.publicKey.rawRepresentation)
        XCTAssertNotEqual(signingKey.publicKey.rawRepresentation, irk.publicKey.rawRepresentation)
    }

    func test_sensitiveOrderSigningKey_fallsBackToIRK_whenNoAdminRoot() async throws {
        // A legacy/pre-D account: UMK present, but NO admin root minted.
        try await Keystore.generateUMK(reason: "test")
        XCTAssertFalse(Keystore.hasAdminRoot)
        let signingKey = try await Keystore.sensitiveOrderSigningKey(reason: "test")
        let irk = try await Keystore.deriveIRK(reason: "test")
        XCTAssertEqual(signingKey.publicKey.rawRepresentation, irk.publicKey.rawRepresentation,
                       "with no admin root the gate signs sensitive orders with the legacy owner IRK")
    }

    // MARK: - A real sensitive order (set-leader vote) verifies under the gate

    /// Mirrors the ViewModel gate: the SENSITIVE set-leader vote is signed by the
    /// admin root when this device holds one (verifies under the admin root, NOT
    /// the IRK), and by the IRK when it doesn't — while the byte content of the
    /// vote is identical either way (only the signing key changes).
    func test_setLeaderVote_signsUnderAdminRoot_whenPresent_elseIRK() async throws {
        let user = "alice"
        let stk = String(repeating: "ab", count: 32)   // 32-byte hex STK
        let domain = "home.alice.flagship.services"

        // (a) Present: admin root signs the vote.
        _ = try await Keystore.openAccountRoots(reason: "test")
        let irk = try await Keystore.deriveIRK(reason: "test")
        let adminKey = try await Keystore.adminRootKey(reason: "test")
        let orderKey = Keystore.hasAdminRoot ? adminKey : irk

        let body = try SetLeaderDeposit.buildDeposit(
            username: user, serverDomain: domain, preferredStkPubHex: stk,
            irk: irk, orderKey: orderKey)
        let vote = CloudGossip.SetLeaderVote(
            user: body.vote.user, preferredStkPubHex: body.vote.preferredStkPubHex,
            issuedAt: body.vote.issuedAt, nonce: body.vote.nonce)
        let sig = HexUtil.decode(body.signature)!
        XCTAssertTrue(vote.verify(sig, with: adminKey.publicKey),
                      "with an admin root, the vote MUST verify under the admin root")
        XCTAssertFalse(vote.verify(sig, with: irk.publicKey),
                       "…and MUST NOT verify under the membership IRK (the authority split)")
        // The mailbox-auth envelope STAYS the IRK (deposit credential).
        XCTAssertEqual(body.auth.phoneIrkPub.lowercased(),
                       HexUtil.encode(irk.publicKey.rawRepresentation).lowercased())

        // (b) Absent: no admin root ⇒ the vote is IRK-signed.
        Keystore.wipe()
        try await Keystore.generateUMK(reason: "test")
        let irk2 = try await Keystore.deriveIRK(reason: "test")
        let orderKey2: Curve25519.Signing.PrivateKey? = Keystore.hasAdminRoot
            ? try await Keystore.adminRootKey(reason: "test") : nil
        let body2 = try SetLeaderDeposit.buildDeposit(
            username: user, serverDomain: domain, preferredStkPubHex: stk,
            irk: irk2, orderKey: orderKey2)
        let vote2 = CloudGossip.SetLeaderVote(
            user: body2.vote.user, preferredStkPubHex: body2.vote.preferredStkPubHex,
            issuedAt: body2.vote.issuedAt, nonce: body2.vote.nonce)
        let sig2 = HexUtil.decode(body2.signature)!
        XCTAssertTrue(vote2.verify(sig2, with: irk2.publicKey),
                      "with no admin root, the vote is signed by the legacy owner IRK")
    }

    // MARK: - AuthCode admin-root pinning (D-1) canonical bytes

    func test_authCode_adminRootPubKey_appendsCanonicalBytes_backwardCompatible() {
        let base = AuthCode(
            serial: "01AA", username: "alice", serverName: "home",
            serverDomain: "home.alice.flagship.services",
            delegatedPubKey: Data(repeating: 1, count: 32),
            userPubKey: Data(repeating: 2, count: 32),
            issuedAt: 1000, expiresAt: 2000)
        // Absent ⇒ byte-identical to pre-D (no `ar=` suffix).
        XCTAssertFalse(String(data: base.canonicalBytes(), encoding: .utf8)!.contains("ar="))

        let ar = Data(repeating: 0xEE, count: 32)
        var withAr = base
        withAr.adminRootPubKey = ar
        let s = String(data: withAr.canonicalBytes(), encoding: .utf8)!
        XCTAssertTrue(s.hasSuffix("|ar=\(HexUtil.encode(ar))"),
                      "present ⇒ appended LAST with an `ar=` prefix, matching TS canonicalAuthCode")
    }
}
