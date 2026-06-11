import Foundation
import Observation
import CryptoKit
import FlagshipAPI
import FlagshipCore

/// C3 — view model driving the retail-box NFC tap-to-pair flow.
///
/// State machine:
///   idle ── startTap() ──▶ readingTag ──┬─▶ askingForWifi  (PAIR verified)
///                                       └─▶ failure        (any reader err;
///                                            non-security errors offer the
///                                            LED-SAS fallback entry point)
///   askingForWifi ── sendSealedWifi() ──▶ sealing ──▶ depositing ──┬─▶ success
///                                                                  └─▶ failure
///   askingForWifi ── >30 s after the tap ──▶ failure (session-lock expired;
///                                            the box has rolled its keys —
///                                            re-tap required)
///   failure(fallback available) ── startLedSasFallback() ──▶ ledSasFallback
///   reset() ──▶ idle (clears all transient material)
///
/// `ledSasFallback` is the Q2-locked degrade seam: NFC read failed or is
/// unavailable, so pairing continues over LAN/cloud confirmed by the box's
/// LED-SAS blink pattern. The capture/decode UI is N-PHONE-6; this phase is
/// its mount point. Security failures (signature mismatch) NEVER route here
/// — fail-closed is for security, absent hardware is just UX.
///
/// The view model never persists K_session, the ephemeral X25519
/// private key, or the sealed WiFi blob — everything lives in @MainActor
/// properties that are dropped on `reset()` or instance teardown.
@MainActor
@Observable
public final class NfcPairViewModel {

    /// Everything the post-tap confirmation screen shows. `sasDisplay` +
    /// `sasLed` are the optional SAS glance (design refinement §10):
    /// proximity already authenticated the key, but in a noisy room
    /// (three boxes in pairing mode) the user can match the LED pattern.
    /// `suffix6` is the two-box disambiguation hint (refinement §9).
    public struct PairConfirmation: Equatable, Sendable {
        public let boxLabel: String
        public let suffix6: String
        /// First 6 hex chars of the SAS — on-screen glance.
        public let sasDisplay: String
        /// 9-pulse RGBY sequence the box's LED blinks for the same SAS.
        public let sasLed: String
        /// Wall-clock ms when the box's 30 s session lock expires.
        public let sessionExpiresAtMs: Int64
    }

