#if DEBUG
import Foundation
import CryptoKit
import FlagshipAPI
import FlagshipCore

extension GymSweepSeams {
    /// Saved backups the server seams seed, by fixed id, so a test can find their rows.
    public static let olderBackupId = "0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f"
    public static let failedRunReason = "needs about 4.0 GB, has 1.0 GB"
    public static let restoreArchiveId = "5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e"
    public static let failedAppReason = "its image didn't build"
    public static let peersLostServer = "lost.bright-maple.flagship.services"

    /// A `.flagship` file Import a backup picks by itself (the system file
    /// picker can't be driven from a test). Set by `-smoke-restore-*`.
    @MainActor public static var importFile: URL?

    /// A scripted builder peer for "Pair with the builder app"
    /// (`-smoke-builder-peer`); nil uses the live relay.
    static var builderPairClient: (any BuilderPairClient)?
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

        // `-smoke-apps-name-lookup-miss`: the phone's router cached "no such name" for
        // the box, so its first Apps request can't look the address up (a retry works).
        if args.contains("-smoke-apps-name-lookup-miss") {
            mocks.screens.appsListError = URLError(.cannotFindHost)
            mocks.screens.appsListErrorOnce = true
        }

        // `-smoke-release-fails-once`: `.com` fails the first release of a name
        // (Cancel order / Delete), then works, so the retry path is exercised.
        if args.contains("-smoke-release-fails-once") {
            mocks.server?.releaseError = ScreensClientError.http(status: 502, message: "error code: 1102")
            mocks.server?.releaseErrorOnce = true
        }

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
        let s = mocks.screens
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        let day: Int64 = 86_400_000
        // No backups yet, no keys, no policy chosen: an admin device deposits keys.
        if args.contains("-smoke-backups-fresh") {
            s.policyCurrent = BackupPolicyCurrent(policy: "unset")
            s.savedBackupsList = []
            s.savedKeyPool = []
        }
        // One backup, an empty key pool: a non-admin device shows the box's reason.
        if args.contains("-smoke-backups-waiting") {
            s.policyCurrent = BackupPolicyCurrent(policy: "phone", phoneReserveBytes: 32 << 30, issuedAt: now - 9 * day)
            s.savedBackupsList = [s.makeSavedBackup(createdAt: now - 3 * day, id: olderBackupId)]
            s.savedKeyPool = []
        }
        // Phone-side, 32 GB, keys in the pool and one backup on the server.
        if args.contains("-smoke-backups-ready") {
            s.policyCurrent = BackupPolicyCurrent(policy: "phone", phoneReserveBytes: 32 << 30, issuedAt: now - 9 * day)
            s.savedBackupsList = [s.makeSavedBackup(createdAt: now - day, id: olderBackupId)]
            s.seedKeyPool(60)
            // Long enough for a test to see "Backing up…" before the backup is listed.
            s.savedRunReads = 5
        }
        // The last run failed with the box's sentence.
        if args.contains("-smoke-backups-failed") {
            s.policyCurrent = BackupPolicyCurrent(policy: "phone", phoneReserveBytes: 32 << 30, issuedAt: now - 9 * day)
            s.savedBackupsList = [s.makeSavedBackup(createdAt: now - 2 * day, id: olderBackupId)]
            s.seedKeyPool(60)
            s.savedLastRun = SavedBackupLastRun(at: now - 3_600_000, ok: false, trigger: "schedule", reason: failedRunReason)
        }
        // Peer-distributed, the server over its limit (150 GB of 120 GB), the peer engine placing.
        if args.contains("-smoke-backups-peer-over") {
            s.policyCurrent = BackupPolicyCurrent(policy: "peer", phoneReserveBytes: 0, issuedAt: now - 9 * day)
            s.policyUsedBytes = 150 << 30
            s.policyDiskBytes = 360 << 30
            s.policyPeer = PeerBackupEngineStatus(state: "placing", lastPlacedAt: now - 3_600_000, healthyBricks: 3, totalBricks: 5,
                                                  hostingBytes: 12 << 30, holders: 4)
            s.savedBackupsList = [s.makeSavedBackup(createdAt: now - day, id: olderBackupId)]
            s.seedKeyPool(60)
        }
        // A server made to restore a backup, waiting for it; the restore ends with one app that failed.
        if args.contains("-smoke-restore-one-failed"), let pod = app.pods.first(where: { $0.status == .online }) {
            app.podsAwaitingBackup[pod.fqdn.lowercased()] = AwaitingBackupWire(archiveId: restoreArchiveId, state: "waiting")
            if let made = try? makeBackupFile(server: pod.fqdn) {
                importFile = made.url
                s.restoreWaiting = ServerRestoreWaiting(archiveId: restoreArchiveId, bytes: made.dataBytes, sha256: made.sha256)
            }
            s.restoreApps = [
                ServerRestoreApp(serviceId: "bright-maple--wiki", name: "Wiki", state: "done"),
                ServerRestoreApp(serviceId: "bright-maple--notes", name: "Notes", state: "failed", reason: failedAppReason),
            ]
            s.restoreFinalState = "done"
        }
        // Restore from other servers: a lost server whose newest backup is kept
        // in pieces on other servers; a new server waits for it; the restore ends with one app that failed.
        if args.contains("-smoke-restore-from-peers"), let pod = app.pods.first(where: { $0.status == .online }) {
            app.podsAwaitingBackup[pod.fqdn.lowercased()] = AwaitingBackupWire(archiveId: restoreArchiveId, state: "waiting")
            if let made = try? makeBackupFile(server: peersLostServer) {
                s.restoreWaiting = ServerRestoreWaiting(archiveId: restoreArchiveId, bytes: made.dataBytes, sha256: made.sha256)
                s.peerRootFixture = PeerRootSummary(
                    serverId: peersLostServer, generation: 3, revision: 2, createdAt: now - day,
                    archive: .init(archiveId: restoreArchiveId, createdAt: now - day, bytes: made.dataBytes, sha256: made.sha256,
                                   backupFile: made.metaJson),
                    holders: 8, needed: 4, keepUntil: now + 20 * day)
            }
            s.restoreApps = [
                ServerRestoreApp(serviceId: "bright-maple--wiki", name: "Wiki", state: "done"),
                ServerRestoreApp(serviceId: "bright-maple--notes", name: "Notes", state: "failed", reason: failedAppReason),
            ]
            s.restoreFinalState = "done"
        }
        // The peer-backup page of a protected server with two holders.
        if args.contains("-smoke-peer-status") {
            s.peerBackupStatusFixture = try? JSONDecoder().decode(PeerBackupStatusResponse.self, from: Data("""
            {"v":2,"state":"protected","reason":"","lastPlacedAt":\(now - 3_600_000),"healthyBricks":8,"totalBricks":8,
             "holders":2,"archiveId":null,"hostingBytes":0,"provenBytes":0,"poolBytes":0,"policy":"peer",
             "archiveCreatedAt":\(now - day),"keepUntil":\(now + 20 * day),
             "holderList":[{"label":"Server 1","state":"ok","lastProofAt":\(now - 7_200_000),"bricks":4},
                           {"label":"Server 2","state":"offline","lastProofAt":null,"bricks":4}],
             "hosting":{"poolBytes":5368709120,"realBytes":2147483648,"fillerBytes":3221225472,"provenBytes":1073741824,"leases":3,"bricks":9,"reliability":88,"leaving":false},
             "participating":true,"peersBackingYouUp":[],"peersYouBackUp":[],"shards":[],
             "repair":{"state":"idle","lastTickMs":null,"queued":0,"completed24h":0},
             "stats":{"total":8,"durable":8,"atRisk":0,"yourBytesStored":0,"peerBytesHosted":2147483648}}
            """.utf8))
        }
        // A cut-short `.flagship` file: Import a backup refuses it with its sentence.
        if args.contains("-smoke-restore-damaged") {
            let url = FileManager.default.temporaryDirectory.appendingPathComponent("gym-cut-short.flagship")
            if let head = try? ServerBackupBundle.header(metaLength: 4_000) {
                try? (head + Data(repeating: 0x7b, count: 100)).write(to: url)
                importFile = url
            }
        }
        // `-smoke-import-archive [other]`: a backup Import opens by itself
        // (made on this account, or `other` for another account's).
        if args.contains("-smoke-import-archive") {
            let other = value(args, "-smoke-import-archive") == "other"
            if let made = try? makeBackupFile(server: "attic.bright-maple.flagship.services", otherAccount: other) {
                importFile = made.url
                mocks.screens.restoreWaiting = ServerRestoreWaiting(archiveId: restoreArchiveId, bytes: made.dataBytes, sha256: made.sha256)
            }
        }
        // `-smoke-phone-copies`: the phone keeps one saved copy of the attic
        // server's backup (Restore from backup → From this phone).
        if args.contains("-smoke-phone-copies") {
            let fqdn = "attic.bright-maple.flagship.services"
            if let made = try? makeBackupFile(server: fqdn) {
                let store = PhoneBackupStore.shared
                store.remember(.init(fqdn: fqdn, policy: "phone", reserveBytes: 32 << 30))
                let dir = store.root.appendingPathComponent(fqdn).appendingPathComponent("gym-copy-1", isDirectory: true)
                try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
                let file = dir.appendingPathComponent("attic.flagship")
                try? FileManager.default.removeItem(at: file)
                try? FileManager.default.copyItem(at: made.url, to: file)
                let size = ((try? FileManager.default.attributesOfItem(atPath: file.path)[.size]) as? NSNumber)?.int64Value ?? 0
                let copy = PhoneBackupStore.Copy(archiveId: "gym-copy-1", createdAt: now - day, bytes: size, fileName: "attic.flagship")
                try? JSONEncoder().encode(copy).write(to: dir.appendingPathComponent("copy.json"))
                mocks.screens.restoreWaiting = ServerRestoreWaiting(archiveId: restoreArchiveId, bytes: made.dataBytes, sha256: made.sha256)
            }
        }
        builderPairClient = args.contains("-smoke-builder-peer") ? GymBuilderPairClient() : nil
    }

    /// A stable fake STK for a server.
    static func stkHex(_ fqdn: String) -> String {
        HexUtil.encode(Data(SHA256.hash(data: Data("gym-stk|\(fqdn.lowercased())".utf8))))
    }

    /// A real one-file backup of `server` with this smoke account's account
    /// slot, so Import opens it with the account key as on a phone.
    static func makeBackupFile(server: String, otherAccount: Bool = false) throws -> (url: URL, dataBytes: Int64, sha256: String, metaJson: String) {
        guard let seed = otherAccount ? Data(repeating: 0x11, count: 32) : GymSeams.accountRootSeed, let kek = ServerArchive.deriveKey(umkSeed: seed, archiveId: restoreArchiveId) else {
            throw CocoaError(.featureUnsupported)
        }
        let data = Data(ServerBackupFormat.dataMagic.utf8) + Data((0..<(6 << 20)).map { UInt8(($0 * 13) & 0xff) })
        let sha = HexUtil.encode(Data(SHA256.hash(data: data)))
        let label = server.split(separator: ".").first.map(String.init) ?? "home"
        let body: [String: Any] = [
            "createdAt": Int64(Date().timeIntervalSince1970 * 1000) - 86_400_000,
            "server": ["name": label, "domain": server, "bootUnlockMode": "auto", "diskEncryption": "luks"],
            "apps": [["serviceId": "bright-maple--wiki", "name": "Wiki"], ["serviceId": "bright-maple--notes", "name": "Notes"]],
            "left": [],
            "includes": [], "excludes": [],
            "data": ["fileName": "\(label)-gym.flagship-data", "bytes": data.count, "sha256": sha, "frameBytes": 1 << 20],
        ]
        let contentKey = ServerBackupFormat.randomBytes(32)
        let slot = try ServerBackupFormat.wrapAccountSlot(archiveId: restoreArchiveId, contentKey: contentKey, kek: kek,
                                                          nonce: ServerBackupFormat.randomBytes(12))
        let file = try ServerBackupFormat.sealFile(archiveId: restoreArchiveId, contentKey: contentKey, slots: [slot],
                                                   bodyJson: try JSONSerialization.data(withJSONObject: body),
                                                   nonce: ServerBackupFormat.randomBytes(12))
        let meta: [String: Any] = [
            "magic": ServerBackupFormat.magic, "v": ServerBackupFormat.version, "archiveId": file.archiveId,
            "slots": file.slots.map { ["kind": $0.kind, "nonceHex": $0.nonceHex, "wrappedHex": $0.wrappedHex] },
            "bodyNonceHex": file.bodyNonceHex, "bodyHex": file.bodyHex,
        ]
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("\(label)-gym.flagship")
        let metaData = try JSONSerialization.data(withJSONObject: meta)
        try ServerBackupBundle.make(meta: metaData, data: data).write(to: url)
        return (url, Int64(data.count), sha, String(decoding: metaData, as: UTF8.self))
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
#endif
