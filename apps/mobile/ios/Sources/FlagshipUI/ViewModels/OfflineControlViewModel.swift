import Foundation
import Observation
import CryptoKit
import Flagship
import FlagshipAPI
import FlagshipCore

/// What Offline control needs from the device: everything local, nothing from `.com`
/// (docs/data-sovereignty.md 4.1, 4.9).
public struct OfflineControlEnvironment: Sendable {
    /// The servers this device knows by name and pinned key.
    public var servers: @Sendable () -> [(domain: String, stkHex: String?, lan: [String])]
    /// The ML-DSA key the server's STK vouched for, if this device pinned one.
    public var pinnedMldsa: @Sendable (String) -> String?
    /// Whether this device holds the server's installation policy as strict.
    public var strict: @Sendable (String) -> Bool
    /// The sensitive-order key: the admin root where this device holds it, else the account key (IRK).
    public var orderKey: @Sendable (_ reason: String) async throws -> (key: Curve25519.Signing.PrivateKey, role: PqBindingRole)
    /// The hybrid half by the same key, where this device holds its ML-DSA key.
    public var pqSignature: @Sendable (_ canonical: Data, _ key: Curve25519.Signing.PrivateKey, _ role: PqBindingRole) async -> PqSignatureWire?
    /// The account slot's key for a backup (opens it in this account without the passcode).
    public var accountKek: @Sendable (_ archiveId: String) async throws -> Data
    public var passcodeSlot: @Sendable (_ archiveId: String, _ contentKey: Data, _ passcode: String) async throws -> ServerBackupSlot
    public var connector: RescueConnector
    public var discovery: @Sendable () -> RescueDiscovery
    public var book: RescueServerBook
    public var now: @Sendable () -> Int64

    public init(servers: @escaping @Sendable () -> [(domain: String, stkHex: String?, lan: [String])],
                pinnedMldsa: @escaping @Sendable (String) -> String?, strict: @escaping @Sendable (String) -> Bool,
                orderKey: @escaping @Sendable (String) async throws -> (key: Curve25519.Signing.PrivateKey, role: PqBindingRole),
                pqSignature: @escaping @Sendable (Data, Curve25519.Signing.PrivateKey, PqBindingRole) async -> PqSignatureWire?,
                accountKek: @escaping @Sendable (String) async throws -> Data,
                passcodeSlot: @escaping @Sendable (String, Data, String) async throws -> ServerBackupSlot,
                connector: RescueConnector, discovery: @escaping @Sendable () -> RescueDiscovery, book: RescueServerBook,
                now: @escaping @Sendable () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }) {
        self.servers = servers; self.pinnedMldsa = pinnedMldsa; self.strict = strict; self.orderKey = orderKey
        self.pqSignature = pqSignature; self.accountKek = accountKek; self.passcodeSlot = passcodeSlot
        self.connector = connector; self.discovery = discovery; self.book = book; self.now = now
    }

    /// The device's own keys, pins and network.
    @MainActor
    public static func live(username: String) -> OfflineControlEnvironment {
        #if DEBUG
        if let gym = GymRescue.environment(username: username) { return gym }
        #endif
        let user = username.lowercased()
        return OfflineControlEnvironment(
            servers: {
                let pins = ServerKeyPins()
                let book = RescueServerBook.shared
                let names = Set(pins.domains()).union(book.entries().map(\.domain))
                return names.sorted().map { ($0, pins.pinnedStkHex($0), book.entry($0)?.lan ?? []) }
            },
            pinnedMldsa: { ServerKeyPins().record($0)?.mldsa },
            strict: { QuantumSafetyService.isStrict(username: user, serverDomain: $0) },
            orderKey: { reason in
                if Keystore.hasAdminRoot { return (try await Keystore.adminRootKey(reason: reason), .adminRoot) }
                return (try await Keystore.deriveIRK(reason: reason), .accountIrk)
            },
            pqSignature: { canonical, key, role in
                await QuantumSafetyService.pqSignature(canonical: canonical, edKey: key, role: role, username: user)
            },
            accountKek: { id in try await Keystore.deriveServerArchiveKey(archiveId: id, reason: String(localized: "Protect this backup with your account key")) },
            passcodeSlot: { id, key, passcode in
                try await Task.detached(priority: .userInitiated) { try ServerBackupPasscode.slot(archiveId: id, contentKey: key, passcode: passcode) }.value
            },
            connector: LiveRescueConnector(),
            discovery: { BonjourRescueDiscovery() },
            book: .shared)
    }
}

