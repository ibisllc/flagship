import Foundation
import CryptoKit
import FlagshipAPI
import FlagshipCore

extension GymSweepSeams {
    /// The fixture backup a smoke launch hands the Import screen instead of
    /// the system file picker (`-smoke-import-archive`).
    static var importArchiveURLs: [URL]?
    /// A scripted builder peer for "Pair with the builder app"
    /// (`-smoke-builder-peer`); nil uses the live relay.
    static var builderPairClient: (any BuilderPairClient)?

    /// The archive id `-smoke-awaiting-backup` marks Home as waiting for.
    static let gymArchiveId = String(repeating: "ab", count: 16)
    static let gymFirewallReason = "its internet firewall isn't running: nftables isn't installed"
    static let gymGvisorReason = "runsc failed its test container"

    /// Server seams for GymSweepServerTests.
    static func server(_ args: [String], _ app: AppState, _ mocks: GymMocks) {
        // Every launch: what the server page's cards read from their mocks.
        mocks.frontPage.options = [
            FrontPageOption(urlLabel: "plants", name: "Plants"),
            FrontPageOption(urlLabel: "wiki", name: "Wiki"),
        ]
        mocks.lockPower.journalLines = ["gym: flagship-daemon started", "gym: serving 2 apps"]
        mocks.migration.scripted = true

        // `-smoke-server-fresh`: forget what earlier runs left in this
        // simulator's defaults (lock-down policies, pending updates).
        if args.contains("-smoke-server-fresh") {
            for pod in app.pods where !pod.fqdn.isEmpty {
                DeadManStore().clear(for: pod.fqdn)
                PendingUpdateStore().clear(serverFqdn: pod.fqdn)
            }
        }
        // `-smoke-server-identity`: the online servers' STKs are known, so a
        // delete also deposits the erase order.
        if args.contains("-smoke-server-identity") || args.contains("-smoke-server-directory") {
            for pod in app.pods where pod.status == .online {
                app.upsertRegisteredPod(fqdn: pod.fqdn, name: pod.name, liveness: .live,
                                        identityPubKeyHex: stkHex(pod.fqdn))
            }
        }
        // `-smoke-server-directory`: `.com`'s directory lists the online
        // servers with their STKs and peer-backup is on, so Migrate can start.
        if args.contains("-smoke-server-directory") {
            let now = Int64(Date().timeIntervalSince1970 * 1000)
            mocks.mailbox.directory = app.pods.filter { $0.status == .online }.map {
                PodDirectoryEntry(serverDomain: $0.fqdn, identityPubKey: stkHex($0.fqdn), lastReported: now,
                                  registeredAt: now - 86_400_000, hasCert: true, liveness: "live", lastSeenMsAgo: 0)
            }
            mocks.screens.peerBackupStatusFixture = PeerBackupStatusResponse(
                participating: true,
                peersBackingYouUp: [PeerBackupPeerHostingYou(peerFqdn: "office.bright-maple.flagship.services",
                                                             shardsHosted: 4, lastSeenMs: now, online: true)],
                peersYouBackUp: [], shards: [],
                repair: PeerBackupRepairStatus(state: "idle", lastTickMs: nil, queued: 0, completed24h: 0, lastError: nil),
                stats: PeerBackupStats(total: 4, durable: 4, atRisk: 0, yourBytesStored: 4096, peerBytesHosted: 0))
        }
        if args.contains("-smoke-sandbox-firewall-down") {
            mocks.screens.appSandboxFixture = AppSandbox(state: "unavailable", reason: gymFirewallReason)
        } else if args.contains("-smoke-sandbox-gvisor-down") {
            mocks.screens.appSandboxFixture = AppSandbox(state: "unavailable", reason: gymGvisorReason)
        }
        // `-smoke-update-stale`: Home was sent an update 31 minutes ago and
        // hasn't applied it (Send again / Forget it).
        if args.contains("-smoke-update-stale"), let home = app.pods.first(where: { $0.status == .online }) {
            let now = Int64(Date().timeIntervalSince1970 * 1000)
            PendingUpdateStore().save(
                PendingUpdateOrder(targetCommit: String(repeating: "4b1e0c9d", count: 5), targetTag: "v0.0.0-gym",
                                   fromCommit: "9f2c1ab3de4567890abcdef1234567890abcdef1", orderedAt: now - 31 * 60_000),
                serverFqdn: home.fqdn)
        }
        // `-smoke-import-archive [other]`: a backup pair the Import screen
        // opens (made on this account, or `other` for another account's).
        if args.contains("-smoke-import-archive") {
            let other = value(args, "-smoke-import-archive") == "other"
            if let made = try? makeBackupPair(otherAccount: other) {
                importArchiveURLs = made.urls
                mocks.screens.restoreWaiting = ServerRestoreWaiting(archiveId: gymArchiveId, bytes: made.bytes, sha256: made.sha256)
            }
        } else {
            importArchiveURLs = nil
        }
        builderPairClient = args.contains("-smoke-builder-peer") ? GymBuilderPairClient() : nil
    }

