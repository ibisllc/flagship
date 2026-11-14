import Foundation
import Observation
import CryptoKit
import Flagship
import FlagshipAPI
import FlagshipCore

/// Backs the phone side of the remote ceremony. The computer's remote page
/// shows `https://flagshipserver.com/remote?s=&k=`; the phone joins that QR-relay session,
/// both screens show the same code, and on approval the phone mints a
/// single-use companion ticket on the server the owner picked and seals it to
/// the browser, which redeems it on that server.
///
/// The Flagship browser extension pairs the same way from
/// `https://flagshipserver.com/pair-extension?s=&k=`: the phone mints an extension
/// ticket and seals it with the server key this phone pinned, so the extension can
/// check the box's signed certificate fingerprint itself.
@MainActor
@Observable
public final class CompanionDockViewModel {
    public struct ServerChoice: Identifiable, Equatable, Sendable {
        public let fqdn: String
        public let name: String
        public let online: Bool
        public var id: String { fqdn }

        public init(fqdn: String, name: String, online: Bool) {
            self.fqdn = fqdn.lowercased()
            self.name = name
            self.online = online
        }
    }

    /// Which code was scanned: a Remote browser or the browser extension.
    public enum Mode: Equatable, Sendable {
        case remote
        case browserExtension
    }

    public enum ApprovalPhase: Equatable, Sendable {
        case idle
        case connecting
        case matching(matchCode: String, gateExpired: Bool)
        case approving
        case connected(serverName: String)
        case failed(String)
    }

    public private(set) var state: LoadingState<CompanionListResponse> = .idle
    public private(set) var phase: ApprovalPhase = .idle
    public private(set) var revokePending: Set<String> = []
    public let servers: [ServerChoice]
    public private(set) var selectedFqdn: String?
    public private(set) var mode: Mode = .remote

    private let clients: PodScreensClientFactory
    private let relay: any QrRelayClient
    private let username: String
    private let authenticate: @MainActor @Sendable (String) async throws -> Void
    private let confirmGateNanos: UInt64
    private let pinnedStk: @Sendable (String) -> Data?
    private var aeadKey: SymmetricKey?
    private var session = 0

    public init(
        clients: PodScreensClientFactory,
        relay: any QrRelayClient,
        servers: [ServerChoice],
        defaultFqdn: String?,
        username: String,
        authenticate: @escaping @MainActor @Sendable (String) async throws -> Void = { reason in
            try await BiometricGate().evaluate(reason: reason)
        },
        confirmGateNanos: UInt64 = 600_000_000,
        pinnedStk: @escaping @Sendable (String) -> Data? = { CertPinRegistry.shared.stkPub(forDomain: $0) }
    ) {
        let ordered = servers.enumerated()
            .sorted { ($0.element.online ? 0 : 1, $0.offset) < ($1.element.online ? 0 : 1, $1.offset) }
            .map(\.element)
        self.servers = ordered
        let wanted = defaultFqdn?.lowercased()
        self.selectedFqdn = ordered.first(where: { $0.fqdn == wanted })?.fqdn ?? ordered.first?.fqdn
        self.clients = clients
        self.relay = relay
        self.username = username
        self.authenticate = authenticate
        self.confirmGateNanos = confirmGateNanos
        self.pinnedStk = pinnedStk
    }

    public var selectedServer: ServerChoice? {
        servers.first { $0.fqdn == selectedFqdn }
    }

    public static func isRemoteLink(_ raw: String) -> Bool {
        RemoteApprovalLink.parse(raw) != nil
    }

    public static func isExtensionLink(_ raw: String) -> Bool {
        ExtensionPairLink.parse(raw) != nil
    }

    /// A connected companion's row title: the extension by name, a Remote
    /// browser by its session prefix.
    public static func label(for companion: CompanionSummary) -> String {
        if companion.isExtension { return String(localized: "Firefox extension") }
        return String(localized: "Session \(companion.tokenPrefix)")
    }

    /// A code this screen can take: Remote's or the browser extension's.
    public static func isApprovalLink(_ raw: String) -> Bool {
        isRemoteLink(raw) || isExtensionLink(raw)
    }

    public func select(fqdn: String) async {
        guard servers.contains(where: { $0.fqdn == fqdn }), fqdn != selectedFqdn else { return }
        selectedFqdn = fqdn
        await load()
    }

    public func load() async {
        guard let fqdn = selectedFqdn else {
            state = .failed(String(localized: "No server to connect a browser to."))
            return
        }
        state = .loading
        do {
            let client = await clients.client(forFqdn: fqdn)
            state = .loaded(try await client.companionList())
        } catch {
            state = .failed(UserErrorText.of(error))
        }
    }

