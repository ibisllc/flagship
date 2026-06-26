import Foundation
import CryptoKit

/// Pure, transport-free state machine for a burner pairing session. The
/// transport (`BurnerSessionClient`, in the app target) owns the
/// WebSocket + a ping timer and feeds decoded relay frames in here; the
/// engine decides the stage transitions and the frames to send back. This
/// split keeps the crypto + protocol logic unit-testable with no network.
///
/// Relay frame shapes are defined by apps/com/src/burnerRelay.ts:
///   ← {kind:"accepted"|"peer-present"|"peer-joined"|"peer-gone"
///       |"peer-missing"|"pong"|"expired"|"error", …}
///   ← {kind:"peer", frame:<phone app frame>}
/// Phone app frames (inside `peer`):
///   {kind:"phone-hello", phonePk}
///   {kind:"confirm-pairing"}
///   {kind:"deliver", ciphertext, nonce}
///   {kind:"consent-result", …}        (Phase 4)
public final class BurnerPairingEngine {

    public enum Stage: Equatable {
        case waitingForPhone
        case awaitingConfirm(matchCode: String)
        case paired
        case ended(reason: String)
    }

    public enum Outbound: Equatable {
        /// Forwarded to the phone so a typed-code phone learns our pubkey.
        case burnerHello(burnerPubKeyB64: String)
        /// Pre-serialized JSON for higher-level frames (e.g. consent-request).
        case raw(json: String)
    }

    public enum Action: Equatable {
        case send(Outbound)
        case stage(Stage)
        case recipe(Data)
        /// The phone approved a security-sensitive setting and returned the
        /// signed grant envelope (debug-access) to embed. `grantJSON` is the
        /// `{grant, signatureHex}` blob the box-side gate consumes verbatim.
        case consentGranted(setting: String, grantJSON: String)
        /// The phone declined / failed a consent request.
        case consentDenied(setting: String)
        case log(String)
    }

    public let privateKey: Curve25519.KeyAgreement.PrivateKey
    public let publicKeyB64: String
    public let codeBytes: Data
    public let humanCode: String
    public let sessionId: String
    public let qrPayload: String

    public private(set) var stage: Stage = .waitingForPhone
    private var aeadKey: SymmetricKey?
    public private(set) var matchCode: String?

    public init(privateKey: Curve25519.KeyAgreement.PrivateKey = Curve25519.KeyAgreement.PrivateKey(),
                codeBytes: Data? = nil) {
        self.privateKey = privateKey
        let pkB64 = Base64URLBurner.encode(privateKey.publicKey.rawRepresentation)
        self.publicKeyB64 = pkB64
        let code = codeBytes ?? BurnerPairing.newCodeBytes()
        self.codeBytes = code
        self.humanCode = BurnerPairing.humanCode(fromBytes: code)
        self.sessionId = BurnerPairing.sessionId(forCodeBytes: code)
        self.qrPayload = BurnerPairing.qrPayload(humanCode: humanCode,
                                                 burnerPublicKey: privateKey.publicKey.rawRepresentation)
    }

    /// Display form of the short code ("ABCD-EFGH").
    public var humanCodeDisplay: String { BurnerPairing.formatHumanCode(humanCode) }

    /// Feed one decoded relay frame; returns the actions the transport
    /// should carry out (send frames, apply a stage, deliver a recipe).
    public func onRelayFrame(_ obj: [String: Any]) -> [Action] {
        guard let kind = obj["kind"] as? String else { return [] }
        switch kind {
        case "accepted":
            return []
        case "peer-present", "peer-joined":
            // The phone is here — hand it our pubkey so it can derive the SAS.
            return [.send(.burnerHello(burnerPubKeyB64: publicKeyB64))]
        case "peer-missing":
            return []
        case "pong":
            return []
        case "peer-gone":
            return end("The phone disconnected.")
        case "expired":
            return end("The pairing session timed out.")
        case "error":
            let reason = (obj["reason"] as? String) ?? "relay error"
            return end(reason)
        case "peer":
            guard let frame = obj["frame"] as? [String: Any] else { return [] }
            return onPeerFrame(frame)
        default:
            return []
        }
    }

    private func onPeerFrame(_ frame: [String: Any]) -> [Action] {
        guard let kind = frame["kind"] as? String else { return [] }
        switch kind {
        case "phone-hello":
            guard let phonePkB64 = frame["phonePk"] as? String,
                  let phonePk = Base64URLBurner.decode(phonePkB64) else {
                return [.log("Ignoring malformed phone-hello.")]
            }
            do {
                let mat = try BurnerPairing.deriveMaterial(burnerPrivateKey: privateKey,
                                                           phonePublicKey: phonePk)
                aeadKey = mat.aeadKey
                matchCode = mat.matchCode
                stage = .awaitingConfirm(matchCode: mat.matchCode)
                return [.stage(stage)]
            } catch {
                return [.log("Handshake failed: \((error as? LocalizedError)?.errorDescription ?? "\(error)")")]
            }
        case "confirm-pairing":
            // The phone's user confirmed the SAS matched. Unlock.
            stage = .paired
            return [.stage(.paired)]
        case "deliver":
            guard let key = aeadKey else { return [.log("Recipe arrived before pairing completed.")] }
            guard let ct = frame["ciphertext"] as? String, let nonce = frame["nonce"] as? String else {
                return [.log("Ignoring malformed recipe delivery.")]
            }
            do {
                let data = try BurnerPairing.open(ciphertextBase64Url: ct, nonceBase64Url: nonce, key: key)
                return [.recipe(data)]
            } catch {
                return [.log((error as? LocalizedError)?.errorDescription ?? "Couldn't read the recipe.")]
            }
        case "consent-result":
            guard let setting = frame["setting"] as? String else { return [] }
            // Approved with a signed grant envelope, or declined.
            if let grant = frame["grant"] as? [String: Any],
               let grantData = try? JSONSerialization.data(withJSONObject: grant),
               let grantJSON = String(data: grantData, encoding: .utf8) {
                return [.consentGranted(setting: setting, grantJSON: grantJSON)]
            }
            if let grantStr = frame["grant"] as? String, !grantStr.isEmpty {
                return [.consentGranted(setting: setting, grantJSON: grantStr)]
            }
            return [.consentDenied(setting: setting)]
        default:
            return []
        }
    }

    /// Build a consent-request to send to the phone (e.g. when the user
    /// toggles a security-sensitive Advanced setting). The phone shows a
    /// security warning, requires Face ID, and replies with a signed grant.
    public func consentRequest(setting: String, serverDomain: String, warning: String) -> Outbound {
        .raw(json: BurnerPairingEngine.jsonObject([
            "kind": "consent-request",
            "setting": setting,
            "serverDomain": serverDomain,
            "warning": warning,
        ]))
    }

    private func end(_ reason: String) -> [Action] {
        if case .ended = stage { return [] }
        stage = .ended(reason: reason)
        return [.stage(stage)]
    }

    /// Serialize an outbound frame to JSON text for the transport to send.
    public static func encode(_ out: Outbound) -> String {
        switch out {
        case .burnerHello(let pk):
            return jsonObject(["kind": "burner-hello", "burnerPk": pk])
        case .raw(let json):
            return json
        }
    }

    static func jsonObject(_ dict: [String: Any]) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: dict),
              let s = String(data: data, encoding: .utf8) else { return "{}" }
        return s
    }
}
