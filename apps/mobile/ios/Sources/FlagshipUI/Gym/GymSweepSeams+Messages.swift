#if DEBUG
import Foundation
import CryptoKit
import Flagship
import FlagshipAPI
import FlagshipCore

/// voi.ci pages and Messages (docs/voici-and-messages.md), the GymMessages* scenarios. The mock `.com` answers with
/// real signatures and sealing: the smoke account's page is signed by the gym admin root and its inbox key derives
/// from the gym UMK, visitors write with real pseudonym, thread and browser keys under the mock CA's attestation.
///
///   -smoke-messages           a published page (accepting) with one post, a conversation the owner answered
///                             ("Visitor …" from visitor A) and a request (visitor B)
///   -smoke-messages-empty     no page yet
///   -smoke-messages-lane      with -smoke-messages: another device's post waiting in the drafts lane
///   -smoke-voici-page         another account (river-otter) with a page, for the sign-in approval
///   -smoke-voici-attest-limit the attestation is refused: first-contact-limit (retry in 5 hours)
extension GymSweepSeams {
    public static let gymPageId = String(repeating: "5a", count: 16)
    public static let otterPageId = String(repeating: "07", count: 16)
    static let otterAdmin = [UInt8](repeating: 0x33, count: 32)
    static let otterUmk = [UInt8](repeating: 0x34, count: 32)

