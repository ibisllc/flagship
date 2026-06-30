import Foundation
import Observation
import CryptoKit
import Flagship
import FlagshipAPI
import FlagshipCore

/// Pairs the phone with the desktop Burner over the internet and delivers
/// a freshly-minted recipe.
///
/// The user designs the server here (name etc.), scans the QR (or types the
/// short code) the Burner shows, confirms the 6-digit SAS, and the recipe is
/// minted + sealed + delivered over the live `/burner-pipe` session. Minting
/// reuses `CreateServerViewModel.mintInstallBlob()` verbatim (same auth-code /
/// RCK / pairing / deposit bookkeeping); only the transport differs. The
/// crypto reuses `QrRelay` (the burner uses the identical X25519/HKDF/SAS
/// constants).
///
/// RESUME: the session is PERSISTED (Keychain) so it survives the phone
/// briefly locking → the app being suspended (or even terminated). On the next
/// foreground/launch we reconnect to the SAME relay `sid` reusing the SAME
/// ephemeral keypair; the Mac burner holds the session and auto-resumes on an
/// identical `phone-hello` pubkey (no second SAS). `peer-gone` is ADVISORY (the
/// burner stepped/holds) — NOT a wipe; only an explicit disconnect, an incoming
/// `session-ended`, or `expired` wipes + leaves.
@Observable
@MainActor
public final class BurnerPairViewModel {
    public enum Phase: Sendable, Equatable {
        case scan
        case enterCode
        case connecting
        case matching(matchCode: String, gateExpired: Bool)
        case delivering
        case delivered(serverDomain: String)
        case failed(String)
    }

    /// Why the screen is being left — surfaced so the host can show a brief note.
    public enum LeaveReason: Sendable, Equatable {
        case userDisconnected   // the user tapped "Disconnect from burner"
        case sessionEnded       // the burner disconnected from its side
        case expired            // the session lifetime elapsed
    }

    /// Initial phase is `.scan` — the server is already designed by the
    /// create-server flow; this VM only pairs + delivers.
    public var phase: Phase = .scan
    public var typedCode: String = ""

    public var canSubmitCode: Bool {
        BurnerPairing.codeBytes(fromHumanCode: typedCode) != nil
    }

    /// Set after delivery so the host can record the pending pod.
    public private(set) var lastDeliveredSerial: String?
    public private(set) var deliveredDomain: String?

    /// Non-nil ⇒ the host should dismiss the screen (with the given reason).
    public var leaveRequest: LeaveReason?

    /// ADVISORY — true while the burner has momentarily stepped away
    /// (`peer-gone`); the session is held open, not wiped.
    public var burnerStepped = false

    /// Session deadline (ms since epoch) from the relay `accepted` frame.
    public private(set) var expiresAtMs: Int64?
    /// Re-evaluated every second by the countdown ticker; drives `countdownText`.
    public private(set) var nowMs: Int64 = Int64(Date().timeIntervalSince1970 * 1000)

    /// "Auto-locks in mm:ss" next to the Disconnect button. nil before a
    /// deadline is known.
    public var countdownText: String? {
        guard let exp = expiresAtMs else { return nil }
        let remaining = max(0, exp - nowMs)
        let secs = Int(remaining / 1000)
        return String(format: "Auto-locks in %02d:%02d", secs / 60, secs % 60)
    }

    /// True once a live session exists (connecting/matching/delivering/
    /// delivered) — the host shows the session footer (countdown + Disconnect).
    public var hasActiveSession: Bool {
        switch phase {
        case .scan, .enterCode, .failed: return false
        case .connecting, .matching, .delivering, .delivered: return true
        }
    }

    /// A pending security-sensitive consent the burner asked for (the
    /// session stays open after delivery to receive these). The screen shows
    /// a warning + Face ID; approve signs a grant the burner embeds.
    public struct PendingConsent: Equatable, Sendable {
        public let setting: String
        public let serverDomain: String
        public let warning: String
    }
    public var pendingConsent: PendingConsent?
    public var consentBusy = false

    private let client: any BurnerPairClient
    /// The already-configured minter — `mintInstallBlob()` is called as-is so
    /// the recipe is byte-identical to the website/share/copy paths. Optional:
    /// a resume from store never mints (the recipe is already in hand).
    private let minter: CreateServerViewModel?
    private let store: BurnerPairingStore?

