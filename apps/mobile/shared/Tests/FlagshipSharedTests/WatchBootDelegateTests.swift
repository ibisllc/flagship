import XCTest
import CryptoKit
@testable import FlagshipCore

final class WatchBootDelegateTests: XCTestCase {
    private struct Vectors: Decodable {
        struct Deposit: Decodable {
            let serverDomain: String; let delegatePubHex: String; let decryptPubHex: String; let keySha256Hex: String
            let issuedAt: Int64; let expiresAt: Int64; let sealedKeyHex: String; let signatureHex: String
        }
        struct Invalid: Decodable {
            struct D: Decodable { let serverDomain: String; let delegatePubHex: String; let decryptPubHex: String; let keySha256Hex: String; let issuedAt: Int64; let expiresAt: Int64 }
            let name: String; let delegate: D; let canonical: String
        }
        let accountPubHex: String
        let decryptPrivHex: String
        let diskKeyHex: String
        let deposit: Deposit
        let canonical: String
        let invalid: [Invalid]
    }

    private func vectors() throws -> Vectors {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<14 {
            let url = dir.appendingPathComponent("packages/protocol/test-vectors/watch-boot-delegate/vectors.json")
            if FileManager.default.fileExists(atPath: url.path) { return try JSONDecoder().decode(Vectors.self, from: Data(contentsOf: url)) }
            dir = dir.deletingLastPathComponent()
        }
        throw XCTSkip("vectors.json not found")
    }

    private func unhex(_ h: String) -> Data {
        var d = Data(); var i = h.startIndex
        while i < h.endIndex { let n = h.index(i, offsetBy: 2); d.append(UInt8(h[i..<n], radix: 16)!); i = n }
        return d
    }

    private func att(_ d: Vectors.Deposit) -> WatchBootDelegate {
        WatchBootDelegate(serverDomain: d.serverDomain, delegatePubHex: d.delegatePubHex, decryptPubHex: d.decryptPubHex, keySha256Hex: d.keySha256Hex, issuedAt: d.issuedAt, expiresAt: d.expiresAt)
    }

    func testCanonicalBytesSignatureAndSealedCopyMatchTheSharedVector() throws {
        let v = try vectors()
        let bytes = try att(v.deposit).canonicalBytes()
        XCTAssertEqual(String(decoding: bytes, as: UTF8.self), v.canonical)
        let pub = try Curve25519.Signing.PublicKey(rawRepresentation: unhex(v.accountPubHex))
        XCTAssertTrue(pub.isValidSignature(unhex(v.deposit.signatureHex), for: bytes))
        let dep = WatchBootDeposit(attestation: att(v.deposit), sealedKeyHex: v.deposit.sealedKeyHex, signatureHex: v.deposit.signatureHex)
        XCTAssertEqual(try dep.openKey(decryptPriv: unhex(v.decryptPrivHex)).map { String(format: "%02x", $0) }.joined(), v.diskKeyHex)
    }

    func testEveryOtherServerWatchKeyDigestOrWindowFailsTheSameSignature() throws {
        let v = try vectors()
        let pub = try Curve25519.Signing.PublicKey(rawRepresentation: unhex(v.accountPubHex))
        for bad in v.invalid {
            let d = bad.delegate
            let bytes = try WatchBootDelegate(serverDomain: d.serverDomain, delegatePubHex: d.delegatePubHex, decryptPubHex: d.decryptPubHex, keySha256Hex: d.keySha256Hex, issuedAt: d.issuedAt, expiresAt: d.expiresAt).canonicalBytes()
            XCTAssertEqual(String(decoding: bytes, as: UTF8.self), bad.canonical, bad.name)
            XCTAssertFalse(pub.isValidSignature(unhex(v.deposit.signatureHex), for: bytes), bad.name)
        }
    }

    func testABuiltDepositOpensWithTheMatchingKeyOnlyAndALongerWindowIsRefused() throws {
        let account = Curve25519.Signing.PrivateKey()
        let decrypt = Curve25519.KeyAgreement.PrivateKey()
        let watch = Curve25519.Signing.PrivateKey()
        let disk = Data(repeating: 0x42, count: 32)
        let dep = try WatchBootDeposit.build(
            serverDomain: "Kitchen.Alice.flagship.services", diskKey: disk,
            delegatePub: watch.publicKey.rawRepresentation, decryptPub: decrypt.publicKey.rawRepresentation,
            issuedAt: 1_000, expiresAt: 1_000 + 60_000, sign: { Data(try account.signature(for: $0)) }
        )
        XCTAssertEqual(dep.attestation.serverDomain, "kitchen.alice.flagship.services")
        XCTAssertTrue(account.publicKey.isValidSignature(Data(hexLike: dep.signatureHex), for: try dep.attestation.canonicalBytes()))
        XCTAssertEqual(try dep.openKey(decryptPriv: decrypt.rawRepresentation), disk)
        XCTAssertThrowsError(try dep.openKey(decryptPriv: Curve25519.KeyAgreement.PrivateKey().rawRepresentation))
        XCTAssertThrowsError(try WatchBootDeposit.build(
            serverDomain: "k.a.flagship.services", diskKey: disk, delegatePub: watch.publicKey.rawRepresentation,
            decryptPub: decrypt.publicKey.rawRepresentation, issuedAt: 0, expiresAt: WatchBootDelegate.maxMs + 1, sign: { _ in Data(count: 64) }
        ))
        XCTAssertNotNil(dep.body["deposit"])
    }
}

private extension Data {
    init(hexLike h: String) {
        var d = Data(); var i = h.startIndex
        while i < h.endIndex { let n = h.index(i, offsetBy: 2); d.append(UInt8(h[i..<n], radix: 16)!); i = n }
        self = d
    }
}
