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

    private let clients: PodScreensClientFactory
    private let relay: any QrRelayClient
    private let username: String
    private let authenticate: @MainActor @Sendable (String) async throws -> Void
    private let confirmGateNanos: UInt64
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
        confirmGateNanos: UInt64 = 600_000_000
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
    }

    public var selectedServer: ServerChoice? {
        servers.first { $0.fqdn == selectedFqdn }
    }

    public static func isRemoteLink(_ raw: String) -> Bool {
        RemoteApprovalLink.parse(raw) != nil
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

    /// A remote code was scanned or pasted: join its relay session and show
    /// the match code.
    public func begin(link raw: String) async {
        guard let qr = RemoteApprovalLink.parse(raw) else {
            phase = .failed(String(localized: "This isn't a Flagship remote code. Open \(Endpoints.remoteHost) on your computer and scan the code it shows."))
            return
        }
        await relay.close()
        session += 1
        let mine = session
        aeadKey = nil
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
