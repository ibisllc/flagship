import XCTest
@testable import FlagshipCore
@testable import FlagshipUI
@testable import Flagship
@testable import FlagshipAPI

/// First contact on the recipe side (docs/first-contact.md "What the clients do" 1 and 4).
final class FirstContactRecipeTests: XCTestCase {
    private func signed(enrollmentKeyHex: String?) -> SignedInstallBlob {
        let auth = AuthCode(serial: "01ABCD", username: "harry", serverName: "home", serverDomain: "home.harry.flagship.services",
                            delegatedPubKey: Data(repeating: 0x11, count: 32), userPubKey: Data(repeating: 0x22, count: 32),
                            issuedAt: 1_000, expiresAt: 2_000)
        let blob = InstallBlob(serverDomain: "home.harry.flagship.services", username: "harry", serverName: "home",
                               phoneDelegatedPubKey: Data(repeating: 0x33, count: 32), authCode: auth,
                               authCodeUserSignature: Data(repeating: 0x44, count: 64), rckPubKey: Data(repeating: 0x55, count: 32))
        return SignedInstallBlob(blob: blob, signatureHex: "ab", enrollmentKeyHex: enrollmentKeyHex)
    }

    func test_theSecretRidesTheRecipeAsAnUnsignedTopLevelSibling() throws {
        let secret = String(repeating: "7a", count: 32)
        let obj = try JSONSerialization.jsonObject(with: try JSONEncoder().encode(signed(enrollmentKeyHex: secret).onWire())) as! [String: Any]
        XCTAssertEqual(obj["enrollmentKeyHex"] as? String, secret)
        let blob = obj["blob"] as! [String: Any]
        XCTAssertNil(blob["enrollmentKeyHex"], "Never inside the signed blob.")
        let without = String(data: try JSONEncoder().encode(signed(enrollmentKeyHex: nil).onWire()), encoding: .utf8)!
        XCTAssertFalse(without.contains("enrollmentKeyHex"), "A recipe without one is byte-identical to before.")
    }

    func test_studioGetsItsConfirmKeyBesideTheRecipeInTheDeliverFrame() throws {
        let frame = BuilderOutbound.deliverWithConfirmKey(ciphertextB64: "c", nonceB64: "n",
                                                          confirmKeyCiphertextB64: "kc", confirmKeyNonceB64: "kn").json
        let obj = try JSONSerialization.jsonObject(with: Data(frame.utf8)) as! [String: String]
        XCTAssertEqual(obj, ["kind": "deliver", "ciphertext": "c", "nonce": "n", "confirmKeyCiphertext": "kc", "confirmKeyNonce": "kn"])
        let plain = try JSONSerialization.jsonObject(with: Data(BuilderOutbound.deliver(ciphertextB64: "c", nonceB64: "n").json.utf8)) as! [String: String]
        XCTAssertNil(plain["confirmKeyCiphertext"])
    }

    func test_theKeptSecretsLiveOnThisDeviceUntilThePin() {
        let store = InMemoryFirstContactSecrets()
        store.save(FirstContactSecret(enrollmentKeyHex: String(repeating: "11", count: 32), authCodeSerial: "S"), for: "Home.Harry.flagship.services")
        XCTAssertEqual(store.secret(for: "home.harry.flagship.services")?.authCodeSerial, "S")
        store.delete(for: "home.harry.flagship.services")
        XCTAssertNil(store.secret(for: "home.harry.flagship.services"))
    }
}
