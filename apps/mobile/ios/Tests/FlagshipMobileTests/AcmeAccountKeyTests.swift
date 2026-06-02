import XCTest
import CryptoKit
@testable import Flagship

/// #28 — ACME account-key recovery crypto + exportable storage.
///
/// The account key is an ECDSA P-256 key (Let's Encrypt account keys are
/// ES256, NOT Ed25519). The known-answer vector below is the cross-platform
/// lock: iOS, Android, and the TypeScript control plane all derive the same
/// `accountKeyId` from the same private scalar, so the escrowed key minted on
/// one surface is recognized everywhere.
final class AcmeAccountKeyTests: XCTestCase {

    private func hex(_ d: Data) -> String { d.map { String(format: "%02x", $0) }.joined() }

    /// THE CROSS-PLATFORM LOCK. Private scalar = 32 bytes `00…0002` (thirty-one
    /// 0x00 then 0x02). Its uncompressed SEC1 pubkey (x963) and the resulting
    /// `accountKeyId` (sha256-hex of that pubkey) MUST equal these exact
    /// literals — they are shared verbatim with Android + the TS daemon.
    func test_accountKeyId_knownAnswerVector() throws {
        let scalar = Data(repeating: 0x00, count: 31) + Data([0x02])
        XCTAssertEqual(scalar.count, 32)

        let priv = try P256.Signing.PrivateKey(rawRepresentation: scalar)

        let expectedPubHex =
            "047cf27b188d034f7e8a52380304b51ac3c08969e277f21b35a60b48fc476699" +
            "7807775510db8ed040293d9ac69f7430dbba7dade63ce982299e04b79d227873d1"
        XCTAssertEqual(hex(priv.publicKey.x963Representation), expectedPubHex)

        let expectedAccountKeyId =
            "a9f300eb5960e89133af7362011a1e26f0e2ea2e36dc402a04af6c192b891a8c"
        XCTAssertEqual(
            AcmeAccountKey.accountKeyId(publicKey: priv.publicKey),
            expectedAccountKeyId
        )
    }

    func test_escrow_wrapThenUnwrap_roundTrips() throws {
        let scalar = Data((0..<32).map { _ in UInt8.random(in: 0...255) })
        let prf = Data((0..<32).map { _ in UInt8.random(in: 0...255) })
        let wrapped = try AcmeAccountKey.wrapForEscrow(scalar: scalar, prfSecret: prf)
        let recovered = try AcmeAccountKey.unwrapFromEscrow(base64: wrapped, prfSecret: prf)
        XCTAssertEqual(recovered, scalar)
    }

    func test_escrow_wrongPrf_fails() throws {
        let scalar = Data((0..<32).map { _ in UInt8.random(in: 0...255) })
        let prf = Data((0..<32).map { _ in UInt8.random(in: 0...255) })
        let wrong = Data((0..<32).map { _ in UInt8.random(in: 0...255) })
        let wrapped = try AcmeAccountKey.wrapForEscrow(scalar: scalar, prfSecret: prf)
        XCTAssertThrowsError(
            try AcmeAccountKey.unwrapFromEscrow(base64: wrapped, prfSecret: wrong)
        )
    }

    /// The escrow salt is domain-separated from the UMK wrap salt
    /// (`flagship/recovery-wrap/v1`). Wrapping the same plaintext under the
    /// same PRF secret via `Recovery.wrap` must therefore NOT yield a blob the
    /// account-key unwrapper accepts — proving the two derive distinct keys.
    func test_escrow_salt_isDomainSeparatedFromUmkWrap() throws {
        let scalar = Data((0..<32).map { _ in UInt8.random(in: 0...255) })
        let prf = Data((0..<32).map { _ in UInt8.random(in: 0...255) })
        let umkEnv = try Recovery.wrap(umkSeed: SymmetricKey(data: scalar), prfSecret: prf)
        // Recovery.wrap returns ciphertext + nonce split; reassemble combined.
        let ct = Data(base64Encoded: umkEnv.ciphertextBase64)!
        let nonce = Data(base64Encoded: umkEnv.nonceBase64)!
        let combinedUnderUmkSalt = (nonce + ct).base64EncodedString()
        XCTAssertThrowsError(
            try AcmeAccountKey.unwrapFromEscrow(base64: combinedUnderUmkSalt, prfSecret: prf)
        )
    }

    func test_unwrap_failsWithBase64Garbage() {
        let prf = Data((0..<32).map { _ in UInt8.random(in: 0...255) })
        XCTAssertThrowsError(
            try AcmeAccountKey.unwrapFromEscrow(base64: "!!!not base64!!!", prfSecret: prf)
        )
    }

    /// Keygen + exportable storage: two loads return the SAME key, and the
    /// raw scalar is exportable for escrow. Test bundles on the simulator have
    /// no Keychain entitlement, so writes fall back to the process-local
    /// InMemoryStore — which persists across calls within the test, giving us
    /// the stable-load behavior the other Keystore tests rely on.
    func test_loadOrCreate_isStable() throws {
        Keystore.wipe()  // clear any leakage from another test's account-key slot
        let first = try Keystore.loadOrCreateAcmeAccountKey()
        let second = try Keystore.loadOrCreateAcmeAccountKey()
        XCTAssertEqual(
            first.publicKey.x963Representation,
            second.publicKey.x963Representation
        )
        // The raw scalar must be exportable (for escrow) and match the key.
        let exported = Keystore.acmeAccountKeyScalar()
        XCTAssertEqual(exported, first.rawRepresentation)
        Keystore.wipe()
    }

    /// Importing a recovered scalar yields a key with the same public half,
    /// and a malformed scalar throws rather than persisting garbage.
    func test_import_roundTripsAndValidates() throws {
        Keystore.wipe()
        let scalar = Data(repeating: 0x00, count: 31) + Data([0x02])
        try Keystore.importAcmeAccountKey(scalar: scalar)
        let loaded = try Keystore.loadOrCreateAcmeAccountKey()
        XCTAssertEqual(loaded.rawRepresentation, scalar)
        XCTAssertEqual(
            AcmeAccountKey.accountKeyId(publicKey: loaded.publicKey),
            "a9f300eb5960e89133af7362011a1e26f0e2ea2e36dc402a04af6c192b891a8c"
        )
        // A 5-byte blob is not a valid P-256 scalar.
        XCTAssertThrowsError(try Keystore.importAcmeAccountKey(scalar: Data([1, 2, 3, 4, 5])))
        Keystore.wipe()
    }
}
