import SwiftUI
import FlagshipAPI
import FlagshipCore

/// "Debug access is on until <time>." at the top of the server page.
struct DebugAccessBanner: View {
    @Environment(\.colorScheme) private var scheme
    let expiresAt: Int64

    var body: some View {
        let c = FSColors.scheme(scheme)
        HStack(alignment: .top, spacing: FS.space.s2) {
            Image(systemName: "terminal.fill")
                .foregroundColor(c.danger)
            Text(DebugAccessViewModel.banner(expiresAt: expiresAt))
                .font(FS.font.bodySm().weight(.semibold))
                .foregroundColor(c.text)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(FS.space.s3)
        .background(RoundedRectangle(cornerRadius: FS.radius.md, style: .continuous).fill(c.danger.opacity(0.12)))
        .overlay(RoundedRectangle(cornerRadius: FS.radius.md, style: .continuous).stroke(c.danger.opacity(0.5), lineWidth: 1))
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("sd-debug-access-banner")
    }
}

/// The server page's "Debug access" section (docs/recipe-delivery-and-remote-install.md
/// "Debug access"): turn on, renew, turn off on an admin device; read-only elsewhere.
struct DebugAccessCard: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.screensClient) private var client

    let serverDomain: String
    let view: DebugAccessView?
    var onChanged: () async -> Void = {}

    @State private var vm: DebugAccessViewModel?
    @State private var editing = false
    @State private var confirmOff = false

    var body: some View {
        let c = FSColors.scheme(scheme)
        VStack(alignment: .leading, spacing: FS.space.s3) {
            FSSectionLabel(String(localized: "Debug access"))
            FSCard {
                if let vm {
                    content(vm, c: c)
                } else {
                    ProgressView()
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("sd-debug-access")
        .task(id: serverDomain) {
            vm = DebugAccessViewModel(serverDomain: serverDomain, view: view, client: client, onChanged: onChanged)
        }
        .onChange(of: view) { vm?.adopt(view) }
        .confirmationDialog("Turn off debug access?", isPresented: $confirmOff, titleVisibility: .visible) {
            Button("Turn off", role: .destructive) {
                Task { await vm?.turnOff() }
            }
            .accessibilityIdentifier("sd-debug-access-confirm-off")
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("The key stops working at once and its sessions on the server end.")
        }
    }

    @ViewBuilder
    private func content(_ vm: DebugAccessViewModel, c: FSColors) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s3) {
            if vm.isOn {
                Text(vm.bannerText ?? "")
                    .font(FS.font.bodySm().weight(.semibold))
                    .foregroundColor(c.text)
                    .accessibilityIdentifier("sd-debug-access-state")
                if let fp = vm.view.keyFingerprint {
                    Text("Key \(fp)")
                        .font(FS.font.mono())
                        .foregroundColor(c.textMuted)
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .accessibilityIdentifier("sd-debug-access-key")
                }
                Text(vm.view.grantedBy == "owner-key" ? String(localized: "Turned on with this account's key.") : "Turned on by an admin device.")
                    .font(FS.font.caption())
                    .foregroundColor(c.textMuted)
            } else {
                Text("Off. Turn it on to let one SSH key into this server as the debug user for a while.")
                    .font(FS.font.bodySm())
                    .foregroundColor(c.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("sd-debug-access-state")
            }

            if !vm.canManage {
                Text(DebugAccessViewModel.adminOnly)
                    .font(FS.font.caption())
                    .foregroundColor(c.textMuted)
                    .accessibilityIdentifier("sd-debug-access-admin-only")
            } else if editing {
                form(vm, c: c)
            } else {
                HStack(spacing: FS.space.s2) {
                    FSPrimaryButton(vm.isOn ? String(localized: "Renew") : String(localized: "Turn on")) { editing = true }
                        .accessibilityIdentifier(vm.isOn ? "sd-debug-access-renew" : "sd-debug-access-on")
                    if vm.isOn {
                        FSDangerButton(String(localized: "Turn off")) { confirmOff = true }
                            .disabled(vm.busy)
                            .accessibilityIdentifier("sd-debug-access-off")
                    }
                }
            }
            if let e = vm.error {
                Text(e)
                    .font(FS.font.caption())
                    .foregroundColor(c.danger)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("sd-debug-access-error")
            } else if let n = vm.notice {
                Text(n)
                    .font(FS.font.caption())
                    .foregroundColor(c.textMuted)
                    .accessibilityIdentifier("sd-debug-access-notice")
            }
        }
    }

    @ViewBuilder
    private func form(_ vm: DebugAccessViewModel, c: FSColors) -> some View {
        @Bindable var vm = vm
        VStack(alignment: .leading, spacing: FS.space.s3) {
            TextField("SSH public key (ssh-ed25519 AAAA…)", text: $vm.keyText, axis: .vertical)
                .font(.caption.monospaced())
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .lineLimit(1...4)
                .fsInputBox()
                .accessibilityIdentifier("sd-debug-access-key-field")
            Picker("For", selection: $vm.duration) {
                ForEach(DebugAccess.Duration.allCases) { d in
                    Text(d.label).tag(d)
                }
            }
            .pickerStyle(.segmented)
            .accessibilityIdentifier("sd-debug-access-duration")
            Text(DebugAccessViewModel.warning)
                .font(FS.font.caption().weight(.semibold))
                .foregroundColor(c.danger)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("sd-debug-access-warning")
            HStack(spacing: FS.space.s2) {
                FSPrimaryButton(vm.busy ? String(localized: "Signing…") : (vm.isOn ? String(localized: "Renew") : String(localized: "Turn on")), enabled: !vm.busy) {
                    Task {
                        await vm.turnOn()
                        if vm.error == nil { editing = false }
                    }
                }
                .accessibilityIdentifier("sd-debug-access-submit")
                FSGhostButton(String(localized: "Cancel")) { editing = false }
                    .accessibilityIdentifier("sd-debug-access-cancel")
            }
        }
    }
}
