import Foundation
import CryptoKit
import Observation
import Flagship
import FlagshipCore

/// Joining an organization from an `/org-join` link (docs/enterprise-accounts.md §7). The link key
/// opens the offer the inviter sealed; the person's seat member key comes from their UMK for this
/// org only, and a seat with an admin role also gets a fresh random admin key. Both phones then show
/// the same 6-digit code, which the inviter compares before admitting the seat.
@MainActor
@Observable
public final class OrgJoinViewModel {
    public enum Phase: Equatable {
        case loading
        case ready(orgName: String, pseudonym: String, isAdminRole: Bool)
        case accepted(code: String)
        case failed(String)
    }

    public private(set) var phase: Phase = .loading
    public private(set) var busy = false

    private let orgId: String, seatId: String, keyHex: String
    private let client: OrgClient
    private let keys: OrgSeatKeys
    private let now: () -> Int64
    private let umk: (String) async throws -> [UInt8]
    private var offer: [String: Any] = [:]
    private var invite: [String: Any] = [:]
    private var roles: [OrgSeatRole] = []

    public init(orgId: String, seatId: String, keyHex: String, client: OrgClient = OrgClient(), keys: OrgSeatKeys = .shared,
                now: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) },
                umk: @escaping (String) async throws -> [UInt8] = { reason in try await Keystore.currentUMK(reason: reason).withUnsafeBytes { Array($0) } }) {
        self.orgId = orgId; self.seatId = seatId; self.keyHex = keyHex; self.client = client; self.keys = keys; self.now = now; self.umk = umk
    }

    public func load() async {
        phase = .loading
        do {
            let r = try await client.inviteOffer(orgId: orgId, seatId: seatId)
            guard let offerHex = r["offerHex"] as? String, let sealed = OrgAuthority.bytes(hex: offerHex), let key = OrgAuthority.bytes(hex: keyHex),
                  let inv = r["invite"] as? [String: Any] else { throw OrgAuthorityError("malformed") }
            if (r["accepted"] as? Bool) == true {
                phase = .failed(String(localized: "This invitation was already accepted."))
                return
            }
            let plain = try AES.GCM.open(try AES.GCM.SealedBox(combined: Data(sealed)), using: SymmetricKey(data: key))
            guard let o = try JSONSerialization.jsonObject(with: plain) as? [String: Any], o["orgId"] as? String == orgId, o["seatId"] as? String == seatId,
                  let genesis = o["genesisHash"] as? String else { throw OrgAuthorityError("malformed") }
            // The org's chain must verify from the genesis the inviter sealed into the offer.
            _ = try await client.snapshot(orgId: orgId, genesisHash: genesis, now: now())
            offer = o; invite = inv
            roles = try OrgAuthorityWire.roles(r["roles"])
            phase = .ready(orgName: (o["orgName"] as? String) ?? "", pseudonym: (o["pseudonym"] as? String) ?? "", isAdminRole: OrgAuthority.rolesRaiseAdmin(roles))
        } catch let e as OrgClientError where e.code == "org-invite-expired" {
            phase = .failed(String(localized: "This invitation has run out. Ask for a new one."))
        } catch {
            phase = .failed(String(localized: "This invitation couldn't be opened. Check the link and try again."))
        }
    }

    /// Accepts: derives the seat member key (and makes an admin key for an admin role), signs the acceptance
    /// with the member key, posts it and keeps the seat on this phone. Shows the code to compare.
    public func accept() async {
        guard case .ready = phase, let genesis = offer["genesisHash"] as? String else { return }
        busy = true; defer { busy = false }
        let t = now()
        do {
            var umk = try await self.umk(String(localized: "Join this organization"))
            defer { for i in umk.indices { umk[i] = 0 } }
            let member = try OrgAuthority.memberKey(umk: umk, orgId: orgId, seatId: seatId, issuedAt: t)
            let memberKeyId = OrgAuthority.keyIdHex(ed25519PubHex: member.binding.ed25519PubHex, mldsaPubHex: member.binding.mldsaPubHex)
            var admin: (binding: PqKeyBindingWire, secret: [UInt8])?
            if OrgAuthority.rolesRaiseAdmin(roles) { admin = try keys.makeKey(orgId: orgId, seatId: seatId, now: t) }
            let adminKeyId = admin.map { OrgAuthority.keyIdHex(ed25519PubHex: $0.binding.ed25519PubHex, mldsaPubHex: $0.binding.mldsaPubHex) } ?? ""
            guard let labelSha = invite["labelSha256"] as? String, let rolesHash = invite["rolesHash"] as? String,
                  let oar = OrgAuthority.int64(invite["oarVersion"]), let ia = OrgAuthority.int64(invite["issuedAt"]), let ea = OrgAuthority.int64(invite["expiresAt"]) else {
                throw OrgAuthorityError("malformed")
            }
            let inviteSha = OrgAuthority.sha256Hex(try OrgAuthority.canonicalSeatInvite(orgId: orgId, seatId: seatId, labelSha256: labelSha, rolesHash: rolesHash,
                                                                                        oarVersion: oar, issuedAt: ia, expiresAt: ea))
            let msg = try OrgAuthority.canonicalSeatAccept(orgId: orgId, seatId: seatId, inviteSha256: inviteSha, memberKeyId: memberKeyId, adminKeyId: adminKeyId, issuedAt: t)
            let sig = try PqHybrid.hybridSign(secretKey: member.secret, purpose: OrgAuthority.tagSeatAccept, payload: msg)
            // The seat's X-Wing key rides with the accept; `.com` records it when the grant lands, so this
            // seat receives new key-ring versions without opening the org page first.
            let kem = try PqHybrid.hybridSealKeygen(seed: try OrgAuthority.seatKemSeed(umk: umk, orgId: orgId))
            let kemKeyId = OrgAuthority.kemKeyIdHex(kem.publicKey)
            let kemMsg = try OrgAuthority.canonicalSeatKem(orgId: orgId, seatId: seatId, kemKeyId: kemKeyId, issuedAt: t)
            let kemSig = try PqHybrid.hybridSign(secretKey: member.secret, purpose: OrgAuthority.tagSeatKem, payload: kemMsg)
            try await client.accept(orgId: orgId, seatId: seatId, body: [
                "accept": ["orgId": orgId, "seatId": seatId, "inviteSha256": inviteSha, "memberKeyId": memberKeyId, "adminKeyId": adminKeyId, "issuedAt": NSNumber(value: t)],
                "memberBinding": member.binding.jsonObject,
                "adminBinding": admin.map { $0.binding.jsonObject as Any } ?? NSNull(),
                "signature": OrgAuthority.hex(sig),
                "seatKem": [
                    "statement": ["orgId": orgId, "seatId": seatId, "kemKeyId": kemKeyId, "issuedAt": NSNumber(value: t)] as [String: Any],
                    "kemPubHex": OrgAuthority.hex(kem.publicKey),
                    "signature": OrgAuthority.hex(kemSig),
                ] as [String: Any],
            ])
            let name = (offer["orgName"] as? String) ?? ""
            if let admin {
                try keys.remember(orgId: orgId, seatId: seatId, orgName: name, genesisHash: genesis, binding: admin.binding, secret: admin.secret)
            } else {
                try keys.rememberMember(orgId: orgId, seatId: seatId, orgName: name, genesisHash: genesis, memberBinding: member.binding)
            }
            let code = try OrgAuthority.seatSas(inviteSha256: inviteSha, memberKeyId: memberKeyId, adminKeyId: adminKeyId)
            phase = .accepted(code: "\(code.prefix(3)) \(code.suffix(3))")
        } catch {
            phase = .failed(String(localized: "That didn't go through. Try again."))
        }
    }
}
