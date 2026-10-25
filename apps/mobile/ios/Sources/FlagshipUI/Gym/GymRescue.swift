#if DEBUG
import Foundation
import CryptoKit
import FlagshipAPI
import FlagshipCore

/// Gym-only: Offline control against an in-process box (`-smoke-rescue <scenario>`), so every step
/// of the real view model runs (discovery by the opaque id, the hello and its checks under the
/// pinned key, the signed session and offline orders, the backup and its resumable download) with
/// no network. The box checks what a real one checks that the gym can reach: the session order's
/// signature under the account's admin root, the session nonce and single use of each order.
///
///   found         the box answers Bonjour on this Wi-Fi
///   not-found     nothing answers and nothing was seen before (the manual address is offered)
///   wrong-key     the machine that answers signs with another key (not this server)
///   expired-cert  the box presents an expired certificate (rescue still works, by key)
///   interrupt     the backup download breaks once halfway (Resume finishes it)
///   stranger      the box refuses the session (this device's key isn't the one it pins)
public enum GymRescue {
    public static func scenario() -> String? {
        let args = ProcessInfo.processInfo.arguments
        guard let i = args.firstIndex(of: "-smoke-rescue"), i + 1 < args.count else { return nil }
        return args[i + 1]
    }

    static let stkSeed = Data(repeating: 0x5a, count: 32)
    static let mitmSeed = Data(repeating: 0x6b, count: 32)
    static let ownerSeed = Data(repeating: 9, count: 32)
    static let strangerSeed = Data(repeating: 0x7c, count: 32)

    static func server(_ user: String) -> String { "home.\(user.lowercased()).flagship.services" }

    @MainActor
    public static func environment(username: String) -> OfflineControlEnvironment? {
        guard let s = scenario() else { return nil }
        let domain = server(username)
        let stk = try! Curve25519.Signing.PrivateKey(rawRepresentation: stkSeed)
        let owner = try! Curve25519.Signing.PrivateKey(rawRepresentation: ownerSeed)
        let signer = s == "stranger" ? try! Curve25519.Signing.PrivateKey(rawRepresentation: strangerSeed) : owner
        let box = MockRescueBox(serverDomain: domain, scenario: s, ownerPub: owner.publicKey)
        let stkHex = HexUtil.encode(stk.publicKey.rawRepresentation)
        let book = RescueServerBook.volatile()
        return OfflineControlEnvironment(
            servers: { [(domain, stkHex, [])] },
            pinnedMldsa: { _ in nil },
            strict: { _ in false },
            orderKey: { _ in (signer, .adminRoot) },
            pqSignature: { _, _, _ in nil },
            accountKek: { _ in Data(repeating: 0x33, count: 32) },
            passcodeSlot: { _, _, _ in
                ServerBackupSlot(kind: "passcode", kdf: ServerBackupKdf(m: 64, t: 1, p: 1, saltHex: String(repeating: "01", count: 16)),
                                 nonceHex: String(repeating: "02", count: 12), wrappedHex: String(repeating: "03", count: 48))
            },
            connector: MockRescueConnector(box: box),
            discovery: {
                let id = Rescue.discoveryId(stkPub: stk.publicKey.rawRepresentation, serverDomain: domain)!
                return MockRescueDiscovery(found: s == "not-found" ? [:] : [id: RescueEndpoint(host: "192.168.1.20")])
            },
            book: book)
    }
}

final class MockRescueDiscovery: RescueDiscovery, @unchecked Sendable {
    let found: [String: RescueEndpoint]
    init(found: [String: RescueEndpoint]) { self.found = found }
    func start(onChange: @escaping @Sendable ([String: RescueEndpoint]) -> Void) {
        let f = found
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { onChange(f) }
    }
    func stop() {}
}

/// The box: its STK signs the hello, it spends nonces, pins the owner's key and runs the controls.
final class MockRescueBox: @unchecked Sendable {
    let serverDomain: String
    let scenario: String
    let ownerPub: Curve25519.Signing.PublicKey
    let certSha = String(repeating: "ab", count: 32)
    private let lock = NSLock()
    private var nonces: [String: String] = [:]
    private var sessionNonce: String?
    private var token: String?
    private var spent = Set<String>()
    var apps: [(id: String, name: String, state: String)]
    private var archiveState: String?
    private var polls = 0
    private var bundleFailures = 0
    let bundleBytes: Data

    init(serverDomain: String, scenario: String, ownerPub: Curve25519.Signing.PublicKey) {
        self.serverDomain = serverDomain
        self.scenario = scenario
        self.ownerPub = ownerPub
        let user = serverDomain.split(separator: ".")[1]
        apps = [("\(user)--notes", "Notes", "running"), ("\(user)--chess", "Chess club", "stopped")]
        // Two and a half parts of the downloader's 4 MiB, so the download takes more than one part.
        var b = Data(count: 10 * 1024 * 1024)
        b.withUnsafeMutableBytes { p in for i in 0..<p.count { p[i] = UInt8(truncatingIfNeeded: i &* 31) } }
        bundleBytes = b
    }

    func hello(clientNonce: String) -> (Rescue.Exchange, Data) {
        let boxNonce = Rescue.newNonce()
        let h = Rescue.Exchange(serverDomain: serverDomain, clientNonce: clientNonce, boxNonce: boxNonce, certSha256: certSha,
                                issuedAt: Int64(Date().timeIntervalSince1970 * 1000))
        lock.withLock { nonces[boxNonce] = clientNonce }
        let key = try! Curve25519.Signing.PrivateKey(rawRepresentation: scenario == "wrong-key" ? GymRescue.mitmSeed : GymRescue.stkSeed)
        return (h, try! key.signature(for: try! h.helloCanonical()))
    }

