import Foundation

/// The caller's side of a conversation, in the app (docs/voici-calls.md "Release-manager decisions" 2: Social → the
/// conversations this account started on other people's pages): its own messages and the owner's replies, opened with
/// the account's thread key T for that page, and the envelopes it sends there (a message, or a reveal / unreveal as a
/// `{v:1, control}` body). The envelope is signed by a P-256 key the pseudonym P delegated to, as voi.ci's is.
public enum VoiciVisitorThread {
    /// Every checked message and reply of the conversation, oldest first; controls are left out (they change the
    /// reveal, not the thread). Reading history checks signatures, not freshness.
    public static func messages(items: [VoiciInboxItem], pageId: String, conv: String, ownerSignPub: String, threadSeed: [UInt8], caKeys: [String],
                                origin: String) -> [VoiciThreadMessage] {
        var out: [VoiciThreadMessage] = []
        var seen = Set<String>()
        for item in items where item.envelope["conv"]?.string == conv {
            let kind = item.envelope["kind"]?.string
            let env: WebEnvelope
            if kind == "voici-message" {
                let ctx = VoiciMessageCheckContext(pageId: pageId, acceptsMessages: true, origin: origin, caKeys: caKeys, now: item.envelope["sentAt"]?.time ?? 0)
                guard case .ok(let ok) = VoiciMessages.checkVoiciMessage(item.envelope, ctx) else { continue }
                env = ok.envelope
            } else if kind == "voici-reply" {
                guard case .ok(let ok) = VoiciMessages.checkVoiciReply(item.envelope, pageId: pageId, ownerSignPub: ownerSignPub) else { continue }
                env = ok.envelope
            } else { continue }
            guard env.conv == conv, !seen.contains(env.msgId), let body = CanonicalJson.b64Decode(env.bodyB64),
                  case .ok(let pt)? = try? VoiciMessages.openVoiciBody(body, conv: conv, msgId: env.msgId, recipientSeed: threadSeed) else { continue }
            seen.insert(env.msgId)
            out.append(VoiciThreadMessage(msgId: env.msgId, conv: conv, fromOwner: kind == "voici-reply", from: env.from, seq: env.seq, text: pt.text,
                                          replyTo: pt.replyTo, sentAt: env.sentAt, receipt: item.fetchedAt != nil ? .delivered : .sent, envelope: item.envelope))
        }
        return out.sorted { $0.sentAt != $1.sentAt ? $0.sentAt < $1.sentAt : CanonicalJson.utf16Less($0.msgId, $1.msgId) }
    }

    /// This side's next seq: one past the highest of its own envelopes in the fetched thread (controls included).
    public static func nextSeq(items: [VoiciInboxItem], conv: String, from: String) -> Int64 {
        (items.filter { $0.envelope["conv"]?.string == conv && $0.envelope["from"]?.string == from }.compactMap { $0.envelope["seq"]?.time }.max() ?? 0) + 1
    }

    /// A `voici-message` from this account: text, or a control (reveal / unreveal), sealed to the page's inbox key and
    /// the account's thread key, signed by the delegated P-256 key.
    public static func envelope(pageId: String, conv: String, from: String, seq: Int64, sentAt: Int64, inboxPub: [UInt8], threadPub: [UInt8],
                                cred: [String: JSONValue], text: String? = nil, control: JSONValue? = nil, sign: ([UInt8]) throws -> [UInt8]) throws -> JSONValue {
        let msgId = CanonicalJson.hex(VoiciMessages.random(16))
        let body: [UInt8]
        if let control {
            body = try VoiciMessages.sealVoiciControl(conv: conv, msgId: msgId, sentAt: sentAt, fromPub: from, recipients: [inboxPub, threadPub], control: control)
        } else {
            body = try VoiciMessages.sealVoiciBody(conv: conv, msgId: msgId, sentAt: sentAt, fromPub: from, recipients: [inboxPub, threadPub],
                                                   plaintext: VoiciPlaintext(text: text ?? "", replyTo: nil))
        }
        var env = WebEnvelope(kind: "voici-message", audience: pageId, conv: conv, from: from, msgId: msgId, seq: seq, sentAt: sentAt,
                              bodyB64: CanonicalJson.b64Encode(body), cred: cred, sigAlg: .p256)
        let sig = try sign(try WebEnvelope.canonicalWebEnvelope(env))
        guard sig.count == 64 else { throw CanonicalJsonError("voici message: bad signature") }
        env.sig = CanonicalJson.hex(sig)
        return env.json
    }
}
