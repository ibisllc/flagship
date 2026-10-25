import SwiftUI
import FlagshipAPI
import FlagshipCore

/// The server page's "GPUs": each GPU with its model, memory and state, the app holding it (with
/// Stop), and the apps waiting for one. Mirrors the webapp `views/accelerators.js` and Android
/// `AcceleratorsCard.kt`. Hidden on a box with no GPU or no GPU screen.
struct AcceleratorsCard: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.screensClient) private var client
    @Environment(AppState.self) private var app
    let serverDomain: String

    @State private var vm: AcceleratorsViewModel?
    @State private var stopping: AcceleratorHolder?

    var body: some View {
        let c = FSColors.scheme(scheme)
        VStack(alignment: .leading, spacing: 0) {
            if let vm, vm.shows {
                VStack(alignment: .leading, spacing: FS.space.s3) {
                    FSSectionLabel(AcceleratorsCopy.title)
                    FSCard { content(vm, c: c) }
                }
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("accelerators-card")
            }
        }
        .task(id: serverDomain) {
            let m = vm?.serverDomain == serverDomain ? vm! : AcceleratorsViewModel(serverDomain: serverDomain, client: client)
            vm = m
            await m.load()
        }
        .confirmationDialog(
            stopping.map { AcceleratorsCopy.stopTitle($0) } ?? "",
            isPresented: Binding(get: { stopping != nil }, set: { if !$0 { stopping = nil } }),
            titleVisibility: .visible,
            presenting: stopping
        ) { h in
            // Not tied to this view: the card may vanish when its last row goes, and the reload must still run.
            Button(AcceleratorsCopy.stop, role: .destructive) { if let vm { Task { await vm.stop(h) } } }
                .accessibilityIdentifier("accelerator-stop-confirm")
        } message: { _ in
            Text(AcceleratorsCopy.stopMessage)
        }
    }

    @ViewBuilder
    private func content(_ vm: AcceleratorsViewModel, c: FSColors) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s3) {
            if let e = vm.loadError, vm.view == nil {
                Text(e).font(FS.font.bodySm()).foregroundColor(c.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("accelerators-load-error")
            }
            if let v = vm.view {
                if v.admissionPaused != nil {
                    Text(AcceleratorsCopy.paused).font(FS.font.bodySm()).foregroundColor(c.warning)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("accelerators-paused")
                }
                if v.devices.isEmpty, v.reason != nil {
                    Text(AcceleratorsCopy.serviceError).font(FS.font.bodySm()).foregroundColor(c.textMuted)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("accelerators-service-error")
                }
                approvals(v, vm: vm, c: c)
                ForEach(v.devices) { d in device(d, vm: vm, c: c) }
                if !v.queue.isEmpty {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(AcceleratorsCopy.waitingTitle).font(FS.font.bodySm().weight(.semibold)).foregroundColor(c.text)
                        ForEach(v.queue) { q in
                            Text(AcceleratorsCopy.waiting(q)).font(FS.font.caption()).foregroundColor(c.textMuted)
                                .accessibilityIdentifier("accelerator-queue-\(q.appId)")
                        }
                    }
                    .accessibilityElement(children: .contain)
                    .accessibilityIdentifier("accelerators-queue")
                }
            }
            if let n = vm.notice {
                Text(n).font(FS.font.bodySm()).foregroundColor(c.success)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("accelerators-notice")
            }
            if let e = vm.error {
                Text(e).font(FS.font.bodySm()).foregroundColor(c.danger)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("accelerators-error")
            }
        }
    }

    /// Apps asking to use a GPU (Approve, Decline) and the approvals in force (Withdraw). Each answer
    /// is a signed order; a device without the admin root sees them read-only.
    @ViewBuilder
    private func approvals(_ v: AcceleratorsView, vm: AcceleratorsViewModel, c: FSColors) -> some View {
        let canSign = AdminOrderGate.allows(app)
        if !vm.pending.isEmpty || !v.approvals.isEmpty {
            VStack(alignment: .leading, spacing: FS.space.s3) {
                ForEach(vm.pending) { r in
                    VStack(alignment: .leading, spacing: FS.space.s2) {
                        Text(AcceleratorsCopy.asks(r)).font(FS.font.bodySm()).foregroundColor(c.warning)
                            .fixedSize(horizontal: false, vertical: true)
                            .accessibilityIdentifier("gpu-approval-ask-\(r.appId)")
                        if canSign {
                            HStack(spacing: FS.space.s2) {
                                FSPrimaryButton(AcceleratorsCopy.approve, enabled: vm.busy == nil) { Task { await vm.approve(r) } }
                                    .accessibilityIdentifier("gpu-approval-approve-\(r.appId)")
                                FSSecondaryButton(AcceleratorsCopy.decline) { Task { await vm.decline(r) } }
                                    .disabled(vm.busy != nil)
                                    .accessibilityIdentifier("gpu-approval-decline-\(r.appId)")
                            }
                        }
                    }
                    .accessibilityElement(children: .contain)
                    .accessibilityIdentifier("gpu-approval-pending-\(r.appId)")
                }
                ForEach(v.approvals) { r in
                    VStack(alignment: .leading, spacing: FS.space.s2) {
                        Text(AcceleratorsCopy.allowed(r)).font(FS.font.bodySm()).foregroundColor(c.text)
                            .fixedSize(horizontal: false, vertical: true)
                            .accessibilityIdentifier("gpu-approval-allowed-\(r.appId)")
                        if canSign {
                            FSSecondaryButton(AcceleratorsCopy.withdraw) { Task { await vm.withdraw(r) } }
                                .disabled(vm.busy != nil)
                                .accessibilityIdentifier("gpu-approval-withdraw-\(r.appId)")
                        }
                    }
                    .accessibilityElement(children: .contain)
                    .accessibilityIdentifier("gpu-approval-granted-\(r.appId)")
                }
                if !canSign {
                    Text(AcceleratorsCopy.adminOnly).font(FS.font.caption()).foregroundColor(c.textMuted)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("gpu-approval-admin-only")
                }
            }
        }
    }

    private func device(_ d: AcceleratorDevice, vm: AcceleratorsViewModel, c: FSColors) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(AcceleratorsCopy.device(d)).font(FS.font.bodySm().weight(.semibold)).foregroundColor(c.text)
                .accessibilityIdentifier("accelerator-name-\(d.id)")
            Text(verbatim: "\(AcceleratorsCopy.memory(d.memoryMiB)) · \(AcceleratorsCopy.state(d.state))")
                .font(FS.font.caption()).foregroundColor(d.state == "quarantined" ? c.warning : c.textMuted)
                .accessibilityIdentifier("accelerator-state-\(d.id)")
            ForEach(d.holders) { h in
                HStack(alignment: .center, spacing: FS.space.s2) {
                    Text(AcceleratorsCopy.holder(h)).font(FS.font.caption()).foregroundColor(c.text)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("accelerator-holder-\(d.id)")
                    Spacer(minLength: FS.space.s2)
                    FSSecondaryButton(AcceleratorsCopy.stop) { stopping = h }
                        .disabled(vm.busy != nil)
                        .accessibilityIdentifier("accelerator-stop-\(h.allocationId)")
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("accelerator-\(d.id)")
    }
}
