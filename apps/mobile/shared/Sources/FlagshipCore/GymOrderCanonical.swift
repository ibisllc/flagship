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
                                    nonce: w.order.nonce, pqKeyIds: w.order.pqKeyIds).canonicalBytes()
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
        signers.registerCanonical("serving-policy") { p in
            try? (p as? ServingPolicy)?.canonicalBytes()
        }
        signers.registerCanonical("renewal-delegation") { p in
            try? (p as? RenewalKeyDelegation)?.canonicalBytes()
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
        signers.registerCanonical("chat-approval") { p in
            guard let r = p as? [String: Any], let server = r["serverDomain"] as? String,
                  let a = r["answer"] as? ChatAnswerRequest,
                  let kind = ChatApproval.Kind(rawValue: a.kind), let decision = ChatApproval.Decision(rawValue: a.decision)
            else { return nil }
            return try? ChatApproval(serverDomain: server, requestId: a.requestId, kind: kind, decision: decision,
                                     issuedAt: a.issuedAt).canonicalBytes()
        }
        signers.registerCanonical("browser-grant") { p in
            guard let r = p as? [String: Any], let server = r["serverDomain"] as? String,
                  let req = r["request"] as? BrowserGrantRequest, let a = r["answer"] as? BrowserGrantAnswerRequest
            else { return nil }
            return try? BrowserGrantOrder.answer(for: req, serverDomain: server, decision: a.decision, duration: a.duration,
                                                 issuedAt: a.issuedAt).canonicalBytes()
        }
        signers.registerCanonical("browser-grant-revoke") { p in
            guard let r = p as? [String: Any], let server = r["serverDomain"] as? String,
                  let rv = r["revoke"] as? BrowserGrantRevokeRequest
            else { return nil }
            return try? BrowserGrantRevoke(serverDomain: server, serviceId: rv.serviceId, grantId: rv.grantId,
                                           issuedAt: rv.issuedAt).canonicalBytes()
        }
        signers.registerCanonical("ai-consent") { p in
            guard let r = p as? [String: Any], let server = r["serverDomain"] as? String, let buildId = r["buildId"] as? String,
                  let op = (r["operation"] as? String).flatMap(AiRepairConsent.Operation.init(rawValue:)),
                  let c = r["consent"] as? AiConsentBody, let source = AiRepairConsent.Source(rawValue: c.source)
            else { return nil }
            return try? AiRepairConsent(serverDomain: server, buildId: buildId, operation: op, provider: c.provider,
                                        source: source, highTokens: c.highTokens, issuedAt: c.issuedAt).canonicalBytes()
        }
        // Local AI (docs/architecture-v2/local-ai.md §4): the `order` object exactly as sent.
        signers.registerCanonical("arch-v2-switch") { p in
            guard let o = p as? [String: Any], let d = o["serverDomain"] as? String, let t = o["target"] as? String,
                  let n = o["nonce"] as? String, let at = int64(o["issuedAt"]) else { return nil }
            return try? StackSwitchOrder(serverDomain: d, target: t, nonce: n, issuedAt: at).canonicalBytes()
        }
        signers.registerCanonical("gpu-approval") { p in
            guard let o = p as? [String: Any], let r = GpuApprovalOrder.request(fromBody: o), let at = int64(o["issuedAt"]) else { return nil }
            return try? GpuApprovalOrder.canonical(server: r.server, r, issuedAt: at)
        }
        signers.registerCanonical("gpu-approval-withdraw") { p in
            guard let o = p as? [String: Any], let server = o["server"] as? String, let app = o["appId"] as? String,
                  let inst = o["installationId"] as? String, let gen = int64(o["generation"]), let at = int64(o["issuedAt"]) else { return nil }
            return try? GpuApprovalOrder.withdrawCanonical(server: server, appId: app, installationId: inst, generation: gen, issuedAt: at)
        }
        signers.registerCanonical("local-ai-app-grant") { p in
            guard let o = p as? [String: Any], let server = o["serverDomain"] as? String, let id = o["serviceId"] as? String,
                  let r = int64(o["requestsPerDay"]), let t = int64(o["tokensPerDay"]), let m = int64(o["maxTokensPerRequest"]),
                  let at = int64(o["issuedAt"]) else { return nil }
            return try? LocalAiAppGrant(serverDomain: server, serviceId: id, requestsPerDay: r, tokensPerDay: t,
                                        maxTokensPerRequest: m, issuedAt: at).canonicalBytes()
        }
        signers.registerCanonical("local-ai-train") { p in
            guard let o = p as? [String: Any], let server = o["serverDomain"] as? String, let id = o["serviceId"] as? String,
                  let job = o["jobId"] as? String, let base = o["baseModel"] as? String, let e = int64(o["epochs"]),
                  let at = int64(o["issuedAt"]) else { return nil }
            return try? LocalAiTrainOrder(serverDomain: server, serviceId: id, jobId: job, baseModel: base,
                                          epochs: Int(e), issuedAt: at).canonicalBytes()
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
