import Foundation
import Observation
import CryptoKit
import Flagship
import FlagshipAPI
import FlagshipCore

/// Orchestrates the v2 create-server flow:
///
///   1. parseQr      User pastes / scans the QR URL from flagshipserver.com.
///   2. connecting   Open the relay WS as role=phone, send hello.
///   3. matching     Show 6-digit SAS code. User compares with browser
///                   screen; 600 ms gate before Confirm is tappable.
///   4. minting      Hit /api/username/claim + /api/auth-code/issue +
///                   /api/routing/register-rck on flagshipserver.com,
///                   sign canonical InstallBlob with IRK.
///   5. delivering   AEAD-seal the bundle, push through the relay.
///   6. delivered    Browser AEAD-opened it; ISO write happens there.
@Observable
@MainActor
public final class CreateServerViewModel {
    public enum Phase: Sendable {
        case parseQr
        case connecting
        case matching(matchCode: String, gateExpired: Bool)
        case minting
        case delivering
        case delivered(serial: String, serverDomain: String)
        case failed(String)
    }

    public var phase: Phase = .parseQr
    public var name: String = ""
    public var description: String = ""
    public var qrUrl: String = ""

    private let username: String
    private let server: any FlagshipServerClient
    private let relay: any QrRelayClient

    public init(
        username: String,
        server: any FlagshipServerClient,
        relay: any QrRelayClient
    ) {
        self.username = username
        self.server = server
        self.relay = relay
    }

    public var canSubmit: Bool {
        !name.trimmingCharacters(in: .whitespaces).isEmpty
            && !qrUrl.trimmingCharacters(in: .whitespaces).isEmpty
    }

    /// Step 1 → 3. Parses the QR, opens the relay, derives the match
    /// code. Returns when the relay has acked + the match code is
    /// visible to the user.
    public func connectAndMatch() async {
        guard canSubmit else { return }
        phase = .connecting
        do {
            let session = try QrRelay.parseQrUrl(qrUrl)
            let phoneSk = Curve25519.KeyAgreement.PrivateKey()
            let derived = try QrRelay.deriveMaterial(
                phonePrivateKey: phoneSk,
                browserPublicKey: session.browserPublicKey
            )
            let phonePkB64u = Base64URL.encode(phoneSk.publicKey.rawRepresentation)
            try await relay.openAndHello(sid: session.sid, phonePkBase64Url: phonePkB64u)
            phase = .matching(matchCode: derived.matchCode, gateExpired: false)
            // Stash for the deliver step.
            pendingBundle = .init(session: session, aeadKey: derived.aeadKey)
            // 600 ms confirm gate.
            Task {
                try? await Task.sleep(nanoseconds: 600_000_000)
                if case .matching(let m, _) = phase {
                    phase = .matching(matchCode: m, gateExpired: true)
                }
            }
        } catch {
            phase = .failed(error.localizedDescription)
            await relay.close()
        }
    }

    /// Step 4 → 6. After the user has confirmed the SAS match.
    public func confirmAndDeliver() async {
        guard case .matching(_, true) = phase, let bundle = pendingBundle else { return }
        phase = .minting
        do {
            let blob = try await mintInstallBlob()
            phase = .delivering
            // Wire-format payload: { blob, blobSignature } base64-encoded
            // ciphertext over `JSON.stringify({blob: <onWireBlob>, blobSignature: <hex>})`.
            let onWire = blob.onWire()
            let payload = try JSONEncoder().encode(onWire)
            let sealed = try QrRelay.seal(payload: payload, with: bundle.aeadKey)
            try await relay.deliver(
                ciphertextBase64Url: sealed.ciphertextBase64Url,
                nonceBase64Url: sealed.nonceBase64Url
            )
            phase = .delivered(
                serial: blob.blob.authCode.serial,
                serverDomain: blob.blob.serverDomain
            )
            await relay.close()
        } catch {
            phase = .failed(error.localizedDescription)
            await relay.close()
        }
    }

    public func cancel() async {
        await relay.close()
        phase = .parseQr
    }

    // MARK: - Internals

    private struct PendingBundle {
        let session: QrRelay.QrSession
        let aeadKey: SymmetricKey
    }
    private var pendingBundle: PendingBundle?

