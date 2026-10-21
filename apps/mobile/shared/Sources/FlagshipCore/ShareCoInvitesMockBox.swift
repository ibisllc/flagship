#if DEBUG
import Foundation
import CryptoKit

/// An in-memory shared box that answers the co-manager invite endpoints with
/// the box's exact wire (`/api/shares/invites`, `/invites/withdraw`, the
/// refusal `code`s and sentences). Used by the no-backend gym (smoke mode)
/// and unit tests. It verifies every signature under `memberPub` when one is
/// given, like the box does.
public final class ShareCoInvitesMockBox: ServerShareTransport, @unchecked Sendable {
    public struct App {
        public var canInvite: Bool
        public var why: String?
        public var rank: String?
        public var invites: [[String: Any]]

        public init(canInvite: Bool, why: String? = nil, rank: String? = "manager", invites: [[String: Any]] = []) {
            self.canInvite = canInvite
            self.why = why
            self.rank = rank
            self.invites = invites
        }
    }

    public static let ownerAid = String(repeating: "c4", count: 32)

    private let lock = NSLock()
    public private(set) var apps: [String: App]
    public private(set) var lastCreateBody: [String: Any]?
    public private(set) var lastWithdrawBody: [String: Any]?
    public private(set) var sessionTokens: [String] = []
    public var memberPub: Data?
    public var now: () -> Int64

    public init(apps: [String: App], memberPub: Data? = nil, now: @escaping () -> Int64 = { ServerShareClock.nowMs() }) {
        self.apps = apps
        self.memberPub = memberPub
        self.now = now
    }

    /// The gym's two apps: Plants (B may invite, nothing sent yet) and Wiki
    /// (an admin made B a Member; one invite, "Jo", one person joined).
    public static func gym(creator: String = "bright-maple", bundleKey: Data?) -> ShareCoInvitesMockBox {
        let joId = String(repeating: "a7", count: 32)
        let jo = bundleKey.flatMap { try? ServiceInvite.sealBundle(.init(name: String(localized: "Jo")), householdKey: $0, inviteId: joId) } ?? "00"
        return ShareCoInvitesMockBox(apps: [
            "\(creator)--plants": App(canInvite: true),
            "\(creator)--wiki": App(canInvite: false, why: "demoted", rank: "member", invites: [
                ["inviteId": joId, "createdAt": ServerShareClock.nowMs() - 86_400_000, "encryptedBundle": jo,
                 "maxRedemptions": NSNull(), "expiresAt": NSNull(), "joined": 1],
            ]),
        ])
    }

    public static let whyText: [String: String] = ShareCoInviteCopy.why

    public func send(_ r: URLRequest) async throws -> (status: Int, body: Data) {
        lock.lock()
        defer { lock.unlock() }
        let (status, obj) = handle(r)
        return (status, try JSONSerialization.data(withJSONObject: obj))
    }

    private func refusal(_ status: Int, _ code: String, _ error: String) -> (Int, Any) {
        (status, ["error": error, "code": code])
    }

