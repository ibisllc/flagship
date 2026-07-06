import Foundation
import Observation
import CryptoKit
import Flagship
import FlagshipAPI
import FlagshipCore

/// Pairs the phone with the desktop Burner over the internet and delivers
/// a freshly-minted recipe — a ONE-SHOT deposit.
///
/// The user designs the server, scans the QR (or types the short code) the
/// Burner shows, confirms the 6-digit SAS, and the recipe is minted + sealed +
/// delivered over the live `/burner-pipe` session. Minting reuses
/// `CreateServerViewModel.mintInstallBlob()` verbatim (same auth-code / RCK /
/// pairing / deposit bookkeeping, AND any Advanced toggles — embed-secrets,
/// debug-friendly — baked in behind the SAME create biometric); only the
/// transport differs. The crypto reuses `QrRelay` (the burner uses the
/// identical X25519/HKDF/SAS constants).
///
/// ONE-SHOT: once the recipe is delivered the phone has NO further role — it
/// shows "Sent ✓" and the user may lock/leave. There is no ongoing session, no
/// resume, no countdown, no debug-consent round-trip (the debug grant, if any,
/// is baked into the recipe at mint). The burner keeps the recipe and the
/// laptop user disconnects on the burner side.
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

    private let client: any BurnerPairClient
    /// The already-configured minter — `mintInstallBlob()` is called as-is so
    /// the recipe is byte-identical to the website/share/copy paths.
    private let minter: CreateServerViewModel

    private var phoneSk: Curve25519.KeyAgreement.PrivateKey?
    private var burnerPk: Data?
    private var aeadKey: SymmetricKey?
    private var streamTask: Task<Void, Never>?
    private var helloSent = false

    public init(client: any BurnerPairClient, minter: CreateServerViewModel) {
        self.client = client
        self.minter = minter
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
            let sid = BurnerPairing.sessionId(forCodeBytes: scanned.codeBytes)
            burnerPk = scanned.burnerPublicKey
            let sk = Curve25519.KeyAgreement.PrivateKey()
            phoneSk = sk

            let stream = try await client.connect(sid: sid)
            streamTask = Task { [weak self] in
                for await ev in stream {
                    await self?.handle(ev)
                }
            }
            // If we already have the burner pubkey (scanned QR), derive + greet
            // immediately; otherwise we wait for `burner-hello`.
            if scanned.burnerPublicKey != nil { try sendHelloIfReady() }
        } catch {
            await fail(error.localizedDescription)
        }
    }

    private func handle(_ ev: BurnerInbound) async {
        // ONE-SHOT: once the recipe is delivered the phone has no further role.
        // Ignore any later peer-gone / expired / error — the burner keeps the
        // recipe and the laptop user disconnects on the burner side.
        if case .delivered = phase { return }
        switch ev {
        case .peerPresent, .peerJoined:
            // Re-send our hello if we already have the burner's key (covers a
            // late-joining burner in the QR path).
            try? sendHelloIfReady()
        case .burnerHello(let pkB64):
            if burnerPk == nil { burnerPk = Base64URL.decode(pkB64) }
            try? sendHelloIfReady()
        case .consentRequest:
            // No debug-consent round-trip in the one-shot model — the debug
            // grant (if any) is baked into the recipe at mint time.
            break
        case .peerGone:
            await fail("The computer's burner app disconnected.")
        case .expired:
            await fail("The pairing session timed out.")
        case .relayError(let m):
            await fail(m)
        case .pong:
            break
        }
    }

    /// Derive the SAS once we have both keys, greet the burner, and move to
    /// the match screen. Idempotent (only fires once).
    private func sendHelloIfReady() throws {
        guard !helloSent, let sk = phoneSk, let pk = burnerPk else { return }
        let derived = try QrRelay.deriveMaterial(phonePrivateKey: sk, browserPublicKey: pk)
        aeadKey = derived.aeadKey
        helloSent = true
        let phonePkB64 = Base64URL.encode(sk.publicKey.rawRepresentation)
        Task { await client.send(.phoneHello(phonePkB64: phonePkB64)) }
        phase = .matching(matchCode: derived.matchCode, gateExpired: false)
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
    /// mint + seal + deliver the recipe. After delivery the phone is done.
    public func confirmAndDeliver() async {
        guard case .matching(_, true) = phase, let key = aeadKey else { return }
        await client.send(.confirmPairing)
        phase = .delivering
        do {
            let blob = try await minter.mintInstallBlob()
            lastDeliveredSerial = blob.blob.authCode.serial
            deliveredDomain = blob.blob.serverDomain
            let payload = try JSONEncoder().encode(blob.onWire())
            let sealed = try QrRelay.seal(payload: payload, with: key)
            await client.send(.deliver(ciphertextB64: sealed.ciphertextBase64Url,
                                       nonceB64: sealed.nonceBase64Url))
            minter.recordDeliveredBookkeeping(serverDomain: blob.blob.serverDomain)
            phase = .delivered(serverDomain: blob.blob.serverDomain)
        } catch {
            await fail(error.localizedDescription)
        }
    }

    public func cancel() async {
        streamTask?.cancel()
        streamTask = nil
        await client.close()
        phase = .scan
    }

    private func fail(_ message: String) async {
        streamTask?.cancel()
        streamTask = nil
        await client.close()
        phase = .failed(message)
    }
}
