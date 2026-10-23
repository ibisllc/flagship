import SwiftUI
import FlagshipAPI

/// "Access & permissions" on an app's page: what can act for the app now, and a way to end it.
struct ServicePermissionsSection: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable var controller: ServicePermissionsController

    var body: some View {
        let c = FSColors.scheme(scheme)
        if let p = controller.permissions {
            VStack(alignment: .leading, spacing: FS.space.s3) {
                FSSectionLabel(PermissionWords.title)
                FSCard {
                    VStack(alignment: .leading, spacing: FS.space.s3) {
                        if p.grants.isEmpty {
                            Text(PermissionWords.none).font(FS.font.bodySm()).foregroundColor(c.text)
                        }
                        ForEach(p.grants) { g in
                            VStack(alignment: .leading, spacing: 2) {
                                Divider()
                                Text("\(PermissionWords.kindLabel(g.kind)) · \(g.capability)")
                                    .font(FS.font.bodySm().weight(.semibold)).foregroundColor(c.text)
                                if g.secretAccess {
                                    Text("Can read secrets").font(FS.font.caption()).foregroundColor(c.danger)
                                }
                                ForEach(g.openWork, id: \.self) { w in
                                    Text("Running: \(w)").font(FS.font.caption()).foregroundColor(c.textMuted)
                                }
                                FSSecondaryButton(PermissionWords.revoke, block: true) {
                                    Task { await controller.revoke(grantId: g.id) }
                                }
                                .accessibilityIdentifier("service-permission-revoke-\(g.id)")
                            }
                        }
                        ForEach(p.pendingOperations) { o in
                            Text("Waiting: \(o.kind) (\(o.state))").font(FS.font.caption()).foregroundColor(c.textMuted)
                        }
                        if p.grants.count > 1 {
                            FSSecondaryButton(PermissionWords.revokeAll, block: true) {
                                Task { await controller.revoke(grantId: nil) }
                            }
                            .accessibilityIdentifier("service-permission-revoke-all")
                        }
                        if let n = controller.notice { Text(n).font(FS.font.caption()).foregroundColor(c.textMuted) }
                        if let e = controller.error { Text(e).font(FS.font.bodySm()).foregroundColor(c.danger) }
                    }
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("service-detail-permissions")
        }
    }
}
