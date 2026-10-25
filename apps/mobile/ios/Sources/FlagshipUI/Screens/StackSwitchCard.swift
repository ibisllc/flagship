import SwiftUI
import FlagshipAPI
import FlagshipCore

/// The server page's "Container stack" (admin devices only): which stack the box runs, Move to the
/// new stack (a signed dry run shows the box's plan or why it can't, then Move now sends it), and how
/// the move goes. Mirrors the webapp `views/stack-switch.js` and Android `StackSwitchCard.kt`.
struct StackSwitchCard: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.screensClient) private var client
    let serverDomain: String

    @State private var vm: StackSwitchViewModel?

    var body: some View {
        let c = FSColors.scheme(scheme)
        VStack(alignment: .leading, spacing: 0) {
            if let vm, vm.shows, let s = vm.status {
                VStack(alignment: .leading, spacing: FS.space.s3) {
                    FSSectionLabel(StackCopy.title)
                    FSCard { content(vm, s, c: c) }
                }
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("stack-card")
            }
        }
        .task(id: serverDomain) {
            let m = vm?.serverDomain == serverDomain ? vm! : StackSwitchViewModel(serverDomain: serverDomain, client: client)
            vm = m
            await m.load()
            await m.follow()
        }
        // After Move now the box restarts: follow it while this card is on screen.
        .task(id: vm?.restarting ?? false) {
            if let vm, vm.restarting { await vm.follow() }
        }
    }

    @ViewBuilder
    private func content(_ vm: StackSwitchViewModel, _ s: StackStatus, c: FSColors) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s3) {
            Text(StackCopy.current(s)).font(FS.font.body().weight(.semibold)).foregroundColor(c.text)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("stack-current")
            if let line = StackCopy.record(s.switchRecord) {
                Text(line).font(FS.font.bodySm()).foregroundColor(s.switchRecord?.state == "reverted" ? c.warning : c.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("stack-record")
            }
            if vm.restarting || s.switchRecord?.state == "installing" {
                ProgressView().accessibilityIdentifier("stack-moving")
            }
            switch vm.phase {
            case .idle:
                if !vm.moving {
                    FSSecondaryButton(StackCopy.move(s.plan.target), block: true) { Task { await vm.prepare() } }
                        .disabled(vm.busy)
                        .accessibilityIdentifier("stack-move")
                }
            case .review(let plan):
                review(vm, plan, c: c)
            }
            if let n = vm.notice {
                Text(n).font(FS.font.bodySm()).foregroundColor(c.success)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("stack-notice")
            }
            if let e = vm.error {
                Text(e).font(FS.font.bodySm()).foregroundColor(c.danger)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("stack-error")
            }
        }
    }

    @ViewBuilder
    private func review(_ vm: StackSwitchViewModel, _ plan: StackPlan, c: FSColors) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s2) {
            Text(StackCopy.planTitle).font(FS.font.bodySm().weight(.semibold)).foregroundColor(c.text)
            ForEach(Array(plan.steps.enumerated()), id: \.offset) { i, step in
                Text(verbatim: "\(i + 1). \(step)").font(FS.font.bodySm()).foregroundColor(c.text)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("stack-step-\(i)")
            }
            if let room = StackCopy.room(plan) {
                Text(room).font(FS.font.caption()).foregroundColor(c.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("stack-room")
            }
            ForEach(Array(plan.blockers.enumerated()), id: \.offset) { i, b in
                Text(b.error).font(FS.font.bodySm()).foregroundColor(c.danger)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("stack-blocker-\(i)")
            }
            HStack(spacing: FS.space.s2) {
                FSPrimaryButton(StackCopy.moveNow, enabled: plan.blockers.isEmpty && !vm.busy) { Task { await vm.confirm() } }
                    .accessibilityIdentifier("stack-move-now")
                FSSecondaryButton(String(localized: "Cancel")) { vm.cancel() }
                    .accessibilityIdentifier("stack-cancel")
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("stack-plan")
    }
}
