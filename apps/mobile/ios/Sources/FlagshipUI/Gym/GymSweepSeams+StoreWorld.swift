#if DEBUG
import Foundation
import CryptoKit
import UIKit
import Flagship
import FlagshipAPI
import FlagshipCore

/// The made-up world the store screenshots show (store/demo-world.json, docs/store-assets/capture-plan.md):
/// `-smoke-store-world` with the file's JSON in the `FLAGSHIP_STORE_WORLD` launch environment. Each server
/// gets its own mock box; `-smoke-store-waiting` has cabin waiting for its start-up approval.
struct StoreWorld: Decodable {
    struct Server: Decodable { let name: String; let fqdn: String; let leader: Bool; let uptimeHours: Int }
    struct Waiting: Decodable { let server: String; let askedMinutesAgo: Int }
    struct App: Decodable { let slug: String; let name: String; let summary: String; let server: String; let access: String }
    struct Member: Decodable { let name: String; let rank: String }
    struct Backups: Decodable {
        let server: String; let keep: Int; let policy: String; let lastHoursAgo: Int; let sizeGiB: Double
    }
    let account: String
    let servers: [Server]
    let unlockRequest: Waiting
    let apps: [App]
    let membersApp: String
    let members: [Member]
    let backups: Backups

    static func load() -> StoreWorld? {
        guard let json = ProcessInfo.processInfo.environment["FLAGSHIP_STORE_WORLD"] else { return nil }
        return try? JSONDecoder().decode(StoreWorld.self, from: Data(json.utf8))
    }
}

extension GymSweepSeams {
    private static let storeHousehold = Data(repeating: 0x33, count: 32)
    private static let storeDevice = ServiceAccessFixture.key(0xd0)

    /// The keys Access control signs with in the store world (fixed, like `-smoke-access-fixture`).
    public static func storeAccessKeys() -> ServiceAccessKeys {
        let aid = ServiceAccessFixture.key(5)
        let admin = ServiceAccessFixture.key(9)
        return ServiceAccessKeys(
            authorAidKeys: { _ in (aid, storeHousehold) },
            adminSigner: { _ in admin },
            isAdminDevice: true,
            deviceId: ServiceAccessFixture.thisDeviceId,
            deviceKey: storeDevice,
            deviceNames: [ServiceAccessFixture.thisDeviceId: UIDevice.current.localizedModel])
    }

