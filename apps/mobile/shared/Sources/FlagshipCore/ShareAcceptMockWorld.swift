#if DEBUG
import Foundation
import CryptoKit

/// An in-memory `.com` and owner's box for accepting a co-manage share
/// (docs/share-a-server.md §5.1), with the real wire and checks: `.com`'s
/// account-key attestation (naming the account's admin root, no account), the
/// sealed acceptance (opened with the link key; its #3 and #12 verified as the
/// owner's phone and the box would), and the box's first grant, which takes
/// the acceptance only with that proof and otherwise answers the box's own
/// `accept-*` refusal sentences. Used by the no-backend gym (smoke mode) and
/// unit tests.
public final class ShareAcceptMockWorld: ServerShareTransport, @unchecked Sendable {
    public static let notAdminSentence =
        "Only an admin device of their account can accept a co-manage invitation. Cancel this link and send a new one for them to open on an admin device."
    public static let badSignatureSentence =
        "Their acceptance isn't signed by their account's admin key, so this server can't trust it. Cancel this link and send a new one."

    private let lock = NSLock()
    public let shareId: String
    public let secret: Data
    public let serverDomain: String
    /// The admin root `.com` attests for the joining account.
    public let accountAdminPub: Data
    public private(set) var acceptanceHex: String?
    public private(set) var acceptedProof: ShareAcceptAdminProof?
    public private(set) var refusals: [String] = []
    public private(set) var attestationReads = 0
    public private(set) var grants: [String] = []

    public init(shareId: String, secret: Data, serverDomain: String, accountAdminPub: Data) {
        self.shareId = shareId
        self.secret = secret
        self.serverDomain = serverDomain
        self.accountAdminPub = accountAdminPub
    }

    /// The gym's world: the smoke invitation's share, and the gym admin root.
    public static func gym() -> ShareAcceptMockWorld {
        let admin = try! Curve25519.Signing.PrivateKey(rawRepresentation: GymSeams.gymAdminRootSeed)
        return ShareAcceptMockWorld(shareId: String(repeating: "ab", count: 16), secret: Data(repeating: 0x5e, count: 32),
                                    serverDomain: "cabin.jordan-reyes.flagship.services",
                                    accountAdminPub: admin.publicKey.rawRepresentation)
    }

    public func send(_ r: URLRequest) async throws -> (status: Int, body: Data) {
        lock.lock()
        defer { lock.unlock() }
        let (status, obj) = handle(r)
        return (status, try JSONSerialization.data(withJSONObject: obj))
    }

    private func refuse(_ status: Int, _ code: String, _ error: String) -> (Int, Any) {
        refusals.append(code)
        return (status, ["error": error, "code": code])
    }

    public func attestation() -> [String: Any] {
        let now = ServerShareClock.nowMs()
        return AccountKeyAttestation(keyKind: .adminRoot, keyPubHex: HexUtil.encode(accountAdminPub),
                                     issuedAt: now - 1000, expiresAt: now + 14 * 86_400_000,
                                     signedBy: String(repeating: "ca", count: 32), signature: String(repeating: "00", count: 64)).jsonObject()
    }

    private var ownerRows: [[String: Any]] = []

    /// The owner's side: `.com` lists one accepted invitation, answered by an
    /// app that sent no admin proof (sealed under the owner's household key
    /// and this world's link secret), so the owner's Confirm meets the box's
    /// `accept-not-admin` refusal.
    public func seedOldAcceptance(householdKey: Data, label: String) throws {
        let member = try ServerShare.deriveShareMemberKey(umkSeed: Data(repeating: 0x3b, count: 32), shareId: shareId)
        let accept = ServerShareAccept(serverDomain: serverDomain, shareId: shareId,
                                       memberPubHex: HexUtil.encode(member.publicKey.rawRepresentation),
                                       acceptedAt: ServerShareClock.nowMs() - 60_000)
        let payload = ShareAcceptancePayload(accept: accept, signature: HexUtil.encode(try accept.sign(with: member)))
        let acceptance = try ServerShare.seal(key: ServerShare.shareLinkKey(secret),
                                              aad: ServerShare.shareAad(ServerShare.aadAcceptance, shareId),
                                              plaintext: payload.jsonData())
        let record = ShareOwnerRecord(secretHex: HexUtil.encode(secret), label: label, level: .view,
                                      unlockAtBoot: false, seeAppData: false)
        let owner = try ServerShare.seal(key: householdKey, aad: ServerShare.shareAad(ServerShare.aadOwner, shareId),
                                         plaintext: record.jsonData())
        lock.lock()
        defer { lock.unlock() }
        ownerRows = [["shareId": shareId, "serverDomain": serverDomain, "state": "accepted", "owner": owner,
                      "acceptance": acceptance, "expiresAt": Int64(4_102_444_800_000), "unlock": false]]
    }

