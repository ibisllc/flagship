import Foundation
import CryptoKit
import FlagshipAPI

/// The client contract of "Share this server" (docs/share-a-server.md §9), as
/// orchestration over `ServerShareClient` and the `ServerShare` port. Keys
/// come in through closures so the app can put each one behind Face ID and
/// tests can pass fixed keys.

public enum ServerShareFlowError: Error, Equatable, LocalizedError, Sendable {
    case badLink
    case linkExpired
    case linkUsed
    case shareEnded
    case notConfirmedYet
    case badLabel
    case unknownServerIdentity
    case noDiskKey
    case diskKeyUnreadable
    case notSignedIn
    case startupNotFromServer
    case noStartupWaiting
    case startupNotShared
    case noPushPermission
    case noPushToken

    public var errorDescription: String? {
        switch self {
        case .badLink: return "This link doesn't work. Ask for a new one."
        case .linkExpired: return "This link has expired. Ask for a new one."
        case .linkUsed: return "Someone else already used this link. Ask for a new one."
        case .shareEnded: return "This server isn't shared with you any more."
        case .notConfirmedYet: return "The owner hasn't confirmed yet."
        case .badLabel: return "Use 1 to 64 characters, without |."
        case .unknownServerIdentity: return "This server's identity isn't known yet. Try again once it's online."
        case .noDiskKey: return "This server has no start-up key on file."
        case .diskKeyUnreadable: return "This phone couldn't open the server's start-up key."
        case .notSignedIn: return "Sign in to this server first."
        case .startupNotFromServer: return "That start-up request didn't come from this server."
        case .noStartupWaiting: return "The server stopped waiting. It will ask again when it next starts."
        case .startupNotShared: return "The owner hasn't let you approve this server's start-up."
        case .noPushPermission: return "Allow notifications for Flagship in Settings, then try again."
        case .noPushToken: return "This device couldn't get a notification address. Try again later."
        }
    }
}

public enum ServerShareNames {
    /// `<server>.<owner>.<apex>` → `owner`; the domain itself when it has no such shape.
    public static func ownerName(fromDomain domain: String) -> String {
        let parts = domain.lowercased().split(separator: ".")
        return parts.count >= 3 ? String(parts[1]) : domain
    }

    /// `<server>.<owner>.<apex>` → `server`.
    public static func serverLabel(fromDomain domain: String) -> String {
        String(domain.lowercased().split(separator: ".").first ?? Substring(domain))
    }
}

public enum ServerShareClock {
    public static func nowMs() -> Int64 { Int64(Date().timeIntervalSince1970 * 1000) }
}

/// The box refused a co-manager's update order, in words for the person.
public struct ShareUpdateRefusal: Error, Equatable, LocalizedError, Sendable {
    public let code: String?
    public let message: String

    public init(code: String?, boxError: String?) {
        self.code = code
        self.message = Self.text(code: code, boxError: boxError)
    }

    public var errorDescription: String? { message }

    public static func text(code: String?, boxError: String?) -> String {
        switch code {
        case "busy", "pending-verify": return "An update is already underway."
        case "from-commit-mismatch": return "The server changed version. Refresh and try again."
        case "manage-only": return "Only someone who can manage this server can update it."
        case "stale": return "Your device's clock looks off. Check it and try again."
        default: return boxError ?? "The server didn't take the update."
        }
    }
}

/// Which push token this device registered for a share's start-up notices,
/// so turning the notice off can name it. Holds no secret.
public struct SharePushRegistration: Codable, Equatable, Sendable {
    public let platform: SharePushPlatform
    public let tokenSha256: String

    public init(platform: SharePushPlatform, tokenSha256: String) {
        self.platform = platform
        self.tokenSha256 = tokenSha256
    }
}

/// This device's start-up notice registrations, one per share.
public struct SharePushRegistry: @unchecked Sendable {
    private let defaults: UserDefaults

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    private func key(_ shareId: String) -> String { "flagship.sharePush.v1.\(shareId)" }

    public func registration(_ shareId: String) -> SharePushRegistration? {
        guard let data = defaults.data(forKey: key(shareId)) else { return nil }
        return try? JSONDecoder().decode(SharePushRegistration.self, from: data)
    }

    public func save(_ reg: SharePushRegistration, for shareId: String) {
        if let data = try? JSONEncoder().encode(reg) { defaults.set(data, forKey: key(shareId)) }
    }

    public func forget(_ shareId: String) {
        defaults.removeObject(forKey: key(shareId))
    }
}

// MARK: - Owner (A)

/// The owner's keys, each resolved only when a step needs it.
public struct ShareOwnerKeys: Sendable {
    /// The sensitive-order key (admin root, else IRK). Argument: the Face ID reason.
    public var sensitive: @Sendable (_ reason: String) async throws -> Curve25519.Signing.PrivateKey
    /// Any account key `.com` accepts for reading the owner's share rows.
    public var account: @Sendable () async throws -> Curve25519.Signing.PrivateKey
    /// The household key that seals owner records.
    public var household: @Sendable () async throws -> Data
    /// Ed25519 seeds that may open the server's disk key (BAK, IRK).
    public var diskKeySeeds: @Sendable (_ serverDomain: String) async throws -> [Data]

    public init(
        sensitive: @escaping @Sendable (_ reason: String) async throws -> Curve25519.Signing.PrivateKey,
        account: @escaping @Sendable () async throws -> Curve25519.Signing.PrivateKey,
        household: @escaping @Sendable () async throws -> Data,
        diskKeySeeds: @escaping @Sendable (_ serverDomain: String) async throws -> [Data]
    ) {
        self.sensitive = sensitive
        self.account = account
        self.household = household
        self.diskKeySeeds = diskKeySeeds
    }
}

