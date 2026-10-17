#if DEBUG
import Foundation
import FlagshipAPI

/// Gym-only: teaches `MockOrderSigners` the canonical bytes of the orders
/// whose encoding lives in this module, so the mock `.com` and boxes verify
/// them as the real ones do. Called by the `-smoke-mode` seam.
public enum GymOrderCanonical {
    public static func install(on signers: MockOrderSigners = .shared) {
        signers.registerCanonical("server-order") { p in
            guard let w = p as? SignedServerOrderWire else { return nil }
            return try? ServerOrder(user: w.order.user, stks: w.order.stks, issuedAt: w.order.issuedAt,
                                    nonce: w.order.nonce).canonicalBytes()
        }
        signers.registerCanonical("server-unrevoke") { p in
            guard let r = p as? ServerUnrevocationRequest else { return nil }
            return ServerUnrevocation.canonicalBytes(username: r.request.username, serverDomain: r.request.serverDomain,
                                                     issuedAt: r.request.issuedAt)
        }
        signers.registerCanonical("server-revoke") { p in
            guard let r = p as? ServerRevocationRequest else { return nil }
            return ServerRevocationClaim.canonicalBytes(userId: r.request.userId, revokedServerId: r.request.revokedServerId,
                                                        reason: r.request.reason, issuedAt: r.request.issuedAt)
        }
        signers.registerCanonical("release-server-name") { p in
            guard let r = p as? ReleaseServerNameRequest else { return nil }
            return ReleaseServerName.canonicalBytes(username: r.request.username, serverDomain: r.request.serverDomain,
                                                    issuedAt: r.request.issuedAt)
        }
        signers.registerCanonical("server-update") { p in
            guard let b = p as? UpdateDepositBody else { return nil }
            return try? ServerUpdateOrder(serverDomain: b.order.serverDomain, targetCommit: b.order.targetCommit,
                                          fromCommit: b.order.fromCommit, nonce: b.order.nonce,
                                          issuedAt: b.order.issuedAt).canonicalBytes()
        }
        signers.registerCanonical("server-decommission") { p in
            guard let b = p as? DecommissionDepositBody else { return nil }
            let o = b.order
            return ServerDecommissionOrder(podCanonical: o.podCanonical, retiredStkPubHex: o.retiredStkPubHex,
                                           finalBackup: o.finalBackup, diskDisposition: o.diskDisposition,
                                           backupEpoch: o.backupEpoch, nonce: o.nonce, issuedAt: o.issuedAt).canonicalBytes()
        }
        signers.registerCanonical("watch-delegate") { p in
            guard let r = p as? WatchDelegateMintRequest else { return nil }
            let g = r.grant
            return WatchDelegateKeyEnvelope(grantId: g.grantId, username: g.username, delegatePubKeyHex: g.delegatePubKey,
                                            scopes: g.scopes, issuedAt: g.issuedAt, expiresAt: g.expiresAt).canonicalBytes()
        }
        signers.registerCanonical("watch-delegate-revoke") { p in
            guard let r = p as? WatchDelegateRevokeRequest else { return nil }
            return RevokeWatchDelegateEnvelope(grantId: r.request.grantId, username: r.request.username,
                                               issuedAt: r.request.issuedAt).canonicalBytes()
        }
        signers.registerCanonical("server-migration") { p in
            guard let b = p as? MigrationStartBody else { return nil }
            let o = b.order
            return ServerMigrationOrder(serverDomain: o.serverDomain, oldStkPubHex: o.oldStkPubHex,
                                        diskDisposition: o.diskDisposition, nonce: o.nonce, issuedAt: o.issuedAt).canonicalBytes()
        }
        signers.registerCanonical("server-migration-control") { p in
            guard let b = p as? MigrationControlBody else { return nil }
            let c = b.control
            return ServerMigrationControl(serverDomain: c.serverDomain, action: c.action, nonce: c.nonce,
                                          issuedAt: c.issuedAt).canonicalBytes()
        }
        signers.registerCanonical("transfer-offer") { p in
            guard let b = p as? TransferOfferBody else { return nil }
            let o = b.offer
            return ServerTransferOfferOrder(serverDomain: o.serverDomain, transferNonce: o.transferNonce,
                                            issuedAt: o.issuedAt, expiresAt: o.expiresAt).canonicalBytes()
        }
        signers.registerCanonical("auth-code-admin") { p in
            guard let r = p as? AuthCodeIssueRequest, let d = HexUtil.decode(r.code.delegatedPubKey),
                  let u = HexUtil.decode(r.code.userPubKey) else { return nil }
            let code = AuthCode(version: r.code.version, serial: r.code.serial, username: r.code.username,
                                serverName: r.code.serverName, serverDomain: r.code.serverDomain,
                                delegatedPubKey: d, userPubKey: u, issuedAt: r.code.issuedAt, expiresAt: r.code.expiresAt,
                                adminRootPubKey: r.code.adminRootPubKey.flatMap(HexUtil.decode))
            return try? code.adminCanonicalBytes()
        }
        signers.registerCanonical("journal") { p in
            guard let r = p as? [String: Any], let server = r["serverId"] as? String, let unit = r["unit"] as? String,
                  let lines = int64(r["lines"]), let at = int64(r["issuedAt"])
            else { return nil }
            return JournalRequest(serverId: server, unit: unit, lines: lines, issuedAt: at).canonicalBytes()
        }
        signers.registerCanonical("power-off") { p in
            guard let r = p as? [String: Any], let server = r["serverId"] as? String,
                  let mode = (r["mode"] as? String).flatMap(PowerMode.init(rawValue:)), let at = int64(r["issuedAt"])
            else { return nil }
            return PowerOffOrder(serverId: server, mode: mode, issuedAt: at).canonicalBytes()
        }
        signers.registerCanonical("deadman-policy") { p in
            guard let r = p as? [String: Any], let server = r["serverId"] as? String, let enabled = r["enabled"] as? Bool,
                  let window = int64(r["windowMs"]), let grace = int64(r["graceMs"]),
                  let mode = (r["lockoutMode"] as? String).flatMap(PowerMode.init(rawValue:)), let at = int64(r["issuedAt"])
            else { return nil }
            return DeadManPolicy(serverId: server, enabled: enabled, windowMs: window, graceMs: grace,
                                 lockoutMode: mode, issuedAt: at).canonicalBytes()
        }
        signers.registerCanonical("deadman-affirm") { p in
            guard let r = p as? [String: Any], let server = r["serverId"] as? String,
                  let nonce = (r["nonce"] as? String).flatMap(HexUtil.decode), let at = int64(r["issuedAt"])
            else { return nil }
            return DeadManAffirmation(serverId: server, nonce: nonce, issuedAt: at).canonicalBytes()
        }
        signers.registerCanonical("front-page") { p in
            guard let r = p as? [String: Any], let server = r["serverId"] as? String, let label = r["label"] as? String,
                  let at = int64(r["issuedAt"])
            else { return nil }
            return SetFrontPageOrder(serverId: server, label: label, issuedAt: at).canonicalBytes()
        }
        signers.registerCanonical("uninstall") { p in
            guard let r = p as? [String: Any], let server = r["serverId"] as? String, let creator = r["creator"] as? String,
                  let slug = r["slug"] as? String, let at = int64(r["issuedAt"])
            else { return nil }
            return UninstallServiceOrder(serverId: server, creator: creator, slug: slug, issuedAt: at).canonicalBytes()
        }
        signers.registerCanonical("server-archive-keys") { p in
            try? (p as? ArchiveKeysDeposit)?.canonicalBytes()
        }
        signers.registerCanonical("backup-policy") { p in
            try? (p as? BackupPolicyOrder)?.canonicalBytes()
        }
    }

    private static func int64(_ v: Any?) -> Int64? {
        switch v {
        case let i as Int64: return i
        case let i as Int: return Int64(i)
        case let n as NSNumber: return n.int64Value
        case let s as String: return Int64(s)
        default: return nil
        }
    }
}
#endif
