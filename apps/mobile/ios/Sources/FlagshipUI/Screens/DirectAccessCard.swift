import SwiftUI
import FlagshipAPI
import FlagshipCore

/// The server page's "Direct access" section (docs/direct-access-and-domains.md):
/// opt in with the privacy warning, then one direct name per app with its state
/// and the outside check. Read-only on a device without the admin root. Hidden
/// on a box that doesn't serve direct access.
struct DirectAccessCard: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.screensClient) private var box
    @Environment(\.directNamesClient) private var com
    @Environment(AppState.self) private var app

    let serverDomain: String

    @State private var vm: DirectAccessViewModel?
    @State private var confirmOff = false

    var body: some View {
        let c = FSColors.scheme(scheme)
        Group {
            if let vm, !vm.supported {
                EmptyView()
            } else {
                VStack(alignment: .leading, spacing: FS.space.s3) {
                    FSSectionLabel(String(localized: "Direct access"))
                    FSCard {
                        if let vm, vm.loaded {
                            content(vm, c: c)
                        } else {
                            ProgressView()
                        }
                    }
                }
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("sd-direct-access")
            }
        }
        .task(id: serverDomain) {
            let made = DirectAccessViewModel(serverDomain: serverDomain, username: app.currentUser ?? "", box: box, com: com,
                                             canManage: AdminOrderGate.allows(app))
            vm = made
            await made.load()
        }
        .confirmationDialog("Turn off direct access?", isPresented: $confirmOff, titleVisibility: .visible) {
            Button("Turn off", role: .destructive) { Task { await vm?.turnOff() } }
                .accessibilityIdentifier("sd-direct-access-confirm-off")
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Its names stop pointing at this server. The address stays in public DNS history.")
        }
        .sheet(isPresented: Binding(get: { vm?.nameDraft != nil }, set: { if !$0 { vm?.nameDraft = nil } })) {
            if let vm { DirectNameSheet(vm: vm) }
        }
    }

    @ViewBuilder
    private func content(_ vm: DirectAccessViewModel, c: FSColors) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s3) {
            if vm.isOn {
                Text("On. Visitors can reach this server's apps directly, without the relay.")
                    .font(FS.font.bodySm().weight(.semibold))
                    .foregroundColor(c.text)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("sd-direct-access-state")
                addressLines(vm, c: c)
            } else {
                Text("Off. Visitors reach this server's apps through the relay.")
                    .font(FS.font.bodySm())
                    .foregroundColor(c.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("sd-direct-access-state")
            }

            if !vm.canManage {
                Text(DirectAccessViewModel.adminOnly)
                    .font(FS.font.caption())
                    .foregroundColor(c.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("sd-direct-access-admin-only")
            } else if vm.editing {
                form(vm, c: c)
            } else {
                HStack(spacing: FS.space.s2) {
                    FSPrimaryButton(vm.isOn ? String(localized: "Change") : String(localized: "Turn on")) { vm.startEditing() }
                        .accessibilityIdentifier(vm.isOn ? "sd-direct-access-change" : "sd-direct-access-on")
                    if vm.isOn {
                        FSDangerButton(String(localized: "Turn off")) { confirmOff = true }
                            .disabled(vm.busy)
                            .accessibilityIdentifier("sd-direct-access-off")
                    }
                }
            }

            if vm.isOn || vm.rows.contains(where: { $0.state != nil }) {
                Divider().background(c.border)
                names(vm, c: c)
            }

            if let e = vm.error {
                Text(e)
                    .font(FS.font.caption())
                    .foregroundColor(c.danger)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("sd-direct-access-error")
            } else if let n = vm.notice {
                Text(n)
                    .font(FS.font.caption())
                    .foregroundColor(c.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("sd-direct-access-notice")
            }
        }
    }

    @ViewBuilder
    private func addressLines(_ vm: DirectAccessViewModel, c: FSColors) -> some View {
        if !vm.addresses.isEmpty {
            Text("Addresses: \(vm.addresses.joined(separator: ", "))")
                .font(FS.font.caption()).foregroundColor(c.textMuted)
                .accessibilityIdentifier("sd-direct-access-addresses")
        }
        if !vm.prefixes.isEmpty {
            Text("Address ranges: \(vm.prefixes.joined(separator: ", "))")
                .font(FS.font.caption()).foregroundColor(c.textMuted)
        }
        if !vm.reported.isEmpty {
            Text("This server reports: \(vm.reported.joined(separator: ", "))")
                .font(FS.font.caption()).foregroundColor(c.textMuted)
        }
    }

    @ViewBuilder
    private func form(_ vm: DirectAccessViewModel, c: FSColors) -> some View {
        @Bindable var vm = vm
        VStack(alignment: .leading, spacing: FS.space.s3) {
            Text(DirectAccessViewModel.warning)
                .font(FS.font.caption().weight(.semibold))
                .foregroundColor(c.danger)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("sd-direct-access-warning")
            Text("Public addresses (an IPv4 forwarded on your router, or a fixed IPv6), one per line")
                .font(FS.font.caption()).foregroundColor(c.textMuted)
            TextField("81.2.69.142", text: $vm.addressesText, axis: .vertical)
                .font(.caption.monospaced())
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .lineLimit(1...4)
                .fsInputBox()
                .accessibilityIdentifier("sd-direct-access-addresses-field")
            Text("Address ranges this server may report its own address in (optional)")
                .font(FS.font.caption()).foregroundColor(c.textMuted)
            TextField("2a02:8010:6400::/48", text: $vm.prefixesText, axis: .vertical)
                .font(.caption.monospaced())
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .lineLimit(1...3)
                .fsInputBox()
                .accessibilityIdentifier("sd-direct-access-prefixes-field")
            Text("Port").font(FS.font.caption()).foregroundColor(c.textMuted)
            TextField("443", text: $vm.portText)
                .font(.caption.monospaced())
                .keyboardType(.numberPad)
                .fsInputBox()
                .accessibilityIdentifier("sd-direct-access-port-field")
            HStack(spacing: FS.space.s2) {
                FSPrimaryButton(vm.busy ? String(localized: "Signing…") : (vm.isOn ? String(localized: "Save") : String(localized: "Turn on")),
                                enabled: !vm.busy) {
                    Task { await vm.saveAccess() }
                }
                .accessibilityIdentifier("sd-direct-access-submit")
                FSGhostButton(String(localized: "Cancel")) { vm.editing = false }
                    .accessibilityIdentifier("sd-direct-access-cancel")
            }
        }
    }

    @ViewBuilder
    private func names(_ vm: DirectAccessViewModel, c: FSColors) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s3) {
            Text("Direct names")
                .font(FS.font.bodySm().weight(.semibold))
                .foregroundColor(c.text)
            Text("One name per app on fshp.app. Visitors go straight to this server and the relay never carries it.")
                .font(FS.font.caption()).foregroundColor(c.textMuted)
                .fixedSize(horizontal: false, vertical: true)
            if vm.rows.isEmpty {
                Text("No apps on this server yet.")
                    .font(FS.font.caption()).foregroundColor(c.textMuted)
            }
            ForEach(vm.rows) { row in
                nameRow(vm, row, c: c)
            }
        }
    }

    @ViewBuilder
    private func nameRow(_ vm: DirectAccessViewModel, _ row: DirectAccessViewModel.Row, c: FSColors) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s1) {
            Text(row.appName).font(FS.font.bodySm().weight(.semibold)).foregroundColor(c.text)
            if let fqdn = row.fqdn {
                Text(fqdn)
                    .font(FS.font.mono())
                    .foregroundColor(c.text)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .textSelection(.enabled)
                if let s = row.state {
                    Text(DirectAccessText.state(s))
                        .font(FS.font.caption())
                        .foregroundColor(s.isPublished ? c.text : c.textMuted)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("sd-direct-name-state-\(row.serviceId)")
                    if s.state == "pending", let why = DirectAccessText.reason(s.reason) {
                        Text(why).font(FS.font.caption()).foregroundColor(c.textMuted)
                    }
                    if s.caa == "off" {
                        Text("Any host may get a certificate for this name (CAA off).")
                            .font(FS.font.caption()).foregroundColor(c.textMuted)
                    }
                    if !s.addresses.isEmpty {
                        Text("Points at: \(s.addresses.joined(separator: ", "))")
                            .font(FS.font.caption()).foregroundColor(c.textMuted)
                    }
                    if let p = s.probe {
                        Text(DirectAccessViewModel.probeLine(p))
                            .font(FS.font.caption())
                            .foregroundColor(p.reachable == false ? c.danger : c.textMuted)
                            .fixedSize(horizontal: false, vertical: true)
                            .accessibilityIdentifier("sd-direct-name-probe-\(row.serviceId)")
                    }
                } else {
                    Text("Not turned on")
                        .font(FS.font.caption()).foregroundColor(c.textMuted)
                        .accessibilityIdentifier("sd-direct-name-state-\(row.serviceId)")
                }
                HStack(spacing: FS.space.s2) {
                    if vm.canManage {
                        if row.isOn {
                            FSGhostButton(String(localized: "Settings")) { vm.editName(row) }
                                .accessibilityIdentifier("sd-direct-name-edit-\(row.serviceId)")
                            FSGhostButton(String(localized: "Turn off")) { Task { await vm.turnOffName(row) } }
                                .accessibilityIdentifier("sd-direct-name-off-\(row.serviceId)")
                        } else if vm.isOn {
                            FSGhostButton(String(localized: "Turn on")) { Task { await vm.turnOnName(row) } }
                                .disabled(vm.busy)
                                .accessibilityIdentifier("sd-direct-name-on-\(row.serviceId)")
                        }
                    }
                    if row.state?.isPublished == true {
                        FSGhostButton(String(localized: "Check from outside")) { Task { await vm.probe(row) } }
                            .disabled(vm.busy)
                            .accessibilityIdentifier("sd-direct-name-probe-btn-\(row.serviceId)")
                    }
                }
            } else {
                Text(DirectAccessViewModel.otherCreator)
                    .font(FS.font.caption()).foregroundColor(c.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("sd-direct-name-\(row.serviceId)")
    }
}

/// A direct name's settings: the CAA switch and other addresses.
struct DirectNameSheet: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable var vm: DirectAccessViewModel

    var body: some View {
        let c = FSColors.scheme(scheme)
        NavigationStack {
            ScrollView {
                if let draft = vm.nameDraft {
                    VStack(alignment: .leading, spacing: FS.space.s4) {
                        Text(draft.fqdn).font(FS.font.mono()).foregroundColor(c.text)
                        Toggle(isOn: Binding(get: { vm.nameDraft?.pinCaa ?? true }, set: { vm.nameDraft?.pinCaa = $0 })) {
                            Text("Only this server can get a certificate (CAA)")
                                .font(FS.font.bodySm()).foregroundColor(c.text)
                        }
                        .accessibilityIdentifier("sd-direct-name-caa")
                        Text("Turn this off only if the name points at a host that gets its own certificate.")
                            .font(FS.font.caption()).foregroundColor(c.textMuted)
                            .fixedSize(horizontal: false, vertical: true)
                        Text("Point at other addresses (optional). Leave empty to follow this server's addresses.")
                            .font(FS.font.caption()).foregroundColor(c.textMuted)
                            .fixedSize(horizontal: false, vertical: true)
                        TextField("203.0.114.7", text: Binding(get: { vm.nameDraft?.addressesText ?? "" }, set: { vm.nameDraft?.addressesText = $0 }),
                                  axis: .vertical)
                            .font(.caption.monospaced())
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .lineLimit(1...4)
                            .fsInputBox()
                            .accessibilityIdentifier("sd-direct-name-addresses")
                        if let e = vm.error {
                            Text(e).font(FS.font.caption()).foregroundColor(c.danger)
                                .fixedSize(horizontal: false, vertical: true)
                                .accessibilityIdentifier("sd-direct-name-error")
                        }
                        FSPrimaryButton(vm.busy ? String(localized: "Signing…") : String(localized: "Save"), enabled: !vm.busy) {
                            Task { await vm.saveNameDraft() }
                        }
                        .accessibilityIdentifier("sd-direct-name-save")
                    }
                    .padding(FS.space.s6)
                }
            }
            .background(c.bg.ignoresSafeArea())
            .navigationTitle(String(localized: "Direct name"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { vm.nameDraft = nil }
                }
            }
        }
    }
}