public struct ShareDraft: Equatable, Sendable {
    public var label: String
    public var level: ServerShareLevel
    public var unlockAtBoot: Bool
    public var seeAppData: Bool

    public init(label: String = "", level: ServerShareLevel = .view, unlockAtBoot: Bool = false, seeAppData: Bool = false) {
        self.label = label
        self.level = level
        self.unlockAtBoot = unlockAtBoot
        self.seeAppData = seeAppData
    }
}

public struct CreatedShare: Equatable, Sendable {
    public let shareId: String
    public let link: String
    public let expiresAt: Int64

    public init(shareId: String, link: String, expiresAt: Int64) {
        self.shareId = shareId
        self.link = link
        self.expiresAt = expiresAt
    }
}

/// One line of the owner's "Shared with" card.
public struct OwnerShareRow: Identifiable, Equatable, Sendable {
    public enum Status: Equatable, Sendable {
        /// The box holds the grant.
        case active
        /// B accepted; A compares this code with B's phone, then confirms.
        case awaitingConfirm(sas: String)
        /// Nobody has opened the link yet.
        case offered(link: String, expiresAt: Int64)
        /// The acceptance on `.com` doesn't verify (tampered, or for another server).
        case acceptanceInvalid
    }

    public let shareId: String
    public var label: String
    public var level: ServerShareLevel
    public var unlockAtBoot: Bool
    public var seeAppData: Bool
    public var status: Status
    public var memberPubHex: String?
    public var grantIssuedAt: Int64?
    public var lastSeenAt: Int64?
    /// `.com` holds B's start-up copy. Nil when the invitations weren't read.
    public var startupKeyOnFile: Bool?
    public var acceptance: ShareAcceptancePayload?

    public var id: String { shareId }

    public init(shareId: String, label: String, level: ServerShareLevel, unlockAtBoot: Bool, seeAppData: Bool,
                status: Status, memberPubHex: String? = nil, grantIssuedAt: Int64? = nil, lastSeenAt: Int64? = nil,
                startupKeyOnFile: Bool? = nil, acceptance: ShareAcceptancePayload? = nil) {
        self.shareId = shareId
        self.label = label
        self.level = level
        self.unlockAtBoot = unlockAtBoot
        self.seeAppData = seeAppData
        self.status = status
        self.memberPubHex = memberPubHex
        self.grantIssuedAt = grantIssuedAt
        self.lastSeenAt = lastSeenAt
        self.startupKeyOnFile = startupKeyOnFile
        self.acceptance = acceptance
    }

    /// Active, with unlock at boot on, but `.com` holds no copy for B.
    public var needsStartupKey: Bool {
        status == .active && unlockAtBoot && startupKeyOnFile == false
    }
}

public struct OwnerSharesSnapshot: Equatable, Sendable {
    public var rows: [OwnerShareRow]
    /// The pending invitations on `.com` were read (that needs the account key).
    public var invitationsRead: Bool
    /// The box answered its share list.
    public var serverAnswered: Bool

    public init(rows: [OwnerShareRow], invitationsRead: Bool, serverAnswered: Bool) {
        self.rows = rows
        self.invitationsRead = invitationsRead
        self.serverAnswered = serverAnswered
    }
}

public struct ServerShareOwnerFlow: Sendable {
    public let client: ServerShareClient
    public let username: String
    public let keys: ShareOwnerKeys
    private let now: @Sendable () -> Int64
    private let apexOrigin: @Sendable () -> String

    public init(client: ServerShareClient, username: String, keys: ShareOwnerKeys,
                now: @escaping @Sendable () -> Int64 = { ServerShareClock.nowMs() },
                apexOrigin: @escaping @Sendable () -> String = { Endpoints.controlBaseUrl.absoluteString }) {
        self.client = client
        self.username = username
        self.keys = keys
        self.now = now
        self.apexOrigin = apexOrigin
    }

    /// §9 "A shares": seal the offer and the owner record, sign #6, post it.
    public func create(serverDomain: String, serverName: String, stkPubHex: String, draft: ShareDraft) async throws -> CreatedShare {
        guard let label = ServerShare.normalizeShareLabel(draft.label) else { throw ServerShareFlowError.badLabel }
        let stk = stkPubHex.lowercased()
        guard ServerShare.isLowerHex(stk, 64) else { throw ServerShareFlowError.unknownServerIdentity }
        let domain = serverDomain.lowercased()
        let shareId = ServerShare.randomShareId()
        let secret = ServerShare.randomBytes(32)
        let issuedAt = now()
        let expiresAt = issuedAt + ServerShare.offerTtlMs
        let offerPayload = ShareOfferPayload(
            serverDomain: domain, serverName: serverName, stkPubHex: stk, level: draft.level,
            unlockAtBoot: draft.unlockAtBoot, seeAppData: draft.seeAppData, expiresAt: expiresAt)
        let offerHex = try ServerShare.seal(key: ServerShare.shareLinkKey(secret),
                                            aad: ServerShare.shareAad(ServerShare.aadOffer, shareId),
                                            plaintext: offerPayload.jsonData())
        let record = ShareOwnerRecord(secretHex: HexUtil.encode(secret), label: label, level: draft.level,
                                      unlockAtBoot: draft.unlockAtBoot, seeAppData: draft.seeAppData)
        let ownerHex = try ServerShare.seal(key: try await keys.household(),
                                            aad: ServerShare.shareAad(ServerShare.aadOwner, shareId),
                                            plaintext: record.jsonData())
        let offer = ServerShareOffer(
            username: username, serverDomain: domain, shareId: shareId,
            tokenHash: try ServerShare.shareTokenHash(ServerShare.shareTokenFromSecret(secret)),
            offerSha256: ServerShare.shareSha256Hex(offerHex), ownerSha256: ServerShare.shareSha256Hex(ownerHex),
            expiresAt: expiresAt, issuedAt: issuedAt)
        let key = try await keys.sensitive("Share \(serverName) with \(label)")
        let sig = HexUtil.encode(try offer.sign(with: key))
        try await client.createOffer(username: username, offer: offer, signature: sig, offerHex: offerHex, ownerHex: ownerHex)
        let link = try ServerShare.buildShareLink(apexOrigin: apexOrigin(), shareId: shareId, secret: secret)
        return CreatedShare(shareId: shareId, link: link, expiresAt: expiresAt)
    }