    private func handle(_ r: URLRequest) -> (Int, Any) {
        guard let url = r.url else { return refusal(400, "malformed", "bad request") }
        guard let token = r.value(forHTTPHeaderField: ServerShareClient.sessionHeader), !token.isEmpty else {
            return refusal(401, "no-session", String(localized: "Sign in again."))
        }
        sessionTokens.append(token)
        let body = r.httpBody.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any] ?? [:]
        switch (r.httpMethod ?? "GET", url.path) {
        case ("GET", "/api/shares/invites"):
            let ref = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "service" }?.value ?? ""
            guard let app = apps[ref] else { return refusal(404, "no-such-app", String(localized: "That app isn't on this server.")) }
            return (200, [
                "serviceRef": ref,
                "canInvite": app.canInvite,
                "why": app.why.map { $0 as Any } ?? NSNull(),
                "whyText": app.why.flatMap { Self.whyText[$0] }.map { $0 as Any } ?? NSNull(),
                "rank": app.rank.map { $0 as Any } ?? NSNull(),
                "ownerAid": Self.ownerAid,
                "invites": app.invites,
            ] as [String: Any])
        case ("POST", "/api/shares/invites"):
            lastCreateBody = body
            guard let req = body["request"] as? [String: Any], let sig = body["signature"] as? String,
                  let ref = req["serviceRef"] as? String, let inviteId = req["inviteId"] as? String
            else { return refusal(400, "malformed", String(localized: "That request isn't complete.")) }
            if req["approvalMode"] != nil { return refusal(422, "manual-not-offered", String(localized: "Co-managers can't make approve-first invites.")) }
            guard var app = apps[ref] else { return refusal(404, "no-such-app", String(localized: "That app isn't on this server.")) }
            if !app.canInvite, let why = app.why { return refusal(403, why, Self.whyText[why] ?? why) }
            guard (req["authorAID"] as? String) == Self.ownerAid else {
                return refusal(403, "wrong-author", String(localized: "The invite must name the server's owner."))
            }
            if let pub = memberPub, !verifyCreate(req, sig: sig, pub: pub) {
                return refusal(403, "invalid-signature", "invalid-signature")
            }
            let issuedAt = (req["issuedAt"] as? NSNumber)?.int64Value ?? 0
            if abs(issuedAt - now()) > 5 * 60_000 {
                return refusal(403, "stale", String(localized: "Your device's clock looks off. Check it and try again."))
            }
            if app.invites.contains(where: { $0["inviteId"] as? String == inviteId }) {
                return refusal(409, "exists", String(localized: "That invite already exists."))
            }
            app.invites.append([
                "inviteId": inviteId, "createdAt": issuedAt, "encryptedBundle": req["encryptedBundle"] ?? "",
                "maxRedemptions": req["maxRedemptions"] ?? NSNull(), "expiresAt": req["expiresAt"] ?? NSNull(), "joined": 0,
            ])
            apps[ref] = app
            return (200, ["created": true, "inviteId": inviteId, "tier": "co-manager"])
        case ("POST", "/api/shares/invites/withdraw"):
            lastWithdrawBody = body
            guard let revoke = body["revoke"] as? [String: Any], let inviteId = revoke["inviteId"] as? String,
                  let sig = body["signature"] as? String
            else { return refusal(400, "malformed", String(localized: "That request isn't complete.")) }
            guard let ref = apps.first(where: { $0.value.invites.contains { $0["inviteId"] as? String == inviteId } })?.key,
                  var app = apps[ref]
            else { return refusal(404, "not-yours", String(localized: "That isn't one of your invites.")) }
            if !app.canInvite, let why = app.why { return refusal(403, why, Self.whyText[why] ?? why) }
            if let pub = memberPub {
                let issuedAt = (revoke["issuedAt"] as? NSNumber)?.int64Value ?? 0
                guard let bytes = try? ServiceInvite.canonicalRevoke(inviteId: inviteId, issuedAt: issuedAt),
                      let s = HexUtil.decode(sig), let k = try? Curve25519.Signing.PublicKey(rawRepresentation: pub),
                      k.isValidSignature(s, for: bytes)
                else { return refusal(403, "invalid-signature", "invalid-signature") }
            }
            app.invites.removeAll { $0["inviteId"] as? String == inviteId }
            apps[ref] = app
            return (200, ["ok": true, "pruned": 0, "comNotified": true])
        default:
            return refusal(404, "not-found", String(localized: "Not found."))
        }
    }

    private func verifyCreate(_ req: [String: Any], sig: String, pub: Data) -> Bool {
        guard let aid = (req["authorAID"] as? String).flatMap(HexUtil.decode),
              let bytes = try? ServiceInvite.canonicalCreate(
                  inviteId: req["inviteId"] as? String ?? "", authorAID: aid, serviceRef: req["serviceRef"] as? String ?? "",
                  secretHash: req["secretHash"] as? String ?? "", encryptedBundle: req["encryptedBundle"] as? String ?? "",
                  issuedAt: (req["issuedAt"] as? NSNumber)?.int64Value ?? 0,
                  maxRedemptions: (req["maxRedemptions"] as? NSNumber)?.intValue,
                  expiresAt: (req["expiresAt"] as? NSNumber)?.int64Value),
              let s = HexUtil.decode(sig), let k = try? Curve25519.Signing.PublicKey(rawRepresentation: pub)
        else { return false }
        return k.isValidSignature(s, for: bytes)
    }
}
#endif