    /// A remote or browser-extension code was scanned or pasted: join its relay
    /// session and show the match code.
    public func begin(link raw: String) async {
        let qr: QrRelay.QrSession
        let linkMode: Mode
        if let remote = RemoteApprovalLink.parse(raw) {
            qr = remote
            linkMode = .remote
        } else if let ext = ExtensionPairLink.parse(raw) {
            qr = ext
            linkMode = .browserExtension
        } else {
            phase = .failed(String(localized: "This isn't a Flagship remote code. Open \(Endpoints.remoteHost) on your computer and scan the code it shows."))
            return
        }
        await relay.close()
        session += 1
        let mine = session
        aeadKey = nil
        mode = linkMode
        phase = .connecting
        do {
            let sk = Curve25519.KeyAgreement.PrivateKey()
            let derived = try QrRelay.deriveMaterial(phonePrivateKey: sk, browserPublicKey: qr.browserPublicKey)
            try await relay.openAndHello(sid: qr.sid, phonePkBase64Url: Base64URL.encode(sk.publicKey.rawRepresentation))
            guard mine == session else { return }
            aeadKey = derived.aeadKey
            phase = .matching(matchCode: derived.matchCode, gateExpired: false)
            try? await Task.sleep(nanoseconds: confirmGateNanos)
            if mine == session, case .matching(let code, false) = phase {
                phase = .matching(matchCode: code, gateExpired: true)
            }
        } catch {
            guard mine == session else { return }
            phase = .failed(UserErrorText.of(error))
            await relay.close()
        }
    }

    public func approve() async {
        guard case .matching(_, true) = phase, let key = aeadKey, let server = selectedServer else { return }
        if mode == .browserExtension {
            await approveExtension(key: key, server: server)
            return
        }
        let mine = session
        phase = .approving
        do {
            try await authenticate(String(localized: "Let this browser into your Flagship server"))
            let client = await clients.client(forFqdn: server.fqdn)
            let ticket = try await client.companionMintTicket(CompanionMintTicketRequest())
            let payload = RemoteTicketPayload(
                ticketId: ticket.ticketId,
                ticketSecret: ticket.ticketSecret,
                podBaseUrl: CompanionTicketURL.podBaseUrl(forFqdn: server.fqdn),
                username: username
            )
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.sortedKeys]
            let sealed = try QrRelay.seal(payload: try encoder.encode(payload), with: key)
            try await relay.deliver(ciphertextBase64Url: sealed.ciphertextBase64Url, nonceBase64Url: sealed.nonceBase64Url)
            guard mine == session else { return }
            aeadKey = nil
            phase = .connected(serverName: server.name)
            await relay.close()
            await load()
        } catch {
            guard mine == session else { return }
            aeadKey = nil
            phase = .failed(UserErrorText.of(error))
            await relay.close()
        }
    }

    private struct ExtensionRefusal: Error {
        let sentence: String
    }

    private func approveExtension(key: SymmetricKey, server: ServerChoice) async {
        let mine = session
        phase = .approving
        do {
            try await authenticate(String(localized: "Let this browser extension check your server's certificate"))
            // Only the key this phone pinned: never one `.com` or the box reports.
            guard let stk = pinnedStk(server.fqdn), stk.count == 32 else {
                throw ExtensionRefusal(sentence: String(localized: "This phone hasn't checked this server's code yet. Approve the server on this phone first."))
            }
            let needsUpdate = String(localized: "This server needs an update before it can pair a browser extension.")
            let client = await clients.client(forFqdn: server.fqdn)
            let ticket: CompanionMintExtensionTicketResponse
            do {
                ticket = try await client.companionMintExtensionTicket()
            } catch ScreensClientError.http(status: 404, _), ScreensClientError.notImplemented {
                throw ExtensionRefusal(sentence: needsUpdate)
            }
            guard ticket.scope == "extension" else { throw ExtensionRefusal(sentence: needsUpdate) }
            let payload = ExtensionPairPayload(
                serverDomain: server.fqdn,
                stkPub: stk,
                ticketId: ticket.ticketId,
                ticketSecret: ticket.ticketSecret,
                username: username
            )
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
            let sealed = try QrRelay.seal(payload: try encoder.encode(payload), with: key)
            try await relay.deliver(ciphertextBase64Url: sealed.ciphertextBase64Url, nonceBase64Url: sealed.nonceBase64Url)
            guard mine == session else { return }
            aeadKey = nil
            phase = .connected(serverName: server.name)
            await relay.close()
            await load()
        } catch {
            guard mine == session else { return }
            aeadKey = nil
            phase = .failed((error as? ExtensionRefusal)?.sentence ?? UserErrorText.of(error))
            await relay.close()
        }
    }

    public func cancel() async {
        session += 1
        aeadKey = nil
        phase = .idle
        await relay.close()
    }

    public func revoke(tokenPrefix: String) async {
        guard let fqdn = selectedFqdn else { return }
        revokePending.insert(tokenPrefix)
        defer { revokePending.remove(tokenPrefix) }
        do {
            let client = await clients.client(forFqdn: fqdn)
            _ = try await client.companionRevoke(CompanionRevokeRequest(tokenPrefix: tokenPrefix))
            if case .loaded(let list) = state {
                state = .loaded(
                    CompanionListResponse(
                        companions: list.companions.filter { $0.tokenPrefix != tokenPrefix }
                    )
                )
            }
        } catch {
            state = .failed(UserErrorText.of(error))
        }
    }
}