    /// §9 "A's Shared with card": the box's list is the truth for who has
    /// access; `.com` adds the invitations still waiting (read only when
    /// `readInvitations`, since that needs the account key).
    public func load(serverDomain: String, ownerToken: String?, readInvitations: Bool) async throws -> OwnerSharesSnapshot {
        let domain = serverDomain.lowercased()
        var boxList: BoxSharesResponse?
        var boxError: Error?
        if let ownerToken {
            do { boxList = try await client.boxShares(serverDomain: domain, ownerToken: ownerToken) } catch { boxError = error }
        }
        var rows: [OwnerShareRow] = (boxList?.shares ?? []).map {
            OwnerShareRow(shareId: $0.shareId, label: $0.label, level: $0.level, unlockAtBoot: $0.unlockAtBoot,
                          seeAppData: $0.seeAppData, status: .active, memberPubHex: $0.memberPubHex,
                          grantIssuedAt: $0.issuedAt, lastSeenAt: $0.lastSeenAt)
        }
        let endedOnBox = Set((boxList?.ended ?? []).map(\.shareId))
        guard readInvitations else {
            if rows.isEmpty, let boxError { throw boxError }
            return OwnerSharesSnapshot(rows: rows, invitationsRead: false, serverAnswered: boxList != nil)
        }
        let listKey = try await keys.account()
        let list = ServerShareList(username: username, issuedAt: now())
        let comRows = try await client.listOffers(username: username, list: list,
                                                  signature: HexUtil.encode(try list.sign(with: listKey)))
        let household = try await keys.household()
        let t = now()
        var pending: [OwnerShareRow] = []
        for r in comRows where r.serverDomain.lowercased() == domain && r.state != "ended" {
            if let i = rows.firstIndex(where: { $0.shareId == r.shareId }) {
                rows[i].startupKeyOnFile = r.unlock
                continue
            }
            if endedOnBox.contains(r.shareId) { continue }
            guard let ownerHex = r.owner,
                  let obj = try? ServerShare.openJSON(key: household, aad: ServerShare.shareAad(ServerShare.aadOwner, r.shareId), sealedHex: ownerHex),
                  let record = ShareOwnerRecord(jsonObject: obj),
                  let secret = HexUtil.decode(record.secretHex)
            else { continue }
            var row = OwnerShareRow(shareId: r.shareId, label: record.label, level: record.level,
                                    unlockAtBoot: record.unlockAtBoot, seeAppData: record.seeAppData,
                                    status: .acceptanceInvalid, startupKeyOnFile: r.unlock)
            if r.state == "accepted", let accHex = r.acceptance {
                if let acc = Self.verifiedAcceptance(accHex, secret: secret, shareId: r.shareId, serverDomain: domain),
                   let sas = try? ServerShare.shareSas(shareId: r.shareId, memberPubHex: acc.accept.memberPubHex, secret: secret) {
                    row.status = .awaitingConfirm(sas: ServerShare.formatShareSas(sas))
                    row.memberPubHex = acc.accept.memberPubHex
                    row.acceptance = acc
                }
                pending.append(row)
            } else if r.state == "offered", r.expiresAt > t {
                let link = (try? ServerShare.buildShareLink(apexOrigin: apexOrigin(), shareId: r.shareId, secret: secret)) ?? ""
                row.status = .offered(link: link, expiresAt: r.expiresAt)
                pending.append(row)
            }
        }
        return OwnerSharesSnapshot(rows: pending + rows, invitationsRead: true, serverAnswered: boxList != nil)
    }

    /// Opens B's sealed acceptance and checks it names this server and share,
    /// signed by the key it names.
    public static func verifiedAcceptance(_ hex: String, secret: Data, shareId: String, serverDomain: String) -> ShareAcceptancePayload? {
        guard let key = try? ServerShare.shareLinkKey(secret),
              let aad = try? ServerShare.shareAad(ServerShare.aadAcceptance, shareId),
              let obj = try? ServerShare.openJSON(key: key, aad: aad, sealedHex: hex),
              let acc = ShareAcceptancePayload(jsonObject: obj),
              acc.accept.shareId == shareId,
              acc.accept.serverDomain.lowercased() == serverDomain.lowercased(),
              let sig = HexUtil.decode(acc.signature),
              let pub = HexUtil.decode(acc.accept.memberPubHex),
              acc.accept.verify(signature: sig, publicKey: pub)
        else { return nil }
        return acc
    }

