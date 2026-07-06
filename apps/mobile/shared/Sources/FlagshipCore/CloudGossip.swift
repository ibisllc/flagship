import Foundation
import CryptoKit

/// Swift mirror of the Phase-3 cloud-gossip / per-service leadership foundation
/// in `packages/protocol/src/cloudGossip.ts`. PURE crypto / canonical-bytes
/// plumbing — must stay byte-identical to the TS implementation and the Kotlin
/// mirror (`CloudGossip.kt`); the pinned cross-platform vectors in
/// `CloudGossipCanonicalTests.swift` lock every byte/hex in.
///
///   1. CGK   — `HKDF-SHA256(ikm = umkSeed, salt = empty, info =
///              "flagship.cloud-gossip.v1", 32)`. One key PER CLOUD (no
///              serverId) — derived the SAME way as `ServerKeys.deriveSwk`,
///              only the info differs.
///   2. set-leader — owner-IRK-signed preferred-server vote, mirroring the
///              server-decommission envelope conventions.
///   3. gossip — canonical bytes + an HMAC-SHA256 tag keyed by the CGK, plus an
///              AES-256-GCM nonce-prefixed seal/open transport keyed by the CGK.
///   4. clout  — the pure comparator + per-service elector.
///   5. birthDateFromAuthCode — AuthCode.issuedAt is the immutable birth date.

public enum CloudGossip {

    // MARK: 1. CGK

    private static let infoCGK = "flagship.cloud-gossip.v1"

    /// `CGK = HKDF-SHA256(ikm = umkSeed, salt = empty,
    /// info = "flagship.cloud-gossip.v1", 32)` — per-cloud (no serverId).
    /// Mirrors `ServerKeys.deriveSwk`'s HKDF construction (empty salt).
    public static func deriveCGK(umkSeed: Data) -> Data? {
        guard umkSeed.count == 32 else { return nil }
        let key = HKDF<SHA256>.deriveKey(
            inputKeyMaterial: SymmetricKey(data: umkSeed),
            salt: Data(),
            info: Data(infoCGK.utf8),
            outputByteCount: 32
        )
        return key.withUnsafeBytes { Data($0) }
    }

    // MARK: 2. set-leader vote

    public static let setLeaderTag = "flagship/set-leader/v1"
    /// Sentinel `preferredStkPubHex` that CLEARS the vote.
    public static let setLeaderNone = "none"

    /// Owner-IRK-signed preferred-server vote.
    ///
    /// Canonical bytes (byte-identical to TS + Kotlin):
    ///   flagship/set-leader/v1|<user>|<preferredStkPubHex>|<issuedAt>|<nonce>
    /// `user`, `preferredStkPubHex`, and `nonce` are lowercased; `issuedAt` is
    /// the plain decimal number. `preferredStkPubHex == "none"` clears the vote.
    public struct SetLeaderVote: Equatable, Sendable {
        public let user: String
        public let preferredStkPubHex: String
        public let issuedAt: Int64
        public let nonce: String

        public init(user: String, preferredStkPubHex: String, issuedAt: Int64, nonce: String) {
            self.user = user
            self.preferredStkPubHex = preferredStkPubHex
            self.issuedAt = issuedAt
            self.nonce = nonce
        }

        public func canonicalBytes() -> Data {
            Data(
                [
                    CloudGossip.setLeaderTag,
                    user.lowercased(),
                    preferredStkPubHex.lowercased(),
                    String(issuedAt),
                    nonce.lowercased(),
                ].joined(separator: "|").utf8
            )
        }

        public func sign(with irk: Curve25519.Signing.PrivateKey) throws -> Data {
            try irk.signature(for: canonicalBytes())
        }

        public func verify(_ signature: Data, with irkPub: Curve25519.Signing.PublicKey) -> Bool {
            irkPub.isValidSignature(signature, for: canonicalBytes())
        }
    }

    // MARK: 3. gossip announcement

    public static let gossipTag = "flagship/gossip/v1"
    public static let gossipVoteNone = "none"
    public static let gossipVoteDateNone: Int64 = 0

    /// One pod's per-tick gossip frame.
    ///
    /// Canonical bytes (byte-identical to TS + Kotlin):
    ///   flagship/gossip/v1|<user>|<name>|<birthAuthHex>|<birthDate>|<voteStkHex>|<voteDate>|<services>|<liveness>|<issuedAt>
    /// `services` = the slugs SORTED + `,`-joined (deterministic). `name`,
    /// `birthAuthHex`, `voteStkHex` lowercased; the dates are plain decimals.
    public struct Announcement: Equatable, Sendable {
        public let user: String
        public let name: String
        public let birthAuthHex: String
        public let birthDate: Int64
        public let voteStkHex: String
        public let voteDate: Int64
        public let services: [String]
        /// "live" | "unreachable" | "never".
        public let liveness: String
        public let issuedAt: Int64

        public init(
            user: String, name: String, birthAuthHex: String, birthDate: Int64,
            voteStkHex: String, voteDate: Int64, services: [String],
            liveness: String, issuedAt: Int64
        ) {
            self.user = user
            self.name = name
            self.birthAuthHex = birthAuthHex
            self.birthDate = birthDate
            self.voteStkHex = voteStkHex
            self.voteDate = voteDate
            self.services = services
            self.liveness = liveness
            self.issuedAt = issuedAt
        }

