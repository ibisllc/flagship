import Foundation
import CryptoKit

/// Phase 3b — cross-device pairing transport seam (collaborator admit).
///
/// Unlike the create-server `QrRelayClient` (one-shot phone→browser
/// delivery), the pairing exchange is **bidirectional and two-message**
/// over a single sealed channel:
///
///   admin (sender / originator)                incoming (receiver)
///   ───────────────────────────                ───────────────────
///   open session, derive QR-shaped URL  ──QR──►  scan, derive SAS
///   derive SAS, show, confirm match              show SAS, confirm match
///        receive devicePubHello   ◄────────────  send fresh device pubkey
///        sign DeviceAdmit, seal bundle ────────►  receive sealed bundle
///                                                 verify admit, install UMK
///
/// The shared AEAD key + the 6-digit SAS are derived EXACTLY as in
/// `QrRelay.deriveMaterial` (same HKDF salt / info) so the existing,
/// audited crypto carries the keys. The two payloads (the incoming
/// device pubkey, and the `{umkSeedHex, admit, admitSig}` bundle) are
/// AEAD-sealed under that key.
///
/// SECURITY: the SAS is never on the wire — both sides compute it from
/// the X25519 shared secret, so a MitM that swapped pubkeys produces a
/// mismatched code on the two screens, which the human catches visually.
/// The admin only seals the UMK bundle AFTER confirming the SAS match.
public protocol PairingRelayClient: Sendable {
    /// Admin role: open the relay as the originator, wait for the
    /// incoming device to connect and push its sealed device-pubkey
    /// hello. Returns the incoming device's raw 32-byte pubkey
    /// (already AEAD-opened). Throws on timeout / peer-missing / expiry.
    func adminAwaitDevicePubkey(sid: String, aeadKey: SymmetricKey) async throws -> Data

    /// Admin role: AEAD-seal + push the final bundle to the incoming
    /// device. Returns once the incoming device acknowledges receipt.
    func adminDeliverBundle(sid: String, ciphertextBase64Url: String, nonceBase64Url: String) async throws

    /// Incoming role: connect as the receiver, AEAD-seal + push the
    /// fresh device pubkey, then await + return the admin's sealed
    /// bundle as (ciphertext, nonce) base64url.
    func incomingSendPubkeyAwaitBundle(
        sid: String,
        devicePubCiphertextBase64Url: String,
        devicePubNonceBase64Url: String
    ) async throws -> (ciphertextBase64Url: String, nonceBase64Url: String)

    /// Cleanly close the channel. Idempotent.
    func close() async
}

public enum PairingRelayError: Error, LocalizedError, Sendable {
    case sessionExpired
    case peerMissing
    case transport(String)
    case sessionInvalidated

    public var errorDescription: String? {
        switch self {
        case .sessionExpired:     return "This pairing code expired. Ask the other device to show a new one."
        case .peerMissing:        return "The other device isn't connected. Try scanning again."
        case .transport(let m):   return "Pairing transport error: \(m)"
        case .sessionInvalidated: return "The pairing session was cancelled for your security."
        }
    }
}

// MARK: - Mock

/// In-process pairing relay for unit + UI tests. A single instance is
/// shared by BOTH the admin- and incoming-side view models in a test so
/// the two halves rendezvous: the incoming side's pushed pubkey is
/// handed to the admin side, and the admin side's sealed bundle is
/// handed back to the incoming side.
///
/// Synchronization is via continuations so either side can start first.
public final class MockPairingRelayClient: PairingRelayClient, @unchecked Sendable {
    public enum Behavior: Sendable {
        case happy
        case peerMissing
        case sessionExpired
    }
    public var behavior: Behavior = .happy
    public var simulatedLatency: TimeInterval = 0

    private let lock = NSLock()
    // Raw device pubkey the incoming side pushed (AEAD-opened by the
    // test harness before handing in — see `pushDevicePubkeyRaw`).
    private var devicePubkeyRaw: Data?
    private var devicePubWaiters: [CheckedContinuation<Data, Error>] = []
    // Sealed bundle the admin side delivered (ciphertext, nonce).
    private var bundle: (ct: String, nonce: String)?
    private var bundleWaiters: [CheckedContinuation<(ciphertextBase64Url: String, nonceBase64Url: String), Error>] = []

