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
    public private(set) var index: VoiciPageIndex? {
        didSet {
            // Calls just came on (a publish here or another device's): this phone sends its VoIP token again, which it
            // could not do while there was no page, so it rings without waiting for the next unlock.
            if index?.takesCalls == true, oldValue?.takesCalls != true { Self.callsTurnedOn?() }
        }
    }
    /// Set by the call center (iOS): sends this device's VoIP token to `.com`.
    public static var callsTurnedOn: (@MainActor () -> Void)?
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
    /// Missed calls opened and checked here (docs/voici-calls.md §6), shown in their conversation's thread.
    public private(set) var missedCalls: [VoiciMissedCallRow] = []
    /// "Answer calls while Flagship is locked" is on here: this device holds a bound call key.
    public private(set) var answersWhileLocked = false
    /// "Show names while locked" is on here (docs/voici-locked-caller-names.md): this device keeps the locked-names table.
    public private(set) var showsNamesWhileLocked = false
    /// The synced state blob was read this session (or `.com` holds none): only then is the locked-names table rebuilt,
    /// so a cold start before the unlock never writes an empty one over a good one.
    @ObservationIgnored private var stateLoaded = false
    /// A calls change being published (`setCalls`); nil: every publish carries the index's own calls setting.
    @ObservationIgnored private var pendingCalls: (on: Bool, from: String)?
    /// "Show in search engines" while its own publish is signed (nil: carry the published index's value).
    @ObservationIgnored private var pendingSearch: Bool?

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
        /// Delete = forget (docs/voici-and-messages.md §10.1.1): conv → the deletion marker's `at` this device already
        /// acted on, so what it keeps of a conversation that came back after the delete stays.
        var forgetApplied: [String: Int64] = [:]
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
        state = MessagesState(); phase = .idle; publishError = nil; lastError = nil; isRemoved = false; missedCalls = []
        reveals = [:]; ringBackFlags = [:]; noRingBack = []; callSettings = nil; callSettingsVersion = 0
        local = Local()
        stateLoaded = false
        VoiciCallHistory.shared.configure(username: u.isEmpty ? nil : u)
        VoiciCallHistory.shared.onChange = { [weak self] in self?.rebuildLockedNames() }
        showsNamesWhileLocked = VoiciLockedNamesSettings.isOn(u)
        guard !u.isEmpty else { return }
        VoiciCallKeyStore.rememberAccount(u)
        answersWhileLocked = VoiciCallKeyStore.load(username: u) != nil
        // A sample account's example page is read from `.com` each time; no copy of it is kept on the device.
        if !isSampleReadOnly { load() }
    }

    /// After a wipe: nothing of the account stays in memory, and nothing is written back.
    func forgetInMemory() {
        stopPolling()
        phoneInbox.set(nil)
        username = ""
        Self.currentUsername = nil
        index = nil; published = nil; accountKeys = nil; ownOps = []; laneOps = []; conversations = []
        state = MessagesState(); phase = .idle; publishError = nil; lastError = nil; isRemoved = false; missedCalls = []
        reveals = [:]; ringBackFlags = [:]; noRingBack = []; callSettings = nil; callSettingsVersion = 0
        local = Local()
        stateLoaded = false
        showsNamesWhileLocked = false
        answersWhileLocked = false
        VoiciCallHistory.shared.forgetInMemory()
    }

    public var isAdmin: Bool { Keystore.hasAdminRoot }
    /// Calls are on in the published index (only while the page is public).
    public var callsOn: Bool { isPublic && index?.takesCalls == true }
    /// Who may call: the index's setting while calls are on, else what this device picked last.
    public var callsFrom: String { callsOn ? VoiciCallSettings.read(acceptsCalls: index?.acceptsCalls, callsFrom: index?.callsFrom).from : CallSettingsStore.lastFrom() }
    /// Visitors see the page on voi.ci now.
    public var isPublic: Bool { index != nil && !isRemoved }
    /// "Show in search engines" (owner decision 2026-11-17): the published index says showInSearch 1. Off, voi.ci asks
    /// search engines not to list the page.
    public var showsInSearch: Bool { isPublic && index?.showsInSearch == true }
    public var hasAccount: Bool {
        #if DEBUG
        if sampleAccountsHavePages { return !username.isEmpty }
        #endif
        return !username.isEmpty && !isDemo
    }

    /// A sample account: its page is the example the operator publishes (docs/sample-users.md), read from `.com` and shown
    /// read-only. Nothing is signed here and the UMK is never needed: the device holds no key that signs this page.
    public var isSampleReadOnly: Bool {
        #if DEBUG
        if sampleAccountsHavePages { return false }
        #endif
        return !username.isEmpty && isDemo
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
                                    acceptsMessages: VoiciCallSettings.firstPublishAcceptsMessages, chunks: [], issuedAt: 0)
    }

    /// The next publish is the page's first: this device has seen no index and no removal. It carries the first-publish
    /// defaults (messages on, calls on from people who let the owner call them back); every later publish keeps the owner's choices.
    public var isFirstPublish: Bool { index == nil && !isRemoved && local.highestSeq == 0 }

    /// Changes waiting to be published. Accept messages counts once, and only while it differs from the published page,
    /// so turning it off and on again counts as nothing (a handed-off draft can stay in the lane until the next publish).
    public var pendingCount: Int {
        Set((ownOps + laneOps).filter { $0.op != "accept-messages" }.map(\.opId)).count + (acceptsUnpublished ? 1 : 0)
    }

    /// Accept messages differs from the published page (or, before the first publish, from its default).
    public var acceptsUnpublished: Bool { preview.acceptsMessages != base.acceptsMessages }

    /// Post ids changed by an edit not yet published (shown grayed: "Not published yet").
    public var unpublishedPostIds: Set<String> {
        var s = Set<String>()
        for op in ownOps + laneOps {
            if let p = op.post { s.insert(p.id) }
        }
        return s
    }

    public var profileUnpublished: Bool { (ownOps + laneOps).contains { $0.op == "profile" } }

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
        if isSampleReadOnly {
            await refreshSample()
            return
        }
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
            await loadMissedCalls(client)
            await loadCallSettings(client)
            await rebindCallKeyIfNeeded(client)
            settleHanded()
            await checkReplies()
            phase = .ready
            lastError = nil
            updatePhoneInbox()
            rebuildLockedNames()
        } catch {
            lastError = Self.sentence(error)
            phase = conversations.isEmpty && index == nil ? .failed(lastError ?? "") : .ready
        }
    }

    /// A sample account's example page: the public index checked against the account's own key, its pieces and photos.
    /// No state blob, drafts lane, mailbox or publish; nothing is written to this device's page copy.
    private func refreshSample() async {
        guard let client, !refreshing else { return }
        refreshing = true
        defer { refreshing = false }
        if phase != .ready { phase = .loading }
        do {
            let keys = try await client.accountKeys(username: username)
            accountKeys = keys
            guard let raw = try await client.page(username: username) else {
                index = nil
                published = nil
                phase = .ready
                lastError = nil
                return
            }
            let s = keys.sensitive
            guard case .ok(let idx) = VoiciPage.checkVoiciPageIndex(raw, username: username, sensitiveKind: s.kind, sensitivePub: s.pub),
                  let content = try await VoiciOwner.content(idx, fetch: { try await client.piece(pageId: idx.pageId, sha256: $0.sha256) }) else {
                // Not the account's own page: nothing of it is shown.
                index = nil
                published = nil
                throw VoiciComError(status: 200, code: "page-unchecked")
            }
            for sha in VoiciOwner.imageHashes(content) where VoiciImageStore.load(sha) == nil {
                if let b = try? await client.piece(pageId: idx.pageId, sha256: sha), CanonicalJson.sha256Hex(b) == sha { VoiciImageStore.save(b) }
            }
            index = idx
            published = content
            isRemoved = false
            phase = .ready
            lastError = nil
        } catch {
            lastError = Self.sentence(error)
            phase = index == nil ? .failed(lastError ?? "") : .ready
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
        // A phone-only chunk (§2.7a) comes from this device's own copy when it still has it, else `.com`'s cache; one
        // neither has is carried unchanged by the next publish.
        let mine = published
        guard let content = try await VoiciOwner.content(idx, fetch: { ref in
            if idx.isPhoneChunk(ref.role), let mine, let n = Int(ref.role.dropFirst(6)), let b = VoiciOwner.chunkBytes(mine, n),
               CanonicalJson.sha256Hex(b) == ref.sha256 { return b }
            return try await client.piece(pageId: idx.pageId, sha256: ref.sha256)
        }) else {
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
        guard let umk = Keystore.messagesUMKIfCached() else { return }
        let read: JSONValue?
        do { read = try await client.messagesState(username: username) } catch { return }
        guard let blob = read else {
            stateLoaded = true
            return
        }
        let key = VoiciMessages.deriveMessagesStateKey(umk: Array(umk))
        guard let remote = VoiciMessages.openMessagesState(stateKey: key, username: username, blob: blob) else { return }
        local.stateVersion = blob["version"]?.time ?? local.stateVersion
        state = VoiciMessages.mergeMessagesState(local: state, remote: remote, now: now())
        stateLoaded = true
        applyForgotten()
        save()
    }

    /// For each deletion marker in the synced state this device hasn't acted on yet, everything it keeps by itself of
    /// that conversation goes (§10.1.1): owner side, the stored messages, the checked reveal, ring-back flags, missed
    /// calls and call records; caller side (the conversation is this account's own on another page), that page's
    /// reveal switch and call records. What arrives after this stays.
    func applyForgotten() {
        let live = VoiciMessages.liveForgotten(state, now: now())
        let fresh = live.filter { $0.value.at > (local.forgetApplied[$0.key] ?? -1) }
        local.forgetApplied = live.mapValues(\.at).merging(local.forgetApplied.filter { live[$0.key] != nil }) { max($0, $1) }
        guard !fresh.isEmpty else { return }
        var pages: [String: String] = [:]
        if let umk = Keystore.messagesUMKIfCached() {
            let secret = VoiciMessages.deriveMessagesSecret(umk: Array(umk))
            let candidates = Set(state.signedInSites.map(\.pageId) + VoiciCallHistory.shared.records.compactMap { $0.callablePage?.pageId })
            for pid in candidates {
                if let p = try? VoiciMessages.deriveMessagesPseudonymKey(messagesSecret: secret, pageId: pid),
                   let conv = try? VoiciMessages.voiciConv(pageId: pid, pseudonymPub: CanonicalJson.hex(p.publicKey)), fresh[conv] != nil {
                    pages[pid] = conv
                }
            }
        }
        for conv in fresh.keys {
            local.items.removeAll { $0.envelope["conv"]?.string == conv }
            reveals[conv] = nil
            ringBackFlags[conv] = nil
            noRingBack.remove(conv)
            missedCalls.removeAll { $0.conv == conv }
        }
        VoiciCallHistory.shared.forget { r in
            switch r.peer {
            case .visitor(let conv, _): return fresh[conv] != nil
            case .page(_, let pid): return pages[pid] != nil
            }
        }
        for pid in pages.keys { UserDefaults.standard.removeObject(forKey: VisitorConversationModel.revealKey(pid)) }
        conversations.removeAll { fresh[$0.conv] != nil }
        rebuild()
    }

    /// Caller side (VisitorConversationModel): the synced state's deletion marker for this account's own conversation on
    /// another page, so its other devices forget it too.
    func forgetVisitorConversation(conv: String, pseudonymPub: String) async {
        await editState { s in if let next = try? VoiciMessages.forgetConversation(s, conv: conv, pseudonymPub: pseudonymPub, at: self.now()) { s = next } }
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
        for item in inbox.items {
            if let conv = item.envelope["conv"]?.string, let flag = item.ringBack { ringBackFlags[conv] = flag }
        }
        let known = Set(local.items.compactMap { $0.envelope["msgId"]?.string })
        local.items += inbox.items.filter { !known.contains($0.envelope["msgId"]?.string ?? "") }
        local.cursor = inbox.cursor
        local.blocks = inbox.blocks
        local.revoked = inbox.revoked
        save()
        await rebuildAsync()
    }

    /// Every missed call `.com` holds for the page, opened under the inbox key of each epoch and checked; anything
    /// that fails to open or check is dropped.
    private func loadMissedCalls(_ client: any VoiciComClient) async {
        guard let idx = index, let items = try? await client.missedCalls(username: username) else { return }
        let ca = await client.caKeys()
        var seeds: [[UInt8]] = []
        var e = idx.inboxEpoch
        while e >= 1, let k = keys(epoch: e) { seeds.append(k.inbox.seed); e -= 1 }
        missedCalls = Self.openMissedCalls(items, seeds: seeds, pageId: idx.pageId, origin: Endpoints.voiciOrigin, caKeys: ca)
    }

    nonisolated static func openMissedCalls(_ items: [VoiciMissedCallItem], seeds: [[UInt8]], pageId: String, origin: String, caKeys: [String]) -> [VoiciMissedCallRow] {
        var out: [VoiciMissedCallRow] = []
        for item in items {
            guard let sealed = CanonicalJson.b64Decode(item.sealed) else { continue }
            for seed in seeds {
                guard let m = VoiciCalls.openMissedCall(inboxSeed: seed, callId: item.callId, sealed: sealed, pageId: pageId, origin: origin, caKeys: caKeys) else { continue }
                if !out.contains(where: { $0.callId == item.callId }) {
                    out.append(VoiciMissedCallRow(callId: item.callId, conv: m.request.conv, pseudonymPub: m.request.from, reason: m.reason,
                                                  ringingAt: m.ringingAt, video: m.request.hasVideo, threadPub: m.request.threadPub))
                }
                break
            }
        }
        return out.sorted { $0.ringingAt < $1.ringingAt }
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
        await checkReveals(client)
    }

    /// The visitors' reveals (docs/voici-calls.md "Reveal who I am"), each checked against the page key `.com` serves
    /// for its username; one that fails shows nothing. An unreveal removes the pill.
    public private(set) var reveals: [String: VoiciReveal] = [:]

    private func checkReveals(_ client: any VoiciComClient) async {
        var out: [String: VoiciReveal] = [:]
        for c in conversations {
            guard case .reveal(let r)? = c.control else { continue }
            if let known = reveals[c.conv], known == r { out[c.conv] = known; continue }
            guard let keys = try? await client.accountKeys(username: r.username), let raw = try? await client.page(username: r.username),
                  case .ok(let idx) = VoiciPage.checkVoiciPageIndex(raw, username: r.username, sensitiveKind: keys.sensitive.kind, sensitivePub: keys.sensitive.pub),
                  case .ok(let ok) = VoiciConversations.checkReveal(Self.revealJson(r), conv: c.conv, pageSignPub: idx.ownerSignPub) else { continue }
            out[c.conv] = ok
        }
        reveals = out
    }

    nonisolated static func revealJson(_ r: VoiciReveal) -> JSONValue {
        ["v": 1, "kind": "voici-reveal", "conv": .string(r.conv), "username": .string(r.username), "displayName": r.displayName.map { .string($0) } ?? .null,
         "issuedAt": .number(Double(r.issuedAt)), "sig": .string(r.sig)]
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
        // Accept messages goes up as the switch shows it, so the page never takes messages the owner turned off.
        let accepts = acceptsUnpublished ? [VoiciDraftOp(opId: newId(), op: "accept-messages", at: max(now(), base.issuedAt + 1), deviceId: deviceId,
                                                         accepts: preview.acceptsMessages)] : []
        await publishQuick([VoiciDraftOp(opId: newId(), op: "profile", at: max(now(), base.issuedAt + 1), deviceId: deviceId, profile: q)] + accepts,
                           mayRepublish: true)
    }

    /// Publishes exactly `ops` (never the other drafts).
    func publishQuick(_ ops: [VoiciDraftOp], mayRepublish: Bool = false) async {
        guard let s = await sensitiveSigner(reason: String(localized: "Publish your page")) else { return }
        await publish(signer: s, only: ops, mayRepublish: mayRepublish)
    }

    /// Settings → Messages → Calls: on/off and who may call, published at once in the index by an admin device
    /// (docs/voici-calls.md §6, §8). Drafts stay drafts. False when it couldn't be published (`publishError` says why).
    @discardableResult
    public func setCalls(on: Bool, from: String) async -> Bool {
        guard isAdmin, isPublic, VoiciCallSettings.fromValues.contains(from) else { return false }
        CallSettingsStore.setLastFrom(from)
        guard on != callsOn || (on && from != callsFrom) else { return true }
        guard let s = await sensitiveSigner(reason: String(localized: "Publish your page")) else { return false }
        pendingCalls = (on, from)
        defer { pendingCalls = nil }
        await publish(signer: s, only: [])
        return publishError == nil
    }

    /// Social options → "Show in search engines": published at once in the index by an admin device, like the calls
    /// setting (docs/voici-and-messages.md §2.7). Drafts stay drafts. False when it couldn't be published.
    @discardableResult
    public func setShowInSearch(_ on: Bool) async -> Bool {
        guard isAdmin, isPublic else { return false }
        guard on != showsInSearch else { return true }
        guard let s = await sensitiveSigner(reason: String(localized: "Publish your page")) else { return false }
        pendingSearch = on
        defer { pendingSearch = nil }
        await publish(signer: s, only: [])
        return publishError == nil
    }

    /// The owner's call hours (docs/voici-calls.md, owner decision 2026-11-16 option c): a setting synced between the
    /// owner's own devices, sealed under a key from the UMK, never in the page. Nil: calls ring any time.
    public private(set) var callSettings: VoiciCallSettingsValue? = CallSettingsStore.ownerHours()
    public var callHours: VoiciCallHours? { callSettings?.hours }
    @ObservationIgnored private var callSettingsVersion: Int64 = 0

    private func loadCallSettings(_ client: any VoiciComClient) async {
        guard let umk = Keystore.messagesUMKIfCached(), let blob = try? await client.callSettings(username: username) else { return }
        callSettingsVersion = VoiciCallSettingsSync.version(blob)
        guard let remote = VoiciCallSettingsSync.open(key: VoiciCallSettingsSync.deriveKey(umk: Array(umk)), username: username, blob: blob) else { return }
        adoptCallSettings(callSettings.map { VoiciCallSettingsSync.merge(local: $0, remote: remote) } ?? remote)
    }

    private func adoptCallSettings(_ s: VoiciCallSettingsValue) {
        callSettings = s
        // The ringing phone reads its own copy (it may ring while the account is locked).
        CallSettingsStore.setOwnerHours(s)
    }

    /// The call-hours editor on the Social page: any device of the owner seals the new hours and puts them with
    /// compare-and-set; on a conflict the newer change wins and the put is tried again. False when it couldn't.
    public func setCallHours(_ hours: VoiciCallHours?) async -> Bool {
        guard let client, let umk = Keystore.messagesUMKIfCached(), let device else { return false }
        if let hours, VoiciCallSettingsSync.parseHours(hours.json) == nil { return false }
        guard hours != callHours else { return true }
        let key = VoiciCallSettingsSync.deriveKey(umk: Array(umk))
        var mine = VoiciCallSettingsValue(hours: hours, updatedAt: max(now(), (callSettings?.updatedAt ?? 0) + 1))
        for _ in 0..<3 {
            do {
                let sealed = try VoiciCallSettingsSync.seal(key: key, username: username, version: callSettingsVersion + 1, settings: mine)
                try await client.putCallSettings(username: username, sealed: sealed, device: device)
                callSettingsVersion += 1
                adoptCallSettings(mine)
                return true
            } catch let e as VoiciComError where e.code == "version-conflict" {
                callSettingsVersion = VoiciCallSettingsSync.version(e.stored)
                if let remote = VoiciCallSettingsSync.open(key: key, username: username, blob: e.stored) {
                    mine = VoiciCallSettingsSync.merge(local: mine, remote: remote)
                    if mine == remote { adoptCallSettings(remote); return remote.hours == hours }
                }
            } catch {
                return false
            }
        }
        return false
    }

    // MARK: answering while locked (docs/voici-calls.md, owner decisions 2026-11-15)

    /// Settings → Messages → "Answer calls while Flagship is locked" (off by default). On: an unlocked admin device makes
    /// its call-only key, binds it under the owner messages key and registers the binding with `.com`. Off: a signed
    /// revocation, then the key is deleted. Nil on success, else a sentence.
    public func setAnswerWhileLocked(_ on: Bool) async -> String? {
        if !on { await revokeCallKey(); return nil }
        guard isAdmin, let client, let idx = index, !isRemoved, let k = keys(epoch: idx.inboxEpoch), let device else {
            return String(localized: "Unlock Flagship and try again.")
        }
        do {
            let g = try VoiciCallKeyStore.generate()
            let proof = try VoiciCalls.signCallKeyBinding(username: username, deviceId: deviceId, callKeyPub: g.pubHex, createdAt: now(), ownerSignSeed: k.sign.seed)
            try await client.registerCallKey(username: username, proof: proof, device: device)
            let key = VoiciCallKeyStore.key(username: username, deviceId: deviceId, pageId: idx.pageId, ownerSignPub: k.signPub,
                                            secret: g.secret, enclave: g.enclave, pubHex: g.pubHex, proof: proof)
            if let old = VoiciCallKeyStore.load(username: username), old.pubHex != g.pubHex { await revoke(old, client: client) }
            try VoiciCallKeyStore.save(key)
            answersWhileLocked = true
            rebuildLockedNames()
            return nil
        } catch {
            return Self.sentence(error)
        }
    }

    /// Off, sign-out or removal: a revocation signed by the owner key when this device holds it, else by the call key.
    func revokeCallKey() async {
        // "Show names while locked" sits under this switch and goes with it (D2): the table is erased at once.
        setShowNamesWhileLocked(false)
        guard let k = VoiciCallKeyStore.load(username: username) else { answersWhileLocked = false; return }
        if let client { await revoke(k, client: client) }
        VoiciCallKeyStore.delete(username: username)
        answersWhileLocked = false
    }

    // MARK: names on a locked phone (docs/voici-locked-caller-names.md)

    /// "Answer calls while Flagship is locked" can be offered here: an admin device of a page that takes calls.
    public var answerWhileLockedAvailable: Bool { isAdmin && callsOn }
    /// Where "Show names while locked" shows: under the answer switch while it is on, or on its own (ring-back names
    /// only) on a device that can't answer while locked (D1).
    public var namesWhileLockedVisible: Bool { !answerWhileLockedAvailable || answersWhileLocked }

    /// The switch. On: the table is built now (if the account's state is here) and at every later change. Off: erased.
    public func setShowNamesWhileLocked(_ on: Bool) {
        guard !username.isEmpty else { return }
        VoiciLockedNamesSettings.setOn(username, on)
        showsNamesWhileLocked = on
        if on { rebuildLockedNames() } else { VoiciLockedNamesStore.delete(username: username) }
    }

    /// The one-time "Show names on the lock screen?" sheet after "Answer calls while Flagship is locked" goes on.
    public var shouldOfferNamesSheet: Bool { answersWhileLocked && !showsNamesWhileLocked && !VoiciLockedNamesSettings.sheetShown(username) }
    public func namesSheetAnswered(show: Bool) {
        VoiciLockedNamesSettings.markSheetShown(username)
        if show { setShowNamesWhileLocked(true) }
    }

    /// Rebuilds the whole table from the unlocked account (§3.4). Nothing happens while locked, before the state blob
    /// was read, or with the setting off; a switch the owner can no longer see (the answer switch is available but off)
    /// turns off and erases.
    func rebuildLockedNames() {
        guard hasAccount, showsNamesWhileLocked else { return }
        guard stateLoaded, let umk = Keystore.messagesUMKIfCached() else { return }
        guard namesWhileLockedVisible else { setShowNamesWhileLocked(false); return }
        let includeNames = answersWhileLocked && answerWhileLockedAvailable && VoiciCallKeyStore.load(username: username) != nil
        let records = VoiciCallHistory.shared.records
        let pages = records.compactMap { r -> VoiciLockedNames.RingPage? in
            guard r.direction == .outgoing, case .page(let u, let p) = r.peer else { return nil }
            return VoiciLockedNames.RingPage(username: u, pageId: p, last: r.at)
        }
        let table = VoiciLockedNames.build(
            account: username, now: now(), includeNames: includeNames, nicknames: state.nicknames.mapValues(\.name),
            blocked: Set(state.blocks + local.blocks), forgotten: VoiciMessages.liveForgotten(state, now: now()), records: records,
            missed: missedCalls, ringPages: pages, stoppedAt: VoiciLockedNamesSettings.stops(username),
            messagesSecret: VoiciMessages.deriveMessagesSecret(umk: Array(umk)))
        try? VoiciLockedNamesStore.save(table)
    }

    /// The call center's view: whether the unlocked state is here, so a ring-back hint that still doesn't open is
    /// final rather than early.
    var stateReadThisSession: Bool { stateLoaded }

    private func revoke(_ k: VoiciCallKey, client: any VoiciComClient) async {
        let at = now()
        if let owner = keys(epoch: index?.inboxEpoch), owner.signPub == k.ownerSignPub,
           let bytes = try? VoiciCalls.canonicalCallKeyRevoke(username: k.username, deviceId: k.deviceId, callKeyPub: k.pubHex, revokedAt: at),
           let sig = try? CanonicalJson.ed25519SignHex(bytes, seed: owner.sign.seed) {
            try? await client.revokeCallKey(username: k.username, revoke: VoiciCalls.revokeJson(username: k.username, deviceId: k.deviceId, callKeyPub: k.pubHex, revokedAt: at), signature: sig)
        } else if let r = k.selfRevoke(at: at) {
            try? await client.revokeCallKey(username: k.username, revoke: r.revoke, signature: r.signature)
        }
    }

    /// The inbox key was rotated (a new ownerSignPub): the binding no longer verifies, so bind the same key again.
    private func rebindCallKeyIfNeeded(_ client: any VoiciComClient) async {
        guard let k = VoiciCallKeyStore.load(username: username), let idx = index, !isRemoved, idx.ownerSignPub != k.ownerSignPub,
              let owner = keys(epoch: idx.inboxEpoch), let device,
              let proof = try? VoiciCalls.signCallKeyBinding(username: k.username, deviceId: k.deviceId, callKeyPub: k.pubHex, createdAt: now(), ownerSignSeed: owner.sign.seed),
              (try? await client.registerCallKey(username: username, proof: proof, device: device)) != nil else { return }
        try? VoiciCallKeyStore.save(k.rebound(pageId: idx.pageId, ownerSignPub: owner.signPub, proof: proof))
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
        // A brand-new page goes up with its first post (docs/social-tabs.md). Decided once, before any conflict
        // shows the page already existed; never for a page that was published (or removed) before.
        var welcome = isFirstPublish
        for _ in 0..<3 {
            do {
                try await publishOnce(client, signer, only: only, extra: welcome ? [welcomePostOp(ops: only ?? ownOps + laneOps)] : [])
                return
            } catch let e as VoiciComError where e.code == "seq-conflict" {
                // Another admin device published (or removed the page) first: take what `.com` holds, merge again,
                // re-sign the next seq. Bounded: three tries in all.
                await takeConflict(client, e)
                welcome = welcome && isFirstPublish
                if isRemoved && !mayRepublish { return }
            } catch let e as VoiciComError where e.code == "wrong-page" && index == nil && e.storedPageId.map({ CanonicalJson.isLowerHex($0, bytes: 16) }) == true {
                // A device that never saw the page (it was removed before) continues it under its own pageId.
                welcome = false
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

    /// The first post's text (docs/social-tabs.md), in this device's language.
    nonisolated static var welcomePostText: String { String(localized: "Hello. I am using the Flagship app, from flagshipserver.com") }

    /// Every page starts with one ordinary post, in this device's language, that the owner can edit or delete. Plain
    /// text: no link and no card. Dated just before the page's other new posts so it stays the first.
    func welcomePostOp(ops: [VoiciDraftOp]) -> VoiciDraftOp {
        let earliest = ops.compactMap { $0.op == "post-add" ? $0.post?.createdAt : nil }.min()
        let at = min(now(), (earliest ?? now() + 1) - 1)
        let post = VoiciPost(id: newId(), createdAt: at, editedAt: nil, text: Self.welcomePostText, links: [])
        return VoiciDraftOp(opId: newId(), op: "post-add", at: at, deviceId: deviceId, post: post)
    }

    private func publishOnce(_ client: any VoiciComClient, _ signer: Curve25519.Signing.PrivateKey, only: [VoiciDraftOp]?, extra: [VoiciDraftOp] = []) async throws {
        let epoch = local.pendingEpoch ?? index?.inboxEpoch ?? 1
        guard let k = keys(epoch: epoch) else { throw VoiciComError(status: 0, code: "locked") }
        let ops = extra + (only ?? (ownOps + laneOps.filter { op in !ownOps.contains { $0.opId == op.opId } }))
        let merged = VoiciPage.mergeVoiciPage(base, ops: ops)
        var images: [String: [UInt8]] = [:]
        for sha in VoiciOwner.imageHashes(merged) { images[sha] = VoiciImageStore.load(sha) }
        // Capped server copy (§2.7a): phone-only chunks this device doesn't hold go out as their listed refs.
        let listed = isRemoved ? [] : (index?.pieces ?? [])
        let carried = isRemoved ? [] : VoiciOwner.carriedChunks(index, state: published)
        guard var pieces = try VoiciOwner.pieces(merged, images: images, listed: listed, carried: carried) else {
            throw VoiciComError(status: 0, code: "missing-image")
        }
        // The share card (§2.10): carried while the name, photo and theme are unchanged, else drawn again. A card that
        // can't be drawn leaves the page without one (the piece is optional).
        let listedShare = isRemoved ? nil : index?.pieces.first { $0.role == "share" }
        if let l = listedShare, !VoiciShareCard.needsRedraw(published: isRemoved ? nil : published, listedShare: l, merged: merged) {
            pieces.append(VoiciOwner.Piece(ref: l, bytes: VoiciImageStore.load(l.sha256) ?? []))
        } else if let card = VoiciShareCard.render(username: username, profile: merged.profile, avatar: merged.profile.avatar.flatMap { images[$0] }) {
            VoiciImageStore.save(card)
            pieces.append(VoiciOwner.Piece(ref: VoiciPieceRef(role: "share", sha256: CanonicalJson.sha256Hex(card), size: Int64(card.count)), bytes: card))
        }
        let seed = Array(signer.rawRepresentation)
        let signerPub = HexUtil.encode(signer.publicKey.rawRepresentation)
        let phoneChunks = VoiciPage.phoneChunksFor(merged.chunks.count)
        // After a removal `.com` may have dropped the pieces: send them all again.
        let have = isRemoved ? [] : Set(index?.pieces.map(\.sha256) ?? [])
        for p in pieces where !have.contains(p.ref.sha256) && !p.bytes.isEmpty {
            let up = VoiciPieceUpload(username: username, pageId: k.pageId, sha256: p.ref.sha256, size: p.ref.size, issuedAt: now())
            try await client.uploadPiece(username: username, upload: up, signerPub: signerPub,
                                         signature: try VoiciPage.signVoiciPieceUpload(up, signerSeed: seed), bytes: p.bytes)
        }
        // Every publish carries the calls setting of the index it replaces (a profile edit never turns calls off).
        let current = isFirstPublish ? VoiciCallSettings.firstPublish
            : VoiciCallSettings.read(acceptsCalls: isRemoved ? nil : index?.acceptsCalls, callsFrom: index?.callsFrom)
        let calls = pendingCalls ?? current
        let fields = VoiciCallSettings.indexFields(on: calls.on, from: calls.from)
        // Search engines: hidden on a first publish and after a removal; otherwise the replaced index's value.
        let search = pendingSearch ?? (!isFirstPublish && !isRemoved && index?.showsInSearch == true)
        let body = VoiciPageIndex(username: username, pageId: k.pageId, seq: nextSeq, issuedAt: now(),
                                  acceptsMessages: merged.acceptsMessages, inboxEpoch: epoch, inboxPub: k.inboxPub, ownerSignPub: k.signPub,
                                  pieces: pieces.map(\.ref), signerKind: Keystore.hasAdminRoot ? "admin-root" : "irk",
                                  acceptsCalls: fields.acceptsCalls, callsFrom: fields.callsFrom, showInSearch: search ? 1 : nil,
                                  phoneChunks: phoneChunks > 0 ? Int64(phoneChunks) : nil)
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

    /// The owner calling a visitor of their own page back (owner decision: through the conversation's ring-back
    /// channel, only when the visitor chose "Call and allow call-back"; otherwise there is nothing to ring). The ring
    /// is signed by the page's owner key and carries a hint sealed to the visitor's thread key, so only the visitor's
    /// own app learns which page is calling; the visitor then dials out to this page and this device rings as usual.
    public enum CallVisitorOutcome: Equatable, Sendable {
        case rang(ringId: String)
        /// The visitor didn't allow call-backs in this conversation (or stopped them).
        case noRingBack
        case failed(String)
    }

    /// Conversations `.com` said have no ring-back channel; their Call stays off until the visitor calls again.
    public private(set) var noRingBack: Set<String> = []
    /// `.com`'s ringBack flag per conversation, from the inbox items (release-manager decision 4).
    public private(set) var ringBackFlags: [String: Bool] = [:]

    /// Whether the thread's Call can ring the visitor: calls on, the visitor's thread key known, not refused before.
    public func canRingBack(_ c: VoiciConversation) -> Bool {
        isAdmin && index?.takesCalls == true && !c.threadPub.isEmpty && !noRingBack.contains(c.conv) && ringBackFlags[c.conv] != false
    }

    /// Whether a Calls row can ring back a visitor who never wrote (no thread here): the call's signed request named
    /// the visitor's thread key, calls are on, `.com` hasn't refused a ring to that conversation, the visitor isn't blocked.
    public func canRingBack(conv: String, pseudonymPub: String, threadPub: String) -> Bool {
        isAdmin && index?.takesCalls == true && !threadPub.isEmpty && !pseudonymPub.isEmpty && !noRingBack.contains(conv)
            && ringBackFlags[conv] != false && !state.blocks.contains(pseudonymPub) && !local.blocks.contains(pseudonymPub)
    }

    /// `threadPub` stands in for the conversation's when there is none (a caller who never wrote: the key comes from
    /// the call's signed request).
    public func callVisitor(conv: String, video: Bool = false, threadPub: String? = nil) async -> CallVisitorOutcome {
        guard let client, let idx = index, let k = keys(epoch: idx.inboxEpoch) else { return .failed("locked") }
        let threadHex = conversation(conv)?.threadPub ?? threadPub ?? ""
        guard !threadHex.isEmpty, let tpub = try? CanonicalJson.hexToBytes(threadHex) else { return .noRingBack }
        let ringId = newId()
        let at = now()
        let media = video ? VoiciCalls.mediaVideo : VoiciCalls.mediaAudio
        do {
            let hint = try VoiciRings.sealHint(threadPub: tpub, VoiciRingHint(pageId: idx.pageId, username: username, conv: conv, ringId: ringId,
                                                                              media: media, issuedAt: at))
            let signed = try VoiciRings.signedRing(pageId: idx.pageId, conv: conv, ringId: ringId, hint: CanonicalJson.b64Encode(hint), media: media,
                                                   issuedAt: at, ownerSignSeed: k.sign.seed)
            try await client.ring(username: username, ring: signed.ring, signature: signed.signature)
            return .rang(ringId: ringId)
        } catch let e as VoiciComError where e.code == "no-ring-back" {
            noRingBack.insert(conv)
            return .noRingBack
        } catch {
            return .failed((error as? VoiciComError)?.code ?? "unavailable")
        }
    }

    /// A ring-back push to this account as a caller: the hint opens under this account's thread key for one of the
    /// pages it signed in to (nil while the account is locked, or when none opens).
    func openRing(_ push: VoiciRingPush, alsoPages: [String] = []) -> VoiciRingHint? {
        guard let umk = Keystore.messagesUMKIfCached(), let sealed = CanonicalJson.b64Decode(push.hint) else { return nil }
        let secret = VoiciMessages.deriveMessagesSecret(umk: Array(umk))
        for pageId in Set(state.signedInSites.map(\.pageId) + alsoPages).sorted() {
            guard let p = try? VoiciMessages.deriveMessagesPseudonymKey(messagesSecret: secret, pageId: pageId),
                  let t = try? VoiciMessages.deriveMessagesThreadKey(messagesSecret: secret, pageId: pageId),
                  let conv = try? VoiciMessages.voiciConv(pageId: pageId, pseudonymPub: CanonicalJson.hex(p.publicKey)),
                  let h = VoiciRings.openHint(threadSeed: t.seed, conv: conv, ringId: push.ringId, sealed: sealed), h.pageId == pageId else { continue }
            return h
        }
        return nil
    }

    /// Before this account calls a "callback accounts only" page from the app: attach the conversation's ring-back
    /// channel (calling there is consent to being rung back in that conversation), signed by the pseudonym, with this
    /// device's headers so the ring reaches this account's devices. The owner never learns who the caller is.
    func attachRingBack(pageId: String, umk: [UInt8]) async throws {
        guard let client, let signer = device else { throw VoiciComError(status: 0, code: "locked") }
        let secret = VoiciMessages.deriveMessagesSecret(umk: umk)
        let p = try VoiciMessages.deriveMessagesPseudonymKey(messagesSecret: secret, pageId: pageId)
        let conv = try VoiciMessages.voiciConv(pageId: pageId, pseudonymPub: CanonicalJson.hex(p.publicKey))
        // The page's ring tag key rides along, so a ring-back can be named on this account's locked phones.
        let tagKey = try? VoiciRings.deriveRingTagKey(messagesSecret: secret, pageId: pageId)
        let order = try VoiciRings.signedRingBack(pageId: pageId, conv: conv, op: "attach", issuedAt: now(), pseudonymSeed: p.seed, ringTagKey: tagKey)
        try await client.ringBack(order: order, account: username, device: signer)
    }

    /// Blocks (or unblocks) an anonymous caller's conversation: it can't call this page again until unblocked or
    /// deleted. Nil on success, else a sentence.
    public func setAnonBlocked(conv: String, _ blocked: Bool) async -> String? {
        guard let client, let idx = index, let k = keys(epoch: idx.inboxEpoch) else { return String(localized: "Unlock Flagship and try again.") }
        do {
            let signed = try VoiciConversations.signedAnonBlock(pageId: idx.pageId, conv: conv, op: blocked ? "block" : "unblock", issuedAt: now(), ownerSignSeed: k.sign.seed)
            try await client.anonBlock(username: username, signed: signed)
            if blocked { anonBlocked.insert(conv) } else { anonBlocked.remove(conv) }
            return nil
        } catch {
            return Self.sentence(error)
        }
    }

    /// Anonymous callers this device blocked (the page's block list for them lives on `.com`).
    public private(set) var anonBlocked: Set<String> = []

    /// This account's own published page, which signs a reveal (docs/voici-calls.md "Reveal who I am"); nil without one.
    func ownPageForReveal() -> VisitorConversationModel.OwnPage? {
        guard let idx = index, !isRemoved, let k = keys(epoch: idx.inboxEpoch) else { return nil }
        let name = published?.profile.displayName
        return VisitorConversationModel.OwnPage(username: username, pageId: idx.pageId, displayName: name.flatMap { $0.isEmpty ? nil : $0 }, signSeed: k.sign.seed)
    }

    /// The pages this account signed in to as a visitor whose username this device knows: the ones it can call.
    public var callablePages: [(username: String, pageId: String, title: String)] {
        Set(state.signedInSites.map(\.pageId)).sorted().compactMap { p in
            VoiciSignInBook.username(pageId: p).map { ($0, p, VoiciSignInBook.title(pageId: p)) }
        }
    }

    /// The thread menu's "Allow calls from them" / "Don't allow calls from them": a signed call-allow order
    /// (`flagship/voici-call-allow/v1`) under the page's owner signing key. Nil on success, else a sentence.
    public func setCallAllow(_ c: VoiciConversation, allow: Bool) async -> String? {
        guard let client, let idx = index, let k = keys(epoch: idx.inboxEpoch) else { return String(localized: "Unlock Flagship and try again.") }
        let op = allow ? "allow" : "disallow"
        let at = now()
        do {
            let sig = try VoiciCalls.signAllow(pageId: idx.pageId, conv: c.conv, op: op, issuedAt: at, ownerSignSeed: k.sign.seed)
            try await client.callAllow(username: username, allow: VoiciCalls.allowJson(pageId: idx.pageId, conv: c.conv, op: op, issuedAt: at), signature: sig)
            return nil
        } catch {
            return Self.sentence(error)
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

    /// Delete = forget (docs/voici-calls.md): a signed owner delete makes `.com` drop the conversation's mailbox,
    /// ring-back channel, ring and missed calls at once; then this device's copy goes. Nil on success, else a sentence
    /// (nothing is erased locally when `.com` refused, so the person can try again). Face ID / passcode first: a
    /// cancelled or failed prompt deletes nothing and sends nothing.
    @discardableResult
    public func delete(_ c: VoiciConversation) async -> String? {
        if let refused = await DestructiveAuth.askToDeleteConversation() { return refused }
        if let client, let idx = index, let k = keys(epoch: idx.inboxEpoch) {
            do {
                let signed = try VoiciConversations.signedDeleteOwner(pageId: idx.pageId, conv: c.conv, issuedAt: now(), ownerSignSeed: k.sign.seed)
                try await client.deleteConversation(signed)
            } catch let e as VoiciComError where e.code != "not-found" {
                return Self.sentence(e)
            } catch {}
        }
        reveals[c.conv] = nil
        ringBackFlags[c.conv] = nil
        missedCalls.removeAll { $0.conv == c.conv }
        local.items.removeAll { $0.envelope["conv"]?.string == c.conv }
        conversations.removeAll { $0.conv == c.conv }
        // The synced state forgets it too; its marker makes the owner's other devices drop their copies.
        let pseudonym = CanonicalJson.isLowerHex(c.pseudonymPub, bytes: 32) ? c.pseudonymPub : nil
        await editState { s in if let next = try? VoiciMessages.forgetConversation(s, conv: c.conv, pseudonymPub: pseudonym, at: self.now()) { s = next } }
        save()
        return nil
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
        applyForgotten()
        save()
        rebuildLockedNames()
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
                    state = VoiciMessages.mergeMessagesState(local: state, remote: remote, now: now())
                    applyForgotten()
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

    /// What a voi.ci call needs from this device's keys (docs/voici-calls.md §4), or nil while the account is locked
    /// or has no page: the call then rings with a generic name and asks for an unlock before it can be answered.
    func callKeys() async -> VoiciCallKeys? {
        guard isAdmin, let client, let idx = index, let k = keys(epoch: idx.inboxEpoch), let device = deviceKey() else { return nil }
        var inbox: [[UInt8]] = []
        for e in stride(from: idx.inboxEpoch, through: 1, by: -1) {
            if let key = try? VoiciMessages.deriveVoiciInboxKey(umk: k.umk, pageId: idx.pageId, inboxEpoch: e) { inbox.append(key.seed) }
        }
        var keys = VoiciCallKeys(
            username: username, deviceId: deviceId, deviceKey: device, pageId: idx.pageId, acceptsCalls: idx.takesCalls,
            ownerSignSeed: k.sign.seed, ownerSignPub: k.signPub, inboxSeeds: inbox, caKeys: await client.caKeys(),
            origin: Endpoints.voiciOrigin, blocked: Set(state.blocks + local.blocks), revoked: Set(local.revoked),
            nicknames: state.nicknames.mapValues(\.name), callsFrom: idx.callsFrom ?? "accepted")
        // This copy of the index is refreshed only while the Social tab is open, so another device's change of "Who can
        // call" may not be here yet: an anonymous call this copy refuses is checked against the live signed index, and
        // a newer one is taken in.
        let username = username, pageId = idx.pageId, seen = max(local.highestSeq, idx.seq)
        keys.liveMode = { [weak self] in
            guard let live = await VoiciCallModes.liveCallMode(client: client, username: username, pageId: pageId, highestSeenSeq: seen) else { return nil }
            if live.index.seq > seen { Task { @MainActor in await self?.refresh() } }
            return live.mode
        }
        return keys
    }

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
            revoked: Set(local.revoked), accountKeys: accountKeys, origin: Endpoints.voiciOrigin, client: client,
            index: isRemoved ? nil : idx, published: published))
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
        case "too-many-chunks": return String(localized: "This page keeps more posts on voi.ci than voi.ci allows. Update Flagship, then publish again.")
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
            "forgetApplied": .object(local.forgetApplied.mapValues { .int($0) }),
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
        VoiciCallHistory.forget(username: username?.lowercased(), allProfiles: allProfiles)
        // The locked-names table and its switch go with the account (sign out, remove this device, account gone, wipe).
        if allProfiles { VoiciLockedNamesStore.deleteAll() } else if let u = username, !u.isEmpty { VoiciLockedNamesStore.delete(username: u) }
        VoiciLockedNamesSettings.forget(username: username?.lowercased(), allProfiles: allProfiles)
        SocialBadges.forget(username: username?.lowercased(), allProfiles: allProfiles)
        CallSettingsStore.setOwnerHours(nil)
    }

    /// Wires `Keystore.onWipe` (once, at launch).
    public static func installWipeHook() {
        Keystore.onWipe = { all in
            let u = currentUsername
            forgetLocal(username: u, allProfiles: all)
            Task { @MainActor in
                // Sign-out or removal: the call key goes too, revoked first (the owner key may be gone: it signs itself).
                if let u, let k = VoiciCallKeyStore.load(username: u) {
                    if let client = shared.client, let r = k.selfRevoke(at: Int64(Date().timeIntervalSince1970 * 1000)) {
                        try? await client.revokeCallKey(username: u, revoke: r.revoke, signature: r.signature)
                    }
                    VoiciCallKeyStore.delete(username: u)
                }
                shared.forgetInMemory()
                // The voucher wallet's sealed copy on this device goes too (the synced one stays for the other devices).
                PaymentsCenter.shared.forget()
                OrgPlanTrickle.forget()
            }
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
        local.forgetApplied = (v["forgetApplied"]?.object ?? [:]).compactMapValues(\.time)
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