    private var sessionId: String?
    private var phoneSk: Curve25519.KeyAgreement.PrivateKey?
    private var burnerPk: Data?
    private var aeadKey: SymmetricKey?
    private var matchCode: String?
    private var confirmed = false
    private var recipeDelivered = false
    /// Unsealed recipe wire bytes — persisted so a resumed session can re-seal
    /// + re-deliver without re-minting.
    private var recipeWire: Data?

    private var streamTask: Task<Void, Never>?
    private var countdownTask: Task<Void, Never>?
    /// True between a successful connect and a close/error.
    private var connected = false
    /// We received at least one `accepted` (or resumed a real persisted
    /// session) — distinguishes "session was live, socket dropped" (reconnect)
    /// from "never connected" (fail).
    private var everAccepted = false
    private var reconnecting = false

    public init(
        client: any BurnerPairClient,
        minter: CreateServerViewModel? = nil,
        store: BurnerPairingStore? = KeychainBurnerPairingStore()
    ) {
        self.client = client
        self.minter = minter
        self.store = store
    }

    // MARK: - Flow

    public func switchToEnterCode() { phase = .enterCode }
    public func switchToScan() { phase = .scan }

    /// A QR was scanned. Parse + connect.
    public func qrDetected(_ raw: String) async {
        await beginSession(raw)
    }

    /// The user typed the short code. Parse + connect.
    public func submitCode() async {
        await beginSession(typedCode)
    }

    private func beginSession(_ raw: String) async {
        guard streamTask == nil else { return }
        phase = .connecting
        do {
            let scanned = try BurnerPairing.parse(raw)
            sessionId = BurnerPairing.sessionId(forCodeBytes: scanned.codeBytes)
            burnerPk = scanned.burnerPublicKey
            phoneSk = Curve25519.KeyAgreement.PrivateKey()
            try await openStream()
        } catch {
            await fail(error.localizedDescription)
        }
    }

    /// (Re)open the relay stream for the current `sessionId`, reusing whatever
    /// keys we already hold. Shared by the first connect AND every reconnect.
    private func openStream() async throws {
        guard let sid = sessionId else { return }
        streamTask?.cancel()
        let stream = try await client.connect(sid: sid)
        connected = true
        streamTask = Task { [weak self] in
            for await ev in stream {
                await self?.handle(ev)
            }
        }
        // If we already have the burner pubkey (scanned QR / resume), greet
        // immediately; otherwise we wait for `burner-hello`.
        try sendHelloIfReady()
    }

    private func handle(_ ev: BurnerInbound) async {
        switch ev {
        case .accepted(let exp):
            everAccepted = true
            reconnecting = false
            if exp > 0 { expiresAtMs = exp }
            startCountdown()
            persist()
        case .peerPresent, .peerJoined:
            burnerStepped = false
            // Re-send our hello if we already have the burner's key (covers a
            // late-joining burner in the QR path, and a resume).
            try? sendHelloIfReady()
        case .burnerHello(let pkB64):
            if burnerPk == nil { burnerPk = Base64URL.decode(pkB64) }
            try? sendHelloIfReady()
        case .consentRequest(let setting, let serverDomain, let warning):
            pendingConsent = PendingConsent(setting: setting, serverDomain: serverDomain, warning: warning)
        case .sessionEnded:
            // The burner wiped its half — wipe ours + leave.
            wipeAndClose()
            leaveRequest = .sessionEnded
        case .peerGone:
            // ADVISORY: the burner stepped away / holds. Keep the session.
            burnerStepped = true
        case .expired:
            wipeAndClose()
            leaveRequest = .expired
        case .relayError(let m):
            connected = false
            if isResumable {
                // A live session whose socket dropped (phone suspended, etc.) —
                // hold + reconnect rather than fail.
                scheduleReconnect()
            } else {
                await fail(m)
            }
        case .pong:
            break
        }
    }

    /// Derive the SAS once we have both keys, greet the burner, and advance.
    /// Idempotent on the AEAD derivation; the hello is (re)sent on every
    /// (re)connect because the burner keys off the identical `phone-hello`.
    private func sendHelloIfReady() throws {
        guard let sk = phoneSk, let pk = burnerPk else { return }
        if aeadKey == nil {
            let derived = try QrRelay.deriveMaterial(phonePrivateKey: sk, browserPublicKey: pk)
            aeadKey = derived.aeadKey
            matchCode = derived.matchCode
        }
        let phonePkB64 = Base64URL.encode(sk.publicKey.rawRepresentation)
        Task { await client.send(.phoneHello(phonePkB64: phonePkB64)) }
        advanceAfterHello()
    }

