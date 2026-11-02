import Foundation
import FlagshipAPI
import FlagshipCore

/// The admin phone's half of direct delivery (docs/voici-and-messages.md §8.2, §12.1): the phone endpoint's `live`
/// answer and `deliver` check. Checks run in the spec's order, cheapest first, before anything is decrypted; a
/// message is stored, forwarded to the mailbox (`direct: true`), then acknowledged with the owner messages key; a
/// draft from another device of the account is acknowledged with this phone's admin device key.
final class MessagesPhoneInbox: PhoneWebInbox, @unchecked Sendable {
    struct Snapshot {
        let username: String
        let pageId: String
        let accepts: Bool
        let ownerSignSeed: [UInt8]
        let ownerSignPub: String
        let draftsKey: [UInt8]
        let deviceSeed: [UInt8]
        let phoneRoutePub: String
        let blocked: Set<String>
        let revoked: Set<String>
        let accountKeys: [String]
        let origin: String
        let client: any VoiciComClient
    }

    private let lock = NSLock()
    private var snap: Snapshot?
    private var seen: [String] = []
    private let limiter = VoiciDeliveryLimiter()
    var onMessage: (@Sendable (JSONValue) -> Void)?
    var onDraft: (@Sendable (VoiciDraftOp) -> Void)?
    var now: @Sendable () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }

    func set(_ s: Snapshot?) { lock.withLock { snap = s } }

    func liveOwnerSignPub() -> String? { lock.withLock { snap?.ownerSignPub } }

    private static func refuse(_ status: Int, _ code: String) -> (Int, String) { (status, #"{"error":"refused","code":"\#(code)"}"#) }

    func deliver(_ body: Data, origin: String?) async -> (status: Int, json: String) {
        guard let s = lock.withLock({ snap }) else { return Self.refuse(503, "unavailable") }
        guard body.count <= VoiciMessages.draftMaxEnvelopeBytes, let v = JSONValue.parse(utf8: Array(body)) else { return Self.refuse(400, "malformed") }
        let t = now()
        switch v["kind"]?.string {
        case "voici-message":
            guard body.count <= WebEnvelope.maxBytes else { return Self.refuse(413, "too-large") }
            guard let from = v["from"]?.string, limiter.admit(from: from, now: t) else { return Self.refuse(429, "rate-limited") }
            let caKeys = await s.client.caKeys()
            let ctx = VoiciMessageCheckContext(pageId: s.pageId, acceptsMessages: s.accepts, origin: s.origin, caKeys: caKeys, now: t,
                                               blocked: s.blocked, revoked: s.revoked)
            let checked = VoiciMessages.checkVoiciMessage(v, ctx)
            // A blocked sender learns nothing: accepted, never delivered (no oracle, §9.1).
            if case .refused(.blocked) = checked { return (200, #"{"accepted":true}"#) }
            guard case .ok(let ok) = checked else { return Self.refuse(400, checked.code) }
            let key = ok.envelope.conv + "|" + ok.envelope.msgId
            let fresh: Bool = lock.withLock {
                if seen.contains(key) { return false }
                seen.append(key)
                if seen.count > 2_000 { seen.removeFirst(500) }
                return true
            }
            guard fresh else { return Self.refuse(409, "duplicate") }
            onMessage?(v)
            try? await s.client.send(envelope: v, direct: true)
            return Self.ack(conv: ok.envelope.conv, msgId: ok.envelope.msgId, at: t, phoneRoutePub: s.phoneRoutePub, seed: s.ownerSignSeed)
        case "voici-draft":
            let checked = VoiciMessages.checkVoiciDraft(v, username: s.username, checkGrant: { g, sig, d in
                VoiciOwner.checkDraftGrant(g, signature: sig, devicePub: d, username: s.username, accountKeys: s.accountKeys, now: t)
            }, freshAt: t)
            guard case .ok(let env) = checked, let bytes = CanonicalJson.b64Decode(env.bodyB64),
                  let op = VoiciMessages.openVoiciDraft(draftsKey: s.draftsKey, username: s.username, opId: env.msgId, bodyBytes: bytes)
            else { return Self.refuse(400, checked.isOk ? "malformed" : checked.code) }
            onDraft?(op)
            return Self.ack(conv: "", msgId: env.msgId, at: t, phoneRoutePub: s.phoneRoutePub, seed: s.deviceSeed)
        default:
            return Self.refuse(400, "wrong-kind")
        }
    }

    private static func ack(conv: String, msgId: String, at: Int64, phoneRoutePub: String, seed: [UInt8]) -> (Int, String) {
        let a = VoiciAck(conv: conv, msgId: msgId, receivedAt: at, phoneRoutePub: phoneRoutePub)
        guard let sig = try? VoiciMessages.signVoiciAck(a, seed: seed), let text = try? CanonicalJson.canonicalJson(["ack": a.json(signature: sig)]) else {
            return refuse(500, "ack")
        }
        return (200, text)
    }
}

/// A native sender's direct delivery to the account's admin phone (§8.1): ask `live` (2 s), then `deliver`, and accept
/// only an ack signed by a key that holds an admin grant of this account.
enum PhoneDelivery {
    static func deliverDraft(_ env: JSONValue, username: String, adminDevices: Set<String>) async -> Bool {
        let host = PhoneRoute.hostname(account: username, apex: Endpoints.dataApex)
        guard let live = URL(string: "https://\(host)\(VoiciPhoneWeb.livePath)"), let deliver = URL(string: "https://\(host)\(VoiciPhoneWeb.deliverPath)"),
              let msgId = env["msgId"]?.string, let body = try? CanonicalJson.canonicalJson(env) else { return false }
        var ping = URLRequest(url: live, timeoutInterval: 2)
        ping.cachePolicy = .reloadIgnoringLocalCacheData
        guard let (data, res) = try? await URLSession.shared.gatedData(for: ping), (res as? HTTPURLResponse)?.statusCode == 200,
              VoiciPhoneWeb.parsePhoneLiveAnswer(JSONValue.parse(utf8: Array(data)))?.account == username.lowercased() else { return false }
        var post = URLRequest(url: deliver, timeoutInterval: 10)
        post.httpMethod = "POST"
        post.setValue(VoiciPhoneWeb.envelopeContentType, forHTTPHeaderField: "content-type")
        post.httpBody = Data(body.utf8)
        guard let (answer, r2) = try? await URLSession.shared.gatedData(for: post), (r2 as? HTTPURLResponse)?.statusCode == 200,
              let ack = JSONValue.parse(utf8: Array(answer))?["ack"], let signer = ack["phoneRoutePub"]?.string,
              adminDevices.contains(signer), VoiciMessages.verifyVoiciAck(ack, signerPub: signer, msgId: msgId, conv: "") != nil else { return false }
        return true
    }
}