    /// Three sequential `.com` POSTs + an IRK-signed canonical
    /// InstallBlob. Matches `mintInstallBlobBundle` in create-server.js.
    private func mintInstallBlob() async throws -> SignedInstallBlob {
        let irk = try await Keystore.deriveIRK(reason: "Mint installer for \(name)")
        let irkPubHex = HexUtil.encode(irk.publicKey.rawRepresentation)
        let serverNameSlug = SlugUtil.slugify(name)
        let serverDomain = "\(serverNameSlug).\(username).flagship.services"
        let now = Int64(Date().timeIntervalSince1970 * 1000)

        // 1. claim username (idempotent).
        let claimBytes = UsernameClaim.canonicalBytes(
            username: username, irkPubHex: irkPubHex, issuedAt: now
        )
        let claimSig = try irk.signature(for: claimBytes)
        try await server.claimUsername(.init(
            request: .init(username: username, irkPub: irkPubHex, issuedAt: now),
            signature: HexUtil.encode(claimSig)
        ))

        // 2. issue auth-code.
        let delegated = Curve25519.Signing.PrivateKey()
        let acIssuedAt = Int64(Date().timeIntervalSince1970 * 1000)
        let acExpiresAt = acIssuedAt + 60 * 60_000   // 1 hour
        let authCode = AuthCode(
            serial: SerialGen.random(),
            username: username,
            serverName: serverNameSlug,
            serverDomain: serverDomain,
            delegatedPubKey: delegated.publicKey.rawRepresentation,
            userPubKey: irk.publicKey.rawRepresentation,
            issuedAt: acIssuedAt,
            expiresAt: acExpiresAt
        )
        let acSig = try irk.signature(for: authCode.canonicalBytes())
        try await server.issueAuthCode(.init(
            code: .init(
                version: authCode.version,
                serial: authCode.serial,
                username: authCode.username,
                serverName: authCode.serverName,
                serverDomain: authCode.serverDomain,
                delegatedPubKey: HexUtil.encode(authCode.delegatedPubKey),
                userPubKey: HexUtil.encode(authCode.userPubKey),
                issuedAt: authCode.issuedAt,
                expiresAt: authCode.expiresAt
            ),
            signature: HexUtil.encode(acSig)
        ))

        // 3. register RCK.
        let rck = Curve25519.Signing.PrivateKey()
        let rckIssuedAt = Int64(Date().timeIntervalSince1970 * 1000)
        let rckBytes = RckRegister.canonicalBytes(
            username: username,
            subdomain: serverDomain,
            rckPubHex: HexUtil.encode(rck.publicKey.rawRepresentation),
            issuedAt: rckIssuedAt
        )
        let rckSig = try irk.signature(for: rckBytes)
        try await server.registerRck(.init(
            request: .init(
                username: username,
                subdomain: serverDomain,
                rckPubKey: HexUtil.encode(rck.publicKey.rawRepresentation),
                issuedAt: rckIssuedAt
            ),
            signature: HexUtil.encode(rckSig)
        ))

        // 4. Build + sign InstallBlob.
        let blob = InstallBlob(
            serverDomain: serverDomain,
            username: username,
            serverName: serverNameSlug,
            phoneDelegatedPubKey: delegated.publicKey.rawRepresentation,
            authCode: authCode,
            authCodeUserSignature: acSig,
            issuedAt: acIssuedAt,
            expiresAt: acExpiresAt,
            rckPubKey: rck.publicKey.rawRepresentation
        )
        let blobSig = try irk.signature(for: blob.canonicalBytes())
        return SignedInstallBlob(blob: blob, signatureHex: HexUtil.encode(blobSig))
    }
}

/// Bound pair shipped through the relay. `OnWireBlob` is the hex-coded
/// JSON shape the browser side expects (matches `onWireBlob` in
/// create-server.js).
public struct SignedInstallBlob: Sendable {
    public let blob: InstallBlob
    public let signatureHex: String

    public struct OnWire: Codable, Sendable {
        public let blob: OnWireBlob
        public let blobSignature: String
    }
    public struct OnWireBlob: Codable, Sendable {
        public let version: Int
        public let serverDomain: String
        public let username: String
        public let serverName: String
        public let phoneDelegatedPubKey: String
        public let registrationUrl: String
        public let authCode: OnWireAuthCode
        public let authCodeUserSignature: String
        public let issuedAt: Int64
        public let expiresAt: Int64
        public let installerGitRef: String
        public let rckPubKey: String
    }
    public struct OnWireAuthCode: Codable, Sendable {
        public let version: Int
        public let serial: String
        public let username: String
        public let serverName: String
        public let serverDomain: String
        public let delegatedPubKey: String
        public let userPubKey: String
        public let issuedAt: Int64
        public let expiresAt: Int64
    }

    public func onWire() -> OnWire {
        OnWire(
            blob: OnWireBlob(
                version: blob.version,
                serverDomain: blob.serverDomain,
                username: blob.username,
                serverName: blob.serverName,
                phoneDelegatedPubKey: HexUtil.encode(blob.phoneDelegatedPubKey),
                registrationUrl: blob.registrationUrl,
                authCode: OnWireAuthCode(
                    version: blob.authCode.version,
                    serial: blob.authCode.serial,
                    username: blob.authCode.username,
                    serverName: blob.authCode.serverName,
                    serverDomain: blob.authCode.serverDomain,
                    delegatedPubKey: HexUtil.encode(blob.authCode.delegatedPubKey),
                    userPubKey: HexUtil.encode(blob.authCode.userPubKey),
                    issuedAt: blob.authCode.issuedAt,
                    expiresAt: blob.authCode.expiresAt
                ),
                authCodeUserSignature: HexUtil.encode(blob.authCodeUserSignature),
                issuedAt: blob.issuedAt,
                expiresAt: blob.expiresAt,
                installerGitRef: blob.installerGitRef,
                rckPubKey: HexUtil.encode(blob.rckPubKey)
            ),
            blobSignature: signatureHex
        )
    }
}