/// Settings → Offline control, the server page when the server can't be reached, and the
/// account-gone screen's "Save my servers' data" (docs/data-sovereignty.md): find the server on
/// this Wi-Fi, prove it by its key, open a session with an owner-signed order, then see its status
/// and apps, start/stop/restart an app, restart or shut it down, and make and download a backup.
/// Every action is its own signed order the server checks itself. No `.com`, no relay.
@Observable
@MainActor
public final class OfflineControlViewModel {
    public struct ServerRow: Identifiable, Equatable {
        public let domain: String
        public let pinned: Bool
        /// Where Bonjour found it on this network just now, if it did.
        public var found: RescueEndpoint?
        /// Where it was last seen (a hint).
        public var lastSeen: [String]
        public var id: String { domain }
        public var label: String { domain.split(separator: ".").first.map(String.init) ?? domain }
    }

    public enum Phase: Equatable {
        case list
        case connecting(String)
        case connected
        case failed(String)
    }

    public enum BackupPhase: Equatable {
        case idle
        case passcode
        case building(label: String, fraction: Double)
        case downloading(fraction: Double)
        /// The download stopped: the parts already in are kept for Resume.
        case interrupted(fraction: Double, message: String)
        case saved(URL)
        case failed(String)
    }

    public private(set) var servers: [ServerRow] = []
    public private(set) var phase: Phase = .list
    public private(set) var snapshot: RescueServerSnapshot?
    /// The server this session is open on.
    public private(set) var serverDomain: String?
    /// The certificate failed ordinary web checks (expired, or for a name that no longer resolves).
    public private(set) var certificateNote: String?
    public private(set) var busy: String?
    public private(set) var notice: String?
    public private(set) var actionError: String?
    public private(set) var backup: BackupPhase = .idle
    public private(set) var searching = false

    public let suggestedPasscode: String
    public var useOwnPasscode = false
    public var ownPasscode = ""
    public var ownPasscodeAgain = ""
    public var passcodeSaved = false
    public var manualName = ""
    public var manualAddress = ""

    private let username: String
    private let env: OfflineControlEnvironment
    private let focus: String?
    private var connection: RescueConnection?
    private var discovery: RescueDiscovery?
    private var discovered: [String: RescueEndpoint] = [:]
    private var archive: ServerArchiveStatus?
    private let directory: URL
    private let pollNs: UInt64

    public init(username: String, focus: String? = nil, env: OfflineControlEnvironment,
                suggestedPasscode: String = ServerBackupFormat.generatePasscode(), pollNs: UInt64 = 1_500_000_000,
                directory: URL = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("rescue-backups", isDirectory: true)) {
        self.username = username
        self.focus = focus?.lowercased()
        self.env = env
        self.suggestedPasscode = suggestedPasscode
        self.pollNs = pollNs
        self.directory = directory
    }

    // MARK: finding

    public func start() {
        servers = env.servers()
            .filter { focus == nil || $0.domain == focus }
            .map { ServerRow(domain: $0.domain, pinned: $0.stkHex != nil, found: nil, lastSeen: $0.lan) }
        guard discovery == nil else { return }
        searching = true
        let d = env.discovery()
        discovery = d
        d.start { [weak self] found in Task { @MainActor in self?.apply(found) } }
    }

    public func stop() {
        discovery?.stop()
        discovery = nil
        searching = false
        connection?.close()
        connection = nil
    }

    private func apply(_ found: [String: RescueEndpoint]) {
        discovered = found
        let pins = env.servers()
        for i in servers.indices {
            guard let stk = pins.first(where: { $0.domain == servers[i].domain })?.stkHex.flatMap({ HexUtil.decode($0) }),
                  let id = Rescue.discoveryId(stkPub: stk, serverDomain: servers[i].domain) else { continue }
            servers[i].found = found[id]
        }
    }

    // MARK: connecting

