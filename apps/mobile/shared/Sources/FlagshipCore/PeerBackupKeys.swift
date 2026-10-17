import Foundation
import CryptoKit
import FlagshipAPI

/// Peer backup between accounts (docs/peer-backup.md), the device's side.
/// A device of the account makes the keys for any of its servers, a dead one
/// too: SWK = deriveSWK(UMK, serverId), PBK = HKDF(SWK, "flagship/peer-backup-key/v1").
/// MIRRORS lib/peerBackup.js and passes packages/protocol/test-vectors/peer-backup.
public enum PeerBackupKeys {
    static let infoPbk = "flagship/peer-backup-key/v1"
    static let infoRoot = "flagship/pb-root/v1"

    public enum Failure: Error, LocalizedError, Equatable {
        case notAServer
        case wouldNotOpen
        case otherServer
        public var errorDescription: String? {
            switch self {
            case .notAServer: return "That isn't a server address."
            case .wouldNotOpen: return "The peer backup record doesn't open with this account's key."
            case .otherServer: return "That peer backup record is for another server."
            }
        }
    }

    public static func normalized(_ serverId: String) throws -> String {
        let id = serverId.trimmingCharacters(in: .whitespaces).lowercased()
        guard !id.isEmpty, id.count <= 253,
              id.unicodeScalars.allSatisfy({ ("a"..."z").contains($0) || ("0"..."9").contains($0) || $0 == "." || $0 == "-" })
        else { throw Failure.notAServer }
        return id
    }

    private static func hkdf(_ ikm: Data, _ info: String) -> Data {
        HKDF<SHA256>.deriveKey(inputKeyMaterial: SymmetricKey(data: ikm), salt: Data(),
                               info: Data(info.utf8), outputByteCount: 32)
            .withUnsafeBytes { Data($0) }
    }

    /// PBK of `serverId`'s peer backups, from the account key (32 bytes).
    public static func pbk(umkSeed: Data, serverId: String) throws -> Data {
        let id = try normalized(serverId)
        guard let swk = ServerKeys.deriveSwk(umkSeed: umkSeed, serverId: id) else { throw Failure.notAServer }
        return hkdf(swk, infoPbk)
    }

    /// Open a sealed record with the PBK; the same checks as the box.
    public static func openSealedRoot(_ sealed: PeerSealedRoot, pbk: Data, serverId: String) throws -> PeerRootSummary {
        let id = try normalized(serverId)
        guard let nonce = HexUtil.decode(sealed.nonceHex), let ct = HexUtil.decode(sealed.ciphertextHex), ct.count > 16 else {
            throw Failure.wouldNotOpen
        }
        let key = SymmetricKey(data: hkdf(pbk, infoRoot))
        let plain: Data
        do {
            let box = try AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: nonce), ciphertext: ct.dropLast(16), tag: ct.suffix(16))
            plain = try AES.GCM.open(box, using: key, authenticating: Data("\(infoRoot)|\(id)".utf8))
        } catch {
            throw Failure.wouldNotOpen
        }
        return try summary(ofRootJson: plain, serverId: id)
    }

    struct Root: Decodable {
        struct Network: Decodable { let k: Int? }
        struct Member: Decodable { let expiresAt: Int64 }
        let v: Int
        let serverId: String
        let generation: Int
        let revision: Int
        let createdAt: Int64
        let archive: PeerRootSummary.Archive
        let network: Network?
        let stripes: [[Member]]?
    }

    static func summary(ofRootJson json: Data, serverId: String) throws -> PeerRootSummary {
        guard let root = try? JSONDecoder().decode(Root.self, from: json), root.v == 1, root.serverId == serverId else {
            throw Failure.otherServer
        }
        let members = (root.stripes ?? []).flatMap { $0 }
        return PeerRootSummary(
            serverId: root.serverId, generation: root.generation, revision: root.revision,
            createdAt: root.createdAt, archive: root.archive, holders: members.count,
            needed: root.network?.k ?? 1, keepUntil: members.map(\.expiresAt).min() ?? 0
        )
    }
}