    static func messages(_ args: [String], _ app: AppState, _ mocks: GymMocks) {
        guard let m = mocks.voici else { return }
        MessagesStore.shared.directDelivery = false
        MessagesStore.shared.sampleAccountsHavePages = true
        // Every launch starts from nothing on this device.
        try? FileManager.default.removeItem(at: FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("flagship-messages", isDirectory: true))
        UserDefaults.standard.removeObject(forKey: VoiciRules.key)
        UserDefaults.standard.removeObject(forKey: VoiciSignInBook.key)
        UserDefaults.standard.removeObject(forKey: VoiciSignInBook.delegationsKey)
        UserDefaults.standard.removeObject(forKey: VoiciSignInBook.usernamesKey)
        for k in UserDefaults.standard.dictionaryRepresentation().keys
        where k.hasPrefix("flagship.messages.attestation.") || k.hasPrefix("flagship.voici.reply") {
            UserDefaults.standard.removeObject(forKey: k)
        }
        let user = (app.currentUser ?? "smoketest").lowercased()
        let admin = (try? CanonicalJson.ed25519PublicKey(seed: Array(GymSeams.gymAdminRootSeed))).map(CanonicalJson.hex)
        m.keys[user] = VoiciAccountKeys(irkPub: Keystore.gymIRK().map { HexUtil.encode($0.publicKey.rawRepresentation) } ?? String(repeating: "11", count: 32),
                                        adminRootPub: admin)
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        // This device's own grant, so a non-admin device's drafts verify.
        if let umk = GymSeams.accountRootSeed, let deviceId = app.activeProfile?.deviceId.nilIfEmpty ?? Optional("device"),
           let key = try? AccountMetadata.deriveAccountDeviceKey(umk: umk, accountId: user, deviceId: deviceId) {
            let pub = HexUtil.encode(key.publicKey.rawRepresentation)
            let g = DeviceCapabilityGrantEnvelope(grantId: "gym-grant", username: user, deviceId: deviceId, devicePubKeyHex: pub,
                                                  scopes: DeviceCapabilityGrantEnvelope.memberScopes, issuedAt: now - 1_000, expiresAt: now + 86_400_000)
            let sig = (try? CanonicalJson.ed25519SignHex(Array(g.canonicalBytes()), seed: Array(GymSeams.gymAdminRootSeed))) ?? ""
            m.grants[user] = [["grantId": "gym-grant", "username": .string(user), "deviceId": .string(deviceId), "devicePubHex": .string(pub),
                               "scopes": .array(g.scopes.map { .string($0) }), "issuedAt": .int(g.issuedAt), "expiresAt": .int(g.expiresAt),
                               "signatureHex": .string(sig), "signerRoot": "admin-root"]]
        }
        if args.contains("-smoke-voici-page") {
            m.keys["river-otter"] = VoiciAccountKeys(irkPub: String(repeating: "22", count: 32),
                                                     adminRootPub: (try? CanonicalJson.ed25519PublicKey(seed: otterAdmin)).map(CanonicalJson.hex))
            try? seedPage(m, username: "river-otter", pageId: otterPageId, umk: otterUmk, admin: otterAdmin,
                          profile: VoiciProfile(displayName: "River Otter", bio: "Paddling and photos.", avatar: nil, theme: "sea", links: []),
                          posts: [], now: now)
        }
        if args.contains("-smoke-voici-reply"), let umk = GymSeams.accountRootSeed.map(Array.init) {
            seedReply(m, user: user, umk: umk, now: now)
        }
        if let r = value(args, "-smoke-voici-attest-limit") ?? (args.contains("-smoke-voici-attest-limit") ? "18000" : nil) {
            m.attestRefusal = ("first-contact-limit", Int(r))
        }
        guard args.contains("-smoke-messages"), let umk = GymSeams.accountRootSeed.map(Array.init) else { return }
        let post = VoiciPost(id: String(repeating: "c1", count: 16), createdAt: now - 86_400_000, editedAt: nil, text: "Hello from my page.", links: [])
        guard let idx = try? seedPage(m, username: user, pageId: gymPageId, umk: umk, admin: Array(GymSeams.gymAdminRootSeed),
                                      profile: VoiciProfile(displayName: "Smoke Test", bio: "Testing pages.", avatar: nil, theme: "classic",
                                                            links: [VoiciProfileLink(url: "https://github.com/smoketest", label: "GitHub", site: "github")]),
                                      posts: [post], now: now),
              let inboxPub = try? CanonicalJson.hexToBytes(idx.inboxPub) else { return }
        let a = try? MockVoiciVisitor(secret: [UInt8](repeating: 0xa1, count: 32), pageId: gymPageId, origin: Endpoints.voiciOrigin, now: now)
        let b = try? MockVoiciVisitor(secret: [UInt8](repeating: 0xb2, count: 32), pageId: gymPageId, origin: Endpoints.voiciOrigin, now: now)
        var items: [VoiciInboxItem] = []
        if let a, let e = try? a.message("Hi! Is the garden app open source? https://example.org/garden", inboxPub: inboxPub, seq: 1, sentAt: now - 3_600_000) {
            items.append(VoiciInboxItem(envelope: e, storedAt: now - 3_600_000))
            if let sign = try? VoiciMessages.deriveVoiciOwnerSignKey(umk: umk, pageId: gymPageId, inboxEpoch: 1),
               let conv = try? VoiciMessages.voiciConv(pageId: gymPageId, pseudonymPub: a.pseudonymPub) {
                let c = VoiciConversation(conv: conv, pseudonymPub: a.pseudonymPub, threadPub: CanonicalJson.hex(a.thread.publicKey), messages: [], hasGap: false)
                if let reply = try? VoiciOwner.reply(text: "Yes, it is.", replyTo: nil, conversation: c, pageId: gymPageId, pageSeq: 1,
                                                     ownerSign: (sign.seed, idx.ownerSignPub), inboxPub: inboxPub, seq: 1, now: now - 3_000_000) {
                    items.append(VoiciInboxItem(envelope: reply.json, storedAt: now - 3_000_000, fetchedAt: now - 2_000_000))
                }
            }
        }
        if let b, let e = try? b.message("Can I buy a print of the lake photo?", inboxPub: inboxPub, seq: 1, sentAt: now - 600_000) {
            items.append(VoiciInboxItem(envelope: e, storedAt: now - 600_000))
        }
        m.mailbox[user] = items
        if args.contains("-smoke-messages-lane"), let umk = GymSeams.accountRootSeed {
            let other = try! Curve25519.Signing.PrivateKey(rawRepresentation: Data(repeating: 0x61, count: 32))
            let pub = HexUtil.encode(other.publicKey.rawRepresentation)
            let g = DeviceCapabilityGrantEnvelope(grantId: "gym-ipad", username: user, deviceId: "gym-ipad", devicePubKeyHex: pub,
                                                  scopes: DeviceCapabilityGrantEnvelope.memberScopes, issuedAt: now - 1_000, expiresAt: now + 86_400_000)
            let grant: JSONValue = ["grantId": "gym-ipad", "username": .string(user), "deviceId": "gym-ipad", "devicePubHex": .string(pub),
                                    "scopes": .array(g.scopes.map { .string($0) }), "issuedAt": .int(g.issuedAt), "expiresAt": .int(g.expiresAt)]
            let op = VoiciDraftOp(opId: String(repeating: "d4", count: 16), op: "post-add", at: now - 60_000, deviceId: "gym-ipad",
                                  post: VoiciPost(id: String(repeating: "e5", count: 16), createdAt: now - 60_000, editedAt: nil,
                                                  text: "Written on my iPad.", links: []))
            if let sig = try? CanonicalJson.ed25519SignHex(Array(g.canonicalBytes()), seed: Array(GymSeams.gymAdminRootSeed)),
               let env = try? VoiciOwner.draft(op: op, username: user, draftsKey: VoiciMessages.deriveVoiciDraftsKey(umk: Array(umk)),
                                               deviceSeed: Array(other.rawRepresentation), grant: grant, grantSignature: sig, seq: 1, now: now - 60_000) {
                m.drafts[user] = [env.json]
            }
        }
    }

