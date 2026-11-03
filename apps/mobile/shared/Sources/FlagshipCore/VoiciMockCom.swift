#if DEBUG
import Foundation
import CryptoKit

/// Gym and unit tests only: an in-memory `.com` for voi.ci pages and Messages that answers the routes the apps call
/// with the same checks `.com` runs (the publish check, piece signatures, seq compare-and-set, the state version
/// compare-and-set) and signs attestations with a fixed CA key the app is told to trust.
public final class MockVoiciComClient: VoiciComClient, @unchecked Sendable {
    public static let caSeed = [UInt8](repeating: 0x5c, count: 32)
    public static var caPub: String { CanonicalJson.hex((try? CanonicalJson.ed25519PublicKey(seed: caSeed)) ?? []) }

    private let lock = NSLock()
    public var keys: [String: VoiciAccountKeys] = [:]
    public var pages: [String: JSONValue] = [:]
    public var pieces: [String: [String: [UInt8]]] = [:]
    public var drafts: [String: [JSONValue]] = [:]
    public var mailbox: [String: [VoiciInboxItem]] = [:]
    public var blocks: [String: [String]] = [:]
    public var states: [String: JSONValue] = [:]
    public private(set) var sent: [JSONValue] = []
    public private(set) var reports: [JSONValue] = []
    public private(set) var revokes: [JSONValue] = []
    public private(set) var attestRequests: [JSONValue] = []
    public private(set) var consumed: [String] = []
    public private(set) var publishes = 0
    /// Answer every attestation request with this refusal (code, retryAfterSec).
    public var attestRefusal: (code: String, retryAfterSec: Int?)?
    /// Refuse every write with this code (the network is down: "network").
    public var failWrites: String?
    /// Answer the next revoke with this refusal.
    public var revokeRefusal: (status: Int, code: String)?
    public var now: () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }

    public init() {}

    private func w<T>(_ f: () throws -> T) rethrows -> T { lock.lock(); defer { lock.unlock() }; return try f() }
    private func down() throws { if let c = failWrites { throw VoiciComError(status: 0, code: c) } }

    public func accountKeys(username: String) async throws -> VoiciAccountKeys {
        guard let k = w({ keys[username.lowercased()] }) else { throw VoiciComError(status: 404, code: "not-found") }
        return k
    }

    public func page(username: String) async throws -> JSONValue? { w { pages[username.lowercased()] } }

    public func piece(pageId: String, sha256: String) async throws -> [UInt8] {
        guard let b = w({ pieces[pageId]?[sha256] }) else { throw VoiciComError(status: 404, code: "not-found") }
        return b
    }

    public func uploadPiece(username: String, upload: VoiciPieceUpload, signerPub: String, signature: String, bytes: [UInt8]) async throws {
        try down()
        let u = username.lowercased()
        guard let k = w({ keys[u] }), CanonicalJson.same(k.sensitive.pub, signerPub) else { throw VoiciComError(status: 403, code: "not-sensitive-key") }
        guard VoiciPage.verifyVoiciPieceUpload(upload, signature: signature, signerPub: signerPub) else { throw VoiciComError(status: 403, code: "bad-signature") }
        guard Int64(bytes.count) == upload.size, CanonicalJson.sha256Hex(bytes) == upload.sha256 else { throw VoiciComError(status: 400, code: "bad-piece") }
        w { pieces[upload.pageId, default: [:]][upload.sha256] = bytes }
    }

    public func publish(username: String, index: JSONValue) async throws {
        try down()
        let u = username.lowercased()
        guard let k = w({ keys[u] }) else { throw VoiciComError(status: 404, code: "not-found") }
        let stored = w { pages[u] }.flatMap { VoiciPage.parseVoiciPageIndex($0) }
        let r = VoiciPage.checkVoiciPublish(index, username: u, sensitiveKind: k.sensitive.kind, sensitivePub: k.sensitive.pub,
                                            storedSeq: stored?.seq ?? 0, storedPageId: stored?.pageId, now: now())
        switch r {
        case .refused(let code):
            throw VoiciComError(status: code == .seqConflict ? 409 : 400, code: code.rawValue, stored: code == .seqConflict ? w { pages[u] } : nil)
        case .ok(let idx):
            for p in idx.pieces where w({ pieces[idx.pageId]?[p.sha256] })?.count != Int(p.size) {
                throw VoiciComError(status: 400, code: "missing-piece")
            }
            w {
                pages[u] = index
                publishes += 1
            }
        }
    }

    public func depositDraft(username: String, envelope: JSONValue, device: VoiciDeviceSigner) async throws {
        try down()
        guard await device("POST", VoiciComPaths.drafts(username)) != nil else { throw VoiciComError(status: 401, code: "no-device-key") }
        w { drafts[username.lowercased(), default: []].append(envelope) }
    }

    public func drafts(username: String) async throws -> [JSONValue] { w { drafts[username.lowercased()] ?? [] } }

    public func consumeDrafts(username: String, opIds: [String], issuedAt: Int64, signerPub: String, signature: String) async throws {
        try down()
        let u = username.lowercased()
        guard let k = w({ keys[u] }), CanonicalJson.same(k.sensitive.pub, signerPub),
              CanonicalJson.ed25519VerifyHex(signature, VoiciComPaths.canonicalDraftsConsume(username: u, opIds: opIds, issuedAt: issuedAt), signerPub)
        else { throw VoiciComError(status: 403, code: "bad-signature") }
        w {
            consumed += opIds
            drafts[u] = (drafts[u] ?? []).filter { !opIds.contains($0["msgId"]?.string ?? "") }
        }
    }

    public func inbox(username: String, since: String) async throws -> VoiciInbox {
        w {
            let all = mailbox[username.lowercased()] ?? []
            let from = Int(since) ?? 0
            let items = from < all.count ? Array(all[from...]) : []
            return VoiciInbox(items: items, cursor: String(all.count), blocks: blocks[username.lowercased()] ?? [])
        }
    }

    /// The account whose page `pageId` names.
    private func owner(of pageId: String) -> String? {
        pages.first { $0.value["pageId"]?.string == pageId }?.key
    }

    public func send(envelope: JSONValue, direct: Bool) async throws {
        try down()
        try w {
            guard let pageId = envelope["audience"]?.string, let u = owner(of: pageId) else { throw VoiciComError(status: 404, code: "not-found") }
            sent.append(envelope)
            let msgId = envelope["msgId"]?.string
            if (mailbox[u] ?? []).contains(where: { $0.envelope["msgId"]?.string == msgId }) { return }
            mailbox[u, default: []].append(VoiciInboxItem(envelope: envelope, storedAt: now(), direct: direct))
        }
    }

    public func block(username: String, block: VoiciBlock, signature: String) async throws {
        try down()
        let u = username.lowercased()
        guard let idx = w({ pages[u] }).flatMap({ VoiciPage.parseVoiciPageIndex($0) }),
              VoiciMessages.verifyVoiciBlock(block, signature: signature, ownerSignPub: idx.ownerSignPub)
        else { throw VoiciComError(status: 403, code: "bad-signature") }
        w {
            var b = blocks[u] ?? []
            b.removeAll { $0 == block.pseudonymPub }
            if block.op == "block" { b.append(block.pseudonymPub) }
            blocks[u] = b
        }
    }

    public func report(report: JSONValue, signature: String) async throws {
        try down()
        w { reports.append(["report": report, "signature": .string(signature)]) }
    }

    public func revoke(_ r: WebDelegationRevoke, signature: String, principalPub: String, pageId: String, delegation: JSONValue?, delegationSig: String?) async throws {
        try down()
        if let refusal = w({ () -> (status: Int, code: String)? in defer { revokeRefusal = nil }; return revokeRefusal }) {
            throw VoiciComError(status: refusal.status, code: refusal.code)
        }
        var principal = principalPub
        if let delegation {
            guard let d = WebDelegations.parseWebDelegation(delegation), d.delegatePub == r.delegatePub, let delegationSig,
                  let bytes = try? WebDelegations.canonicalWebDelegation(d), CanonicalJson.ed25519VerifyHex(delegationSig, bytes, d.principalPub) else {
                throw VoiciComError(status: 403, code: "bad-delegation")
            }
            principal = d.principalPub
        }
        guard WebDelegations.verifyWebDelegationRevoke(r, signature: signature, principalPub: principal) else {
            throw VoiciComError(status: 403, code: "bad-signature")
        }
        w { revokes.append(VoiciSignOut.body(r, signature: signature, principalPub: principalPub, pageId: pageId, delegation: delegation, delegationSig: delegationSig)) }
    }

    public func messagesState(username: String) async throws -> JSONValue? { w { states[username.lowercased()] } }

    public func putMessagesState(username: String, blob: SealedMessagesState, device: VoiciDeviceSigner) async throws {
        try down()
        let u = username.lowercased()
        try w {
            let stored = states[u]?["version"]?.time ?? 0
            guard blob.version == stored + 1 else { throw VoiciComError(status: 409, code: "version-conflict", stored: states[u]) }
            states[u] = blob.json
        }
    }

    public func attest(username: String, request: MessagesKeyAttestationRequest, signature: String, integrity: JSONValue?,
                       previous: JSONValue?, device: VoiciDeviceSigner) async throws -> JSONValue {
        try down()
        w { attestRequests.append(["pseudonymPub": .string(request.pseudonymPub), "deviceCheckRef": .string(request.deviceCheckRef), "integrity": integrity ?? .null]) }
        if let r = attestRefusal { throw VoiciComError(status: r.code == "first-contact-limit" ? 429 : 403, code: r.code, retryAfterSec: r.retryAfterSec) }
        return try Self.attestation(pseudonymPub: request.pseudonymPub, now: now()).json
    }

    public func thread(fetch: VoiciThreadFetch, signature: String, cred: JSONValue) async throws -> (items: [VoiciInboxItem], next: String, more: Bool) {
        guard let d = WebDelegations.parseWebDelegation(cred["delegation"]), let bytes = try? fetch.canonicalBytes(),
              CanonicalJson.p256VerifyP1363(signature, bytes, d.delegatePub),
              (try? VoiciMessages.voiciConv(pageId: d.audience, pseudonymPub: d.principalPub)) == fetch.conv
        else { throw VoiciComError(status: 403, code: "bad-signature") }
        return w {
            let all = mailbox.values.flatMap { $0 }.filter { $0.envelope["conv"]?.string == fetch.conv }
            let from = Int(fetch.since) ?? 0
            return (from < all.count ? Array(all[from...]) : [], String(all.count), false)
        }
    }

    public var grants: [String: [JSONValue]] = [:]
    public func deviceGrants(username: String) async throws -> [JSONValue] { w { grants[username.lowercased()] ?? [] } }

    public func caKeys() async -> [String] { [Self.caPub] }

    /// An attestation of `pseudonymPub` by the mock CA (the abuse tag is opaque random bytes here).
    public static func attestation(pseudonymPub: String, now: Int64) throws -> MessagesKeyAttestation {
        let tag = VoiciMessages.random(96)
        let hash = CanonicalJson.sha256Hex(tag)
        let exp = now + MessagesAttestations.ttlMs
        let bytes = try MessagesAttestations.canonicalMessagesKeyAttestation(pseudonymPub: pseudonymPub, abuseEpoch: 1, abuseTagHash: hash,
                                                                             issuedAt: now, expiresAt: exp)
        return MessagesKeyAttestation(pseudonymPub: pseudonymPub, abuseEpoch: 1, abuseTagHash: hash, abuseTag: CanonicalJson.b64Encode(tag),
                                      issuedAt: now, expiresAt: exp, signedBy: caPub, signature: try CanonicalJson.ed25519SignHex(bytes, seed: caSeed))
    }
}

