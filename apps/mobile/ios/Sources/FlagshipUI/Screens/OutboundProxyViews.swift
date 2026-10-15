import SwiftUI
import FlagshipAPI
import FlagshipCore

/// The proxy fields, shared by the create flow's Advanced section and the
/// server page's edit sheet (docs/outbound-proxy.md).
struct OutboundProxyFieldsView: View {
    @Environment(\.colorScheme) private var scheme
    @Binding var kind: BoxProxy.Kind
    @Binding var host: String
    @Binding var port: String
    @Binding var username: String
    @Binding var password: String
    @Binding var fallbackDirect: Bool
    /// Shown under the fields when set.
    let error: String?
    /// Create flow: warn that typed credentials go into the setup file.
    var credentialsGoInRecipe: Bool = false
    /// Edit sheet: the box already holds a password for this proxy.
    var passwordUnchanged: Bool = false
    /// Offer "None" in the picker (the create flow; the sheet has Turn off).
    var offersNone: Bool = true

    var body: some View {
        let c = FSColors.scheme(scheme)
        VStack(alignment: .leading, spacing: FS.space.s2) {
            Picker(OutboundProxyCopy.title, selection: $kind) {
                ForEach(BoxProxy.Kind.allCases.filter { offersNone || $0 != .none }, id: \.self) { k in
                    Text(k.label).tag(k)
                }
            }
            .pickerStyle(.segmented)
            .accessibilityIdentifier("proxy-kind")
            if kind != .none {
                field(OutboundProxyCopy.address, placeholder: OutboundProxyCopy.addressPlaceholder, text: $host, c: c)
                    .accessibilityIdentifier("proxy-host")
                field(OutboundProxyCopy.port, placeholder: kind.defaultPort.map(String.init) ?? "", text: $port, c: c)
                    .keyboardType(.numberPad)
                    .accessibilityIdentifier("proxy-port")
                field(OutboundProxyCopy.username, placeholder: passwordUnchanged ? OutboundProxyCopy.passwordUnchanged : "",
                      text: $username, c: c)
                    .accessibilityIdentifier("proxy-username")
                VStack(alignment: .leading, spacing: 2) {
                    Text(OutboundProxyCopy.password).font(FS.font.caption()).foregroundColor(c.textMuted)
                    SecureField(passwordUnchanged ? OutboundProxyCopy.passwordUnchanged : "", text: $password)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .padding(FS.space.s3)
                        .background(c.surface)
                        .clipShape(RoundedRectangle(cornerRadius: FS.radius.sm))
                        .accessibilityIdentifier("proxy-password")
                }
                if credentialsGoInRecipe && !(username.isEmpty && password.isEmpty) {
                    Text(OutboundProxyCopy.credentialsInRecipe)
                        .font(FS.font.caption())
                        .foregroundColor(c.warning)
                }
                Toggle(isOn: $fallbackDirect) {
                    Text(OutboundProxyCopy.fallback)
                        .font(.subheadline.weight(.medium))
                        .foregroundColor(c.text)
                }
                .tint(c.primary)
                .accessibilityIdentifier("proxy-fallback")
                if !fallbackDirect {
                    Text(OutboundProxyCopy.fallbackNote)
                        .font(FS.font.caption())
                        .foregroundColor(c.textMuted)
                }
                if let error {
                    Text(error)
                        .font(FS.font.caption())
                        .foregroundColor(c.danger)
                        .accessibilityIdentifier("proxy-error")
                }
            }
        }
    }

    private func field(_ label: String, placeholder: String, text: Binding<String>, c: FSColors) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label).font(FS.font.caption()).foregroundColor(c.textMuted)
            TextField(placeholder, text: text)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .padding(FS.space.s3)
                .background(c.surface)
                .clipShape(RoundedRectangle(cornerRadius: FS.radius.sm))
        }
    }
}

