import Foundation

/// Name dibs — claim the account name matching a `.com` you control
/// (docs/naming-recovery-and-name-change.md §7). Canonical bytes mirror
/// packages/protocol/src/nameDibs.ts byte-for-byte; pinned by the shared
/// vectors in CanonicalBytesVectorsTests.
public enum NameDibsInitiate {
    public static let canonicalTag = "flagship/name-dibs-initiate/v1"
    public static func canonicalBytes(username: String, name: String, irkPubHex: String, issuedAt: Int64) -> Data {
        Data([canonicalTag, username, name, irkPubHex, String(issuedAt)].joined(separator: "|").utf8)
    }
}

public enum NameDibsVerify {
    public static let canonicalTag = "flagship/name-dibs-verify/v1"
    public static func canonicalBytes(username: String, name: String, nonce: String, issuedAt: Int64) -> Data {
        Data([canonicalTag, username, name, nonce, String(issuedAt)].joined(separator: "|").utf8)
    }
}

/// The paid name change — move this account to a new name. Bound to the
/// account's stable AID so a captured envelope can't be replayed elsewhere.
public enum NameChangeEnvelope {
    public static let canonicalTag = "flagship/name-change/v1"
    public static func canonicalBytes(aidPubHex: String, oldUsername: String, newUsername: String, issuedAt: Int64) -> Data {
        Data([canonicalTag, aidPubHex, oldUsername, newUsername, String(issuedAt)].joined(separator: "|").utf8)
    }
}
