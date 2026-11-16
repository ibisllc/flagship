import Foundation
import CryptoKit
import Observation
import Flagship
import FlagshipAPI
import FlagshipCore

/// One conversation this account started on someone else's page, in the app (docs/voici-calls.md "Release-manager
/// decisions" 2): the messages and the owner's replies, sending, Call, and the conversation's settings: "Show <name>
/// who I am" (a reveal signed by this account's own page key, sent inside the conversation, so `.com` never sees it),
/// Stop call-backs, and Delete (forget). The owner never learns who this account is unless the reveal is on.
@MainActor
@Observable
final class VisitorConversationModel {
    enum Phase: Equatable { case loading, ready, failed(String) }

    /// This account's own page, which signs a reveal: its username, id, display name and owner signing seed.
    struct OwnPage: Sendable {
        let username: String
        let pageId: String
        let displayName: String?
        let signSeed: [UInt8]
    }

    struct Deps {
        var client: any VoiciComClient
        /// The account's UMK (cached, or after one Face ID).
        var umk: () async throws -> [UInt8]
        /// A sign-in answer for the page naming `delegatePub` (VoiciVisitorSession on device).
        var session: (_ pageId: String, _ delegatePub: String, _ nonce: String, _ ttlMs: Int64) async throws -> VoiciSignInAnswer
        /// This account's own page, or nil without one (no reveal then).
        var ownPage: () async -> OwnPage?
        var account: String
        var device: VoiciDeviceSigner?
        var defaults: UserDefaults = .standard
        var now: () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }
        /// Delete = forget on this account's other devices: the synced state's deletion marker (conv, own pseudonym).
        var forgetSynced: (_ conv: String, _ pseudonymPub: String) async -> Void = { conv, p in
            await MessagesStore.shared.forgetVisitorConversation(conv: conv, pseudonymPub: p)
        }
    }

    let callee: VoiciCallee
    private(set) var phase: Phase = .loading
    private(set) var displayName: String
    private(set) var messages: [VoiciThreadMessage] = []
    private(set) var revealed: Bool
    private(set) var hasOwnPage = false
    private(set) var note: String?
    private(set) var deleted = false

    @ObservationIgnored private var deps: Deps
    @ObservationIgnored private var items: [VoiciInboxItem] = []
    @ObservationIgnored private var keys: (p: (seed: [UInt8], publicKey: [UInt8]), t: (seed: [UInt8], publicKey: [UInt8]), conv: String)?
    @ObservationIgnored private var index: VoiciPageIndex?
    @ObservationIgnored private var delegate: P256.Signing.PrivateKey?
    @ObservationIgnored private var cred: VoiciSignInAnswer?

    init(callee: VoiciCallee, displayName: String, deps: Deps) {
        self.callee = callee
        self.displayName = displayName
        self.deps = deps
        revealed = deps.defaults.bool(forKey: Self.revealKey(callee.pageId))
    }

    static func revealKey(_ pageId: String) -> String { "flagship.voici.revealed.\(pageId)" }
    var conv: String { keys?.conv ?? "" }

    func load() async {
        do {
            let ak = try await deps.client.accountKeys(username: callee.username)
            guard let raw = try await deps.client.page(username: callee.username),
                  case .ok(let idx) = VoiciPage.checkVoiciPageIndex(raw, username: callee.username, sensitiveKind: ak.sensitive.kind,
                                                                    sensitivePub: ak.sensitive.pub, pageId: callee.pageId)
            else { phase = .failed(String(localized: "This page isn't on voi.ci.")); return }
            index = idx
            let secret = VoiciMessages.deriveMessagesSecret(umk: try await deps.umk())
            let p = try VoiciMessages.deriveMessagesPseudonymKey(messagesSecret: secret, pageId: callee.pageId)
            let t = try VoiciMessages.deriveMessagesThreadKey(messagesSecret: secret, pageId: callee.pageId)
            keys = (p, t, try VoiciMessages.voiciConv(pageId: callee.pageId, pseudonymPub: CanonicalJson.hex(p.publicKey)))
            hasOwnPage = await deps.ownPage() != nil
            try await refresh()
            phase = .ready
        } catch {
            phase = .failed(MessagesStore.sentence(error))
        }
    }

    /// A short-lived session (10 minutes): a delegate key for this screen's fetches and sends.
    private func session() async throws -> (key: P256.Signing.PrivateKey, answer: VoiciSignInAnswer) {
        if let k = delegate, let a = cred, a.cred.delegation.expiresAt - deps.now() > 60_000 { return (k, a) }
        let k = P256.Signing.PrivateKey()
        let a = try await deps.session(callee.pageId, CanonicalJson.hex(Array(k.publicKey.x963Representation)),
                                       CanonicalJson.hex((0..<16).map { _ in UInt8.random(in: 0...255) }), VoiciCallHandoffs.sessionMs)
        delegate = k
        cred = a
        return (k, a)
    }

    func refresh() async throws {
        guard let keys, let idx = index else { return }
        let s = try await session()
        let fetchCred: JSONValue = ["attestation": s.answer.cred.attestation.json, "delegation": s.answer.cred.delegation.json,
                                    "delegationSig": .string(s.answer.cred.delegationSig)]
        var since = ""
        var all: [VoiciInboxItem] = []
        for _ in 0..<10 {
            let f = VoiciThreadFetch(conv: keys.conv, since: since, issuedAt: deps.now())
            let sig = try s.key.signature(for: Data(try f.canonicalBytes()))
            let page = try await deps.client.thread(fetch: f, signature: CanonicalJson.hex(Array(sig.rawRepresentation)), cred: fetchCred)
            all += page.items
            since = page.next
            if !page.more { break }
        }
        items = all
        messages = VoiciVisitorThread.messages(items: all, pageId: callee.pageId, conv: keys.conv, ownerSignPub: idx.ownerSignPub, threadSeed: keys.t.seed,
                                               caKeys: await deps.client.caKeys(), origin: Endpoints.voiciOrigin)
    }

    private func sendEnvelope(text: String? = nil, control: JSONValue? = nil) async throws {
        guard let keys, let idx = index else { throw VoiciComError(status: 0, code: "unavailable") }
        let s = try await session()
        let from = CanonicalJson.hex(keys.p.publicKey)
        let env = try VoiciVisitorThread.envelope(pageId: callee.pageId, conv: keys.conv, from: from,
                                                  seq: VoiciVisitorThread.nextSeq(items: items, conv: keys.conv, from: from), sentAt: deps.now(),
                                                  inboxPub: try CanonicalJson.hexToBytes(idx.inboxPub), threadPub: keys.t.publicKey,
                                                  cred: s.answer.cred.json, text: text, control: control) {
            Array(try s.key.signature(for: $0).rawRepresentation)
        }
        try await deps.client.send(envelope: env, direct: false)
        items.append(VoiciInboxItem(envelope: env, storedAt: deps.now()))
    }

    /// Sends a message; false (with `note`) when it couldn't.
    @discardableResult
    func send(_ text: String) async -> Bool {
        do {
            try await sendEnvelope(text: text)
            try? await refresh()
            note = nil
            return true
        } catch {
            note = MessagesStore.sentence(error)
            return false
        }
    }

    /// "Show <name> who I am": a reveal signed by this account's own page key, or an unreveal, sent in the conversation.
    func setRevealed(_ on: Bool) async {
        guard let keys else { return }
        do {
            let control: JSONValue
            if on {
                guard let own = await deps.ownPage() else { note = String(localized: "Publish your own voi.ci page first."); return }
                control = try VoiciConversations.signedReveal(conv: keys.conv, username: own.username, displayName: own.displayName,
                                                              issuedAt: deps.now(), pageSignSeed: own.signSeed)
            } else {
                control = VoiciConversations.unreveal(conv: keys.conv, issuedAt: deps.now())
            }
            try await sendEnvelope(control: control)
            revealed = on
            deps.defaults.set(on, forKey: Self.revealKey(callee.pageId))
            note = nil
        } catch {
            note = MessagesStore.sentence(error)
        }
    }

    /// Stop call-backs: the conversation's ring-back channel goes at `.com`; the owner can't ring this account here.
    func stopCallBacks() async {
        guard let keys, let device = deps.device else { return }
        do {
            let order = try VoiciRings.signedRingBack(pageId: callee.pageId, conv: keys.conv, op: "stop", issuedAt: deps.now(), pseudonymSeed: keys.p.seed)
            try await deps.client.ringBack(order: order, account: deps.account, device: device)
            note = String(localized: "They can't ring you back in this conversation any more.")
        } catch {
            note = MessagesStore.sentence(error)
        }
    }

    /// Delete = forget: `.com` drops the conversation; this device forgets its reveal choice.
    func delete() async {
        guard let keys else { return }
        do {
            try await deps.client.deleteConversation(try VoiciConversations.signedDeleteCaller(pageId: callee.pageId, conv: keys.conv, issuedAt: deps.now(),
                                                                                              pseudonymSeed: keys.p.seed))
            deps.defaults.removeObject(forKey: Self.revealKey(callee.pageId))
            messages = []
            deleted = true
            await deps.forgetSynced(keys.conv, CanonicalJson.hex(keys.p.publicKey))
        } catch {
            note = MessagesStore.sentence(error)
        }
    }
}