    /// After A compared the code: sign #1 and give the box the grant with B's
    /// acceptance. Returns false when unlock at boot is on but B's start-up
    /// copy couldn't be stored (the grant still applied).
    @discardableResult
    public func confirm(_ row: OwnerShareRow, serverDomain: String, serverName: String, ownerToken: String) async throws -> Bool {
        guard case .awaitingConfirm = row.status, let acc = row.acceptance else { throw ServerShareFlowError.badLink }
        let domain = serverDomain.lowercased()
        let grant = ServerShareGrant(serverDomain: domain, shareId: row.shareId, memberPubHex: acc.accept.memberPubHex,
                                     level: row.level, unlockAtBoot: row.unlockAtBoot, seeAppData: row.seeAppData,
                                     label: row.label, issuedAt: now())
        let key = try await keys.sensitive("Give \(row.label) access to \(serverName)")
        try await client.boxGrant(serverDomain: domain, ownerToken: ownerToken, grant: grant,
                                  signature: HexUtil.encode(try grant.sign(with: key)),
                                  accept: acc.accept, acceptSignature: acc.signature)
        guard row.unlockAtBoot else { return true }
        do {
            try await depositStartupKey(serverDomain: domain, shareId: row.shareId,
                                        memberPubHex: acc.accept.memberPubHex, key: key)
            return true
        } catch {
            return false
        }
    }

    /// A new grant for an active share (same id and key, later `issuedAt`),
    /// then B's start-up copy put or withdrawn when that opt-in changed.
    /// Returns false when the start-up copy step failed.
    @discardableResult
    public func change(_ row: OwnerShareRow, level: ServerShareLevel, unlockAtBoot: Bool, seeAppData: Bool,
                       serverDomain: String, serverName: String, ownerToken: String) async throws -> Bool {
        guard row.status == .active, let member = row.memberPubHex else { throw ServerShareFlowError.notConfirmedYet }
        let domain = serverDomain.lowercased()
        let grant = ServerShareGrant(serverDomain: domain, shareId: row.shareId, memberPubHex: member, level: level,
                                     unlockAtBoot: unlockAtBoot, seeAppData: seeAppData, label: row.label,
                                     issuedAt: max(now(), (row.grantIssuedAt ?? 0) + 1))
        let key = try await keys.sensitive("Change \(row.label)'s access to \(serverName)")
        try await client.boxGrant(serverDomain: domain, ownerToken: ownerToken, grant: grant,
                                  signature: HexUtil.encode(try grant.sign(with: key)), accept: nil, acceptSignature: nil)
        guard unlockAtBoot != row.unlockAtBoot else { return true }
        do {
            if unlockAtBoot {
                try await depositStartupKey(serverDomain: domain, shareId: row.shareId, memberPubHex: member, key: key)
            } else {
                try await withdrawStartupKey(serverDomain: domain, shareId: row.shareId, memberPubHex: member, key: key)
            }
            return true
        } catch {
            return false
        }
    }

    /// Retry the start-up copy for an active share that has none on file.
    public func sendStartupKey(_ row: OwnerShareRow, serverDomain: String, serverName: String) async throws {
        guard let member = row.memberPubHex else { throw ServerShareFlowError.notConfirmedYet }
        let key = try await keys.sensitive("Let \(row.label) approve \(serverName)'s start-up")
        try await depositStartupKey(serverDomain: serverDomain.lowercased(), shareId: row.shareId, memberPubHex: member, key: key)
    }

    /// §9 step 6: open the disk key exactly as boot approval does, seal it to
    /// B's member key, sign #8 over the sealed copy's hash.
    public func depositStartupKey(serverDomain: String, shareId: String, memberPubHex: String,
                                  key: Curve25519.Signing.PrivateKey) async throws {
        guard let memberPub = HexUtil.decode(memberPubHex), memberPub.count == 32 else { throw ServerShareFlowError.badLink }
        let sealedForOwner: String
        do {
            sealedForOwner = try await client.sealedDiskKey(serverDomain: serverDomain)
        } catch let e as ServerShareHTTPError where e.status == 404 {
            throw ServerShareFlowError.noDiskKey
        }
        guard let blob = HexUtil.decode(sealedForOwner), !blob.isEmpty else { throw ServerShareFlowError.noDiskKey }
        var diskKey: Data?
        for seed in try await keys.diskKeySeeds(serverDomain) {
            if let opened = try? SecretSeal.openWithEd25519Seed(blob: blob, recipientEd25519Seed: seed) {
                diskKey = opened
                break
            }
        }
        guard let diskKey else { throw ServerShareFlowError.diskKeyUnreadable }
        let sealed = HexUtil.encode(try SecretSeal.sealForEd25519Recipient(plaintext: diskKey, recipientEd25519Pub: memberPub))
        let unlock = ServerShareUnlock(serverDomain: serverDomain, shareId: shareId, memberPubHex: memberPubHex,
                                       sealedSha256: ServerShare.shareSha256Hex(sealed), issuedAt: now())
        try await client.putUnlock(username: username, unlock: unlock,
                                   signature: HexUtil.encode(try unlock.sign(with: key)), sealedKey: sealed)
    }

    public func withdrawStartupKey(serverDomain: String, shareId: String, memberPubHex: String,
                                   key: Curve25519.Signing.PrivateKey) async throws {
        let unlock = ServerShareUnlock(serverDomain: serverDomain, shareId: shareId, memberPubHex: memberPubHex,
                                       sealedSha256: ServerShare.unlockOff, issuedAt: now())
        try await client.putUnlock(username: username, unlock: unlock,
                                   signature: HexUtil.encode(try unlock.sign(with: key)), sealedKey: nil)
    }