/// Gym and unit tests only: a visitor writing to a page from voi.ci, with real keys (a Messages secret, a browser
/// P-256 key) and the mock CA's attestation, so the owner's app receives exactly what a browser would send.
public struct MockVoiciVisitor: Sendable {
    public let pageId: String
    public let pseudonym: (seed: [UInt8], publicKey: [UInt8])
    public let thread: (seed: [UInt8], publicKey: [UInt8])
    public let browser: P256.Signing.PrivateKey
    public let cred: VoiciMessageCred
    public let origin: String

    public var pseudonymPub: String { CanonicalJson.hex(pseudonym.publicKey) }
    public var conv: String { (try? VoiciMessages.voiciConv(pageId: pageId, pseudonymPub: pseudonymPub)) ?? "" }

    public init(secret: [UInt8], pageId: String, origin: String, now: Int64) throws {
        self.pageId = pageId
        self.origin = origin
        pseudonym = try VoiciMessages.deriveMessagesPseudonymKey(messagesSecret: secret, pageId: pageId)
        thread = try VoiciMessages.deriveMessagesThreadKey(messagesSecret: secret, pageId: pageId)
        browser = P256.Signing.PrivateKey()
        let p = CanonicalJson.hex(pseudonym.publicKey)
        // Signed in two days ago, so messages from the last day verify at their own sentAt.
        let since = now - 2 * 86_400_000
        let att = try MockVoiciComClient.attestation(pseudonymPub: p, now: since)
        let del = WebDelegation(scope: "voici-messages", origin: origin, audience: pageId, principalPub: p,
                                delegatePub: CanonicalJson.hex(Array(browser.publicKey.x963Representation)), issuedAt: since,
                                expiresAt: att.expiresAt, nonce: CanonicalJson.hex(VoiciMessages.random(16)))
        let ts = VoiciThreadStatement(pageId: pageId, pseudonymPub: p, threadPub: CanonicalJson.hex(thread.publicKey), issuedAt: since)
        cred = VoiciMessageCred(attestation: att, delegation: del, delegationSig: try WebDelegations.signWebDelegation(del, principalSeed: pseudonym.seed),
                                threadStmt: ts, threadSig: try VoiciMessages.signVoiciThreadStatement(ts, pseudonymSeed: pseudonym.seed))
    }

    /// A `voici-message` to the page whose inbox key is `inboxPub`.
    public func message(_ text: String, inboxPub: [UInt8], seq: Int64, sentAt: Int64, replyTo: String? = nil) throws -> JSONValue {
        let msgId = CanonicalJson.hex(VoiciMessages.random(16))
        let body = try VoiciMessages.sealVoiciBody(conv: conv, msgId: msgId, sentAt: sentAt, fromPub: pseudonymPub,
                                                   recipients: [inboxPub, thread.publicKey], plaintext: VoiciPlaintext(text: text, replyTo: replyTo))
        var env = WebEnvelope(kind: "voici-message", audience: pageId, conv: conv, from: pseudonymPub, msgId: msgId, seq: seq, sentAt: sentAt,
                              bodyB64: CanonicalJson.b64Encode(body), cred: cred.json, sigAlg: .p256)
        let sig = try browser.signature(for: Data(try WebEnvelope.canonicalWebEnvelope(env)))
        env.sig = CanonicalJson.hex(Array(sig.rawRepresentation))
        return env.json
    }
}
#endif