    /// Opens a sealed acceptance and checks #3 and the admin proof, as the box would.
    private func checked(_ hex: String) -> (ShareAcceptancePayload?, String?) {
        guard let acc = ServerShareOwnerFlow.verifiedAcceptance(hex, secret: secret, shareId: shareId, serverDomain: serverDomain)
        else { return (nil, "accept-signature") }
        guard let proof = acc.admin else { return (acc, "accept-not-admin") }
        let a = proof.admit
        guard a.serverDomain == acc.accept.serverDomain, a.shareId == acc.accept.shareId,
              a.memberPubHex == acc.accept.memberPubHex, a.acceptedAt == acc.accept.acceptedAt,
              a.keyKind == .adminRoot, a.keyPubHex == HexUtil.encode(accountAdminPub),
              proof.attestation.keyPubHex == a.keyPubHex,
              let sig = HexUtil.decode(proof.signature), a.verify(signature: sig, publicKey: accountAdminPub)
        else { return (acc, "accept-signature") }
        return (acc, nil)
    }

    private func handle(_ r: URLRequest) -> (Int, Any) {
        guard let url = r.url else { return (400, ["error": "bad request"]) }
        let body = r.httpBody.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any] ?? [:]
        let method = r.httpMethod ?? "GET"
        let path = url.path
        if method == "GET", path.hasSuffix("/account-key-attestation") {
            attestationReads += 1
            return (200, ["attestation": attestation()])
        }
        if method == "GET", path == "/api/server-shares/\(shareId)" {
            let offer = ShareOfferPayload(serverDomain: serverDomain, serverName: "Cabin", stkPubHex: String(repeating: "7c", count: 32),
                                          level: .view, unlockAtBoot: false, seeAppData: false, expiresAt: 4_102_444_800_000)
            let sealed = (try? ServerShare.seal(key: ServerShare.shareLinkKey(secret),
                                                aad: ServerShare.shareAad(ServerShare.aadOffer, shareId),
                                                plaintext: offer.jsonData())) ?? ""
            var view: [String: Any] = ["shareId": shareId, "serverDomain": serverDomain, "offer": sealed,
                                       "state": acceptanceHex == nil ? "offered" : "accepted",
                                       "expiresAt": Int64(4_102_444_800_000), "unlock": false]
            if let acceptanceHex { view["acceptance"] = acceptanceHex }
            return (200, view)
        }
        if method == "POST", path == "/api/server-shares/\(shareId)/accept" {
            guard acceptanceHex == nil else { return (409, ["error": "already accepted"]) }
            guard let hex = body["acceptance"] as? String else { return (400, ["error": "no acceptance"]) }
            let (acc, refusal) = checked(hex)
            if let refusal { return refuse(403, refusal, refusal == "accept-not-admin" ? Self.notAdminSentence : Self.badSignatureSentence) }
            acceptanceHex = hex
            acceptedProof = acc?.admin
            return (200, ["ok": true])
        }
        if method == "POST", path == "/api/share-inbox" {
            let op = (body["request"] as? [String: Any])?["op"] as? String
            return (200, op == "list" ? ["entries": [] as [Any]] : ["ok": true])
        }
        if method == "POST", path.hasSuffix("/server-shares/list") {
            return (200, ["shares": ownerRows])
        }
        if method == "GET", path == "/api/screens/shares" {
            return (200, ["shares": [] as [Any], "ended": [] as [Any]])
        }
        if method == "GET", path == "/api/screens/activity" {
            return (200, ["entries": [] as [Any]])
        }
        if method == "GET", path == "/api/shares/nonce" {
            return (200, ["nonce": String(repeating: "11", count: 32)])
        }
        if method == "POST", path == "/api/shares/session" {
            return (403, ["error": "not-shared", "code": "not-shared"])
        }
        if method == "POST", path == "/api/screens/shares" {
            // The box's first grant: the acceptance with the joining account's admin proof.
            guard let proofObj = body["acceptAdmin"], let proof = ShareAcceptAdminProof(jsonObject: proofObj) else {
                return refuse(403, "accept-not-admin", Self.notAdminSentence)
            }
            guard let sig = HexUtil.decode(proof.signature), proof.admit.keyPubHex == HexUtil.encode(accountAdminPub),
                  proof.admit.verify(signature: sig, publicKey: accountAdminPub)
            else { return refuse(403, "accept-signature", Self.badSignatureSentence) }
            grants.append(proof.admit.shareId)
            return (200, ["ok": true, "created": true])
        }
        return (404, ["error": "no route"])
    }
}
#endif