    /// Pick the phase after a (re)connect's hello, based on what's already done.
    private func advanceAfterHello() {
        if confirmed {
            if recipeDelivered {
                phase = .delivered(serverDomain: deliveredDomain ?? "")
            } else {
                // Resumed a confirmed-but-undelivered session → re-deliver.
                Task { await redeliverIfPossible() }
            }
            return
        }
        guard let code = matchCode else { return }
        if case .matching = phase { return }  // already showing the SAS
        phase = .matching(matchCode: code, gateExpired: false)
        // 600ms gate before Confirm is tappable (mirrors create-server).
        Task { [weak self] in
            try? await Task.sleep(nanoseconds: 600_000_000)
            self?.openGate()
        }
    }

    private func openGate() {
        if case .matching(let m, false) = phase {
            phase = .matching(matchCode: m, gateExpired: true)
        }
    }

    /// The user confirmed the SAS matches: tell the burner to unlock, then
    /// mint + seal + deliver the recipe.
    public func confirmAndDeliver() async {
        guard case .matching(_, true) = phase, let key = aeadKey else { return }
        guard let minter else { return }
        await client.send(.confirmPairing)
        confirmed = true
        phase = .delivering
        persist()
        do {
            let blob = try await minter.mintInstallBlob()
            lastDeliveredSerial = blob.blob.authCode.serial
            deliveredDomain = blob.blob.serverDomain
            let payload = try JSONEncoder().encode(blob.onWire())
            recipeWire = payload
            persist()
            let sealed = try QrRelay.seal(payload: payload, with: key)
            await client.send(.deliver(ciphertextB64: sealed.ciphertextBase64Url,
                                       nonceB64: sealed.nonceBase64Url))
            recipeDelivered = true
            minter.recordDeliveredBookkeeping(serverDomain: blob.blob.serverDomain)
            phase = .delivered(serverDomain: blob.blob.serverDomain)
            persist()
        } catch {
            await fail(error.localizedDescription)
        }
    }

    /// Re-seal + re-deliver the stored recipe after a resume (no re-mint).
    private func redeliverIfPossible() async {
        guard let key = aeadKey, let payload = recipeWire else {
            // Nothing to re-deliver — wait for the burner to ask again.
            return
        }
        do {
            let sealed = try QrRelay.seal(payload: payload, with: key)
            await client.send(.deliver(ciphertextB64: sealed.ciphertextBase64Url,
                                       nonceB64: sealed.nonceBase64Url))
            recipeDelivered = true
            phase = .delivered(serverDomain: deliveredDomain ?? "")
            persist()
        } catch {
            // Leave it undelivered; a later reconnect / burner re-ask retries.
        }
    }

    // MARK: - Resume

    /// Reconnect a live session whose socket dropped (return-to-foreground /
    /// unlock). No-op if there's nothing to resume or we're already connected.
    public func reconnectIfNeeded() async {
        guard isResumable, !connected, !reconnecting else { return }
        reconnecting = true
        do { try await openStream() }
        catch { connected = false; reconnecting = false }
    }

    /// Rehydrate from the persisted record (cold launch). Returns true iff a
    /// fresh, unexpired session was found + a reconnect was started.
    @discardableResult
    public func resumeFromStore() async -> Bool {
        guard let store, let rec = store.load() else { return false }
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        guard rec.expiresAtMs > now else { store.clear(); return false }
        guard let sk = try? Curve25519.KeyAgreement.PrivateKey(rawRepresentation: rec.phoneSkRaw) else {
            store.clear(); return false
        }
        sessionId = rec.sid
        phoneSk = sk
        burnerPk = rec.burnerPkRaw
        confirmed = rec.confirmed
        recipeDelivered = rec.recipeDelivered
        deliveredDomain = rec.serverDomain.isEmpty ? nil : rec.serverDomain
        recipeWire = rec.recipeWire
        lastDeliveredSerial = rec.serial
        expiresAtMs = rec.expiresAtMs
        everAccepted = true   // it WAS a real, accepted session
        phase = confirmed ? (recipeDelivered ? .delivered(serverDomain: rec.serverDomain) : .delivering)
                          : .connecting
        startCountdown()
        do { try await openStream(); return true }
        catch { connected = false; return true }  // keep the screen; will retry
    }