/// The server page's "Outbound proxy" section. Hidden when the box doesn't
/// report one (older daemons).
struct OutboundProxyCard: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.screensClient) private var client
    @Environment(AppState.self) private var app

    let serverDomain: String
    let summary: OutboundProxySummary
    var onRefreshDetail: () async -> Void = {}

    @State private var controller: OutboundProxyController?
    @State private var showSheet = false

    private func ctl() -> OutboundProxyController {
        if let controller { return controller }
        let made = OutboundProxyController(serverDomain: serverDomain, summary: summary, client: client)
        controller = made
        return made
    }

    var body: some View {
        let c = FSColors.scheme(scheme)
        let shown = controller?.summary ?? summary
        VStack(alignment: .leading, spacing: FS.space.s3) {
            Text(OutboundProxyCopy.title.uppercased())
                .font(.system(size: 12, weight: .semibold))
                .tracking(1)
                .foregroundColor(c.textMuted)
            FSCard {
                VStack(alignment: .leading, spacing: FS.space.s2) {
                    Text(OutboundProxyCopy.summaryLine(shown.proxy))
                        .font(FS.font.bodySm())
                        .foregroundColor(c.text)
                        .accessibilityIdentifier("sd-proxy-summary")
                    if let status = OutboundProxyCopy.statusLine(shown.status) {
                        Text(status)
                            .font(FS.font.caption())
                            .foregroundColor(shown.status.state == "ok" ? c.textMuted : c.danger)
                            .accessibilityIdentifier("sd-proxy-status")
                    }
                    if let saved = controller?.savedMessage {
                        Text(saved).font(FS.font.caption()).foregroundColor(c.textMuted)
                    }
                    if let err = controller?.errorMessage, !showSheet {
                        Text(err).font(FS.font.caption()).foregroundColor(c.danger)
                    }
                    if !app.isDemoAccount {
                        HStack(spacing: FS.space.s2) {
                            FSSecondaryButton(OutboundProxyCopy.change) {
                                ctl().beginEdit()
                                showSheet = true
                            }
                            .accessibilityIdentifier("sd-proxy-change")
                            if shown.proxy != nil {
                                FSGhostButton(OutboundProxyCopy.turnOff) {
                                    let vm = ctl()
                                    Task {
                                        if await vm.turnOff() { await onRefreshDetail() }
                                    }
                                }
                                .accessibilityIdentifier("sd-proxy-turn-off")
                            }
                        }
                    }
                }
            }
        }
        .onChange(of: summary) { controller?.update(summary: summary) }
        .sheet(isPresented: $showSheet) {
            NavigationStack {
                OutboundProxySheet(controller: ctl(), onSaved: {
                    showSheet = false
                    Task { await onRefreshDetail() }
                })
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel") { showSheet = false }
                    }
                }
            }
        }
    }
}

private struct OutboundProxySheet: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable var controller: OutboundProxyController
    let onSaved: () -> Void

    var body: some View {
        let c = FSColors.scheme(scheme)
        ScrollView {
            VStack(alignment: .leading, spacing: FS.space.s4) {
                Text(OutboundProxyCopy.explainer)
                    .font(FS.font.caption())
                    .foregroundColor(c.textMuted)
                OutboundProxyFieldsView(
                    kind: $controller.kind,
                    host: $controller.host,
                    port: $controller.port,
                    username: $controller.username,
                    password: $controller.password,
                    fallbackDirect: $controller.fallbackDirect,
                    error: controller.errorMessage ?? controller.fieldError,
                    passwordUnchanged: controller.keepsCredentials,
                    offersNone: false
                )
                FSPrimaryButton(controller.isSaving ? "Saving…" : OutboundProxyCopy.save,
                                enabled: controller.fieldError == nil && !controller.isSaving, block: true) {
                    Task {
                        if await controller.save() { onSaved() }
                    }
                }
                .accessibilityIdentifier("proxy-save")
            }
            .padding(FS.space.s6)
        }
        .background(c.bg.ignoresSafeArea())
        .navigationTitle(OutboundProxyCopy.title)
        .navigationBarTitleDisplayMode(.inline)
    }
}