    func session(order: Rescue.Exchange, signatureHex: String) throws -> String {
        let issued = lock.withLock { nonces.removeValue(forKey: order.boxNonce) }
        guard issued == order.clientNonce, order.certSha256 == certSha,
              let sig = HexUtil.decode(signatureHex), ownerPub.isValidSignature(sig, for: try order.sessionCanonical())
        else {
            throw RescueTransportError.box(status: 403, message: "the rescue session was refused: not signed by this server's owner key, or not with the post-quantum signature this server requires", code: "rescue-refused")
        }
        let t = Rescue.newNonce() + Rescue.newNonce()
        lock.withLock { token = t; sessionNonce = order.boxNonce }
        return t
    }

    func snapshot() -> RescueServerSnapshot {
        lock.withLock {
            RescueServerSnapshot(serverDomain: serverDomain, apps: apps.map { RescueServerApp(serviceId: $0.id, name: $0.name, state: $0.state) },
                                 status: RescueServerStatus(version: "0.3.0", startedAt: Int64(Date().timeIntervalSince1970 * 1000) - 3 * 86_400_000,
                                                            certValidUntil: scenario == "expired-cert" ? Int64(Date().timeIntervalSince1970 * 1000) - 86_400_000 : nil,
                                                            diskUsedBytes: 41 * 1_073_741_824, diskTotalBytes: 256 * 1_073_741_824),
                                 controls: OfflineControlOrder.Action.allCases.map(\.rawValue),
                                 sessionNonce: sessionNonce, sessionEndsAt: Int64(Date().timeIntervalSince1970 * 1000) + 3_600_000)
        }
    }

    func control(order: OfflineControlOrder, signatureHex: String) throws {
        guard order.sessionNonce == lock.withLock({ sessionNonce }) else {
            throw RescueTransportError.box(status: 403, message: "the order was refused: signed for another session", code: "offline-order-refused")
        }
        let fresh = lock.withLock { spent.insert(order.nonce).inserted }
        guard fresh else { throw RescueTransportError.box(status: 403, message: "the order was refused: already used", code: "offline-order-refused") }
        guard let sig = HexUtil.decode(signatureHex), ownerPub.isValidSignature(sig, for: try order.canonicalBytes()) else {
            throw RescueTransportError.box(status: 403, message: "the order was refused: not signed by this server's owner key", code: "offline-order-refused")
        }
        lock.withLock {
            guard let i = apps.firstIndex(where: { $0.id == order.target }) else { return }
            switch order.action {
            case "app-stop": apps[i].state = "stopped"
            case "app-start", "app-restart": apps[i].state = "running"
            default: break
            }
        }
    }

    func archiveStart() { lock.withLock { archiveState = "building"; polls = 0 } }

    func archiveStatus() -> ServerArchiveStatus? {
        lock.withLock {
            guard let st = archiveState else { return nil }
            polls += 1
            if st == "building" && polls >= 3 { archiveState = "ready" }
            let sha = SHA256.hash(data: bundleBytes).map { String(format: "%02x", $0) }.joined()
            return ServerArchiveStatus(archiveId: String(repeating: "0a", count: 16), state: archiveState!, startedAt: 1_792_000_000_000,
                                       progress: ServerArchiveProgress(done: min(polls, 2), total: 2, app: "Notes"),
                                       bundleFileName: "home-2026-10-25.flagship", bundleBytes: Int64(bundleBytes.count), bundleSha256: sha)
        }
    }

    func bundle(offset: Int64) throws -> Data {
        if scenario == "interrupt", offset >= Int64(bundleBytes.count / 2) {
            let fail = lock.withLock { () -> Bool in bundleFailures += 1; return bundleFailures == 1 }
            if fail { throw RescueTransportError.unreachable }
        }
        let end = min(Int(offset) + Int(ArchiveDownloader.chunkBytes), bundleBytes.count)
        return bundleBytes.subdata(in: Int(offset)..<end)
    }

    func forget() { lock.withLock { archiveState = nil } }
}

final class MockRescueConnection: RescueConnection, @unchecked Sendable {
    let box: MockRescueBox
    init(box: MockRescueBox) { self.box = box }
    private func pause() async { try? await Task.sleep(nanoseconds: 150_000_000) }

    func hello(clientNonce: String) async throws -> RescueHelloReply {
        await pause()
        let (h, sig) = box.hello(clientNonce: clientNonce)
        return RescueHelloReply(hello: h, signature: sig, pqSignature: nil, seenCertSha256: box.certSha, certificateTrusted: box.scenario != "expired-cert")
    }
    func pin(certSha256: String) {}
    func openSession(order: Rescue.Exchange, signatureHex: String, pqSignature: PqSignatureWire?) async throws -> Int64 {
        await pause()
        _ = try box.session(order: order, signatureHex: signatureHex)
        return 0
    }
    func server() async throws -> RescueServerSnapshot { box.snapshot() }
    func control(order: OfflineControlOrder, signatureHex: String, pqSignature: PqSignatureWire?) async throws {
        await pause()
        try box.control(order: order, signatureHex: signatureHex)
    }
    func archiveStart(_ req: ServerArchiveStartRequest) async throws { box.archiveStart() }
    func archiveStatus() async throws -> ServerArchiveStatus? { await pause(); return box.archiveStatus() }
    func bundle(offset: Int64) async throws -> Data { await pause(); return try box.bundle(offset: offset) }
    func archiveForget() async throws { box.forget() }
    func close() {}
}

struct MockRescueConnector: RescueConnector {
    let box: MockRescueBox
    func connect(endpoint: RescueEndpoint, serverDomain: String) -> RescueConnection { MockRescueConnection(box: box) }
}
#endif