    static func storeWorld(_ args: [String], _ app: AppState, _ mocks: GymMocks) {
        guard args.contains("-smoke-store-world"), let world = StoreWorld.load() else { return }
        let waiting = args.contains("-smoke-store-waiting")
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        let hour: Int64 = 3_600_000
        let stk = { (fqdn: String) in
            (try? Curve25519.Signing.PrivateKey(rawRepresentation: Data(SHA256.hash(data: Data("store-stk|\(fqdn)".utf8)))))!
        }
        let ordered = world.servers.filter(\.leader) + world.servers.filter { !$0.leader }

        app.completeOnboarding(username: world.account, pods: ordered.map { s in
            let asking = waiting && s.name == world.unlockRequest.server
            return PodInfo(
                podId: "store-\(s.name)", name: s.name, fqdn: s.fqdn,
                status: asking ? .offline : .online, registeredAt: now - 40 * 24 * hour,
                awaitingUnlock: asking, liveness: asking ? nil : .live, lastSeenMsAgo: asking ? nil : 20_000,
                identityPubKeyHex: HexUtil.encode(stk(s.fqdn).publicKey.rawRepresentation))
        })
        app.hasCloudRecovery = true

        podClients = [:]
        var boxes: [String: MockScreensClient] = [:]
        for s in world.servers {
            let box = s.leader ? mocks.screens : MockScreensClient()
            box.podContext = "store-\(s.name)"
            box.simulatedLatency = 0
            box.mockBoxDomain = s.fqdn
            box.mockAccess = [:]
            box.mockEgress = [:]
            box.appStorageFixture = [:]
            box.servingFixture = nil
            box.appsListFixture = decode(["apps": world.apps.filter { $0.server == s.name }.map { a in
                [
                    "serviceId": "\(world.account)--\(a.slug)", "creator": world.account, "slug": a.slug, "urlLabel": a.slug,
                    "summary": a.summary, "url": "https://\(a.slug).\(s.fqdn)/", "status": "running", "version": "1.0.0",
                    "installedAt": now - 30 * 24 * hour, "name": a.name,
                    "accessMode": a.access == "members" ? "members-only" : "open",
                ] as [String: Any]
            }])
            box.serverDetailOverride = decode([
                "serverFqdn": s.fqdn, "username": world.account, "daemonVersion": "0.3.0",
                "currentCommit": String(repeating: "7ac1b50a", count: 5),
                "startedAt": now - Int64(s.uptimeHours) * hour, "uptimeMs": Int64(s.uptimeHours) * hour,
                "certNotAfter": now + 60 * 24 * hour, "certNotBefore": now - 30 * 24 * hour,
                "certSans": [s.fqdn, "*.\(s.fqdn)"],
                "serviceCount": world.apps.filter { $0.server == s.name }.count, "pairedSessionCount": 2,
                "recentInstallEvents": [] as [Any],
            ])
            boxes[s.name] = box
            podClients[s.name] = box
        }
        for box in boxes.values { box.unreachablePodIds = waiting ? ["store-\(world.unlockRequest.server)"] : [] }

        if let home = boxes[world.backups.server] {
            let b = world.backups
            let gib = 1_073_741_824.0
            let apps = world.apps.filter { $0.server == b.server }.map {
                ServerArchiveApp(serviceId: "\(world.account)--\($0.slug)", name: $0.name)
            }
            home.savedSchedule = BackupSchedule(frequency: "daily", minuteOfDayUtc: 180, weekdayUtc: 0, keepDaily: b.keep, keepWeekly: 4)
            home.seedKeyPool(300)
            home.savedBackupsList = (0..<3).map { i in
                let size = Int64(b.sizeGiB * gib) - Int64(i) * 40_000_000
                return SavedBackup(
                    archiveId: String(repeating: String(i + 5), count: 32), createdAt: now - Int64(b.lastHoursAgo + 24 * i) * hour,
                    trigger: "schedule", bytes: size, sha256: String(repeating: "cd", count: 32), backupBytes: 2048,
                    backupFileName: "\(b.server).flagship-backup", dataFileName: "\(b.server).flagship-data", apps: apps,
                    bundleFileName: "\(b.server).flagship", bundleBytes: size + 2064, bundleSha256: String(repeating: "ab", count: 32))
            }
            home.savedLastRun = SavedBackupLastRun(at: now - Int64(b.lastHoursAgo) * hour, ok: true, trigger: "schedule",
                                                   archiveId: home.savedBackupsList.first?.archiveId)
            home.policyCurrent = BackupPolicyCurrent(policy: b.policy, phoneReserveBytes: 32 * Int64(gib), issuedAt: 1)
            home.policyUsedBytes = Int64(b.sizeGiB * gib)
            home.policyDiskBytes = 480 * Int64(gib)
        }

        let ref = "\(world.account)--\(world.membersApp)"
        let aid = { (i: Int) in String(repeating: String(i + 6), count: 64) }
        var rows: [ServiceInviteRow] = []
        for (i, m) in world.members.enumerated() {
            let inviteId = "inv-\(m.name.lowercased())"
            let sealed = (try? ServiceInvite.sealBundle(ServiceInvite.Bundle(name: m.name, photo: nil),
                                                       householdKey: storeHousehold, inviteId: inviteId)) ?? ""
            rows.append(ServiceInviteRow(inviteId: inviteId, serviceRef: ref, encryptedBundleHex: sealed, boundAidHex: aid(i),
                                         boundAt: now - Int64(i + 2) * 24 * hour, createdAt: now - Int64(i + 3) * 24 * hour,
                                         revokedAt: nil, creatorTier: "admin", creatorDeviceId: ServiceAccessFixture.thisDeviceId))
        }
        let members = AppMembersResponse(
            serviceId: ref, mode: "restricted", defaultRole: "member",
            accountMembers: [.device(id: ServiceAccessFixture.thisDeviceId,
                                     pub: HexUtil.encode(storeDevice.publicKey.rawRepresentation), admin: true, rank: "master")],
            members: world.members.enumerated().map { i, m in
                AppMember(aid: aid(i), role: m.rank, grants: [AppMemberGrant(inviteId: "inv-\(m.name.lowercased())", role: m.rank)])
            },
            invites: world.members.map {
                AppMemberInviteRole(inviteId: "inv-\($0.name.lowercased())", role: $0.rank, set: $0.rank != "member", tier: "admin",
                                    creatorPub: HexUtil.encode(ServiceAccessFixture.key(9).publicKey.rawRepresentation),
                                    creatorDeviceId: ServiceAccessFixture.thisDeviceId)
            })
        for box in boxes.values { box.mockMembers = [ref: members] }
        mocks.access.rows = rows
        mocks.access.state = ServiceAccessState(mode: "restricted", allowCount: world.members.count)

        // The start-up request cabin's box posts: signed by its STK, which the phone pinned when it first approved cabin.
        mocks.mailbox.pending = []
        let asked = now - Int64(world.unlockRequest.askedMinutesAgo) * 60_000
        mocks.mailbox.directory = world.servers.map { s in
            let asking = waiting && s.name == world.unlockRequest.server
            return PodDirectoryEntry(
                serverDomain: s.fqdn, identityPubKey: HexUtil.encode(stk(s.fqdn).publicKey.rawRepresentation),
                lastReported: asking ? asked - 300_000 : now - 20_000, registeredAt: now - 40 * 24 * hour, hasCert: true,
                pendingRequests: asking ? [PendingRequestSummaryWire(id: String(repeating: "42", count: 32), type: "unlock-key",
                                                                      issuedAt: asked, expiresAt: asked + 600_000)] : [],
                liveness: asking ? nil : "live", lastSeenMsAgo: asking ? nil : 20_000)
        }
        for s in world.servers { ServerKeyPins().pin(stk(s.fqdn).publicKey.rawRepresentation, for: s.fqdn) }
        if waiting, let s = world.servers.first(where: { $0.name == world.unlockRequest.server }) {
            let key = stk(s.fqdn)
            let pub = key.publicKey.rawRepresentation
            let nonce = Data(repeating: 0x42, count: 32)
            let request = SecretRequest(serverDomain: s.fqdn, stkPub: pub, purpose: .unlockKey, nonce: nonce, issuedAt: asked)
            if let sig = try? key.signature(for: request.canonicalBytes()) {
                mocks.mailbox.pending = [PendingSecretRequest(
                    serverDomain: s.fqdn, requestNonceHex: HexUtil.encode(nonce), stkPub: HexUtil.encode(pub),
                    purpose: SecretPurpose.unlockKey.rawValue, issuedAt: asked, requestSignature: HexUtil.encode(sig),
                    deviceInfo: nil, postedAt: asked, expiresAt: asked + 600_000)]
            }
        }
    }

    private static func decode<T: Decodable>(_ object: [String: Any]) -> T? {
        guard let data = try? JSONSerialization.data(withJSONObject: object) else { return nil }
        return try? JSONDecoder().decode(T.self, from: data)
    }
}
#endif