    /// Connect to `domain`: where Bonjour found it, else where it was last seen, else `address`.
    public func connect(_ domain: String, address: String? = nil) async {
        let d = domain.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        actionError = nil
        notice = nil
        guard let stkHex = env.servers().first(where: { $0.domain == d })?.stkHex, let stk = HexUtil.decode(stkHex), stk.count == 32 else {
            phase = .failed(String(localized: "This phone has never confirmed \(d)'s own key, so it can't check that the server it finds is really yours. Open it once from Home while Flagship can be reached."))
            return
        }
        var endpoints: [RescueEndpoint] = []
        if let a = address.flatMap(Self.endpoint) { endpoints.append(a) }
        if let f = servers.first(where: { $0.domain == d })?.found { endpoints.append(f) }
        for s in env.servers().first(where: { $0.domain == d })?.lan ?? [] { if let e = Self.endpoint(s) { endpoints.append(e) } }
        var seen = Set<RescueEndpoint>()
        endpoints = endpoints.filter { seen.insert($0).inserted }
        guard !endpoints.isEmpty else {
            phase = .failed(String(localized: "\(d) wasn't found on this Wi-Fi. Check that this phone is on the same network as the server, or enter its address."))
            return
        }
        phase = .connecting(d)
        var last = String(localized: "\(d) didn't answer on this network. Check that this phone is on the same Wi-Fi as the server, or enter its address.")
        for e in endpoints {
            let conn = env.connector.connect(endpoint: e, serverDomain: d)
            do {
                try await openSession(conn, domain: d, stk: stk, stkHex: stkHex, endpoint: e)
                return
            } catch RescueTransportError.unreachable {
                conn.close()
                continue
            } catch let e as RefusedHere {
                conn.close()
                last = e.message
                break
            } catch {
                conn.close()
                last = Self.message(error)
                break
            }
        }
        phase = .failed(last)
    }

    private struct RefusedHere: Error { let message: String }

    private func openSession(_ conn: RescueConnection, domain: String, stk: Data, stkHex: String, endpoint: RescueEndpoint) async throws {
        let clientNonce = Rescue.newNonce()
        let reply = try await conn.hello(clientNonce: clientNonce)
        if let why = Rescue.checkHello(reply.hello, signature: reply.signature, stkPub: stk, serverDomain: domain, clientNonce: clientNonce,
                                       seenCertSha256: reply.seenCertSha256, now: env.now()) {
            throw RefusedHere(message: Self.helloRefusal(why, domain: domain))
        }
        if let why = Rescue.checkHelloPq(reply.hello, pqSignature: reply.pqSignature, stkHex: stkHex, pinnedMldsaHex: env.pinnedMldsa(domain),
                                         strict: env.strict(domain)) {
            throw RefusedHere(message: Self.pqRefusal(why))
        }
        // From here on, only a connection that presents this very certificate is accepted.
        conn.pin(certSha256: reply.seenCertSha256)
        let order = Rescue.Exchange(serverDomain: reply.hello.serverDomain, clientNonce: clientNonce, boxNonce: reply.hello.boxNonce,
                                    certSha256: reply.hello.certSha256, issuedAt: env.now())
        let canonical = try order.sessionCanonical()
        let (key, role) = try await env.orderKey(String(localized: "Connect to \(domain) on this network"))
        let sig = try key.signature(for: canonical)
        let pq = await env.pqSignature(canonical, key, role)
        _ = try await conn.openSession(order: order, signatureHex: HexUtil.encode(sig), pqSignature: pq)
        let s = try await conn.server()
        connection = conn
        snapshot = s
        serverDomain = domain
        certificateNote = reply.certificateTrusted ? nil
            : String(localized: "This server's web certificate isn't valid any more (it expired, or its name no longer resolves). This phone checked the server by its own key instead.")
        env.book.saw(domain, at: endpoint.host.contains(":") ? "[\(endpoint.host)]:\(endpoint.port)" : "\(endpoint.host):\(endpoint.port)")
        phase = .connected
    }

    public func disconnect() {
        connection?.close()
        connection = nil
        snapshot = nil
        serverDomain = nil
        backup = .idle
        phase = .list
    }

    public func refresh() async {
        guard let conn = connection else { return }
        do { snapshot = try await conn.server() } catch { actionError = Self.message(error) }
    }

    // MARK: controls

    public var offersControls: Bool { !(snapshot?.controls ?? []).isEmpty }

