import Foundation
import CryptoKit
import DeviceCheck
import FlagshipCore

/// Apple's per-device evidence for a Messages attestation request (docs/voici-and-messages.md §9.5, the B2 note): the
/// install's first request sends the App Attest attestation object with clientDataHash = SHA-256 of the request's
/// canonical bytes, later requests an assertion over the same hash, and every request a DeviceCheck token:
/// `{platform:"ios", keyId, attestation | assertion, deviceToken}`. No device identifier leaves the phone; `.com` keeps an HMAC of the key id.
/// Where neither is available (Simulator, an old device) the request says `none` and lands in the slow tier.
public enum DeviceIntegrity {
    public struct Evidence: Sendable {
        public var ref: String
        /// Nil for `none` (the request carries no integrity).
        public var json: JSONValue?
    }

    static let keyIdDefaultsKey = "flagship.messages.appAttestKeyId"
    static let attestedDefaultsKey = "flagship.messages.appAttestSent"

    /// The `deviceCheckRef` the request names: `ios` when App Attest or DeviceCheck can run here, else `none`.
    public static var ref: String { DCAppAttestService.shared.isSupported && DCDevice.current.isSupported ? "ios" : "none" }

    /// Evidence over `requestBytes`; `none` (no integrity) when App Attest or DeviceCheck can't give it here.
    public static func evidence(requestBytes: [UInt8]) async -> Evidence {
        let none = Evidence(ref: "none", json: nil)
        let attest = DCAppAttestService.shared
        guard attest.isSupported, DCDevice.current.isSupported else { return none }
        let hash = Data(SHA256.hash(data: requestBytes))
        let defaults = UserDefaults.standard
        do {
            var out: [String: JSONValue] = ["platform": "ios"]
            if let keyId = defaults.string(forKey: keyIdDefaultsKey), defaults.bool(forKey: attestedDefaultsKey) {
                out["keyId"] = .string(keyId)
                out["assertion"] = .string(try await attest.generateAssertion(keyId, clientDataHash: hash).base64EncodedString())
            } else {
                let keyId = try await attest.generateKey()
                let object = try await attest.attestKey(keyId, clientDataHash: hash)
                defaults.set(keyId, forKey: keyIdDefaultsKey)
                defaults.set(true, forKey: attestedDefaultsKey)
                out["keyId"] = .string(keyId)
                out["attestation"] = .string(object.base64EncodedString())
            }
            out["deviceToken"] = .string(try await DCDevice.current.generateToken().base64EncodedString())
            return Evidence(ref: "ios", json: .object(out))
        } catch {
            // An invalid key (reinstall, restore) or a refused call: attest a new key next time; this request is "none".
            defaults.removeObject(forKey: keyIdDefaultsKey)
            defaults.set(false, forKey: attestedDefaultsKey)
            return none
        }
    }
}