    public init() {}

    /// Test helper: the incoming side normally seals the pubkey; the
    /// Mock can't open it without the AEAD key, so the incoming VM hands
    /// the RAW pubkey here alongside the sealed frame. Production never
    /// uses this — the live relay forwards opaque ciphertext.
    public var lastIncomingSealedPubkey: (ct: String, nonce: String)?
    public var lastDeliveredBundle: (ct: String, nonce: String)?

    private func delay() async {
        if simulatedLatency > 0 {
            try? await Task.sleep(nanoseconds: UInt64(simulatedLatency * 1_000_000_000))
        }
    }

    private func mapBehaviorError() -> PairingRelayError? {
        switch behavior {
        case .happy:         return nil
        case .peerMissing:   return .peerMissing
        case .sessionExpired: return .sessionExpired
        }
    }

    public func adminAwaitDevicePubkey(sid: String, aeadKey: SymmetricKey) async throws -> Data {
        await delay()
        if let e = mapBehaviorError() { throw e }
        return try await withCheckedThrowingContinuation { cont in
            let raw: Data? = lock.withLock {
                if let raw = devicePubkeyRaw { return raw }
                devicePubWaiters.append(cont)
                return nil
            }
            if let raw { cont.resume(returning: raw) }
        }
    }

    public func adminDeliverBundle(sid: String, ciphertextBase64Url: String, nonceBase64Url: String) async throws {
        await delay()
        if let e = mapBehaviorError() { throw e }
        let waiters: [CheckedContinuation<(ciphertextBase64Url: String, nonceBase64Url: String), Error>] = lock.withLock {
            bundle = (ciphertextBase64Url, nonceBase64Url)
            lastDeliveredBundle = (ciphertextBase64Url, nonceBase64Url)
            let waiters = bundleWaiters
            bundleWaiters.removeAll()
            return waiters
        }
        for w in waiters { w.resume(returning: (ciphertextBase64Url, nonceBase64Url)) }
    }

    public func incomingSendPubkeyAwaitBundle(
        sid: String,
        devicePubCiphertextBase64Url: String,
        devicePubNonceBase64Url: String
    ) async throws -> (ciphertextBase64Url: String, nonceBase64Url: String) {
        await delay()
        if let e = mapBehaviorError() { throw e }
        lock.withLock {
            lastIncomingSealedPubkey = (devicePubCiphertextBase64Url, devicePubNonceBase64Url)
        }
        // The incoming side must publish the RAW pubkey to the admin side
        // via `provideRawIncomingPubkey` (the Mock can't open the seal).
        // If it hasn't yet, the admin's await is pending; once it does,
        // those waiters drain. Now await the admin's bundle.
        return try await withCheckedThrowingContinuation { cont in
            let ready: (ciphertextBase64Url: String, nonceBase64Url: String)? = lock.withLock {
                if let b = bundle { return (b.ct, b.nonce) }
                bundleWaiters.append(cont)
                return nil
            }
            if let ready { cont.resume(returning: ready) }
        }
    }

    /// Test bridge: hand the admin side the incoming device's RAW pubkey
    /// (since the Mock can't AEAD-open the sealed frame). Drains any
    /// pending `adminAwaitDevicePubkey` waiters.
    public func provideRawIncomingPubkey(_ raw: Data) {
        lock.lock()
        devicePubkeyRaw = raw
        let waiters = devicePubWaiters
        devicePubWaiters.removeAll()
        lock.unlock()
        for w in waiters { w.resume(returning: raw) }
    }

    public func close() async {
        let (dpw, bw) = lock.withLock {
            let dpw = devicePubWaiters; devicePubWaiters.removeAll()
            let bw = bundleWaiters; bundleWaiters.removeAll()
            return (dpw, bw)
        }
        for w in dpw { w.resume(throwing: PairingRelayError.sessionInvalidated) }
        for w in bw { w.resume(throwing: PairingRelayError.sessionInvalidated) }
    }
}