    /// Remove (an active share) or Cancel (a pending one): sign #2. The box
    /// learns it at once, or from `.com` on its next poll if it's offline.
    public func end(_ row: OwnerShareRow, serverDomain: String, serverName: String, ownerToken: String?) async throws {
        let domain = serverDomain.lowercased()
        let revoke = ServerShareRevoke(serverDomain: domain, shareId: row.shareId, issuedAt: now())
        let reason = row.status == .active ? "Remove \(row.label) from \(serverName)" : "Cancel the invitation for \(row.label)"
        let sig = HexUtil.encode(try revoke.sign(with: try await keys.sensitive(reason)))
        var boxError: Error?
        if row.status == .active {
            if let ownerToken {
                do {
                    try await client.boxRevoke(serverDomain: domain, ownerToken: ownerToken, revoke: revoke, signature: sig)
                } catch {
                    boxError = error
                }
            }
        }
        do {
            try await client.revokeOnCom(username: username, revoke: revoke, signature: sig)
        } catch let e as ServerShareHTTPError where e.status == 404 {
            if let boxError { throw boxError }
        }
    }

    public func activity(serverDomain: String, ownerToken: String, limit: Int = 50) async throws -> [ShareActivityEntry] {
        try await client.boxActivity(serverDomain: serverDomain.lowercased(), ownerToken: ownerToken, limit: limit)
    }
}

// MARK: - The second account (B)

public struct ShareInvitation: Equatable, Sendable {
    public let shareId: String
    public let secretHex: String
    public let offer: ShareOfferPayload
    /// `offered`, `accepted` or `ended` on `.com`.
    public let state: String

    public init(shareId: String, secretHex: String, offer: ShareOfferPayload, state: String) {
        self.shareId = shareId
        self.secretHex = secretHex
        self.offer = offer
        self.state = state
    }

    public var ownerName: String { ServerShareNames.ownerName(fromDomain: offer.serverDomain) }
}

public struct AcceptedShare: Equatable, Sendable {
    public let entry: SharedServerEntry
    /// Formatted `123 456`.
    public let sas: String

    public init(entry: SharedServerEntry, sas: String) {
        self.entry = entry
        self.sas = sas
    }
}

/// One server in B's "Shared with me" (an opened inbox entry).
public struct SharedServerEntry: Equatable, Sendable, Identifiable, Hashable {
    public let entryId: String
    public let shareId: String
    public let secretHex: String
    public let serverDomain: String
    public let serverName: String
    public let acceptedAt: Int64

    public init(entryId: String, shareId: String, secretHex: String, serverDomain: String, serverName: String, acceptedAt: Int64) {
        self.entryId = entryId
        self.shareId = shareId
        self.secretHex = secretHex
        self.serverDomain = serverDomain
        self.serverName = serverName
        self.acceptedAt = acceptedAt
    }

    public var id: String { shareId }
    public var ownerName: String { ServerShareNames.ownerName(fromDomain: serverDomain) }
    public var displayName: String { serverName.isEmpty ? ServerShareNames.serverLabel(fromDomain: serverDomain) : serverName }
}

/// A start-up request that verified against the STK pinned in the offer.
public struct VerifiedShareStartup: Equatable, Sendable, Identifiable {
    public let request: SecretRequest
    public let expiresAt: Int64?
    public var id: String { HexUtil.encode(request.nonce) }

    public init(request: SecretRequest, expiresAt: Int64?) {
        self.request = request
        self.expiresAt = expiresAt
    }
}

public struct ServerShareMemberFlow: Sendable {
    public let client: ServerShareClient
    /// The account's UMK seed (32 bytes). Argument: the Face ID reason.
    let umkSeed: @Sendable (_ reason: String) async throws -> Data
    let now: @Sendable () -> Int64

    public init(client: ServerShareClient,
                umkSeed: @escaping @Sendable (_ reason: String) async throws -> Data,
                now: @escaping @Sendable () -> Int64 = { ServerShareClock.nowMs() }) {
        self.client = client
        self.umkSeed = umkSeed
        self.now = now
    }

    /// §9 "B accepts" 1-2: read the offer with the link token and open it.
    public func open(shareId: String, secretHex: String) async throws -> ShareInvitation {
        guard let secret = HexUtil.decode(secretHex), secret.count == 32 else { throw ServerShareFlowError.badLink }
        let view: ComShareView
        do {
            view = try await client.getShare(shareId: shareId, token: try ServerShare.shareTokenFromSecret(secret))
        } catch let e as ServerShareHTTPError where e.status == 404 || e.status == 400 {
            throw ServerShareFlowError.badLink
        } catch let e as ServerShareHTTPError where e.status == 410 {
            throw ServerShareFlowError.linkExpired
        }
        guard let obj = try? ServerShare.openJSON(key: ServerShare.shareLinkKey(secret),
                                                  aad: ServerShare.shareAad(ServerShare.aadOffer, shareId), sealedHex: view.offer),
              let offer = ShareOfferPayload(jsonObject: obj)
        else { throw ServerShareFlowError.badLink }
        if view.state == "ended" { throw ServerShareFlowError.shareEnded }
        return ShareInvitation(shareId: shareId, secretHex: secretHex, offer: offer, state: view.state)
    }

