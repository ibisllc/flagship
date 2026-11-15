import Foundation
import FlagshipCore

/// This phone's org seats (docs/enterprise-accounts.md §2, §7). A seat admin key is RANDOM (never
/// UMK-derived: the person's non-admin devices hold the UMK), hybrid Ed25519 + ML-DSA-65, made here,
/// sealed to the Secure Enclave wrapping key that seals the UMK ("PQ, hardware-wrapped"), and opened
/// only in an unlocked session. It is bound by a `pq-key-binding` of role `org-seat-admin`.
public final class OrgSeatKeys: @unchecked Sendable {
    public static let shared = OrgSeatKeys()

    public struct Seat: Codable, Equatable, Identifiable {
        public let orgId: String
        public let seatId: String
        public var orgName: String
        public let genesisHash: String
        public let binding: PqKeyBindingWire
        /// A member seat holds no admin key: `binding` is its member key's (re-derived from the UMK when
        /// needed), and it approves nothing. Nil on records from before members could join.
        public var memberOnly: Bool?
        public var keyId: String { OrgAuthority.keyIdHex(ed25519PubHex: binding.ed25519PubHex, mldsaPubHex: binding.mldsaPubHex) }
        public var id: String { "\(orgId):\(seatId)" }
    }

    private struct Record: Codable {
        var seat: Seat
        var sealed: Data
        var ephemeralPub: Data
    }

    private let prefix = "com.flagship.org-seat."
    private func slot(_ orgId: String, _ seatId: String) -> String { "\(prefix)\(orgId).\(seatId)" }
    private func aad(_ orgId: String, _ seatId: String) -> Data { Data(["flagship/org-seat-key-wrap/v1", orgId, seatId].joined(separator: "|").utf8) }

    public init() {}

    public func seats() -> [Seat] {
        Keystore.pqRecords(prefix: prefix).compactMap { try? JSONDecoder().decode(Record.self, from: $0).seat }
    }

    /// Makes a seat admin key for `orgId`/`seatId` and its binding. The seat is stored only once
    /// `genesisHash` is known (`remember`), so a key for a seat that never formed leaves nothing behind.
    public func makeKey(orgId: String, seatId: String, now: Int64) throws -> (binding: PqKeyBindingWire, secret: [UInt8]) {
        let (pub, secret) = try PqHybrid.hybridSigKeygen(edSeed: PqHybrid.randomSeed(), mldsaSeed: PqHybrid.randomSeed())
        let st = PqKeyBindingStatement(role: "org-seat-admin", subjectId: OrgAuthority.seatSubject(orgId: orgId, seatId: seatId),
                                       ed25519PubHex: OrgAuthority.hex(Array(pub[0..<32])), mldsaPubHex: OrgAuthority.hex(Array(pub[32...])), issuedAt: now)
        let binding = try PqTrust.signPqKeyBinding(st) { purpose, payload in try PqHybrid.hybridSign(secretKey: secret, purpose: purpose, payload: payload) }
        return (binding, secret)
    }

    public func remember(orgId: String, seatId: String, orgName: String, genesisHash: String, binding: PqKeyBindingWire, secret: [UInt8]) throws {
        let sealed = try Keystore.pqSealSeed(Data(secret), aad: aad(orgId, seatId))
        let rec = Record(seat: Seat(orgId: orgId, seatId: seatId, orgName: orgName, genesisHash: genesisHash, binding: binding, memberOnly: nil),
                         sealed: sealed.sealed, ephemeralPub: sealed.ephemeralPub)
        try Keystore.pqRecordWrite(slot(orgId, seatId), try JSONEncoder().encode(rec))
    }

    /// A member seat: nothing secret is kept (the member key derives from the UMK), only the binding.
    public func rememberMember(orgId: String, seatId: String, orgName: String, genesisHash: String, memberBinding: PqKeyBindingWire) throws {
        let rec = Record(seat: Seat(orgId: orgId, seatId: seatId, orgName: orgName, genesisHash: genesisHash, binding: memberBinding, memberOnly: true),
                         sealed: Data(), ephemeralPub: Data())
        try Keystore.pqRecordWrite(slot(orgId, seatId), try JSONEncoder().encode(rec))
    }

    /// Signs with the seat admin key; nil when the session is locked (the caller asks to unlock).
    public func sign(_ seat: Seat, purpose: String, payload: [UInt8]) -> [UInt8]? {
        guard let raw = Keystore.pqRecordRead(slot(seat.orgId, seat.seatId)),
              let rec = try? JSONDecoder().decode(Record.self, from: raw),
              let ctx = Keystore.sessionAuthContext,
              let secret = try? Keystore.pqOpenSeed(rec.sealed, ephemeralPub: rec.ephemeralPub, aad: aad(seat.orgId, seat.seatId), context: ctx)
        else { return nil }
        var s = [UInt8](secret)
        defer { for i in s.indices { s[i] = 0 } }
        return try? PqHybrid.hybridSign(secretKey: s, purpose: purpose, payload: payload)
    }

    public func forget(_ seat: Seat) { Keystore.pqRecordDelete(slot(seat.orgId, seat.seatId)) }
}