    /// Sign and send one offline action. `serviceId` for an app action.
    public func perform(_ action: OfflineControlOrder.Action, serviceId: String? = nil) async {
        guard let conn = connection, let domain = serverDomain, let sessionNonce = snapshot?.sessionNonce else { return }
        actionError = nil
        notice = nil
        let target = action.isServerAction ? domain : (serviceId ?? "")
        let name = snapshot?.apps.first { $0.serviceId == target }?.name ?? target
        busy = target + "|" + action.rawValue
        defer { busy = nil }
        do {
            let order = OfflineControlOrder(serverDomain: domain, sessionNonce: sessionNonce, action: action, target: target, issuedAt: env.now())
            let canonical = try order.canonicalBytes()
            let (key, role) = try await env.orderKey(Self.reason(action, name: name, server: domain))
            let sig = try key.signature(for: canonical)
            let pq = await env.pqSignature(canonical, key, role)
            try await conn.control(order: order, signatureHex: HexUtil.encode(sig), pqSignature: pq)
            notice = Self.done(action, name: name)
            if action.isServerAction {
                // The server goes down a moment after it answers: this session ends with it.
                connection?.close()
                connection = nil
                snapshot = nil
                phase = .list
            } else {
                await refresh()
            }
        } catch {
            actionError = Self.message(error)
        }
    }

    // MARK: backup ("Rescue my data")

    public var chosenPasscode: String? {
        guard useOwnPasscode else { return suggestedPasscode }
        guard ServerBackupFormat.passcodeProblem(ownPasscode) == nil, ownPasscode == ownPasscodeAgain else { return nil }
        return ownPasscode
    }

    public var ownPasscodeHint: String? {
        guard useOwnPasscode else { return nil }
        if ownPasscode.isEmpty { return String(localized: "At least 12 characters with three kinds (lowercase, uppercase, digits, symbols), or 20 of anything.") }
        if let p = ServerBackupFormat.passcodeProblem(ownPasscode) { return p }
        if !ownPasscodeAgain.isEmpty && ownPasscodeAgain != ownPasscode { return String(localized: "The two don't match.") }
        return nil
    }

    public var canStartBackup: Bool { backup == .passcode && chosenPasscode != nil && passcodeSaved }

    public func askPasscode() { backup = .passcode }

    public func startBackup() async {
        guard canStartBackup, let passcode = chosenPasscode, let conn = connection else { return }
        backup = .building(label: String(localized: "Protecting the backup with its passcode…"), fraction: 0)
        do {
            let id = ServerArchive.newArchiveId()
            var contentKey = ServerBackupFormat.randomBytes(32)
            defer { contentKey.resetBytes(in: 0..<contentKey.count) }
            let account = try ServerBackupFormat.wrapAccountSlot(archiveId: id, contentKey: contentKey, kek: try await env.accountKek(id),
                                                                 nonce: ServerBackupFormat.randomBytes(12))
            let pass = try await env.passcodeSlot(id, contentKey, passcode)
            try await conn.archiveStart(ServerArchiveStartRequest(archiveId: id, key: HexUtil.encode(contentKey), slots: [pass, account]))
            while true {
                guard let s = try await conn.archiveStatus() else { throw BackupGone() }
                if s.state == "failed" { throw BackupFailed(reason: s.reason ?? String(localized: "the backup couldn't be made")) }
                if s.state == "ready" { archive = s; break }
                let p = s.progress
                let total = max(p?.total ?? 0, 0)
                backup = .building(
                    label: total > 0 ? String(localized: "Backing up \(p?.app ?? "apps") (\(min((p?.done ?? 0) + 1, total)) of \(total))…") : String(localized: "Making the backup…"),
                    fraction: total > 0 ? Double(p?.done ?? 0) / Double(total) : 0)
                try await Task.sleep(nanoseconds: pollNs)
            }
        } catch {
            backup = .failed(Self.message(error))
            return
        }
        await download()
    }