/// On an app's page, once its direct name is published: which link to share,
/// the direct one (straight to the server) or the relay one.
struct DirectLinkShareGroup: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.directNamesClient) private var com

    let username: String
    let slug: String
    let creator: String
    /// The relay address (canonical), shared when the owner picks the relay.
    let relayUrl: String?

    enum Choice: String, CaseIterable, Identifiable {
        case direct, relay
        var id: String { rawValue }
    }

    @State private var published: String?
    @State private var choice: Choice = .direct

    static func directName(state: DirectAccountState?, slug: String, creator: String, username: String) -> String? {
        guard creator.lowercased() == username.lowercased(), let state,
              let fqdn = DirectName.derivedName(slug: slug, creator: creator, apex: state.apex),
              state.name(fqdn)?.isPublished == true else { return nil }
        return fqdn
    }

    var body: some View {
        let c = FSColors.scheme(scheme)
        Group {
            if let published {
                let url = choice == .direct || relayUrl == nil ? "https://\(published)" : (relayUrl ?? "")
                VStack(alignment: .leading, spacing: FS.space.s2) {
                    FSSectionLabel(String(localized: "Link to share"))
                    Picker("Link to share", selection: $choice) {
                        Text("Direct").tag(Choice.direct)
                        Text("Through the relay").tag(Choice.relay)
                    }
                    .pickerStyle(.segmented)
                    .accessibilityIdentifier("app-direct-link-choice")
                    Text(choice == .direct
                         ? String(localized: "Goes straight to your server and uses none of your relay data. It works only while your server can be reached from outside.")
                         : String(localized: "Goes through the Flagship relay. It works even when your server can't be reached from outside."))
                        .font(FS.font.caption()).foregroundColor(c.textMuted)
                        .fixedSize(horizontal: false, vertical: true)
                    Text(url.replacingOccurrences(of: "https://", with: ""))
                        .font(FS.font.mono()).foregroundColor(c.text)
                        .textSelection(.enabled)
                        .accessibilityIdentifier("app-direct-link-url")
                    if let link = URL(string: url) {
                        ShareLink(item: link) {
                            Label(String(localized: "Share link"), systemImage: "square.and.arrow.up")
                                .font(FS.font.bodySm().weight(.semibold))
                        }
                        .accessibilityIdentifier("app-direct-link-share")
                    }
                }
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("app-direct-link")
            } else {
                Color.clear.frame(height: 0)
            }
        }
        .task(id: "\(slug)--\(creator)") {
            let state = try? await com.state(username: username)
            published = Self.directName(state: state, slug: slug, creator: creator, username: username)
        }
    }
}
