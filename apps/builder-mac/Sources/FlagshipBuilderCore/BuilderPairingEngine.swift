import Foundation
import CryptoKit

/// Pure, transport-free state machine for a builder pairing session. The
/// transport (`BuilderSessionClient`, in the app target) owns the
/// WebSocket + a ping timer and feeds decoded relay frames in here; the
/// engine decides the stage transitions and the frames to send back. This
/// split keeps the crypto + protocol logic unit-testable with no network.
///
/// The link is a ONE-SHOT recipe deposit: the phone scans the QR, both sides
/// confirm a SAS, and the phone delivers the FULL recipe (with its own Advanced
/// toggles already baked in). After delivery the phone has no further role —
/// the builder keeps the recipe + burn UI; the engine ending (a phone drop) does
/// not wipe a delivered recipe (that decision lives in the model).
///
/// Relay frame shapes are defined by apps/com/src/builderRelay.ts:
///   ← {kind:"accepted"|"peer-present"|"peer-joined"|"peer-gone"
///       |"peer-missing"|"pong"|"expired"|"error", …}
///   ← {kind:"peer", frame:<phone app frame>}
/// Phone app frames (inside `peer`):
///   {kind:"phone-hello", phonePk}
///   {kind:"confirm-pairing"}
///   {kind:"deliver", ciphertext, nonce}
/// Builder app frames (inside `peer`):
///   {kind:"builder-hello", builderPk}
///   {kind:"recipe-accepted"}
public final class BuilderPairingEngine {

    public enum Stage: Equatable {
        case waitingForPhone
        case awaitingConfirm(matchCode: String)
        case paired
        case reconnecting
        case ended(reason: String)
    }

    public enum Outbound: Equatable {
        /// Forwarded to the phone so a typed-code phone learns our pubkey.
        case builderHello(builderPubKeyB64: String)
        /// Sent only after the desktop has successfully staged the recipe.
        case recipeAccepted
    }

    public enum Action: Equatable {
        case send(Outbound)
        case stage(Stage)
        case recipe(Data)
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
    private var phonePk: Data?

    public init(privateKey: Curve25519.KeyAgreement.PrivateKey = Curve25519.KeyAgreement.PrivateKey(),
                codeBytes: Data? = nil) {
        self.privateKey = privateKey
        let pkB64 = Base64URLBuilder.encode(privateKey.publicKey.rawRepresentation)
        self.publicKeyB64 = pkB64
        let code = codeBytes ?? BuilderPairing.newCodeBytes()
        self.codeBytes = code
        self.humanCode = BuilderPairing.humanCode(fromBytes: code)
        self.sessionId = BuilderPairing.sessionId(forCodeBytes: code)
        self.qrPayload = BuilderPairing.qrPayload(humanCode: humanCode,
                                                 builderPublicKey: privateKey.publicKey.rawRepresentation)
    }

    /// Display form of the short code ("ABCD-EFGH").
    public var humanCodeDisplay: String { BuilderPairing.formatHumanCode(humanCode) }

    /// Feed one decoded relay frame; returns the actions the transport
    /// should carry out (send frames, apply a stage, deliver a recipe).
    public func onRelayFrame(_ obj: [String: Any]) -> [Action] {
        guard let kind = obj["kind"] as? String else { return [] }
        switch kind {
        case "accepted":
            return []
        case "peer-present", "peer-joined":
            // The phone is here — hand it our pubkey so it can derive the SAS.
            return [.send(.builderHello(builderPubKeyB64: publicKeyB64))]
        case "peer-missing":
            return []
        case "pong":
            return []
        case "peer-gone":
            // The relay explicitly defines peer-gone as advisory. Hold a
            // confirmed session so the same phone can reconnect after a
            // transient iOS/network socket loss; before confirmation, keep
            // the same QR live and wait again.
            switch stage {
            case .paired, .reconnecting:
                if case .reconnecting = stage { return [] }
                stage = .reconnecting
                return [.stage(.reconnecting)]
            default:
                aeadKey = nil
                matchCode = nil
                phonePk = nil
                if case .waitingForPhone = stage { return [] }
                stage = .waitingForPhone
                return [.stage(.waitingForPhone)]
            }
        case "expired":
            return end("This pairing session reached its time limit.")
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
                  let incomingPk = Base64URLBuilder.decode(phonePkB64) else {
                return [.log("Ignoring malformed phone-hello.")]
            }
            if case .reconnecting = stage {
                guard let previous = phonePk, previous == incomingPk else {
                    return [.log("A different phone connected while waiting to reconnect — ignoring.")]
                }
                do {
                    let mat = try BuilderPairing.deriveMaterial(builderPrivateKey: privateKey,
                                                               phonePublicKey: incomingPk)
                    aeadKey = mat.aeadKey
                    matchCode = mat.matchCode
                    stage = .paired
                    return [.stage(.paired)]
                } catch {
                    return [.log("Couldn't resume the session: \((error as? LocalizedError)?.errorDescription ?? "\(error)")")]
                }
            }
            do {
                let mat = try BuilderPairing.deriveMaterial(builderPrivateKey: privateKey,
                                                           phonePublicKey: incomingPk)
                aeadKey = mat.aeadKey
                matchCode = mat.matchCode
                phonePk = incomingPk
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
                let data = try BuilderPairing.open(ciphertextBase64Url: ct, nonceBase64Url: nonce, key: key)
                return [.recipe(data)]
            } catch {
                return [.log((error as? LocalizedError)?.errorDescription ?? "Couldn't read the recipe.")]
            }
        default:
            return []
        }
    }

    private func end(_ reason: String) -> [Action] {
        if case .ended = stage { return [] }
        stage = .ended(reason: reason)
        return [.stage(stage)]
    }

    /// Serialize an outbound frame to JSON text for the transport to send.
    public static func encode(_ out: Outbound) -> String {
        switch out {
        case .builderHello(let pk):
            return jsonObject(["kind": "builder-hello", "builderPk": pk])
        case .recipeAccepted:
            return jsonObject(["kind": "recipe-accepted"])
        }
    }

    static func jsonObject(_ dict: [String: Any]) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: dict),
              let s = String(data: data, encoding: .utf8) else { return "{}" }
        return s
    }
}

/// Pure, testable policy for what the model does when the live phone session
/// ends (peer-gone / expired / error). A delivered recipe means the one-shot
/// deposit completed — the phone is expected to leave — so we KEEP it and stay
/// in the burn UI. With no recipe yet, a terminal expiry/error relocks to a
/// fresh QR.
///
/// This lives in the core (engine) module so the model's behaviour can be
/// unit-tested via the shared seam — the `WizardModel` itself is in the exe
/// target the test target can't import.
public enum SessionEndPolicy {
    public enum Outcome: Equatable { case keepDeliveredRecipe, relock }

    public static func onSessionEnded(recipeDelivered: Bool) -> Outcome {
        recipeDelivered ? .keepDeliveredRecipe : .relock
    }
}