    /// Download the one `.flagship` file: 4 MiB parts, several at once, resuming where an
    /// interrupted download stopped, checked against the server's SHA-256.
    public func download() async {
        guard let conn = connection, let s = archive, let domain = serverDomain else { return }
        let total = s.bundleBytes ?? 0
        guard total > 0 else {
            backup = .failed(String(localized: "This server's release can't hand out the backup as one file yet."))
            return
        }
        let stem = ServerArchive.fileStem(sourceServer: domain, createdAt: Date(timeIntervalSince1970: Double(s.startedAt) / 1000))
        let name = s.bundleFileName ?? "\(stem).\(ServerBackupBundle.fileExtension)"
        let dir = directory.appendingPathComponent(s.archiveId, isDirectory: true)
        backup = .downloading(fraction: 0)
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            let part = dir.appendingPathComponent("\(name).part")
            try await ArchiveDownloader.download(
                total: total, sha256: s.bundleSha256, to: part, stateFile: dir.appendingPathComponent("\(name).part.json"),
                fetch: { offset in try await conn.bundle(offset: offset) },
                progress: { [weak self] received in
                    await MainActor.run {
                        guard let self, case .downloading = self.backup else { return }
                        self.backup = .downloading(fraction: Double(received) / Double(total))
                    }
                })
            let out = dir.appendingPathComponent(name)
            try? FileManager.default.removeItem(at: out)
            try FileManager.default.moveItem(at: part, to: out)
            try? await conn.archiveForget()
            backup = .saved(out)
        } catch let e as ArchiveDownloader.DownloadError where e == .damaged {
            backup = .failed(e.errorDescription ?? String(localized: "The download didn't finish."))
        } catch {
            var got = 0.0
            if case let .downloading(f) = backup { got = f }
            backup = .interrupted(fraction: got,
                                  message: String(localized: "The download stopped: \(Self.message(error)) What's already here is kept; Resume picks up from there."))
        }
    }

    // MARK: manual

    public var canConnectManually: Bool {
        !manualName.trimmingCharacters(in: .whitespaces).isEmpty && Self.endpoint(manualAddress) != nil
    }

    public func connectManually() async {
        await connect(manualName, address: manualAddress)
    }

    // MARK: words

    static func endpoint(_ s: String) -> RescueEndpoint? {
        let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty, t.count <= 64 else { return nil }
        if t.hasPrefix("["), let close = t.firstIndex(of: "]") {
            let host = String(t[t.index(after: t.startIndex)..<close])
            let rest = t[t.index(after: close)...]
            let port = rest.hasPrefix(":") ? Int(rest.dropFirst()) : 443
            return port.map { RescueEndpoint(host: host, port: $0) }
        }
        let parts = t.split(separator: ":")
        if parts.count == 2, let p = Int(parts[1]), (1...65535).contains(p) { return RescueEndpoint(host: String(parts[0]), port: p) }
        if parts.count == 1 { return RescueEndpoint(host: t, port: 443) }
        return RescueEndpoint(host: t, port: 443)
    }

    static func helloRefusal(_ why: String, domain: String) -> String {
        switch why {
        case "bad-signature": return String(localized: "This isn't your server: what answered couldn't prove it holds the key of \(domain). Nothing was sent to it.")
        case "cert-mismatch": return String(localized: "Something between this phone and the server is changing the connection, so this phone stopped. Nothing was sent to it.")
        case "wrong-server": return String(localized: "Another server answered at that address.")
        case "expired", "not-yet-valid": return String(localized: "The server's clock and this phone's are more than two minutes apart. Check the time on both and try again.")
        default: return String(localized: "The server's answer didn't match this phone's question. Try again.")
        }
    }

    static func pqRefusal(_ why: String) -> String {
        switch why {
        case "strict-requires-hybrid", "strict-requires-binding":
            return String(localized: "This server is set to post-quantum checks only, and it didn't prove itself that way. Nothing was sent to it.")
        default:
            return String(localized: "The server's post-quantum signature didn't check out, so this phone stopped. Nothing was sent to it.")
        }
    }

    static func reason(_ a: OfflineControlOrder.Action, name: String, server: String) -> String {
        switch a {
        case .appStart: return String(localized: "Start \(name)")
        case .appStop: return String(localized: "Stop \(name)")
        case .appRestart: return String(localized: "Restart \(name)")
        case .serverRestart: return String(localized: "Restart \(server)")
        case .serverShutdown: return String(localized: "Shut down \(server)")
        }
    }

    static func done(_ a: OfflineControlOrder.Action, name: String) -> String {
        switch a {
        case .appStart: return String(localized: "\(name) was started.")
        case .appStop: return String(localized: "\(name) was stopped. It starts again when you start it here, or when the server restarts.")
        case .appRestart: return String(localized: "\(name) was restarted.")
        case .serverRestart: return String(localized: "The server is restarting. To unlock its disk it needs Flagship, so while Flagship can't be reached it stays locked after the restart.")
        case .serverShutdown: return String(localized: "The server is shutting down.")
        }
    }

    private struct BackupGone: Error, LocalizedError { var errorDescription: String? { String(localized: "The backup disappeared from the server.") } }
    private struct BackupFailed: Error, LocalizedError { let reason: String; var errorDescription: String? { String(localized: "The backup failed: \(reason).") } }

    static func message(_ error: Error) -> String {
        if let e = error as? RescueTransportError { return e.errorDescription ?? String(localized: "That didn't work.") }
        if let e = error as? LocalizedError, let d = e.errorDescription { return d }
        return HumanError.humanize(error)
    }
}
