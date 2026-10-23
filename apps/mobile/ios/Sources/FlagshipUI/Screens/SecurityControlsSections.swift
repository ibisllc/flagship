import SwiftUI
import FlagshipAPI

/// "Restored permissions" on an app's page (N09).
struct RestoredAccessSection: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable var controller: RestoredAccessController
    let canApprove: Bool

    var body: some View {
        let c = FSColors.scheme(scheme)
        if let d = controller.draft {
            VStack(alignment: .leading, spacing: FS.space.s3) {
                FSSectionLabel(SecurityControlWords.restoredTitle)
                FSCard {
                    VStack(alignment: .leading, spacing: FS.space.s3) {
                        Text(SecurityControlWords.restoredIntro).font(FS.font.bodySm()).foregroundColor(c.textMuted)
                        Text("\(d.people) \(d.people == 1 ? "person" : "people") on the old list.\(d.mode == "open" ? " The app was open to all." : "")")
                            .font(FS.font.bodySm()).foregroundColor(c.text)
                        if canApprove {
                            FSPrimaryButton(SecurityControlWords.restoredApprove, block: true) { Task { await controller.approve() } }
                                .accessibilityIdentifier("restored-access-approve")
                            FSSecondaryButton(SecurityControlWords.restoredDiscard, block: true) { Task { await controller.discard() } }
                                .accessibilityIdentifier("restored-access-discard")
                        } else {
                            Text(SecurityControlWords.restoredAdminOnly).font(FS.font.caption()).foregroundColor(c.textMuted)
                        }
                        if let e = controller.error { Text(e).font(FS.font.bodySm()).foregroundColor(c.danger) }
                    }
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("service-detail-restored-access")
        }
    }
}

/// "Updates" on an app's page (N11): manual first, staged, automatic, never.
struct UpdateModeSection: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable var controller: UpdateModeController

    var body: some View {
        let c = FSColors.scheme(scheme)
        if let s = controller.state {
            VStack(alignment: .leading, spacing: FS.space.s3) {
                FSSectionLabel(SecurityControlWords.updatesTitle)
                FSCard {
                    VStack(alignment: .leading, spacing: FS.space.s3) {
                        ForEach(s.modes.filter { SecurityControlWords.updateLabel($0) != nil }, id: \.self) { m in
                            Button {
                                Task { await controller.choose(m) }
                            } label: {
                                HStack(alignment: .top, spacing: FS.space.s3) {
                                    Image(systemName: m == s.mode ? "largecircle.fill.circle" : "circle").foregroundColor(m == s.mode ? c.accent : c.textMuted)
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(SecurityControlWords.updateLabel(m) ?? m).font(FS.font.bodySm().weight(.semibold)).foregroundColor(c.text)
                                        Text(SecurityControlWords.updateNote(m) ?? "").font(FS.font.caption()).foregroundColor(c.textMuted)
                                    }
                                    Spacer(minLength: 0)
                                }
                            }
                            .buttonStyle(.plain)
                            .accessibilityIdentifier("update-mode-\(m)")
                        }
                        if let e = controller.error { Text(e).font(FS.font.bodySm()).foregroundColor(c.danger) }
                    }
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("service-detail-update-mode")
        }
    }
}