        public func canonicalBytes() -> Data {
            let svc = services.sorted().joined(separator: ",")
            return Data(
                [
                    CloudGossip.gossipTag,
                    user.lowercased(),
                    name.lowercased(),
                    birthAuthHex.lowercased(),
                    String(birthDate),
                    voteStkHex.lowercased(),
                    String(voteDate),
                    svc,
                    liveness,
                    String(issuedAt),
                ].joined(separator: "|").utf8
            )
        }
    }

    /// HMAC-SHA256 of the canonical gossip bytes under the CGK, lowercased hex.
    public static func macGossip(_ a: Announcement, cgk: Data) -> String {
        let tag = HMAC<SHA256>.authenticationCode(
            for: a.canonicalBytes(),
            using: SymmetricKey(data: cgk)
        )
        return Data(tag).map { String(format: "%02x", $0) }.joined()
    }

    /// Constant-time check that `mac` (lowercased hex) is the CGK-HMAC of `a`.
    /// Never throws.
    public static func verifyGossipMac(_ a: Announcement, mac: String, cgk: Data) -> Bool {
        let expected = macGossip(a, cgk: cgk)
        let got = mac.lowercased()
        guard expected.utf8.count == got.utf8.count else { return false }
        var diff: UInt8 = 0
        for (x, y) in zip(expected.utf8, got.utf8) { diff |= x ^ y }
        return diff == 0
    }

    /// AES-256-GCM transport seal keyed by the CGK. Wire layout (nonce-prefixed):
    ///   [nonce: 12 B][ciphertext + GCM tag: var]
    public static func sealGossip(_ plaintext: Data, cgk: Data) throws -> Data {
        let nonceBytes = Data((0..<12).map { _ in UInt8.random(in: 0...255) })
        let nonce = try AES.GCM.Nonce(data: nonceBytes)
        let sealed = try AES.GCM.seal(plaintext, using: SymmetricKey(data: cgk), nonce: nonce)
        // nonce || ciphertext || tag (SealedBox.combined IS nonce||ct||tag).
        return nonceBytes + sealed.ciphertext + sealed.tag
    }

    /// Open a `sealGossip` blob with the CGK. Throws on a bad tag/length.
    public static func openGossip(_ blob: Data, cgk: Data) throws -> Data {
        guard blob.count >= 12 + 16 else {
            throw CryptoKitError.incorrectParameterSize
        }
        let nonce = try AES.GCM.Nonce(data: blob.prefix(12))
        let rest = blob.suffix(from: blob.startIndex + 12)
        let ct = rest.prefix(rest.count - 16)
        let tag = rest.suffix(16)
        let box = try AES.GCM.SealedBox(nonce: nonce, ciphertext: ct, tag: tag)
        return try AES.GCM.open(box, using: SymmetricKey(data: cgk))
    }

    // MARK: 4. clout ranking

    public struct CloutMember: Equatable, Sendable {
        public let id: String
        public let domain: String
        public let birthDate: Int64
        /// The owner's set-leader vote issuedAt (ms), or nil when not voted.
        public let voteIssuedAt: Int64?
        /// "live" | "unreachable" | "never".
        public let liveness: String
        public let services: [String]

        public init(
            id: String, domain: String, birthDate: Int64,
            voteIssuedAt: Int64?, liveness: String, services: [String]
        ) {
            self.id = id
            self.domain = domain
            self.birthDate = birthDate
            self.voteIssuedAt = voteIssuedAt
            self.liveness = liveness
            self.services = services
        }
    }

    /// The raw clout comparator. Returns true when `a` STRICTLY outranks `b`
    /// (i.e. `a` should lead over `b`):
    ///   1. higher `voteIssuedAt` wins (nil treated as the lowest);
    ///   2. tie → lower `birthDate` (oldest birth certificate) wins;
    ///   3. tie → lower `domain` lexicographically.
    public static func cloutLess(_ a: CloutMember, _ b: CloutMember) -> Bool {
        let av = a.voteIssuedAt
        let bv = b.voteIssuedAt
        if av != bv {
            // nil is the lowest; a higher vote is "less" (sorts first / leads).
            switch (av, bv) {
            case let (.some(x), .some(y)): return x > y
            case (.some, .none): return true   // a voted, b not → a leads
            case (.none, .some): return false
            case (.none, .none): break
            }
        }
        if a.birthDate != b.birthDate { return a.birthDate < b.birthDate }
        return a.domain < b.domain
    }

    /// Elect the leader for one service: among the `live` members that run
    /// `serviceSlug`, the highest-clout one. nil when no live runner exists.
    public static func electLeadForService(
        _ members: [CloutMember], serviceSlug: String
    ) -> CloutMember? {
        let eligible = members.filter {
            $0.liveness == "live" && $0.services.contains(serviceSlug)
        }
        guard var lead = eligible.first else { return nil }
        for m in eligible.dropFirst() where cloutLess(m, lead) { lead = m }
        return lead
    }

    // MARK: 5. birth date

    /// The immutable birth date: `AuthCode.issuedAt` (ms). The create-time,
    /// owner-IRK-signed auth code is signed once, so `issuedAt` is a stable,
    /// unforgeable per-pod birth instant.
    public static func birthDateFromAuthCode(issuedAt: Int64) -> Int64 { issuedAt }
}
