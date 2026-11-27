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
    struct App: Decodable {
        let slug: String; let name: String; let summary: String; let server: String; let access: String
        /// The summary in other languages (lang code -> text); English is `summary`.
        let summaryByLang: [String: String]?
        /// The app's voi.ci link (a random code or a custom name), so every row shows its own.
        let link: String?
        var localizedSummary: String { GymSweepSeams.localized((summaryByLang ?? [:]).merging(["en": summary]) { a, _ in a }) }
    }
    struct Member: Decodable { let name: String; let rank: String }
    struct Backups: Decodable {
        let server: String; let keep: Int; let policy: String; let lastHoursAgo: Int; let sizeGiB: Double
    }
    /// Slide 03: the conversations from the account's voi.ci page, in the capture's language: Sam's, then `others`.
    struct Messages: Decodable {
        struct Line: Decodable { let from: String; let minutesAgo: Int; let text: [String: String] }
        /// Another person who wrote: a fixed visitor key (`seed`, one byte repeated) and the owner's nickname.
        struct Other: Decodable { let id: String; let seed: UInt8; let nickname: [String: String]; let thread: [Line] }
        let displayName: String
        let nickname: [String: String]
        let thread: [Line]
        let others: [Other]?
    }
    /// Slide 08: a build chat, ready to deploy.
    struct Build: Decodable {
        struct Message: Decodable { let role: String; let minutesAgo: Int; let text: [String: String] }
        let sessionId: String; let name: String; let server: String; let credits: Double?
        let messages: [Message]
    }
    /// Slides 01 and 02 (0.4): the call ringing, and this device's call list ("nickname" = the thread's visitor).
    struct Calls: Decodable {
        struct Ringing: Decodable { let from: String?; let video: Bool }
        struct Entry: Decodable {
            let from: String?; let direction: String; let outcome: String; let video: Bool; let minutesAgo: Int; let durationSec: Int?
        }
        let ringing: Ringing
        let history: [Entry]
    }
    let account: String
    let servers: [Server]
    let unlockRequest: Waiting
    let apps: [App]
    let membersApp: String
    let members: [Member]
    let backups: Backups
    let messages: Messages?
    let calls: Calls?
    let build: Build?

    /// The caller's name on the ringing screen: the owner's nickname for the thread's visitor, in the capture's language.
    var ringingName: String? {
        guard let m = messages, calls?.ringing.from == "nickname" else { return nil }
        return GymSweepSeams.localized(m.nickname)
    }

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
        defer { storeMessages(world, mocks) }
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
        mocks.server?.storeShortCodes = Dictionary(uniqueKeysWithValues: world.apps.compactMap { a in
            a.link.map { ("\(world.account)--\(a.slug)", $0) }
        })

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
                    "summary": a.localizedSummary, "url": "https://\(a.slug).\(s.fqdn)/", "status": "running", "version": "1.0.0",
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
        if let b = world.build, let box = boxes[b.server] { storeChat(b, on: box) }

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

    /// The capture's language (`-AppleLanguages`), picked from a per-language text: exact, then the language alone, then English.
    nonisolated static func localized(_ texts: [String: String]) -> String {
        let lang = Bundle.main.preferredLocalizations.first ?? "en"
        return texts[lang] ?? texts[String(lang.prefix(while: { $0 != "-" }))] ?? texts["en"] ?? ""
    }

    /// Slide 06: river-otter's published voi.ci page and one conversation on it, answered by the owner and renamed
    /// with the owner's nickname, so the thread opens accepted, titled by the nickname, nothing unread.
    static func storeMessages(_ world: StoreWorld, _ mocks: GymMocks) {
        guard let w = world.messages, let m = mocks.voici, let umk = GymSeams.accountRootSeed.map(Array.init) else { return }
        let user = world.account
        let admin = Array(GymSeams.gymAdminRootSeed)
        m.keys[user] = VoiciAccountKeys(irkPub: Keystore.gymIRK().map { HexUtil.encode($0.publicKey.rawRepresentation) } ?? String(repeating: "11", count: 32),
                                        adminRootPub: (try? CanonicalJson.ed25519PublicKey(seed: admin)).map(CanonicalJson.hex))
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        guard let idx = try? seedPage(m, username: user, pageId: gymPageId, umk: umk, admin: admin,
                                      profile: VoiciProfile(displayName: w.displayName, bio: "", avatar: nil, theme: "classic", links: []),
                                      posts: [], now: now),
              let inboxPub = try? CanonicalJson.hexToBytes(idx.inboxPub),
              let visitor = try? MockVoiciVisitor(secret: [UInt8](repeating: 0x5e, count: 32), pageId: gymPageId, origin: Endpoints.voiciOrigin, now: now),
              let sign = try? VoiciMessages.deriveVoiciOwnerSignKey(umk: umk, pageId: gymPageId, inboxEpoch: 1),
              let conv = try? VoiciMessages.voiciConv(pageId: gymPageId, pseudonymPub: visitor.pseudonymPub) else { return }
        let c = VoiciConversation(conv: conv, pseudonymPub: visitor.pseudonymPub, threadPub: CanonicalJson.hex(visitor.thread.publicKey),
                                  messages: [], hasGap: false)
        var items: [VoiciInboxItem] = []
        var visitorSeq: Int64 = 0
        var ownerSeq: Int64 = 0
        for line in w.thread {
            let at = now - Int64(line.minutesAgo) * 60_000
            let text = localized(line.text)
            if line.from == "owner" {
                ownerSeq += 1
                if let r = try? VoiciOwner.reply(text: text, replyTo: nil, conversation: c, pageId: gymPageId, pageSeq: 1,
                                                 ownerSign: (sign.seed, idx.ownerSignPub), inboxPub: inboxPub, seq: ownerSeq, now: at) {
                    items.append(VoiciInboxItem(envelope: r.json, storedAt: at, fetchedAt: at + 60_000))
                }
            } else {
                visitorSeq += 1
                if let e = try? visitor.message(text, inboxPub: inboxPub, seq: visitorSeq, sentAt: at) {
                    items.append(VoiciInboxItem(envelope: e, storedAt: at))
                }
            }
        }
        var people: [String: (conv: String, pseudonymPub: String)] = ["nickname": (conv, visitor.pseudonymPub)]
        var state = MessagesState()
        state.nicknames[visitor.pseudonymPub] = MessagesState.Nickname(name: localized(w.nickname), at: now - 3_000_000)
        state.accepted = [conv]
        for o in w.others ?? [] {
            guard let v = try? MockVoiciVisitor(secret: [UInt8](repeating: o.seed, count: 32), pageId: gymPageId, origin: Endpoints.voiciOrigin, now: now),
                  let oc = try? VoiciMessages.voiciConv(pageId: gymPageId, pseudonymPub: v.pseudonymPub) else { continue }
            let conversation = VoiciConversation(conv: oc, pseudonymPub: v.pseudonymPub, threadPub: CanonicalJson.hex(v.thread.publicKey),
                                                 messages: [], hasGap: false)
            var vSeq: Int64 = 0
            var oSeq: Int64 = 0
            for line in o.thread {
                let at = now - Int64(line.minutesAgo) * 60_000
                if line.from == "owner" {
                    oSeq += 1
                    if let r = try? VoiciOwner.reply(text: localized(line.text), replyTo: nil, conversation: conversation, pageId: gymPageId, pageSeq: 1,
                                                     ownerSign: (sign.seed, idx.ownerSignPub), inboxPub: inboxPub, seq: oSeq, now: at) {
                        items.append(VoiciInboxItem(envelope: r.json, storedAt: at, fetchedAt: at + 60_000))
                    }
                } else {
                    vSeq += 1
                    if let e = try? v.message(localized(line.text), inboxPub: inboxPub, seq: vSeq, sentAt: at) {
                        items.append(VoiciInboxItem(envelope: e, storedAt: at))
                    }
                }
            }
            people[o.id] = (oc, v.pseudonymPub)
            state.nicknames[v.pseudonymPub] = MessagesState.Nickname(name: localized(o.nickname), at: now - 3_000_000)
            state.accepted.append(oc)
        }
        m.mailbox[user] = items.sorted { $0.storedAt < $1.storedAt }
        storeCalls(world, user: user, people: people)
        if let sealed = try? VoiciMessages.sealMessagesState(stateKey: VoiciMessages.deriveMessagesStateKey(umk: umk), username: user,
                                                            version: 1, state: state) {
            m.states[user] = sealed.json
        }
    }

    /// Slide 03: this device's call list (kept on the device only), newest first. A call `from` "nickname" is Sam's, an
    /// `others` id that person's (named by the owner's nickname for their conversation), null an unnamed visitor's.
    /// Not seen yet, so the call button shows the missed ones.
    static func storeCalls(_ world: StoreWorld, user: String, people: [String: (conv: String, pseudonymPub: String)]) {
        guard let calls = world.calls else { return }
        // The list shows each call's clock time: count back from 9:41 today, the status bar's time (the simulator's
        // clock can't be set), so a call "30 minutes ago" reads 9:11.
        var anchor = Calendar.current.date(bySettingHour: 9, minute: 41, second: 0, of: Date()) ?? Date()
        if anchor > Date() { anchor = Date() }
        let now = Int64(anchor.timeIntervalSince1970 * 1000)
        let stranger = String(repeating: "7c", count: 32)
        let records = calls.history.enumerated().map { i, e in
            let who = e.from.flatMap { people[$0] } ?? (conv: String(repeating: "c7", count: 16), pseudonymPub: stranger)
            return VoiciCallRecord(callId: String(format: "%032x", 0xca11 + i), direction: e.direction == "outgoing" ? .outgoing : .incoming,
                                   outcome: VoiciCallRecord.Outcome(rawValue: e.outcome) ?? .answered,
                                   peer: .visitor(conv: who.conv, pseudonymPub: who.pseudonymPub),
                                   video: e.video, at: now - Int64(e.minutesAgo) * 60_000, durationMs: Int64(e.durationSec ?? 0) * 1000)
        }
        if let data = try? JSONEncoder().encode(records) { FileCallHistoryStore.standard.write(user, data) }
        UserDefaults.standard.removeObject(forKey: SocialBadges.callsSeenKey(user))
    }

    /// Slide 08: the world's build chat on its server's box, ready to deploy, in the capture's language.
    static func storeChat(_ b: StoreWorld.Build, on box: MockScreensClient) {
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        let messages = b.messages.enumerated().map { i, m in
            VibeCodeSessionMessage(role: m.role, text: localized(m.text), timestamp: now - Int64(m.minutesAgo) * 60_000,
                                   credits: m.role == "assistant" && i == b.messages.count - 1 ? b.credits : nil)
        }
        box.vibeCodeSessionsFixture = [
            VibeCodeSessionMeta(sessionId: b.sessionId, startedAt: now - Int64(b.messages.first?.minutesAgo ?? 15) * 60_000,
                                status: "ready-to-deploy", name: b.name, updatedAt: now - 60_000),
        ]
        box.vibeCodeQuietStreams = [b.sessionId]
        box.vibeCodeSessionStateFixtures[b.sessionId] = VibeCodeSessionPublicState(
            id: b.sessionId, appId: nil, status: "ready-to-deploy", messages: messages, pendingRequest: nil, model: "medium",
            summarised: false, canContinue: true, provider: "flagship", conversationTokens: 24_000)
    }

    private static func decode<T: Decodable>(_ object: [String: Any]) -> T? {
        guard let data = try? JSONSerialization.data(withJSONObject: object) else { return nil }
        return try? JSONDecoder().decode(T.self, from: data)
    }
}
#endif
