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

/// "An outbound proxy is part of Pro." with a link to the Pro page, shown to
/// Free accounts instead of the fields.
struct OutboundProxyProNote: View {
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let c = FSColors.scheme(scheme)
        VStack(alignment: .leading, spacing: 2) {
            Text(OutboundProxyCopy.proNote)
                .font(FS.font.caption())
                .foregroundColor(c.textMuted)
            Link(OutboundProxyCopy.seePro, destination: OutboundProxyCopy.proUrl)
                .font(FS.font.caption())
        }
        .accessibilityIdentifier("proxy-pro")
    }
}

/// The server page's loud proxy line (docs/outbound-proxy.md "Failure UX"): red while the proxy fails (and, when
/// the server can't be reached, that it stays offline until the proxy is fixed), a warning while it connects around it.
struct OutboundProxyAlertBanner: View {
    @Environment(\.colorScheme) private var scheme
    let state: String
    let code: String?
    let offline: Bool

    var body: some View {
        let c = FSColors.scheme(scheme)
        if let line = OutboundProxyCopy.alertLine(state: state, code: code) {
            let failing = state == "failing"
            VStack(alignment: .leading, spacing: FS.space.s1) {
                Label(line, systemImage: failing ? "exclamationmark.octagon.fill" : "exclamationmark.triangle.fill")
                    .font(FS.font.bodySm().weight(.semibold))
                    .foregroundColor(failing ? c.danger : c.warning)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("sd-proxy-alert")
                if failing && offline {
                    Text(OutboundProxyCopy.offlineUntilFixed)
                        .font(FS.font.caption())
                        .foregroundColor(c.danger)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("sd-proxy-alert-offline")
                }
            }
            .padding(FS.space.s3)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background((failing ? c.dangerWash : c.warningWash))
            .clipShape(RoundedRectangle(cornerRadius: FS.radius.md, style: .continuous))
            .accessibilityElement(children: .contain)
        }
    }
}

/// The proxy each server last reported (no secrets: kind, host, port, flags), so the page can still offer
/// "keep the password" through `.com`'s lane while the box is offline.
enum OutboundProxyLastKnown {
    private static func key(_ fqdn: String) -> String { "flagship.outboundProxy.lastKnown.\(fqdn.lowercased())" }
    static func save(_ s: OutboundProxySummary, fqdn: String) {
        if let d = try? JSONEncoder().encode(s) { UserDefaults.standard.set(d, forKey: key(fqdn)) }
    }
    static func load(fqdn: String) -> OutboundProxySummary? {
        UserDefaults.standard.data(forKey: key(fqdn)).flatMap { try? JSONDecoder().decode(OutboundProxySummary.self, from: $0) }
    }
}

/// The server page's "Outbound proxy" section. Hidden when the box doesn't
/// report one (older daemons). With `boxUnreachable` (the box's proxy keeps it
/// offline) changes go through `.com`'s lane.
struct OutboundProxyCard: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.screensClient) private var client
    @Environment(\.flagshipServerClient) private var serverClient
    @Environment(AppState.self) private var app

    let serverDomain: String
    let summary: OutboundProxySummary
    var boxUnreachable: Bool = false
    var onRefreshDetail: () async -> Void = {}

    @State private var controller: OutboundProxyController?
    @State private var showSheet = false

    private func ctl() -> OutboundProxyController {
        if let controller { return controller }
        let made = OutboundProxyController(serverDomain: serverDomain, summary: summary, client: client,
                                           lane: serverClient, boxUnreachable: boxUnreachable)
        controller = made
        return made
    }

    var body: some View {
        let c = FSColors.scheme(scheme)
        let shown = controller?.summary ?? summary
        // The box says `available: false` once .com has told it the account is
        // on Free: no new proxy, but one already set can still be turned off.
        let pro = shown.available != false
        // Offline, a proxy is set even when this phone never saw which one.
        let hasProxy = shown.proxy != nil || boxUnreachable
        VStack(alignment: .leading, spacing: FS.space.s3) {
            Text(OutboundProxyCopy.title.uppercased())
                .font(.system(size: 12, weight: .semibold))
                .tracking(1)
                .foregroundColor(c.textMuted)
            FSCard {
                VStack(alignment: .leading, spacing: FS.space.s2) {
                    if shown.proxy != nil || !boxUnreachable {
                        Text(OutboundProxyCopy.summaryLine(shown.proxy))
                            .font(FS.font.bodySm())
                            .foregroundColor(c.text)
                            .accessibilityIdentifier("sd-proxy-summary")
                    }
                    if !boxUnreachable, let status = OutboundProxyCopy.statusLine(shown.status) {
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
                    if !pro {
                        OutboundProxyProNote()
                    }
                    if !app.isDemoAccount && (pro || hasProxy) {
                        HStack(spacing: FS.space.s2) {
                            if pro {
                                FSSecondaryButton(OutboundProxyCopy.change) {
                                    ctl().beginEdit()
                                    showSheet = true
                                }
                                .accessibilityIdentifier("sd-proxy-change")
                            }
                            if hasProxy {
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
        .onChange(of: boxUnreachable) { controller?.boxUnreachable = boxUnreachable }
        .onAppear { if !boxUnreachable { OutboundProxyLastKnown.save(summary, fqdn: serverDomain) } }
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
                FSPrimaryButton(controller.isSaving ? String(localized: "Saving…") : OutboundProxyCopy.save,
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
