import Foundation
import FlagshipAPI
import FlagshipCore

/// Projections from the phone's richer FlagshipAPI models onto the thin,
/// FlagshipAPI-free `WatchProtocol` wire types the watch security-alerts
/// surface consumes. Lives in FlagshipUI because it's the only layer that
/// sees BOTH the FlagshipAPI models and the FlagshipCore wire types — the
/// watch target can't import FlagshipAPI, so the mapping has to happen
/// here before it crosses `WatchSecurityAlertsBridge`.
public extension WatchProtocol.SecurityAlert {
    /// Project an account audit event onto the watch wire type.
    init(audit event: AuditEvent) {
        self.init(
            seq: event.seq,
            kind: event.eventKind,
            detail: event.detail,
            devicePrefix: event.devicePrefix,
            postedAt: event.postedAt
        )
    }
}

public extension WatchProtocol.PendingApproval {
    /// Project a pending boot-secret mailbox request onto the watch wire
    /// type. The box's reported IP (if any) rides along so the watch row
    /// can show provenance.
    init(secretRequest req: PendingSecretRequest) {
        self.init(
            requestId: req.id,
            serverFqdn: req.serverDomain,
            requestedAt: req.postedAt,
            ip: req.deviceInfo?.ip
        )
    }
}