    /// This account signed in to river-otter's page two days ago (state blob, attestation kept on this device) and
    /// river-otter replied: the Messages tab shows "You have a reply on voi.ci/river-otter".
    static func seedReply(_ m: MockVoiciComClient, user: String, umk: [UInt8], now: Int64) {
        guard let raw = m.pages["river-otter"], let idx = VoiciPage.parseVoiciPageIndex(raw),
              let me = try? MockVoiciVisitor(secret: VoiciMessages.deriveMessagesSecret(umk: umk), pageId: otterPageId, origin: Endpoints.voiciOrigin, now: now),
              let inboxPub = try? CanonicalJson.hexToBytes(idx.inboxPub),
              let sign = try? VoiciMessages.deriveVoiciOwnerSignKey(umk: otterUmk, pageId: otterPageId, inboxEpoch: 1) else { return }
        var items: [VoiciInboxItem] = []
        if let mine = try? me.message("Love the otter photos!", inboxPub: inboxPub, seq: 1, sentAt: now - 7_200_000) {
            items.append(VoiciInboxItem(envelope: mine, storedAt: now - 7_200_000))
        }
        let c = VoiciConversation(conv: me.conv, pseudonymPub: me.pseudonymPub, threadPub: CanonicalJson.hex(me.thread.publicKey), messages: [], hasGap: false)
        if let r = try? VoiciOwner.reply(text: "Thank you!", replyTo: nil, conversation: c, pageId: otterPageId, pageSeq: 1,
                                         ownerSign: (sign.seed, idx.ownerSignPub), inboxPub: inboxPub, seq: 1, now: now - 3_600_000) {
            items.append(VoiciInboxItem(envelope: r.json, storedAt: now - 3_600_000))
        }
        m.mailbox["river-otter"] = items
        VoiciSignInBook.remember(pageId: otterPageId, username: "river-otter", displayName: "River Otter")
        if let text = try? CanonicalJson.canonicalJson(me.cred.attestation.json) {
            UserDefaults.standard.set(text, forKey: VoiciSignInBook.attestationKey(otterPageId))
        }
        var state = MessagesState()
        state.signedInSites = [MessagesState.SignedInSite(pageId: otterPageId, delegatePub: me.cred.delegation.delegatePub, at: now - 2 * 86_400_000)]
        if let sealed = try? VoiciMessages.sealMessagesState(stateKey: VoiciMessages.deriveMessagesStateKey(umk: umk), username: user, version: 1, state: state) {
            m.states[user] = sealed.json
        }
    }

    /// Publishes a page straight into the mock (pieces and a signed index at seq 1).
    @discardableResult
    static func seedPage(_ m: MockVoiciComClient, username: String, pageId: String, umk: [UInt8], admin: [UInt8], profile: VoiciProfile,
                         posts: [VoiciPost], now: Int64) throws -> VoiciPageIndex {
        let state = VoiciPageState(profile: profile, acceptsMessages: 1, chunks: VoiciPage.chunkVoiciPosts(posts), issuedAt: 0)
        guard let pieces = try VoiciOwner.pieces(state, images: [:]) else { throw CanonicalJsonError("gym page") }
        for p in pieces { m.pieces[pageId, default: [:]][p.ref.sha256] = p.bytes }
        let inbox = try VoiciMessages.deriveVoiciInboxKey(umk: umk, pageId: pageId, inboxEpoch: 1)
        let sign = try VoiciMessages.deriveVoiciOwnerSignKey(umk: umk, pageId: pageId, inboxEpoch: 1)
        let idx = try VoiciPage.signVoiciPageIndex(VoiciPageIndex(
            username: username, pageId: pageId, seq: 1, issuedAt: now - 86_400_000, acceptsMessages: 1, inboxEpoch: 1,
            inboxPub: CanonicalJson.hex(inbox.publicKey), ownerSignPub: CanonicalJson.hex(sign.publicKey), pieces: pieces.map(\.ref),
            signerKind: "admin-root"), signerSeed: admin)
        m.pages[username] = idx.json
        return idx
    }
}

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}
#endif