    /// §9 "B accepts" 3-5: sign #3 with the per-share key, post it sealed,
    /// save the share to the inbox, and return the code to read to the owner.
    public func accept(_ inv: ShareInvitation) async throws -> AcceptedShare {
        guard let secret = HexUtil.decode(inv.secretHex) else { throw ServerShareFlowError.badLink }
        let seed = try await umkSeed("Accept the server shared with you")
        let member = try ServerShare.deriveShareMemberKey(umkSeed: seed, shareId: inv.shareId)
        let memberPubHex = HexUtil.encode(member.publicKey.rawRepresentation)
        let token = try ServerShare.shareTokenFromSecret(secret)
        let linkKey = try ServerShare.shareLinkKey(secret)
        let acceptedAt = now()
        let accept = ServerShareAccept(serverDomain: inv.offer.serverDomain, shareId: inv.shareId,
                                       memberPubHex: memberPubHex, acceptedAt: acceptedAt)
        let payload = ShareAcceptancePayload(accept: accept, signature: HexUtil.encode(try accept.sign(with: member)))
        let sealed = try ServerShare.seal(key: linkKey, aad: ServerShare.shareAad(ServerShare.aadAcceptance, inv.shareId),
                                          plaintext: payload.jsonData())
        do {
            try await client.accept(shareId: inv.shareId, token: token, acceptanceHex: sealed)
        } catch let e as ServerShareHTTPError where e.status == 409 {
            guard try await acceptedByMe(inv, secret: secret, memberPubHex: memberPubHex) else { throw ServerShareFlowError.linkUsed }
        } catch let e as ServerShareHTTPError where e.status == 410 {
            throw e.error?.contains("expired") == true ? ServerShareFlowError.linkExpired : ServerShareFlowError.shareEnded
        } catch let e as ServerShareHTTPError where e.status == 404 {
            throw ServerShareFlowError.badLink
        }
        let entry = SharedServerEntry(entryId: ServerShare.randomShareId(), shareId: inv.shareId, secretHex: inv.secretHex,
                                      serverDomain: inv.offer.serverDomain, serverName: inv.offer.serverName,
                                      acceptedAt: acceptedAt)
        try await inboxPut(entry, seed: seed)
        let sas = try ServerShare.shareSas(shareId: inv.shareId, memberPubHex: memberPubHex, secret: secret)
        return AcceptedShare(entry: entry, sas: ServerShare.formatShareSas(sas))
    }

    /// A second Accept (B reopened the link) is fine when the acceptance on file is ours.
    private func acceptedByMe(_ inv: ShareInvitation, secret: Data, memberPubHex: String) async throws -> Bool {
        let view = try await client.getShare(shareId: inv.shareId, token: try ServerShare.shareTokenFromSecret(secret))
        guard let hex = view.acceptance,
              let acc = ServerShareOwnerFlow.verifiedAcceptance(hex, secret: secret, shareId: inv.shareId,
                                                                serverDomain: inv.offer.serverDomain)
        else { return false }
        return acc.accept.memberPubHex == memberPubHex
    }

    private func inboxPut(_ e: SharedServerEntry, seed: Data) async throws {
        let inboxKey = try ServerShare.deriveShareInboxKey(umkSeed: seed)
        let entry = ShareInboxEntry(shareId: e.shareId, secretHex: e.secretHex, serverDomain: e.serverDomain,
                                    serverName: e.serverName, acceptedAt: e.acceptedAt)
        let ct = try ServerShare.seal(key: ServerShare.deriveShareInboxSealKey(umkSeed: seed),
                                      aad: ServerShare.shareAad(ServerShare.aadInboxEntry, e.entryId), plaintext: entry.jsonData())
        let req = ShareInboxRequest(inboxPubHex: HexUtil.encode(inboxKey.publicKey.rawRepresentation), op: .put,
                                    entryId: e.entryId, ctSha256: ServerShare.shareSha256Hex(ct), issuedAt: now())
        try await client.inboxPut(request: req, signature: HexUtil.encode(try req.sign(with: inboxKey)), ct: ct)
    }

    /// §9 "B's Shared with me": every inbox entry that opens, one per share
    /// (the newest when a link was accepted twice).
    public func inbox() async throws -> [SharedServerEntry] {
        let seed = try await umkSeed("Show the servers shared with you")
        let inboxKey = try ServerShare.deriveShareInboxKey(umkSeed: seed)
        let sealKey = try ServerShare.deriveShareInboxSealKey(umkSeed: seed)
        let req = ShareInboxRequest(inboxPubHex: HexUtil.encode(inboxKey.publicKey.rawRepresentation), op: .list,
                                    entryId: "", ctSha256: "", issuedAt: now())
        let raw = try await client.inboxList(request: req, signature: HexUtil.encode(try req.sign(with: inboxKey)))
        var byShare: [String: SharedServerEntry] = [:]
        for r in raw {
            guard let aad = try? ServerShare.shareAad(ServerShare.aadInboxEntry, r.entryId),
                  let obj = try? ServerShare.openJSON(key: sealKey, aad: aad, sealedHex: r.ct),
                  let e = ShareInboxEntry(jsonObject: obj)
            else { continue }
            let entry = SharedServerEntry(entryId: r.entryId, shareId: e.shareId, secretHex: e.secretHex,
                                          serverDomain: e.serverDomain, serverName: e.serverName, acceptedAt: e.acceptedAt)
            if let prev = byShare[e.shareId], prev.acceptedAt >= entry.acceptedAt { continue }
            byShare[e.shareId] = entry
        }
        return byShare.values.sorted { $0.acceptedAt > $1.acceptedAt }
    }