    private var isResumable: Bool {
        guard everAccepted, sessionId != nil, phoneSk != nil, let exp = expiresAtMs else { return false }
        if case .failed = phase { return false }
        if leaveRequest != nil { return false }
        return exp > Int64(Date().timeIntervalSince1970 * 1000)
    }

    private func scheduleReconnect() {
        guard !reconnecting else { return }
        reconnecting = true
        Task { [weak self] in
            try? await Task.sleep(nanoseconds: 600_000_000)
            guard let self else { return }
            self.reconnecting = false
            await self.reconnectIfNeeded()
        }
    }

    // MARK: - Disconnect / countdown

    /// "Disconnect from burner" — the user's explicit "I'm done / changed my
    /// mind". Tell the burner to wipe its half (best-effort), wipe ours, leave.
    public func disconnect() async {
        await client.send(.sessionEnded)
        wipeAndClose()
        leaveRequest = .userDisconnected
    }

    private func startCountdown() {
        guard countdownTask == nil else { return }
        countdownTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                self.nowMs = Int64(Date().timeIntervalSince1970 * 1000)
                if let exp = self.expiresAtMs, self.nowMs >= exp {
                    self.wipeAndClose()
                    self.leaveRequest = .expired
                    return
                }
                try? await Task.sleep(nanoseconds: 1_000_000_000)
            }
        }
    }

    // MARK: - Teardown

    /// Cancel timers/stream, close the socket, wipe the persisted + in-memory
    /// session material. Idempotent.
    private func wipeAndClose() {
        countdownTask?.cancel(); countdownTask = nil
        streamTask?.cancel(); streamTask = nil
        connected = false
        store?.clear()
        recipeWire = nil
        aeadKey = nil
        phoneSk = nil
        Task { [client] in await client.close() }
    }

    /// Legacy cancel entry (back/cancel buttons): close + reset to scan WITHOUT
    /// telling the burner — used by the create flow's own Cancel.
    public func cancel() async {
        wipeAndClose()
        phase = .scan
    }

    private func persist() {
        guard let store, let sid = sessionId, let sk = phoneSk, let exp = expiresAtMs else { return }
        store.save(PersistedBurnerPairing(
            sid: sid,
            phoneSkRaw: sk.rawRepresentation,
            burnerPkRaw: burnerPk,
            confirmed: confirmed,
            recipeDelivered: recipeDelivered,
            serverDomain: deliveredDomain ?? "",
            recipeWire: recipeWire,
            serial: lastDeliveredSerial,
            expiresAtMs: exp
        ))
    }

    private func fail(_ message: String) async {
        wipeAndClose()
        phase = .failed(message)
    }

    // MARK: - Consent (unchanged crypto)

    /// Approve the pending consent: Face ID → sign the debug-access grant →
    /// send it back over the session for the burner to embed.
    public func approveConsent() async {
        guard let pending = pendingConsent, !consentBusy else { return }
        consentBusy = true
        defer { consentBusy = false }
        do {
            let irk = try await Keystore.deriveIRK(reason: "Approve debug access for \(pending.serverDomain)")
            let grant = DebugAccess.Grant(serverDomain: pending.serverDomain, sshAuthorizedKey: "",
                                          issuedAt: Int64(Date().timeIntervalSince1970 * 1000))
            let sig = try DebugAccess.sign(grant, irk: irk)
            let envelope = DebugAccess.envelopeJSON(grant, signatureHex: sig)
            let frame = ["kind": "consent-result", "setting": pending.setting, "grant": envelope]
            if let data = try? JSONSerialization.data(withJSONObject: frame),
               let json = String(data: data, encoding: .utf8) {
                await client.send(.raw(json: json))
            }
            pendingConsent = nil
        } catch {
            // Face ID cancelled / failed → tell the burner it was declined.
            await denyConsent()
        }
    }

    public func denyConsent() async {
        guard let pending = pendingConsent else { return }
        let frame = ["kind": "consent-result", "setting": pending.setting]
        if let data = try? JSONSerialization.data(withJSONObject: frame),
           let json = String(data: data, encoding: .utf8) {
            await client.send(.raw(json: json))
        }
        pendingConsent = nil
    }
}
