import Foundation
import Observation
import CryptoKit
import Flagship
import FlagshipAPI
import FlagshipCore

/// The account's voi.ci page and its Messages, on this device (docs/voici-and-messages.md §5, §7, §8, §10, §11).
///
/// Every edit, on any device, is a draft op. An admin device merges its own and the other devices' ops into the
/// published page and signs a new index; any other device hands its ops to the admin phone (directly when it holds
/// the bare name, else through `.com`'s drafts lane) and shows them grayed until a published index carries them.
/// Messages are read from the mailbox, checked and opened on the device; nothing from them reaches a model (§10.4).
@MainActor
@Observable
public final class MessagesStore {
    public static let shared = MessagesStore()

    public enum Phase: Equatable { case idle, loading, ready, failed(String) }

    // MARK: wiring

    @ObservationIgnored public private(set) var client: (any VoiciComClient)?
    @ObservationIgnored private(set) var username = ""
    @ObservationIgnored private var deviceId = ""
    @ObservationIgnored private var isDemo = false
    @ObservationIgnored public var now: () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }
    @ObservationIgnored let phoneInbox = MessagesPhoneInbox()
    @ObservationIgnored private var refreshing = false
    @ObservationIgnored private var poller: Task<Void, Never>?
    /// Try the admin phone's bare name before the drafts lane (off in the mock gym, which has no network).
    @ObservationIgnored public var directDelivery = true

    // MARK: the page

    /// The last signed index this device saw. After "Remove my page" it stays (its pageId and inbox keys still open the
    /// conversations) and `isRemoved` is set.
    public private(set) var index: VoiciPageIndex?
    /// The page was taken down (here or on another device): `.com` answers "no page". Its content stays on the device.
    public private(set) var isRemoved = false
    /// The last published content; kept after a removal so turning the page on again republishes it.
    public private(set) var published: VoiciPageState?
    public private(set) var accountKeys: VoiciAccountKeys?
    /// This device's edits not yet in a published index.
    public private(set) var ownOps: [VoiciDraftOp] = []
    /// Other devices' edits waiting for an admin device (the drafts lane, or delivered to this phone).
    public private(set) var laneOps: [VoiciDraftOp] = []
    public private(set) var isPublishing = false
    public private(set) var publishError: String?

    // MARK: Messages

    public private(set) var conversations: [VoiciConversation] = []
    public private(set) var state = MessagesState()
    public private(set) var phase: Phase = .idle
    public private(set) var lastError: String?

    // MARK: kept on the device

    @ObservationIgnored private var local = Local()

    struct Local {
        var pageId = ""
        var highestSeq: Int64 = 0
        var pendingEpoch: Int64?
        var items: [VoiciInboxItem] = []
        var cursor = ""
        var deliveredToPhone: Set<String> = []
        var stateVersion: Int64 = 0
        var draftSeq: Int64 = 0
        /// opId → how it left this device: "lane", or "phone@<index seq at the ack>".
        var handed: [String: String] = [:]
        var blocks: [String] = []
        var revoked: [String] = []
    }

    public init() {}

    /// Called once the app knows the account (and again on a switch or sign-out).
    public func configure(client: any VoiciComClient, username: String?, deviceId: String?, isDemo: Bool) {
        let u = (username ?? "").lowercased()
        let changed = u != self.username
        self.client = client
        self.isDemo = isDemo
        self.deviceId = deviceId.flatMap { $0.isEmpty ? nil : $0 } ?? "device"
        Self.currentUsername = u
        guard changed else { return }
        self.username = u
        index = nil; published = nil; accountKeys = nil; ownOps = []; laneOps = []; conversations = []
        state = MessagesState(); phase = .idle; publishError = nil; lastError = nil; isRemoved = false
        local = Local()
        guard !u.isEmpty else { return }
        load()
    }

    /// After a wipe: nothing of the account stays in memory, and nothing is written back.
    func forgetInMemory() {
        stopPolling()
        phoneInbox.set(nil)
        username = ""
        Self.currentUsername = nil
        index = nil; published = nil; accountKeys = nil; ownOps = []; laneOps = []; conversations = []
        state = MessagesState(); phase = .idle; publishError = nil; lastError = nil; isRemoved = false
        local = Local()
    }

    public var isAdmin: Bool { Keystore.hasAdminRoot }
    /// Visitors see the page on voi.ci now.
    public var isPublic: Bool { index != nil && !isRemoved }
    public var hasAccount: Bool {
        #if DEBUG
        if sampleAccountsHavePages { return !username.isEmpty }
        #endif
        return !username.isEmpty && !isDemo
    }

    #if DEBUG
    /// The mock gym's smoke account is a sample account; its Messages scenarios give it a page.
    @ObservationIgnored public var sampleAccountsHavePages = false
    #endif
    public var pageURL: String { "https://\(Endpoints.voiciHost)/\(username)" }

    // MARK: derived

    /// What the page will be once every pending edit is published (the editor and the preview show this).
    public var preview: VoiciPageState {
        VoiciPage.mergeVoiciPage(base, ops: ownOps + laneOps.filter { op in !ownOps.contains { $0.opId == op.opId } })
    }

    var base: VoiciPageState {
        published ?? VoiciPageState(profile: VoiciProfile(displayName: username, bio: "", avatar: nil, theme: "classic", links: []),
                                    acceptsMessages: 0, chunks: [], issuedAt: 0)
    }

    public var pendingCount: Int { Set((ownOps + laneOps).map(\.opId)).count }

    /// Post ids changed by an edit not yet published (shown grayed: "Not published yet").
    public var unpublishedPostIds: Set<String> {
        var s = Set<String>()
        for op in ownOps + laneOps {
            if let p = op.post { s.insert(p.id) }
        }
        return s
    }

    public var profileUnpublished: Bool { (ownOps + laneOps).contains { $0.op == "profile" || $0.op == "accept-messages" } }

    public var acceptsMessages: Bool { preview.acceptsMessages == 1 }

    public var visibleConversations: [VoiciConversation] {
        conversations.filter { !state.archived.contains($0.conv) && !state.blocks.contains($0.pseudonymPub) }
    }

    public func isRequest(_ c: VoiciConversation) -> Bool { !c.ownerReplied && !state.accepted.contains(c.conv) }

    public var requests: [VoiciConversation] { visibleConversations.filter(isRequest) }
    public var accepted: [VoiciConversation] { visibleConversations.filter { !isRequest($0) } }

    public func isUnread(_ c: VoiciConversation) -> Bool {
        guard let last = c.messages.last(where: { !$0.fromOwner }) else { return false }
        if let lastAny = c.messages.last, lastAny.fromOwner, lastAny.sentAt >= last.sentAt { return false }
        return state.readUpTo[c.conv] != last.msgId
    }

    public var unreadCount: Int { visibleConversations.filter(isUnread).count }

    public func name(_ c: VoiciConversation) -> String { name(pseudonymPub: c.pseudonymPub) }

    public func name(pseudonymPub: String) -> String {
        if let n = state.nicknames[pseudonymPub]?.name, !n.isEmpty { return n }
        return (try? VoiciText.voiciPseudonymName(pseudonymPub, prefix: String(localized: "Visitor "))) ?? String(localized: "Visitor")
    }

    public func conversation(_ conv: String) -> VoiciConversation? { conversations.first { $0.conv == conv } }

    // MARK: keys

    struct Keys {
        let umk: [UInt8]
        let pageId: String
        let epoch: Int64
        let inbox: (seed: [UInt8], publicKey: [UInt8])
        let sign: (seed: [UInt8], publicKey: [UInt8])
        var signPub: String { CanonicalJson.hex(sign.publicKey) }
        var inboxPub: String { CanonicalJson.hex(inbox.publicKey) }
    }

    var pageId: String {
        if let i = index { return i.pageId }
        if local.pageId.isEmpty {
            local.pageId = CanonicalJson.hex(Array((0..<16).map { _ in UInt8.random(in: 0...255) }))
            save()
        }
        return local.pageId
    }

    func keys(epoch: Int64? = nil) -> Keys? {
        guard let umk = Keystore.messagesUMKIfCached().map(Array.init) else { return nil }
        let e = epoch ?? index?.inboxEpoch ?? 1
        guard let inbox = try? VoiciMessages.deriveVoiciInboxKey(umk: umk, pageId: pageId, inboxEpoch: e),
              let sign = try? VoiciMessages.deriveVoiciOwnerSignKey(umk: umk, pageId: pageId, inboxEpoch: e) else { return nil }
        return Keys(umk: umk, pageId: pageId, epoch: e, inbox: inbox, sign: sign)
    }

    func deviceKey() -> Curve25519.Signing.PrivateKey? {
        if let k = Keystore.sessionAccountDeviceKey(accountId: username, deviceId: deviceId) { return k }
        guard let umk = Keystore.messagesUMKIfCached() else { return nil }
        return try? AccountMetadata.deriveAccountDeviceKey(umk: umk, accountId: username, deviceId: deviceId)
    }

    /// Device headers for one `.com` request (the `/profile` scheme), signed by this device's account key.
    nonisolated static func deviceSigner(username: String, deviceId: String, key: Curve25519.Signing.PrivateKey) -> VoiciDeviceSigner {
        { method, path in
            let pub = HexUtil.encode(key.publicKey.rawRepresentation)
            guard let requestId = try? AccountMetadata.generateDeviceId() else { return nil }
            let at = Int64(Date().timeIntervalSince1970 * 1000)
            guard let bytes = try? AccountMetadata.canonicalDirectoryRequest(accountId: username, deviceId: deviceId, signerPubHex: pub, method: method,
                                                                             path: path, requestId: requestId, issuedAt: at),
                  let sig = try? key.signature(for: bytes) else { return nil }
            return AccountDirectoryAuthorization(deviceId: deviceId, signerPubHex: pub, requestId: requestId, issuedAt: at, signatureHex: HexUtil.encode(Data(sig)))
        }
    }

    var device: VoiciDeviceSigner? {
        guard let k = deviceKey() else { return nil }
        return Self.deviceSigner(username: username, deviceId: deviceId, key: k)
    }

    // MARK: refresh

    /// Reads the page, the state blob, the drafts lane and the mailbox; an admin device then publishes what waits.
    public func refresh() async {
        guard hasAccount, let client, !refreshing else { return }
        refreshing = true
        defer { refreshing = false }
        if phase != .ready { phase = .loading }
        do {
            let keys = try await client.accountKeys(username: username)
            accountKeys = keys
            try await loadPage(client, keys)
            await loadState(client)
            await loadLane(client, keys)
            await loadInbox(client)
            settleHanded()
            await checkReplies()
            phase = .ready
            lastError = nil
            updatePhoneInbox()
        } catch {
            lastError = Self.sentence(error)
            phase = conversations.isEmpty && index == nil ? .failed(lastError ?? "") : .ready
        }
    }

    /// Polls while the Messages tab is on screen (the mailbox has no live channel in 0.3).
    public func startPolling() {
        poller?.cancel()
        poller = Task { [weak self] in
            while !Task.isCancelled {
                await self?.refresh()
                try? await Task.sleep(for: .seconds(30))
            }
        }
    }

    public func stopPolling() {
        poller?.cancel()
        poller = nil
    }

    private func loadPage(_ client: any VoiciComClient, _ keys: VoiciAccountKeys) async throws {
        guard let raw = try await client.page(username: username) else {
            // No page on `.com`: never made, or removed (here or on another device). Its content stays here.
            if index != nil, !isRemoved {
                isRemoved = true
                save()
            }
            return
        }
        try await adopt(raw, client, keys)
    }

    /// Takes a signed index read from `.com` (a read, or the one a 409 carries), checked against the account's own key and
    /// never older than the highest seq this device saw (an old index or a removal can't be replayed).
    private func adopt(_ raw: JSONValue, _ client: any VoiciComClient, _ keys: VoiciAccountKeys) async throws {
        let s = keys.sensitive
        guard case .ok(let idx) = VoiciPage.checkVoiciPageIndex(raw, username: username, sensitiveKind: s.kind, sensitivePub: s.pub,
                                                                  highestSeenSeq: local.highestSeq) else {
            throw VoiciComError(status: 200, code: "page-unchecked")
        }
        if let i = index, i.seq == idx.seq, published != nil {
            if isRemoved {
                isRemoved = false
                save()
            }
            return
        }
        guard let content = try await VoiciOwner.content(idx, fetch: { try await client.piece(pageId: idx.pageId, sha256: $0.sha256) }) else {
            throw VoiciComError(status: 200, code: "page-unchecked")
        }
        for sha in VoiciOwner.imageHashes(content) where VoiciImageStore.load(sha) == nil {
            if let b = try? await client.piece(pageId: idx.pageId, sha256: sha), CanonicalJson.sha256Hex(b) == sha { VoiciImageStore.save(b) }
        }
        index = idx
        published = content
        local.highestSeq = max(local.highestSeq, idx.seq)
        local.pageId = idx.pageId
        isRemoved = false
        PageWelcomeCardStore.recordPublished(username: username)
        save()
    }

    private func loadState(_ client: any VoiciComClient) async {
        guard let umk = Keystore.messagesUMKIfCached(), let blob = try? await client.messagesState(username: username) else { return }
        let key = VoiciMessages.deriveMessagesStateKey(umk: Array(umk))
        guard let remote = VoiciMessages.openMessagesState(stateKey: key, username: username, blob: blob) else { return }
        local.stateVersion = blob["version"]?.time ?? local.stateVersion
        state = VoiciMessages.mergeMessagesState(local: state, remote: remote)
        save()
    }

    private func loadLane(_ client: any VoiciComClient, _ keys: VoiciAccountKeys) async {
        guard let umk = Keystore.messagesUMKIfCached(), let lane = try? await client.drafts(username: username) else { return }
        let draftsKey = VoiciMessages.deriveVoiciDraftsKey(umk: Array(umk))
        let accountKeys = [keys.adminRootPub, keys.irkPub].compactMap { $0 }
        var ops: [VoiciDraftOp] = []
        var inLane = Set<String>()
        for env in lane {
            guard case .ok(let e) = VoiciMessages.checkVoiciDraft(env, username: username, checkGrant: { [username, now] g, s, d in
                VoiciOwner.checkDraftGrant(g, signature: s, devicePub: d, username: username, accountKeys: accountKeys, now: now())
            }), let body = CanonicalJson.b64Decode(e.bodyB64),
                  let op = VoiciMessages.openVoiciDraft(draftsKey: draftsKey, username: username, opId: e.msgId, bodyBytes: body) else { continue }
            inLane.insert(op.opId)
            for im in op.images ?? [] { if let b = CanonicalJson.b64Decode(im.data) { VoiciImageStore.save(b) } }
            if !ownOps.contains(where: { $0.opId == op.opId }) { ops.append(op) }
        }
        // Delivered straight to this phone earlier and not yet published: keep them.
        laneOps = ops + laneOps.filter { op in !inLane.contains(op.opId) && local.handed[op.opId] == "received" }
        // This device's own ops handed through the lane and no longer there: an admin device published them.
        ownOps.removeAll { op in local.handed[op.opId] == "lane" && !inLane.contains(op.opId) && !isAdmin }
    }

    /// Own ops handed straight to the admin phone are published once a newer index exists.
    private func settleHanded() {
        guard let seq = index?.seq else { return }
        ownOps.removeAll { op in
            guard let h = local.handed[op.opId], h.hasPrefix("phone@"), let at = Int64(h.dropFirst(6)) else { return false }
            return seq > at
        }
        save()
    }

    private func loadInbox(_ client: any VoiciComClient) async {
        guard let inbox = try? await client.inbox(username: username, since: local.cursor) else { rebuild(); return }
        let known = Set(local.items.compactMap { $0.envelope["msgId"]?.string })
        local.items += inbox.items.filter { !known.contains($0.envelope["msgId"]?.string ?? "") }
        local.cursor = inbox.cursor
        local.blocks = inbox.blocks
        local.revoked = inbox.revoked
        save()
        await rebuildAsync()
    }

    private func rebuild() { Task { await rebuildAsync() } }

    /// Opens every stored envelope under the inbox key of each epoch the page has had.
    func rebuildAsync() async {
        guard let client, let idx = index, let k = keys(epoch: idx.inboxEpoch) else { return }
        let ca = await client.caKeys()
        var all = VoiciOwner.conversations(items: local.items, pageId: idx.pageId, ownerSignPub: k.signPub, inboxSeed: k.inbox.seed,
                                           caKeys: ca, origin: Endpoints.voiciOrigin, deliveredToPhone: local.deliveredToPhone)
        // Older epochs (after a rotation the old keys still open what they sealed).
        var e = idx.inboxEpoch - 1
        while e >= 1, let old = keys(epoch: e) {
            let more = VoiciOwner.conversations(items: local.items, pageId: idx.pageId, ownerSignPub: old.signPub, inboxSeed: old.inbox.seed,
                                                caKeys: ca, origin: Endpoints.voiciOrigin, deliveredToPhone: local.deliveredToPhone)
            for c in more where !all.contains(where: { $0.conv == c.conv }) { all.append(c) }
            e -= 1
        }
        conversations = all.sorted { $0.lastAt > $1.lastAt }
    }

    // MARK: editing (any device)

    public enum EditError: Error, Equatable { case refused(String) }

    private func newId() -> String { CanonicalJson.hex((0..<16).map { _ in UInt8.random(in: 0...255) }) }

    /// Records one edit and sends it on its way.
    private func record(_ op: VoiciDraftOp) async {
        ownOps.append(op)
        save()
        // Every edit is a draft until Publish on an admin device (or the quick controls on the Messages header).
        if !isAdmin { await handOff(op) }
    }

    /// A profile draft. It replaces this device's earlier profile draft that hasn't left the device, so the editor's
    /// "N changes not published" counts what changed, not every keystroke; no draft when it equals what's published.
    public func setProfile(_ profile: VoiciProfile, avatar: [UInt8]?) async {
        if let avatar { VoiciImageStore.save(avatar) }
        var images: [VoiciDraftImage]?
        if let sha = profile.avatar, sha != base.profile.avatar, let b = avatar ?? VoiciImageStore.load(sha) {
            images = [VoiciDraftImage(sha256: sha, data: CanonicalJson.b64Encode(b))]
        }
        ownOps.removeAll { $0.op == "profile" && local.handed[$0.opId] == nil }
        guard profile != base.profile || laneOps.contains(where: { $0.op == "profile" }) else { save(); return }
        await record(VoiciDraftOp(opId: newId(), op: "profile", at: max(now(), base.issuedAt + 1), deviceId: deviceId, profile: profile, images: images))
    }

    public func setAcceptsMessages(_ on: Bool) async {
        ownOps.removeAll { $0.op == "accept-messages" && local.handed[$0.opId] == nil }
        guard (on ? 1 : 0) != base.acceptsMessages || laneOps.contains(where: { $0.op == "accept-messages" }) else { save(); return }
        await record(VoiciDraftOp(opId: newId(), op: "accept-messages", at: max(now(), base.issuedAt + 1), deviceId: deviceId, accepts: on ? 1 : 0))
    }

    /// The Messages header's name and photo. While the page is public, an admin device publishes just this change at
    /// once (other drafts stay drafts); otherwise it is a draft like any other. Returns a sentence when refused.
    public func setQuickProfile(displayName: String, avatar: [UInt8]?, removeAvatar: Bool = false) async -> String? {
        let name = displayName.trimmingCharacters(in: .whitespacesAndNewlines).precomposedStringWithCanonicalMapping
        if let r = VoiciText.checkVoiciText(.displayName, name) {
            return r == .tooShort ? String(localized: "Add a display name.") : Self.textSentence(r)
        }
        if let avatar { VoiciImageStore.save(avatar) }
        let sha = removeAvatar ? nil : avatar.map { CanonicalJson.sha256Hex($0) } ?? preview.profile.avatar
        if isPublic && isAdmin {
            var q = base.profile
            q.displayName = name
            q.avatar = sha
            guard q != base.profile else { return nil }
            await publishQuick([VoiciDraftOp(opId: newId(), op: "profile", at: max(now(), base.issuedAt + 1), deviceId: deviceId, profile: q)])
            return publishError
        }
        var q = preview.profile
        q.displayName = name
        q.avatar = sha
        guard q != preview.profile else { return nil }
        await setProfile(q, avatar: avatar)
        return nil
    }

    public func addPost(text: String, links: [VoiciPostLink], images: [String: [UInt8]]) async {
        let post = VoiciPost(id: newId(), createdAt: now(), editedAt: nil, text: text, links: links)
        await record(VoiciDraftOp(opId: newId(), op: "post-add", at: now(), deviceId: deviceId, post: post, images: draftImages(images)))
    }

    public func editPost(_ post: VoiciPost, images: [String: [UInt8]] = [:]) async {
        var p = post
        p.editedAt = now()
        await record(VoiciDraftOp(opId: newId(), op: "post-edit", at: now(), deviceId: deviceId, post: p, images: draftImages(images)))
    }

    public func deletePost(_ id: String) async {
        await record(VoiciDraftOp(opId: newId(), op: "post-delete", at: now(), deviceId: deviceId, postId: id))
    }

    private func draftImages(_ images: [String: [UInt8]]) -> [VoiciDraftImage]? {
        guard !images.isEmpty else { return nil }
        return images.sorted { $0.key < $1.key }.prefix(VoiciMessages.draftMaxImages).map { sha, b in
            VoiciImageStore.save(b)
            return VoiciDraftImage(sha256: sha, data: CanonicalJson.b64Encode(b))
        }
    }

    // MARK: handing an edit to the admin phone (non-admin devices, §5.2)

    private func handOff(_ op: VoiciDraftOp) async {
        guard let client, let key = deviceKey(), let umk = Keystore.messagesUMKIfCached() else { return }
        let devicePub = HexUtil.encode(key.publicKey.rawRepresentation)
        guard let grants = try? await client.deviceGrants(username: username),
              let mine = grants.first(where: { $0["devicePubHex"]?.string?.lowercased() == devicePub && ($0["expiresAt"]?.time ?? 0) > now() }),
              let sig = mine["signatureHex"]?.string?.lowercased() else { return }
        var grant: [String: JSONValue] = [:]
        for k in ["grantId", "username", "deviceId", "devicePubHex", "scopes", "issuedAt", "expiresAt"] { grant[k] = mine[k] }
        local.draftSeq += 1
        guard let env = try? VoiciOwner.draft(op: op, username: username, draftsKey: VoiciMessages.deriveVoiciDraftsKey(umk: Array(umk)),
                                              deviceSeed: Array(key.rawRepresentation), grant: .object(grant), grantSignature: sig,
                                              seq: local.draftSeq, now: now()) else { return }
        let adminDevices = Set(grants.filter { g in
            g["signerRoot"]?.string == "admin-root" && (g["scopes"]?.array ?? []).contains(.string("admin"))
        }.compactMap { $0["devicePubHex"]?.string?.lowercased() })
        if directDelivery, await PhoneDelivery.deliverDraft(env.json, username: username, adminDevices: adminDevices) {
            local.handed[op.opId] = "phone@\(index?.seq ?? 0)"
        } else if let device {
            do {
                try await client.depositDraft(username: username, envelope: env.json, device: device)
                local.handed[op.opId] = "lane"
            } catch {
                lastError = Self.sentence(error)
            }
        }
        save()
    }

    // MARK: publishing (admin devices, §5.1, §5.3)

    /// The sensitive key when it needs no prompt (the unlocked session's admin root, else its IRK).
    func silentSigner() -> Curve25519.Signing.PrivateKey? {
        Keystore.hasAdminRoot ? Keystore.sessionAdminRoot() : Keystore.sessionIRKIfCached()
    }

    /// The sensitive key for one signature: the unlocked session's key when it needs no prompt, else Face ID. The same
    /// rule for publishing and removing the page, so neither is ever signed with a weaker key or more silently.
    private func sensitiveSigner(reason: String) async -> Curve25519.Signing.PrivateKey? {
        if let s = silentSigner() { return s }
        do {
            return try await ServerOrderSaver.sensitiveOrderKey(reason: reason)
        } catch {
            publishError = Self.sentence(error)
            return nil
        }
    }

    /// The editor's Publish bar: every pending change (this device's and the other devices'), Face ID when the session
    /// holds no key. The caller has already shown the one-time warning when the page is not public.
    public func publishNow() async {
        guard let s = await sensitiveSigner(reason: String(localized: "Publish your page")) else { return }
        await publish(signer: s)
    }

    /// The Public switch turned on: the page goes up with its name and photo as the header shows them, on top of what
    /// was published last (a page turned off comes back as it was); every other draft stays a draft.
    public func goPublic() async {
        guard isAdmin, !isPublic else { return }
        var q = base.profile
        q.displayName = preview.profile.displayName
        q.avatar = preview.profile.avatar
        await publishQuick([VoiciDraftOp(opId: newId(), op: "profile", at: max(now(), base.issuedAt + 1), deviceId: deviceId, profile: q)], mayRepublish: true)
    }

    /// Publishes exactly `ops` (never the other drafts).
    func publishQuick(_ ops: [VoiciDraftOp], mayRepublish: Bool = false) async {
        guard let s = await sensitiveSigner(reason: String(localized: "Publish your page")) else { return }
        await publish(signer: s, only: ops, mayRepublish: mayRepublish)
    }

    /// Rotate the inbox key: the next index names `inboxEpoch + 1`; messages sealed to the old key stay readable here.
    /// Only the key changes: drafts stay drafts.
    public func rotateInbox() async {
        guard let idx = index, isPublic else { return }
        local.pendingEpoch = idx.inboxEpoch + 1
        save()
        guard let s = await sensitiveSigner(reason: String(localized: "Publish your page")) else { return }
        await publish(signer: s, only: [])
    }

    /// - Parameters:
    ///   - only: publish just these ops on top of the published page; nil publishes every pending change.
    ///   - mayRepublish: only the Public switch (after its warning) may bring back a page another device took down;
    ///     any other publish that learns of the removal from a 409 stops there.
    func publish(signer: Curve25519.Signing.PrivateKey?, only: [VoiciDraftOp]? = nil, mayRepublish: Bool = false) async {
        guard let signer, isAdmin, let client, !isPublishing else { return }
        isPublishing = true
        publishError = nil
        defer { isPublishing = false }
        for _ in 0..<3 {
            do {
                try await publishOnce(client, signer, only: only)
                return
            } catch let e as VoiciComError where e.code == "seq-conflict" {
                // Another admin device published (or removed the page) first: take what `.com` holds, merge again,
                // re-sign the next seq. Bounded: three tries in all.
                await takeConflict(client, e)
                if isRemoved && !mayRepublish { return }
            } catch let e as VoiciComError where e.code == "wrong-page" && index == nil && e.storedPageId.map({ CanonicalJson.isLowerHex($0, bytes: 16) }) == true {
                // A device that never saw the page (it was removed before) continues it under its own pageId.
                local.pageId = e.storedPageId!
                save()
            } catch {
                publishError = Self.sentence(error)
                return
            }
        }
        publishError = String(localized: "Couldn't publish. Try again.")
    }

    /// A 409's stored index (checked against the account's own key, never older than what this device saw), or, for a
    /// removed page, the seq the ladder stands at.
    private func takeConflict(_ client: any VoiciComClient, _ e: VoiciComError) async {
        if e.storedRemoved {
            // Taken down (on another device): its stored index is the old public one, its seq the removal's.
            local.highestSeq = max(local.highestSeq, e.storedSeq ?? 0)
            if let p = e.storedPageId, index == nil { local.pageId = p }
            if index != nil { isRemoved = true }
            save()
        } else if let raw = e.stored, raw != .null, let keys = accountKeys {
            try? await adopt(raw, client, keys)
        } else if let keys = accountKeys {
            try? await loadPage(client, keys)
        }
    }

    /// The seq the next signed record takes: one above anything this device saw (a publish or a removal).
    private var nextSeq: Int64 { max(index?.seq ?? 0, local.highestSeq) + 1 }

    private func publishOnce(_ client: any VoiciComClient, _ signer: Curve25519.Signing.PrivateKey, only: [VoiciDraftOp]?) async throws {
        let epoch = local.pendingEpoch ?? index?.inboxEpoch ?? 1
        guard let k = keys(epoch: epoch) else { throw VoiciComError(status: 0, code: "locked") }
        let ops = only ?? (ownOps + laneOps.filter { op in !ownOps.contains { $0.opId == op.opId } })
        let merged = VoiciPage.mergeVoiciPage(base, ops: ops)
        var images: [String: [UInt8]] = [:]
        for sha in VoiciOwner.imageHashes(merged) { images[sha] = VoiciImageStore.load(sha) }
        guard let pieces = try VoiciOwner.pieces(merged, images: images) else { throw VoiciComError(status: 0, code: "missing-image") }
        let seed = Array(signer.rawRepresentation)
        let signerPub = HexUtil.encode(signer.publicKey.rawRepresentation)
        // After a removal `.com` may have dropped the pieces: send them all again.
        let have = isRemoved ? [] : Set(index?.pieces.map(\.sha256) ?? [])
        for p in pieces where !have.contains(p.ref.sha256) {
            let up = VoiciPieceUpload(username: username, pageId: k.pageId, sha256: p.ref.sha256, size: p.ref.size, issuedAt: now())
            try await client.uploadPiece(username: username, upload: up, signerPub: signerPub,
                                         signature: try VoiciPage.signVoiciPieceUpload(up, signerSeed: seed), bytes: p.bytes)
        }
        let body = VoiciPageIndex(username: username, pageId: k.pageId, seq: nextSeq, issuedAt: now(),
                                  acceptsMessages: merged.acceptsMessages, inboxEpoch: epoch, inboxPub: k.inboxPub, ownerSignPub: k.signPub,
                                  pieces: pieces.map(\.ref), signerKind: Keystore.hasAdminRoot ? "admin-root" : "irk")
        let idx = try VoiciPage.signVoiciPageIndex(body, signerSeed: seed)
        try await client.publish(username: username, index: idx.json)
        if only == nil {
            let laneIds = laneOps.map(\.opId)
            if !laneIds.isEmpty {
                let at = now()
                let sig = try CanonicalJson.ed25519SignHex(VoiciComPaths.canonicalDraftsConsume(username: username, opIds: laneIds, issuedAt: at), seed: seed)
                try? await client.consumeDrafts(username: username, opIds: laneIds, issuedAt: at, signerPub: signerPub, signature: sig)
            }
            ownOps = []
            laneOps = []
        } else {
            ownOps = Self.carry(ownOps, over: merged, issuedAt: idx.issuedAt)
            laneOps = Self.carry(laneOps, over: merged, issuedAt: idx.issuedAt)
        }
        index = idx
        isRemoved = false
        published = VoiciPageState(profile: merged.profile, acceptsMessages: merged.acceptsMessages, chunks: merged.chunks, issuedAt: idx.issuedAt)
        local.highestSeq = idx.seq
        local.pageId = idx.pageId
        local.pendingEpoch = nil
        PageWelcomeCardStore.recordPublished(username: username)
        save()
        updatePhoneInbox()
    }

    /// The drafts left after a quick publish: profile drafts take the name and photo just published (and vanish when
    /// nothing else in them differs), and profile and accept-messages drafts stay newer than the published page, so
    /// the merge (later `at` wins) still applies them.
    nonisolated static func carry(_ ops: [VoiciDraftOp], over published: VoiciPageState, issuedAt: Int64) -> [VoiciDraftOp] {
        ops.compactMap { op in
            var o = op
            if o.op == "profile", var p = o.profile {
                p.displayName = published.profile.displayName
                p.avatar = published.profile.avatar
                if p == published.profile { return nil }
                o.profile = p
                o.images = o.images?.filter { $0.sha256 == p.avatar }
                if o.images?.isEmpty == true { o.images = nil }
            }
            if o.op == "profile" || o.op == "accept-messages" { o.at = max(o.at, issuedAt + 1) }
            return o
        }
    }

    /// "Remove my page": a signed VoiciPageRemove on the publish ladder (seq + 1), with the key and the Face ID rule
    /// publishing uses. Visitors then see "There's no page here."; posts, profile, drafts and conversations stay here.
    public func removePage() async {
        guard isAdmin, isPublic, let client, var current = index, !isPublishing else { return }
        guard let signer = await sensitiveSigner(reason: String(localized: "Remove your page")) else { return }
        isPublishing = true
        publishError = nil
        defer { isPublishing = false }
        for attempt in 0..<2 {
            do {
                let r = try VoiciPageRemove.sign(username: username, pageId: current.pageId, seq: max(current.seq, local.highestSeq) + 1,
                                                 issuedAt: now(), signerKind: Keystore.hasAdminRoot ? "admin-root" : "irk",
                                                 signerSeed: Array(signer.rawRepresentation))
                try await client.removePage(username: username, remove: r.json)
                local.highestSeq = r.seq
                isRemoved = true
                save()
                updatePhoneInbox()
                return
            } catch let e as VoiciComError where e.code == "seq-conflict" && attempt == 0 {
                // Another admin device published first: refresh and retry once, on the index `.com` now holds.
                await takeConflict(client, e)
                guard let i = index, isPublic else { return }
                current = i
            } catch let e as VoiciComError where e.code == "not-found" {
                // Already gone (removed on another device).
                isRemoved = true
                save()
                updatePhoneInbox()
                return
            } catch {
                publishError = Self.removeSentence(error)
                return
            }
        }
        publishError = String(localized: "Couldn't remove your page. Try again.")
    }

    static func removeSentence(_ error: Error) -> String {
        if let e = error as? VoiciComError, e.code == "wrong-signer" { return String(localized: "Only an admin device can remove your page.") }
        return sentence(error)
    }

    // MARK: Messages actions (§7.4, §9, §10.1)

    public func reply(to conv: String, text: String, replyTo: String? = nil) async -> Bool {
        guard let client, let idx = index, let c = conversation(conv), !c.threadPub.isEmpty, let k = keys() else { return false }
        if let refused = VoiciText.checkVoiciText(.messageText, text) {
            lastError = Self.textSentence(refused)
            return false
        }
        do {
            let env = try VoiciOwner.reply(text: text, replyTo: replyTo, conversation: c, pageId: idx.pageId, pageSeq: idx.seq,
                                           ownerSign: (k.sign.seed, k.signPub), inboxPub: k.inbox.publicKey,
                                           seq: VoiciOwner.nextReplySeq(c, ownerSignPub: k.signPub), now: now())
            try await client.send(envelope: env.json, direct: false)
            local.items.append(VoiciInboxItem(envelope: env.json, storedAt: now()))
            save()
            await rebuildAsync()
            return true
        } catch {
            lastError = Self.sentence(error)
            return false
        }
    }

    public func setBlocked(_ c: VoiciConversation, _ blocked: Bool) async {
        guard let client, let idx = index, let k = keys() else { return }
        let b = VoiciBlock(pageId: idx.pageId, pseudonymPub: c.pseudonymPub, op: blocked ? "block" : "unblock", issuedAt: now())
        do {
            try await client.block(username: username, block: b, signature: try VoiciMessages.signVoiciBlock(b, ownerSignSeed: k.sign.seed))
        } catch {
            lastError = Self.sentence(error)
            return
        }
        await editState { s in
            s.blocks.removeAll { $0 == c.pseudonymPub }
            if blocked { s.blocks.append(c.pseudonymPub) }
        }
    }

    /// Report one message to Flagship (§9.2). The 0.3 apps send the signed envelope only (no attached text).
    public func report(_ m: VoiciThreadMessage, reason: String) async -> Bool {
        guard let client, let idx = index, let k = keys() else { return false }
        let r = VoiciMessageReport(pageId: idx.pageId, envelope: m.envelope, reason: reason, attached: nil, issuedAt: now())
        do {
            let sig = try VoiciMessages.signVoiciMessageReport(r, ownerSignSeed: k.sign.seed)
            let body: JSONValue = ["kind": "message", "pageId": .string(r.pageId), "envelope": r.envelope, "reason": .string(reason),
                                   "attached": .null, "issuedAt": .int(r.issuedAt)]
            try await client.report(report: body, signature: sig)
            return true
        } catch {
            lastError = Self.sentence(error)
            return false
        }
    }

    public func rename(_ c: VoiciConversation, to name: String) async -> String? {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines).precomposedStringWithCanonicalMapping
        if !trimmed.isEmpty, let refused = VoiciText.checkVoiciText(.nickname, trimmed) { return Self.textSentence(refused) }
        await editState { s in s.nicknames[c.pseudonymPub] = MessagesState.Nickname(name: trimmed, at: self.now()) }
        return nil
    }

    /// Accept a request: here and on the owner's devices (state blob), and on `.com` as a signed `unblock` of the
    /// pseudonym, which lifts the 3-before-a-reply limit (release manager, B1).
    public func accept(_ c: VoiciConversation) async {
        if let client, let idx = index, let k = keys() {
            let b = VoiciBlock(pageId: idx.pageId, pseudonymPub: c.pseudonymPub, op: "unblock", issuedAt: now())
            if let sig = try? VoiciMessages.signVoiciBlock(b, ownerSignSeed: k.sign.seed) {
                try? await client.block(username: username, block: b, signature: sig)
            }
        }
        await editState { s in if !s.accepted.contains(c.conv) { s.accepted.append(c.conv) } }
    }

    public func delete(_ c: VoiciConversation) async {
        await editState { s in if !s.archived.contains(c.conv) { s.archived.append(c.conv) } }
        local.items.removeAll { $0.envelope["conv"]?.string == c.conv }
        save()
        conversations.removeAll { $0.conv == c.conv }
    }

    public func markRead(_ c: VoiciConversation) async {
        guard let last = c.messages.last(where: { !$0.fromOwner }), state.readUpTo[c.conv] != last.msgId else { return }
        await editState { s in s.readUpTo[c.conv] = last.msgId }
    }

    /// Websites this account is signed in to (as a visitor): sign one out (§6.4). P's signature is enough for `.com`
    /// to refuse that browser, so any device can do it; the delegation, where this device kept it, also lists the
    /// sign-out on the page. The site leaves the list only once `.com` said yes.
    public func signOut(site: MessagesState.SignedInSite) async {
        guard let client, let umk = Keystore.messagesUMKIfCached(),
              let p = try? VoiciMessages.deriveMessagesPseudonymKey(messagesSecret: VoiciMessages.deriveMessagesSecret(umk: Array(umk)), pageId: site.pageId)
        else { return }
        do {
            try await VoiciSignOut.send(client, pageId: site.pageId, delegatePub: site.delegatePub, pseudonymSeed: p.seed,
                                        kept: VoiciSignInBook.delegation(site.delegatePub), now: now())
        } catch let e as VoiciComError where e.status == 0 || e.code == "rate-limited" {
            lastError = Self.sentence(e)
            return
        } catch {
            lastError = String(localized: "Couldn't sign out of that website. Try again.")
            return
        }
        await editState { s in s.signedInSites.removeAll { $0.delegatePub == site.delegatePub } }
    }

    func recordSignIn(pageId: String, delegatePub: String) async {
        await editState { s in
            s.signedInSites.removeAll { $0.delegatePub == delegatePub }
            s.signedInSites.append(MessagesState.SignedInSite(pageId: pageId, delegatePub: delegatePub, at: self.now()))
        }
    }

    /// Changes the state blob here and on `.com` (version compare-and-set; a conflict merges and retries).
    func editState(_ change: (inout MessagesState) -> Void) async {
        change(&state)
        save()
        guard let client, let umk = Keystore.messagesUMKIfCached(), let device else { return }
        let key = VoiciMessages.deriveMessagesStateKey(umk: Array(umk))
        for _ in 0..<3 {
            guard let sealed = try? VoiciMessages.sealMessagesState(stateKey: key, username: username, version: local.stateVersion + 1, state: state) else { return }
            do {
                try await client.putMessagesState(username: username, blob: sealed, device: device)
                local.stateVersion += 1
                save()
                return
            } catch let e as VoiciComError where e.code == "version-conflict" {
                if let remote = VoiciMessages.openMessagesState(stateKey: key, username: username, blob: e.stored) {
                    state = VoiciMessages.mergeMessagesState(local: state, remote: remote)
                }
                local.stateVersion = e.stored?["version"]?.time ?? local.stateVersion
            } catch {
                return
            }
        }
    }

    // MARK: replies to this account as a visitor (owner decision: "You have a reply on voi.ci/<x>")

    public struct ReplyNotice: Identifiable, Equatable, Sendable {
        public let pageId: String
        public let username: String
        public let latest: Int64
        public var id: String { pageId }
        public var url: URL { URL(string: "https://\(Endpoints.voiciHost)/\(username)")! }
    }

    public private(set) var replyNotices: [ReplyNotice] = []
    @ObservationIgnored private var checkingReplies = false

    /// On open and foreground only (no push, no background polling): for each page this account signed in to (state
    /// blob), fetch its own conversation with the app's own delegated key, check each owner reply against the page's
    /// signed key, and note a reply newer than the last one seen. The conversation itself stays on voi.ci.
    public func checkReplies() async {
        guard hasAccount, let client, !checkingReplies, let umk = Keystore.messagesUMKIfCached() else { return }
        checkingReplies = true
        defer { checkingReplies = false }
        let secret = VoiciMessages.deriveMessagesSecret(umk: Array(umk))
        let ca = await client.caKeys()
        var out: [ReplyNotice] = []
        for pageId in Set(state.signedInSites.map(\.pageId)).sorted() {
            guard let user = VoiciSignInBook.username(pageId: pageId),
                  let latest = await latestReply(client, secret: secret, pageId: pageId, username: user, caKeys: ca) else { continue }
            if latest > UserDefaults.standard.double(forKey: Self.seenKey(pageId)).int64 { out.append(ReplyNotice(pageId: pageId, username: user, latest: latest)) }
        }
        replyNotices = out
    }

    /// The reply notice was tapped: the page opens on voi.ci and the notice goes.
    public func openedReply(_ n: ReplyNotice) {
        UserDefaults.standard.set(Double(n.latest), forKey: Self.seenKey(n.pageId))
        replyNotices.removeAll { $0.pageId == n.pageId }
    }

    static func seenKey(_ pageId: String) -> String { "flagship.voici.replySeen.\(pageId)" }
    static func cursorKey(_ pageId: String) -> String { "flagship.voici.replyCursor.\(pageId)" }

    /// The newest verified owner reply's storedAt (also from earlier fetches), or nil.
    private func latestReply(_ client: any VoiciComClient, secret: [UInt8], pageId: String, username: String, caKeys: [String]) async -> Int64? {
        let t = now()
        guard let p = try? VoiciMessages.deriveMessagesPseudonymKey(messagesSecret: secret, pageId: pageId),
              let att = UserDefaults.standard.string(forKey: VoiciSignInBook.attestationKey(pageId)).flatMap({ JSONValue.parse($0) }),
              case .ok(let a) = MessagesAttestations.checkMessagesKeyAttestation(att, caKeys: caKeys, now: t, pseudonymPub: CanonicalJson.hex(p.publicKey)),
              let keys = try? await client.accountKeys(username: username), let raw = try? await client.page(username: username),
              case .ok(let idx) = VoiciPage.checkVoiciPageIndex(raw, username: username, sensitiveKind: keys.sensitive.kind,
                                                                 sensitivePub: keys.sensitive.pub, pageId: pageId),
              let conv = try? VoiciMessages.voiciConv(pageId: pageId, pseudonymPub: CanonicalJson.hex(p.publicKey)) else { return nil }
        // The app's own browser-like key for this page, derived so every device of the account has the same one.
        let readerSeed = HKDF<SHA256>.deriveKey(inputKeyMaterial: SymmetricKey(data: secret), salt: Data(),
                                                info: Data("flagship/voici-app-reader/v1|\(pageId)".utf8), outputByteCount: 32)
        guard let reader = try? P256.Signing.PrivateKey(rawRepresentation: readerSeed.withUnsafeBytes { Data($0) }) else { return nil }
        let nonce = CanonicalJson.hex(Array(SHA256.hash(data: Data("\(pageId)|\(a.issuedAt)".utf8)).prefix(16)))
        let d = WebDelegation(scope: "voici-messages", origin: Endpoints.voiciOrigin, audience: pageId, principalPub: CanonicalJson.hex(p.publicKey),
                              delegatePub: CanonicalJson.hex(Array(reader.publicKey.x963Representation)), issuedAt: a.issuedAt,
                              expiresAt: a.expiresAt, nonce: nonce)
        guard let dsig = try? WebDelegations.signWebDelegation(d, principalSeed: p.seed) else { return nil }
        let cred: JSONValue = ["attestation": a.json, "delegation": d.json, "delegationSig": .string(dsig)]
        var since = UserDefaults.standard.string(forKey: Self.cursorKey(pageId)) ?? ""
        var latest = UserDefaults.standard.double(forKey: Self.seenKey(pageId)).int64
        for _ in 0..<10 {
            let f = VoiciThreadFetch(conv: conv, since: since, issuedAt: now())
            guard let bytes = try? f.canonicalBytes(), let sig = try? reader.signature(for: Data(bytes)),
                  let page = try? await client.thread(fetch: f, signature: CanonicalJson.hex(Array(sig.rawRepresentation)), cred: cred) else { break }
            for item in page.items where item.envelope["kind"]?.string == "voici-reply"
                && VoiciMessages.checkVoiciReply(item.envelope, pageId: pageId, ownerSignPub: idx.ownerSignPub, conv: conv).isOk {
                latest = max(latest, item.storedAt)
            }
            since = page.next
            UserDefaults.standard.set(since, forKey: Self.cursorKey(pageId))
            UserDefaults.standard.set(max(Double(latest), UserDefaults.standard.double(forKey: Self.latestKey(pageId))), forKey: Self.latestKey(pageId))
            if !page.more { break }
        }
        let known = UserDefaults.standard.double(forKey: Self.latestKey(pageId)).int64
        return known > 0 ? known : nil
    }

    static func latestKey(_ pageId: String) -> String { "flagship.voici.replyLatest.\(pageId)" }

    // MARK: the phone endpoint (§8.2)

    /// Hands the phone endpoint what it needs to take deliveries while this admin phone is open and unlocked.
    func updatePhoneInbox() {
        guard isAdmin, let idx = index, let k = keys(epoch: idx.inboxEpoch), let device = deviceKey(), let client else {
            phoneInbox.set(nil)
            return
        }
        let accountKeys = [accountKeys?.adminRootPub, accountKeys?.irkPub].compactMap { $0 }
        phoneInbox.set(MessagesPhoneInbox.Snapshot(
            username: username, pageId: idx.pageId, accepts: idx.acceptsMessages == 1, ownerSignSeed: k.sign.seed, ownerSignPub: k.signPub,
            draftsKey: VoiciMessages.deriveVoiciDraftsKey(umk: k.umk), deviceSeed: Array(device.rawRepresentation),
            phoneRoutePub: HexUtil.encode(device.publicKey.rawRepresentation), blocked: Set(state.blocks + local.blocks),
            revoked: Set(local.revoked), accountKeys: accountKeys, origin: Endpoints.voiciOrigin, client: client))
        phoneInbox.onMessage = { [weak self] env in Task { @MainActor in await self?.received(message: env) } }
        phoneInbox.onDraft = { [weak self] op in Task { @MainActor in await self?.received(draft: op) } }
    }

    func received(message env: JSONValue) async {
        guard let id = env["msgId"]?.string, !local.items.contains(where: { $0.envelope["msgId"]?.string == id }) else { return }
        local.items.append(VoiciInboxItem(envelope: env, storedAt: now(), direct: true))
        local.deliveredToPhone.insert(id)
        save()
        await rebuildAsync()
    }

    func received(draft op: VoiciDraftOp) async {
        guard !laneOps.contains(where: { $0.opId == op.opId }) else { return }
        for im in op.images ?? [] { if let b = CanonicalJson.b64Decode(im.data) { VoiciImageStore.save(b) } }
        laneOps.append(op)
        local.handed[op.opId] = "received"
        save()
    }

    /// The app locked or went to the background: drop every key from memory.
    public func lock() {
        phoneInbox.set(nil)
        stopPolling()
    }

    // MARK: sentences

    static func sentence(_ error: Error) -> String {
        guard let e = error as? VoiciComError else { return UserErrorText.of(error) }
        switch e.code {
        case "network": return String(localized: "Couldn't reach Flagship. Check your connection and try again.")
        case "locked": return String(localized: "Unlock Flagship to use Messages.")
        case "rate-limited":
            return e.retryAfterSec.map { String(localized: "Too many tries. Try again in about \(max(1, $0 / 60)) minutes.") }
                ?? String(localized: "Too many tries. Try again later.")
        case "taken-down": return String(localized: "This page was removed by Flagship. You can appeal from flagshipserver.com/abuse.")
        case "banned": return String(localized: "Your account can't send messages. If you think this is a mistake, tell us.")
        case "missing-image": return String(localized: "A photo for this page is missing on this device. Pick it again.")
        case "page-unchecked": return String(localized: "Your published page couldn't be checked. Try again later.")
        case "not-sensitive-key", "bad-signature": return String(localized: "Only an admin device can publish this page.")
        case "awaiting-reply": return String(localized: "Reply first to keep this conversation going.")
        default: return String(localized: "Something went wrong. Try again.")
        }
    }

    static func textSentence(_ r: VoiciText.Refusal) -> String {
        switch r {
        case .tooLong: return String(localized: "That's too long.")
        case .tooShort: return String(localized: "Write something first.")
        default: return String(localized: "That text has characters a page can't show.")
        }
    }

    // MARK: storage

    private var fileURL: URL? {
        guard !username.isEmpty else { return nil }
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("flagship-messages", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("\(username).json")
    }

    /// Only public or sealed things are kept: envelopes as received (ciphertext), own pending edits, the state blob's
    /// plaintext is not written here (it lives sealed on `.com`) except the parts the screens need offline.
    private func save() {
        guard let url = fileURL else { return }
        let v: JSONValue = [
            "pageId": .string(local.pageId), "highestSeq": .int(local.highestSeq), "pendingEpoch": .optInt(local.pendingEpoch),
            "cursor": .string(local.cursor), "stateVersion": .int(local.stateVersion), "draftSeq": .int(local.draftSeq),
            "deliveredToPhone": .array(local.deliveredToPhone.sorted().map { .string($0) }),
            "handed": .object(local.handed.mapValues { .string($0) }),
            "items": .array(local.items.map { ["envelope": $0.envelope, "storedAt": .int($0.storedAt), "fetchedAt": .optInt($0.fetchedAt), "direct": .bool($0.direct)] }),
            "ownOps": .array(ownOps.map(\.json)),
            "laneOps": .array(laneOps.map(\.json)),
            "index": index?.json ?? .null,
            "removed": .bool(isRemoved),
            // The published content is public; kept so a page turned off can come back as it was.
            "published": published?.json ?? .null,
        ]
        guard let text = try? CanonicalJson.canonicalJson(v) else { return }
        try? Data(text.utf8).write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    /// The account leaves this device (`Keystore.wipe`): its copy (the page, a removed page's content, drafts,
    /// conversations) goes with it; a full reset also drops every account's copy and the page images.
    nonisolated static func forgetLocal(username: String?, allProfiles: Bool) {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let dir = support.appendingPathComponent("flagship-messages", isDirectory: true)
        if allProfiles {
            try? FileManager.default.removeItem(at: dir)
            try? FileManager.default.removeItem(at: support.appendingPathComponent("flagship-voici-images", isDirectory: true))
        } else if let u = username?.lowercased(), !u.isEmpty {
            try? FileManager.default.removeItem(at: dir.appendingPathComponent("\(u).json"))
        }
    }

    /// Wires `Keystore.onWipe` (once, at launch).
    public static func installWipeHook() {
        Keystore.onWipe = { all in
            let u = currentUsername
            forgetLocal(username: u, allProfiles: all)
            Task { @MainActor in shared.forgetInMemory() }
        }
    }

    /// The configured account, readable from `Keystore.onWipe` (which may run off the main actor).
    nonisolated(unsafe) static var currentUsername: String?

    /// VoiciPageState.json read back (this device's own copy; each piece is checked like a published one).
    nonisolated static func parseState(_ v: JSONValue) -> VoiciPageState? {
        guard let profile = VoiciPage.parseVoiciProfile(v["profile"]), let accepts = v["acceptsMessages"]?.safeInt,
              let chunks = v["chunks"]?.array, let issuedAt = v["issuedAt"]?.safeInt else { return nil }
        var out: [[VoiciPost]] = []
        for c in chunks {
            guard let posts = c.array?.compactMap({ VoiciPage.parseVoiciPost($0) }) else { return nil }
            out.append(posts)
        }
        return VoiciPageState(profile: profile, acceptsMessages: accepts, chunks: out, issuedAt: issuedAt)
    }

    private func load() {
        guard let url = fileURL, let data = try? Data(contentsOf: url), let v = JSONValue.parse(utf8: Array(data)) else { return }
        local.pageId = v["pageId"]?.string ?? ""
        local.highestSeq = v["highestSeq"]?.time ?? 0
        local.pendingEpoch = v["pendingEpoch"]?.time
        local.cursor = v["cursor"]?.string ?? ""
        local.stateVersion = v["stateVersion"]?.time ?? 0
        local.draftSeq = v["draftSeq"]?.time ?? 0
        local.deliveredToPhone = Set((v["deliveredToPhone"]?.array ?? []).compactMap(\.string))
        local.handed = (v["handed"]?.object ?? [:]).compactMapValues(\.string)
        local.items = (v["items"]?.array ?? []).compactMap { i in
            guard let e = i["envelope"], let at = i["storedAt"]?.time else { return nil }
            return VoiciInboxItem(envelope: e, storedAt: at, fetchedAt: i["fetchedAt"]?.time, direct: i["direct"] == .bool(true))
        }
        ownOps = (v["ownOps"]?.array ?? []).compactMap { VoiciMessages.parseVoiciDraftOp($0) }
        laneOps = (v["laneOps"]?.array ?? []).compactMap { VoiciMessages.parseVoiciDraftOp($0) }
        if let raw = v["index"], let idx = VoiciPage.parseVoiciPageIndex(raw) { index = idx }
        isRemoved = v["removed"] == .bool(true)
        published = v["published"].flatMap(Self.parseState)
    }
}

/// Re-encoded JPEGs (the avatar and link-card images) by SHA-256, kept on the device until published.
enum VoiciImageStore {
    static var dir: URL {
        let d = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("flagship-voici-images", isDirectory: true)
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }

    static func save(_ bytes: [UInt8]) {
        guard VoiciPage.isVoiciJpeg(bytes) else { return }
        try? Data(bytes).write(to: dir.appendingPathComponent(CanonicalJson.sha256Hex(bytes)), options: .atomic)
    }

    static func load(_ sha: String) -> [UInt8]? {
        guard CanonicalJson.isLowerHex(sha, bytes: 32), let d = try? Data(contentsOf: dir.appendingPathComponent(sha)),
              CanonicalJson.sha256Hex(Array(d)) == sha else { return nil }
        return Array(d)
    }
}

private extension Double {
    var int64: Int64 { Int64(self) }
}