    /// A stable fake STK for a server.
    static func stkHex(_ fqdn: String) -> String {
        HexUtil.encode(Data(SHA256.hash(data: Data("gym-stk|\(fqdn.lowercased())".utf8))))
    }

    /// A small backup (backup file + data file) of a server called "attic"
    /// holding Wiki, sealed to this account's archive key (or another
    /// account's, which then asks for a passcode the file doesn't have).
    static func makeBackupPair(otherAccount: Bool) throws -> (urls: [URL], bytes: Int64, sha256: String) {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("gym-import", isDirectory: true)
        try? FileManager.default.removeItem(at: dir)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let seed = otherAccount ? Data(repeating: 0x11, count: 32) : (GymSeams.accountRootSeed ?? Data(repeating: 0x47, count: 32))
        guard let kek = ServerArchive.deriveKey(umkSeed: seed, archiveId: gymArchiveId) else { throw CocoaError(.fileWriteUnknown) }
        let contentKey = Data(repeating: 0x42, count: 32)
        var data = Data(ServerBackupFormat.dataMagic.utf8)
        data.append(Data(repeating: 9, count: 64 * 1024))
        let sha = HexUtil.encode(Data(SHA256.hash(data: data)))
        let body: [String: Any] = [
            "createdAt": 1_792_000_000_000,
            "server": ["name": "attic", "domain": "attic.bright-maple.flagship.services",
                       "bootUnlockMode": "auto", "diskEncryption": "luks"],
            "apps": [["serviceId": "bright-maple--wiki", "name": "Wiki"]],
            "left": [], "includes": [], "excludes": [],
            "data": ["fileName": "attic-2026-10-16.flagship-data", "bytes": data.count, "sha256": sha, "frameBytes": 1_048_576],
        ]
        let slot = try ServerBackupFormat.wrapAccountSlot(archiveId: gymArchiveId, contentKey: contentKey, kek: kek,
                                                          nonce: Data(repeating: 3, count: 12))
        let file = try ServerBackupFormat.sealFile(archiveId: gymArchiveId, contentKey: contentKey, slots: [slot],
                                                   bodyJson: try JSONSerialization.data(withJSONObject: body),
                                                   nonce: Data(repeating: 1, count: 12))
        let text = "{\"magic\":\"flagship-backup\",\"v\":2,\"archiveId\":\"\(gymArchiveId)\",\"slots\":[{\"kind\":\"account\",\"nonceHex\":\"\(slot.nonceHex)\",\"wrappedHex\":\"\(slot.wrappedHex)\"}],\"bodyNonceHex\":\"\(file.bodyNonceHex)\",\"bodyHex\":\"\(file.bodyHex)\"}\n"
        let backupURL = dir.appendingPathComponent("attic-2026-10-16.flagship-backup")
        let dataURL = dir.appendingPathComponent("attic-2026-10-16.flagship-data")
        try Data(text.utf8).write(to: backupURL)
        try data.write(to: dataURL)
        return ([backupURL, dataURL], Int64(data.count), sha)
    }
}

/// Gym-only builder peer: accepts the phone, greets it with a fixed key and
/// confirms receipt of the recipe, as Flagship Studio does over the relay.
final class GymBuilderPairClient: BuilderPairClient, @unchecked Sendable {
    private var continuation: AsyncStream<BuilderInbound>.Continuation?
    private let builderKey = Curve25519.KeyAgreement.PrivateKey()

    func connect(sid: String) async throws -> AsyncStream<BuilderInbound> {
        GymProbe.note("builder connected")
        let pk = Base64URL.encode(builderKey.publicKey.rawRepresentation)
        return AsyncStream { cont in
            self.continuation = cont
            cont.yield(.accepted)
            cont.yield(.builderHello(builderPkB64: pk))
        }
    }

    func send(_ frame: BuilderOutbound) async throws {
        if case .deliver = frame {
            GymProbe.note("recipe delivered to the builder")
            continuation?.yield(.recipeAccepted)
        }
    }

    func close() async {
        continuation?.finish()
        continuation = nil
    }
}