    public func deleteInboxEntry(_ entryId: String) async throws {
        let seed = try await umkSeed("Update the servers shared with you")
        let inboxKey = try ServerShare.deriveShareInboxKey(umkSeed: seed)
        let req = ShareInboxRequest(inboxPubHex: HexUtil.encode(inboxKey.publicKey.rawRepresentation), op: .delete,
                                    entryId: entryId, ctSha256: "", issuedAt: now())
        try await client.inboxDelete(request: req, signature: HexUtil.encode(try req.sign(with: inboxKey)))
    }

    public func memberKey(shareId: String, reason: String) async throws -> Curve25519.Signing.PrivateKey {
        try ServerShare.deriveShareMemberKey(umkSeed: try await umkSeed(reason), shareId: shareId)
    }

    /// §9 "B signs in to S": nonce → #5 → a 12-hour share token.
    public func signIn(_ entry: SharedServerEntry) async throws -> ShareSessionResponse {
        let member = try await memberKey(shareId: entry.shareId, reason: "Open \(entry.displayName)")
        let domain = entry.serverDomain.lowercased()
        let nonce = try await client.boxNonce(serverDomain: domain)
        let session = ServerShareSession(serverDomain: domain, shareId: entry.shareId,
                                         memberPubHex: HexUtil.encode(member.publicKey.rawRepresentation),
                                         nonceHex: nonce, issuedAt: now())
        do {
            return try await client.boxSession(serverDomain: domain, session: session,
                                               signature: HexUtil.encode(try session.sign(with: member)))
        } catch let e as ServerShareHTTPError where e.isShareEnded {
            throw ServerShareFlowError.shareEnded
        } catch let e as ServerShareHTTPError where e.isNotShared {
            throw ServerShareFlowError.notConfirmedYet
        }
    }

    /// §9 "Leave": #4 to the box and to `.com`, then drop the inbox entry.
    /// Either end alone ends the share, so one unreachable side is fine.
    public func leave(_ entry: SharedServerEntry) async throws {
        guard let secret = HexUtil.decode(entry.secretHex) else { throw ServerShareFlowError.badLink }
        let member = try await memberKey(shareId: entry.shareId, reason: "Leave \(entry.displayName)")
        let domain = entry.serverDomain.lowercased()
        let leave = ServerShareLeave(serverDomain: domain, shareId: entry.shareId,
                                     memberPubHex: HexUtil.encode(member.publicKey.rawRepresentation), issuedAt: now())
        let sig = HexUtil.encode(try leave.sign(with: member))
        var boxError: Error?
        do { try await client.boxLeave(serverDomain: domain, leave: leave, signature: sig) } catch { boxError = error }
        do {
            try await client.leaveOnCom(token: try ServerShare.shareTokenFromSecret(secret), leave: leave, signature: sig)
        } catch {
            if let boxError { throw boxError }
        }
        try? await deleteInboxEntry(entry.entryId)
    }

    /// Start-up notices for this device (part of unlock at boot): sign #10
    /// `put` and give `.com` the token for this share only.
    public func registerStartupPush(_ entry: SharedServerEntry, platform: SharePushPlatform,
                                    providerToken: String) async throws -> SharePushRegistration {
        let reg = SharePushRegistration(platform: platform, tokenSha256: ServerShare.shareSha256Hex(providerToken))
        do {
            try await sendPush(entry, op: .put, reg: reg, providerToken: providerToken,
                               reason: "Get start-up notices for \(entry.displayName)")
        } catch let e as ServerShareHTTPError where e.status == 403 && e.code == "unlock-not-shared" {
            throw ServerShareFlowError.startupNotShared
        } catch let e as ServerShareHTTPError where e.status == 410 {
            throw ServerShareFlowError.shareEnded
        } catch let e as ServerShareHTTPError where e.status == 404 {
            throw ServerShareFlowError.badLink
        }
        return reg
    }

    /// Sign #10 `delete` for the token this device registered. A share that
    /// already ended took the token with it.
    public func unregisterStartupPush(_ entry: SharedServerEntry, _ reg: SharePushRegistration) async throws {
        do {
            try await sendPush(entry, op: .delete, reg: reg, providerToken: nil,
                               reason: "Stop start-up notices for \(entry.displayName)")
        } catch let e as ServerShareHTTPError where e.status == 404 || e.status == 410 {
        }
    }

    private func sendPush(_ entry: SharedServerEntry, op: SharePushOp, reg: SharePushRegistration,
                          providerToken: String?, reason: String) async throws {
        guard let secret = HexUtil.decode(entry.secretHex) else { throw ServerShareFlowError.badLink }
        let member = try await memberKey(shareId: entry.shareId, reason: reason)
        let push = ServerSharePush(serverDomain: entry.serverDomain.lowercased(), shareId: entry.shareId,
                                   memberPubHex: HexUtil.encode(member.publicKey.rawRepresentation), op: op,
                                   platform: reg.platform, tokenSha256: reg.tokenSha256, issuedAt: now())
        try await client.sharePush(token: try ServerShare.shareTokenFromSecret(secret), push: push,
                                   signature: HexUtil.encode(try push.sign(with: member)), providerToken: providerToken)
    }