    public enum Phase: Equatable, Sendable {
        case idle
        case readingTag
        /// PAIR verified; show SSID/PSK form + the optional SAS glance.
        case askingForWifi(PairConfirmation)
        case sealing
        case depositing
        case success(message: String)
        case failure(message: String, ledSasFallbackAvailable: Bool)
        /// Q2 fallback seam — N-PHONE-6 mounts the LED capture flow here.
        case ledSasFallback
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
    /// Wall-clock ms of the verified tap — anchors the session-lock window.
    private var tapAtMs: Int64?

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
            // needing another await point — and so the SAS glance can
            // show right away (it needs the completed ECDH).
            let priv = ephemeralKeyGen()
            let ss = try deriveSharedSecret(
                ePhonePriv: priv,
                eBoxPub: result.payload.eBoxPub
            )
            let ePhonePub = priv.publicKey.rawRepresentation
            let sas = deriveSAS(
                sharedSecret: ss,
                stkPub: result.payload.stkPub,
                eBoxPub: result.payload.eBoxPub,
                ePhonePub: ePhonePub,
                nonce: result.payload.nonce,
                sessionId: result.payload.sessionId,
                v: result.payload.v
            )
            let tapped = now()
            paired = result
            ephemeralPriv = priv
            tapAtMs = tapped
            phase = .askingForWifi(PairConfirmation(
                boxLabel: result.payload.hint.mdnsName,
                suffix6: result.payload.hint.suffix6,
                sasDisplay: encodeSasForDisplay(sas),
                sasLed: (try? encodeLedSas(sas)) ?? "",
                sessionExpiresAtMs: tapped + PAIR_SESSION_LOCK_MS
            ))
        } catch let err as NfcPairReaderError {
            clearPairing()
            phase = .failure(
                message: Self.userMessage(for: err),
                ledSasFallbackAvailable: Self.ledSasFallbackAvailable(for: err)
            )
        } catch {
            clearPairing()
            phase = .failure(
                message: "Pairing failed: \(error.localizedDescription)",
                ledSasFallbackAvailable: false
            )
        }
    }

    /// User typed SSID/PSK and tapped "Send to box". Derive K_session,
    /// seal the WiFiConfig, POST the ePhonePub-prefixed blob to the
    /// cloud rendezvous.
    public func sendSealedWifi() async {
        guard let paired, let ephemeralPriv, let tapAtMs else {
            phase = .failure(
                message: "No active pairing — tap the box first.",
                ledSasFallbackAvailable: false
            )
            return
        }
        if ssid.isEmpty {
            phase = .failure(
                message: "Wi-Fi network name (SSID) is required.",
                ledSasFallbackAvailable: false
            )
            return
        }
        // Session-lock window: the box latched this sessionId for 30 s
        // at the tap and has rolled a fresh keypair since. Depositing
        // against the dead session would silently never be consumed —
        // fail with a re-tap prompt instead.
        if now() - tapAtMs > PAIR_SESSION_LOCK_MS {
            clearPairing()
            phase = .failure(
                message: "The pairing session expired — tap your box again.",
                ledSasFallbackAvailable: false
            )
            return
        }

        phase = .sealing
        let sealed: SealedWiFiConfig
        let depositBlob: Data
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
            // The box can't derive K_session without our ephemeral pub —
            // prefix it (protocol deposit-blob format; tamper-evident
            // because ePhonePub is bound into the K_session transcript).
            depositBlob = try buildWifiDepositBlob(ePhonePub: ePhonePub, sealed: sealed)
        } catch {
            // Sealing-failure is a programming bug (wrong-size key) or
            // a CryptoKit anomaly. Don't leak crypto detail to the user.
            phase = .failure(
                message: "Couldn't prepare the Wi-Fi blob. Try again.",
                ledSasFallbackAvailable: false
            )
            return
        }

        phase = .depositing
        do {
            try await rendezvous.depositSealedWifi(
                rendezvousId: paired.payload.hint.cloudRendezvousId,
                sealedHex: NfcPairHex.encode(depositBlob),
                nonceHex: NfcPairHex.encode(sealed.nonce)
            )
        } catch let err as NfcRendezvousError {
            // We do NOT cache the sealed blob locally for retry — on a
            // 5xx the safest path is to ask the user to re-tap, which
            // remints both the ephemeral key and the rendezvous slot.
            phase = .failure(
                message: err.errorDescription ?? "Couldn't reach the server.",
                ledSasFallbackAvailable: false
            )
            return
        } catch {
            phase = .failure(
                message: "Couldn't reach the server: \(error.localizedDescription)",
                ledSasFallbackAvailable: false
            )
            return
        }

        let networkLabel = ssid
        // Wipe transient material on success: the cloud has the sealed
        // blob, the box will consume it, and the phone has nothing more
        // to do with this pairing.
        clearPairing()
        phase = .success(message: "Your box is connecting to \(networkLabel).")
    }

    /// Q2 fallback entry — only reachable from a failure that offered it.
    /// N-PHONE-6 replaces the destination's stub body with the LED
    /// capture + decode flow; the transition contract stays as-is.
    public func startLedSasFallback() {
        guard case .failure(_, true) = phase else { return }
        phase = .ledSasFallback
    }

    /// Reset to idle. Clears the form fields + transient crypto material.
    public func reset() {
        clearPairing()
        ssid = ""
        psk = ""
        phase = .idle
    }

    // MARK: helpers

    private func clearPairing() {
        paired = nil
        ephemeralPriv = nil
        tapAtMs = nil
    }

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

    /// Q2: a failed/unavailable NFC *read* degrades to the LED-SAS
    /// path. Security verdicts do NOT — a tampered tag must dead-end
    /// (fail-closed is security-only); a user cancel is benign and just
    /// retries the tap.
    static func ledSasFallbackAvailable(for err: NfcPairReaderError) -> Bool {
        switch err {
        case .sessionUnavailable, .timeout, .tagFormatUnrecognized,
             .multipleRecords, .malformedPayload:
            return true
        case .userCanceled, .signatureMismatch:
            return false
        }
    }
}
