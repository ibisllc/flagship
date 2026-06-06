import Foundation
import Observation
import CryptoKit
import FlagshipAPI
import FlagshipCore

/// C3 — view model driving the retail-box NFC tap-to-pair flow.
///
/// State machine:
///   idle ── startTap() ──▶ readingTag ──┬─▶ askingForWifi  (PAIR verified)
///                                       └─▶ failure        (any reader err)
///   askingForWifi ── sendSealedWifi() ──▶ sealing ──▶ depositing ──┬─▶ success
///                                                                  └─▶ failure
///   reset() ──▶ idle (clears all transient material)
///
/// The view model never persists K_session, the ephemeral X25519
/// private key, or the sealed WiFi blob — everything lives in @MainActor
/// properties that are dropped on `reset()` or instance teardown.
@MainActor
@Observable
public final class NfcPairViewModel {

    public enum Phase: Equatable, Sendable {
        case idle
        case readingTag
        /// PAIR verified; show SSID/PSK form. `boxLabel` is the
        /// hint.mdnsName (e.g. "flagship-abcdef.local") so the user
        /// has a human-readable confirmation of which box they tapped.
        case askingForWifi(boxLabel: String)
        case sealing
        case depositing
        case success(message: String)
        case failure(String)
    }

    // MARK: Public, observable

    public private(set) var phase: Phase = .idle
    public var ssid: String = ""
    public var psk: String = ""
    /// ISO 3166-1 alpha-2. Defaults to "US"; the form picker is the
    /// only writer the screen exposes today.
    public var regulatoryRegion: String = "US"

    // MARK: Dependencies

    private let reader: any NfcPairReaderProtocol
    private let rendezvous: any NfcRendezvousClient
    private let ephemeralKeyGen: @Sendable () -> Curve25519.KeyAgreement.PrivateKey
    private let now: @Sendable () -> Int64

    // MARK: Transient — cleared on reset() or successful deposit

    private var paired: ReadPairResult?
    private var ephemeralPriv: Curve25519.KeyAgreement.PrivateKey?

    public init(
        reader: any NfcPairReaderProtocol,
        rendezvous: any NfcRendezvousClient,
        ephemeralKeyGen: @escaping @Sendable () -> Curve25519.KeyAgreement.PrivateKey = {
            Curve25519.KeyAgreement.PrivateKey()
        },
        now: @escaping @Sendable () -> Int64 = {
            Int64(Date().timeIntervalSince1970 * 1000)
        }
    ) {
        self.reader = reader
        self.rendezvous = rendezvous
        self.ephemeralKeyGen = ephemeralKeyGen
        self.now = now
    }

    /// User tapped "Tap your box". Open the reader, verify the PAIR
    /// signature, advance to the SSID/PSK form on success.
    public func startTap() async {
        phase = .readingTag
        do {
            let result = try await reader.readPair()
            // Materialize the ephemeral key as soon as PAIR verifies so
            // a later sendSealedWifi can derive K_session without
            // needing another await point.
            paired = result
            ephemeralPriv = ephemeralKeyGen()
            phase = .askingForWifi(boxLabel: result.payload.hint.mdnsName)
        } catch let err as NfcPairReaderError {
            paired = nil
            ephemeralPriv = nil
            phase = .failure(Self.userMessage(for: err))
        } catch {
            paired = nil
            ephemeralPriv = nil
            phase = .failure("Pairing failed: \(error.localizedDescription)")
        }
    }

    /// User typed SSID/PSK and tapped "Send to box". Derive K_session,
    /// seal the WiFiConfig, POST to the cloud rendezvous.
    public func sendSealedWifi() async {
        guard let paired, let ephemeralPriv else {
            phase = .failure("No active pairing — tap the box first.")
            return
        }
        if ssid.isEmpty {
            phase = .failure("Wi-Fi network name (SSID) is required.")
            return
        }

        phase = .sealing
        let sealed: SealedWiFiConfig
        do {
            let ss = try deriveSharedSecret(
                ePhonePriv: ephemeralPriv,
                eBoxPub: paired.payload.eBoxPub
            )
            let ePhonePub = ephemeralPriv.publicKey.rawRepresentation
            let kSession = deriveSessionKey(
                sharedSecret: ss,
                stkPub: paired.payload.stkPub,
                eBoxPub: paired.payload.eBoxPub,
                ePhonePub: ePhonePub,
                nonce: paired.payload.nonce,
                sessionId: paired.payload.sessionId,
                v: paired.payload.v
            )
            let cfg = WiFiConfig(
                ssid: ssid,
                psk: psk,
                regulatoryRegion: regulatoryRegion,
                issuedAt: now()
            )
            sealed = try sealWiFiConfig(cfg, kSession: kSession)
        } catch {
            // Sealing-failure is a programming bug (wrong-size key) or
            // a CryptoKit anomaly. Don't leak crypto detail to the user.
            phase = .failure("Couldn't prepare the Wi-Fi blob. Try again.")
            return
        }

        phase = .depositing
        do {
            try await rendezvous.depositSealedWifi(
                rendezvousId: paired.payload.hint.cloudRendezvousId,
                sealedHex: NfcPairHex.encode(sealed.ciphertext),
                nonceHex: NfcPairHex.encode(sealed.nonce)
            )
        } catch let err as NfcRendezvousError {
            // We do NOT cache the sealed blob locally for retry — on a
            // 5xx the safest path is to ask the user to re-tap, which
            // remints both the ephemeral key and the rendezvous slot.
            phase = .failure(err.errorDescription ?? "Couldn't reach the server.")
            return
        } catch {
            phase = .failure("Couldn't reach the server: \(error.localizedDescription)")
            return
        }

        let networkLabel = ssid
        // Wipe transient material on success: the cloud has the sealed
        // blob, the box will consume it, and the phone has nothing more
        // to do with this pairing.
        self.paired = nil
        self.ephemeralPriv = nil
        phase = .success(message: "Your box is connecting to \(networkLabel).")
    }

    /// Reset to idle. Clears the form fields + transient crypto material.
    public func reset() {
        paired = nil
        ephemeralPriv = nil
        ssid = ""
        psk = ""
        phase = .idle
    }

    // MARK: helpers

    private static func userMessage(for err: NfcPairReaderError) -> String {
        switch err {
        case .sessionUnavailable:
            return "This device doesn't support NFC tag reading."
        case .userCanceled:
            return "Cancelled. Tap your box to try again."
        case .tagFormatUnrecognized:
            return "That doesn't look like a Flagship tag. Hold your phone closer to the box."
        case .multipleRecords(let n):
            return "Tag has \(n) records — expected 2. The box may need a firmware update."
        case .malformedPayload(let detail):
            return "Tag is malformed (\(detail))."
        case .signatureMismatch:
            return "Tag signature didn't verify. Don't use this box — it may be tampered."
        case .timeout:
            return "Timed out waiting for the box. Try again."
        }
    }
}