    /// A co-manager moves the server to an endorsed release: sign #11 and
    /// hand it to the box, which applies it through the owner's gates.
    public func orderUpdate(_ entry: SharedServerEntry, shareToken: String, targetCommit: String,
                            fromCommit: String) async throws -> ShareUpdateAccepted {
        let target = targetCommit.lowercased()
        let from = fromCommit.lowercased()
        guard ServerShare.isLowerHex(target, 40), ServerShare.isLowerHex(from, 40) else {
            throw ShareUpdateRefusal(code: "from-commit-mismatch", boxError: nil)
        }
        let member = try await memberKey(shareId: entry.shareId, reason: "Update \(entry.displayName)")
        let domain = entry.serverDomain.lowercased()
        let update = ServerShareUpdate(serverDomain: domain, shareId: entry.shareId,
                                       memberPubHex: HexUtil.encode(member.publicKey.rawRepresentation),
                                       targetCommit: target, fromCommit: from,
                                       nonce: HexUtil.encode(ServerShare.randomBytes(32)), issuedAt: now())
        do {
            return try await client.boxUpdate(serverDomain: domain, shareToken: shareToken, update: update,
                                              signature: HexUtil.encode(try update.sign(with: member)))
        } catch let e as ServerShareHTTPError where e.status != 0 && e.status != 401 {
            throw ShareUpdateRefusal(code: e.code, boxError: e.error)
        }
    }

    /// The STK the owner pinned in the offer (`.com` can't swap it).
    public func pinnedStk(_ entry: SharedServerEntry) async throws -> String {
        try await open(shareId: entry.shareId, secretHex: entry.secretHex).offer.stkPubHex
    }

    /// §9 "B approves a start-up": pending `unlock-key` requests for this
    /// server whose STK equals the pinned one and whose signature verifies.
    public func pendingStartups(_ entry: SharedServerEntry, stkPubHex: String) async throws -> [VerifiedShareStartup] {
        let member = try await memberKey(shareId: entry.shareId, reason: "Check whether \(entry.displayName) is starting")
        let domain = entry.serverDomain.lowercased()
        let path = ServerShareClient.bootPendingPath(domain)
        let auth = try BootAuth.shareHeader(serverDomain: domain, method: "GET", path: path, memberKey: member, now: now())
        let rows = try await client.bootPending(serverDomain: domain, auth: auth)
        return Self.verifiedStartups(rows, serverDomain: domain, stkPubHex: stkPubHex, now: now())
    }

    public static func verifiedStartups(_ rows: [ShareBootPending], serverDomain: String, stkPubHex: String, now: Int64) -> [VerifiedShareStartup] {
        guard let stkData = HexUtil.decode(stkPubHex.lowercased()), stkData.count == 32,
              let stk = try? Curve25519.Signing.PublicKey(rawRepresentation: stkData)
        else { return [] }
        var out: [VerifiedShareStartup] = []
        for r in rows {
            let q = r.request
            guard q.purpose == SecretPurpose.unlockKey.rawValue,
                  q.serverDomain.lowercased() == serverDomain.lowercased(),
                  q.stkPub.lowercased() == stkPubHex.lowercased(),
                  let nonce = HexUtil.decode(q.nonce), nonce.count == 32,
                  let sig = HexUtil.decode(r.signature)
            else { continue }
            if let exp = r.expiresAt, exp <= now { continue }
            let request = SecretRequest(serverDomain: q.serverDomain, stkPub: stkData, purpose: .unlockKey, nonce: nonce, issuedAt: q.issuedAt)
            guard SecretRequest.verify(request, signature: sig, stkPub: stk) else { continue }
            out.append(VerifiedShareStartup(request: request, expiresAt: r.expiresAt))
        }
        return out
    }

    /// Open B's sealed copy, re-seal it for the box STK bound to this request,
    /// and post the answer with role `share`.
    public func approveStartup(_ entry: SharedServerEntry, startup: VerifiedShareStartup, stkPubHex: String) async throws {
        guard startup.request.stkPub == HexUtil.decode(stkPubHex.lowercased()) else { throw ServerShareFlowError.startupNotFromServer }
        let member = try await memberKey(shareId: entry.shareId, reason: "Start \(entry.displayName)")
        let domain = entry.serverDomain.lowercased()
        let keyPath = ServerShareClient.bootKeyPath(domain)
        let sealedHex: String
        do {
            sealedHex = try await client.bootKey(serverDomain: domain, auth: try BootAuth.shareHeader(
                serverDomain: domain, method: "GET", path: keyPath, memberKey: member, now: now()))
        } catch let e as ServerShareHTTPError where e.status == 404 || e.status == 403 {
            throw ServerShareFlowError.noDiskKey
        }
        guard let blob = HexUtil.decode(sealedHex),
              let diskKey = try? SecretSeal.openWithEd25519Seed(blob: blob, recipientEd25519Seed: member.rawRepresentation)
        else { throw ServerShareFlowError.diskKeyUnreadable }
        let resp = try SealedSecretResponse.build(secret: diskKey, request: startup.request, now: now)
        let body = SecretResponseBody(serverDomain: startup.request.serverDomain, requestNonceHex: resp.requestNonceHex,
                                      purpose: resp.purpose.rawValue, sealed: HexUtil.encode(resp.sealed), issuedAt: resp.issuedAt)
        do {
            try await client.bootRespond(body, auth: try BootAuth.shareHeader(
                serverDomain: startup.request.serverDomain, method: "POST", path: ServerShareClient.bootResponsePath,
                memberKey: member, now: now()))
        } catch let e as ServerShareHTTPError where e.status == 404 {
            throw ServerShareFlowError.noStartupWaiting
        }
    }
}
