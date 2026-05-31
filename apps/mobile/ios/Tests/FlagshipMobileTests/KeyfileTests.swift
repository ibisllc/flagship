import XCTest
import CryptoKit
@testable import Flagship
@testable import FlagshipCore

final class KeyfileTests: XCTestCase {

    /// Golden file produced by the canonical TS writer
    /// (packages/protocol/src/keyfile.ts). Unwrapping it with the known
    /// passphrase MUST yield the known 32-byte seed — this proves the
    /// Swift reader is byte-compatible with the TS format (argon2id
    /// params, AAD canonical string, AES-256-GCM split, hex encoding).
    private static let goldenFile = """
    {"magic":"flagship-key","version":1,"username":"interop","accountId":"acct-golden","createdAt":"2026-05-25T00:00:00.000Z","kdf":{"algo":"argon2id","m":65536,"t":3,"p":4,"saltHex":"fc6235a631ca2ca22c0335541200972a"},"aead":"aes-256-gcm","nonceHex":"a032679f057a61a653814b15","ciphertextHex":"606618b0f9918b91ee724ff83ee7cb88728d9b6663899991c0e2e0133579547ec3547122d83165ebfe0d2d74fc827c24"}
    """

    private static let goldenPassphrase = "interop-test-passphrase"
    private static let goldenSeedHex =
        "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20"

    // MARK: - INTEROP GATE

    func test_interop_unwrapsGoldenFileToExpectedSeed() throws {
        let (umk, meta) = try Keyfile.unwrap(
            fileText: Self.goldenFile,
            passphrase: Self.goldenPassphrase
        )
        let seedHex = HexUtil.encode(umk.withUnsafeBytes { Data($0) })
        XCTAssertEqual(seedHex, Self.goldenSeedHex, "golden interop seed mismatch")
        XCTAssertEqual(meta.username, "interop")
        XCTAssertEqual(meta.accountId, "acct-golden")
        XCTAssertEqual(meta.createdAt, "2026-05-25T00:00:00.000Z")
    }

    func test_interop_wrongPassphraseFailsCleanly() {
        XCTAssertThrowsError(
            try Keyfile.unwrap(fileText: Self.goldenFile, passphrase: "wrong-passphrase-here")
        ) { error in
            XCTAssertEqual(error as? Keyfile.KeyfileError, .badPassphrase)
        }
    }

    // MARK: - Round trip

    func test_wrapThenUnwrap_recoversSeed() throws {
        // Use the lightest valid params so the test runs fast — the
        // params travel in the file so unwrap uses them too.
        let fast = Keyfile.ArgonParams(m: 256, t: 1, p: 1)
        let seed = SymmetricKey(size: .bits256)
        let meta = Keyfile.Meta(username: "alice", accountId: "acct-1", createdAt: "2026-05-25T12:00:00.000Z")
        let text = try Keyfile.wrap(umkSeed: seed, passphrase: "correct horse battery", meta: meta, params: fast)
        let (recovered, recoveredMeta) = try Keyfile.unwrap(fileText: text, passphrase: "correct horse battery")
        XCTAssertEqual(
            seed.withUnsafeBytes { Data($0) },
            recovered.withUnsafeBytes { Data($0) }
        )
        XCTAssertEqual(recoveredMeta, meta)
    }

    func test_wrap_omitsAccountIdWhenNil() throws {
        let fast = Keyfile.ArgonParams(m: 256, t: 1, p: 1)
        let seed = SymmetricKey(size: .bits256)
        let meta = Keyfile.Meta(username: "bob", accountId: nil, createdAt: "2026-05-25T12:00:00.000Z")
        let text = try Keyfile.wrap(umkSeed: seed, passphrase: "longenoughpass", meta: meta, params: fast)
        XCTAssertFalse(text.contains("accountId"), "nil accountId must be omitted from the envelope")
        // And it round-trips with a nil accountId AAD.
        let (recovered, recoveredMeta) = try Keyfile.unwrap(fileText: text, passphrase: "longenoughpass")
        XCTAssertEqual(seed.withUnsafeBytes { Data($0) }, recovered.withUnsafeBytes { Data($0) })
        XCTAssertNil(recoveredMeta.accountId)
    }

    func test_unwrap_wrongPassphraseThrowsBadPassphrase() throws {
        let fast = Keyfile.ArgonParams(m: 256, t: 1, p: 1)
        let seed = SymmetricKey(size: .bits256)
        let meta = Keyfile.Meta(username: "alice", accountId: nil, createdAt: "2026-05-25T12:00:00.000Z")
        let text = try Keyfile.wrap(umkSeed: seed, passphrase: "the-right-pass", meta: meta, params: fast)
        XCTAssertThrowsError(try Keyfile.unwrap(fileText: text, passphrase: "the-wrong-pass")) { error in
            XCTAssertEqual(error as? Keyfile.KeyfileError, .badPassphrase)
        }
    }

    func test_unwrap_tamperedHeaderFailsAADBinding() throws {
        let fast = Keyfile.ArgonParams(m: 256, t: 1, p: 1)
        let seed = SymmetricKey(size: .bits256)
        let meta = Keyfile.Meta(username: "alice", accountId: "acct-1", createdAt: "2026-05-25T12:00:00.000Z")
        let text = try Keyfile.wrap(umkSeed: seed, passphrase: "the-right-pass", meta: meta, params: fast)
        // Flip the username in the header — the AAD binding must reject it.
        let tampered = text.replacingOccurrences(of: "\"alice\"", with: "\"mallory\"")
        XCTAssertNotEqual(tampered, text)
        XCTAssertThrowsError(try Keyfile.unwrap(fileText: tampered, passphrase: "the-right-pass")) { error in
            XCTAssertEqual(error as? Keyfile.KeyfileError, .badPassphrase)
        }
    }

    func test_unwrap_notAKeyfileThrowsMalformed() {
        XCTAssertThrowsError(try Keyfile.unwrap(fileText: "{\"hello\":\"world\"}", passphrase: "whatever")) { error in
            guard case .malformed = (error as? Keyfile.KeyfileError) else {
                return XCTFail("expected .malformed, got \(error)")
            }
        }
        XCTAssertThrowsError(try Keyfile.unwrap(fileText: "not json at all", passphrase: "whatever")) { error in
            guard case .malformed = (error as? Keyfile.KeyfileError) else {
                return XCTFail("expected .malformed, got \(error)")
            }
        }
    }

    func test_wrap_rejectsShortPassphrase() {
        let seed = SymmetricKey(size: .bits256)
        let meta = Keyfile.Meta(username: "alice", accountId: nil, createdAt: "2026-05-25T12:00:00.000Z")
        XCTAssertThrowsError(try Keyfile.wrap(umkSeed: seed, passphrase: "short", meta: meta)) { error in
            guard case .malformed = (error as? Keyfile.KeyfileError) else {
                return XCTFail("expected .malformed, got \(error)")
            }
        }
    }

    func test_aadCanonicalString_matchesSpec() {
        // Pin the exact AAD string the TS side builds, so the binding
        // can never silently drift.
        let aad = Keyfile.aad(
            version: 1,
            username: "interop",
            accountId: "acct-golden",
            createdAt: "2026-05-25T00:00:00.000Z",
            params: Keyfile.ArgonParams(m: 65536, t: 3, p: 4)
        )
        let expected = "flagship/keyfile/v1|1|interop|acct-golden|2026-05-25T00:00:00.000Z|argon2id|m=65536|t=3|p=4|aes-256-gcm"
        XCTAssertEqual(String(data: aad, encoding: .utf8), expected)
    }
}
