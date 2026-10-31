import SwiftUI
import CryptoKit
import FlagshipAPI
import FlagshipCore
import Flagship

/// The server page's dead-man line (issuance-and-lease-records.md section 5): when the server stops
/// serving its apps (or locks) if no admin opens Flagship. Admins tap it (Face ID) to change it.
struct ServingLineCard: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(AppState.self) private var app
    @Environment(\.secretMailboxClient) private var mailbox
    @Environment(\.podScreensClients) private var podClients
    @Environment(ToastCenter.self) private var toasts

    let serverDomain: String
    let serverName: String
    /// server-detail `serving`; nil from an older box (then `.com`'s view is used).
    let serving: ServingView?
    let identityPubKeyHex: String
    var onChanged: () async -> Void = {}

    @State private var comEntry: AccountServingEntry?
    @State private var editor: ServingPolicyEditor?
    @State private var opening = false

    private var isAdmin: Bool { AdminOrderGate.allows(app) && !app.isDemoAccount }

    /// What the line shows: the box's view, else `.com`'s.
    private var view: ServingView? {
        if let serving { return serving }
        guard let e = comEntry else { return nil }
        return ServingView(grace: e.policy?.record.grace ?? e.grace ?? "indefinite",
                           onLapse: e.policy?.record.onLapse ?? e.onLapse ?? "stop-apps",
                           until: e.until, policyGen: e.policy?.record.policyGen ?? 0, regGen: e.regGen,
                           scopeSha256: e.policy?.record.scopeSha256 ?? "")
    }

    private var boxPub: String {
        let k = serving?.boxPub ?? comEntry?.boxPub ?? identityPubKeyHex
        return k.lowercased()
    }

    /// A policy edit needs the scope the box reports and the box's key.
    private var canEdit: Bool {
        guard isAdmin, let v = view else { return false }
        return v.scopeSha256.count == 64 && boxPub.count == 64 && v.regGen >= 1
    }

    var body: some View {
        let c = FSColors.scheme(scheme)
        Group {
            if let v = view {
                FSCard {
                    Button { Task { await open(v) } } label: {
                        HStack(spacing: FS.space.s3) {
                            Image(systemName: v.graceValue == .indefinite ? "infinity" : (v.onLapseValue == .lockServer ? "lock" : "clock"))
                                .foregroundColor(c.textMuted)
                            Text(ServingLineText.line(v, now: Date()))
                                .font(FS.font.body())
                                .foregroundColor(c.text)
                                .multilineTextAlignment(.leading)
                                .accessibilityIdentifier("sd-serving-line")
                            Spacer(minLength: 0)
                            if opening { ProgressView() } else if canEdit {
                                Image(systemName: "chevron.right").foregroundColor(c.textMuted)
                            }
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .disabled(!canEdit || opening)
                    .accessibilityIdentifier("sd-serving-open")
                }
            }
        }
        .task(id: serverDomain) { await loadComView() }
        .sheet(item: $editor) { ed in
            ServingEditorSheet(editor: ed, serverName: serverName) { saved in
                editor = nil
                if saved {
                    toasts.success(String(localized: "Saved."))
                    Task { await onChanged() }
                }
            }
        }
    }

    private func loadComView() async {
        guard serving == nil || boxPub.count != 64, isAdmin, !app.isDemoAccount, let user = app.currentUser, !user.isEmpty else { return }
        comEntry = try? await mailbox.fetchServing(username: user).servers
            .first { $0.serverDomain.lowercased() == serverDomain.lowercased() }
    }

    /// Face ID opens the admin root, then the editor.
    @MainActor
    private func open(_ v: ServingView) async {
        guard canEdit, let user = app.currentUser else { return }
        opening = true
        defer { opening = false }
        let key: Curve25519.Signing.PrivateKey
        do {
            key = try await ServerOrderSaver.adminOrderKey(reason: String(localized: "Change when \(serverName) stops if no admin opens Flagship"))
        } catch {
            if BiometricGate.GateError.from(error) != .userCancelled {
                toasts.error(error is AdminOrderRefused ? AdminOrderGate.server : String(localized: "Couldn't open your account key. Try again."))
            }
            return
        }
        guard let renewer = ServingRenewal.renewer() ?? fallbackRenewer(user) else { return }
        let client = await podClients.client(forFqdn: serverDomain)
        editor = ServingPolicyEditor(
            current: v, username: user, serverDomain: serverDomain, boxPub: boxPub, adminRoot: key,
            mailbox: mailbox, box: client, renewer: renewer,
            bootLock: DiskEncryptionStore().isLuks(for: serverDomain) ? BootLock(client: mailbox) : nil
        )
    }

    private func fallbackRenewer(_ user: String) -> ServingRenewer? {
        let deviceId = app.activeProfile?.deviceId ?? ""
        return ServingRenewer(username: user, mailbox: mailbox, box: { [podClients] d in await podClients.client(forFqdn: d) },
                              deviceKeyPub: { Keystore.sessionAccountDeviceKey(accountId: user, deviceId: deviceId).map { HexUtil.encode($0.publicKey.rawRepresentation) } })
    }
}

/// The words of the line, exactly as section 5 has them.
enum ServingLineText {
    static func date(_ ms: Int64) -> String {
        Date(timeIntervalSince1970: Double(ms) / 1000).formatted(.dateTime.day().month(.abbreviated))
    }

    static func graceLabel(_ g: ServingGrace) -> String {
        switch g {
        case .sevenDays: return String(localized: "7 days")
        case .thirtyDays: return String(localized: "30 days")
        case .indefinite: return String(localized: "Never")
        }
    }

    static func line(_ v: ServingView, now: Date) -> AttributedString {
        switch ServingLine.kind(grace: v.graceValue, onLapse: v.onLapseValue, until: v.until) {
        case .noLimit:
            return AttributedString(localized: "**No time limit**")
        case .staysOnline(let until):
            let d = date(until), g = graceLabel(v.graceValue)
            return AttributedString(localized: "**Stays online until \(d)** if no admin opens Flagship · *\(g)*")
        case .locks(let until):
            let d = date(until), g = graceLabel(v.graceValue)
            return AttributedString(localized: "**Locks on \(d)** if no admin opens Flagship · *\(g)*")
        case .noLease:
            let g = graceLabel(v.graceValue)
            return AttributedString(localized: "**Waiting for an admin to open Flagship** · *\(g)*")
        }
    }
}

/// The editor: how long, and what then. "Never" greys out locking.
struct ServingEditorSheet: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable var editor: ServingPolicyEditor
    let serverName: String
    let onDone: (Bool) -> Void

    var body: some View {
        let c = FSColors.scheme(scheme)
        NavigationStack {
            Form {
                Section {
                    Picker(String(localized: "If no admin opens Flagship for:"), selection: Binding(
                        get: { editor.grace }, set: { editor.setGrace($0) }
                    )) {
                        ForEach(ServingGrace.allCases, id: \.self) { g in
                            Text(ServingLineText.graceLabel(g)).tag(g)
                        }
                    }
                    .pickerStyle(.segmented)
                    .accessibilityIdentifier("serving-grace-picker")
                } header: {
                    Text("If no admin opens Flagship for:")
                }
                Section {
                    choice(.stopApps, String(localized: "Stop serving its apps"), id: "serving-lapse-stop", c: c)
                    choice(.lockServer, String(localized: "Stop its apps and lock the server"), id: "serving-lapse-lock", c: c)
                        .disabled(!editor.canLock)
                } header: {
                    Text("Then:")
                } footer: {
                    Text("Locking restarts the server with its disk locked. It starts again only when an admin approves on their phone.")
                }
                if case .failed(let msg) = editor.phase {
                    Section {
                        Text(msg).foregroundColor(c.danger).accessibilityIdentifier("serving-error")
                    }
                }
            }
            .navigationTitle(serverName)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(String(localized: "Cancel")) { onDone(false) }
                        .accessibilityIdentifier("serving-cancel")
                }
                ToolbarItem(placement: .confirmationAction) {
                    if editor.phase == .saving {
                        ProgressView()
                    } else {
                        Button(String(localized: "Save")) {
                            Task { if await editor.save() { onDone(true) } }
                        }
                        .disabled(!editor.changed)
                        .accessibilityIdentifier("serving-save")
                    }
                }
            }
        }
        .presentationDetents([.medium, .large])
    }

    private func choice(_ value: ServingOnLapse, _ label: String, id: String, c: FSColors) -> some View {
        let on = editor.onLapse == value
        return Button { editor.onLapse = value } label: {
            HStack {
                Image(systemName: on ? "largecircle.fill.circle" : "circle")
                    .foregroundColor(on ? c.accent : c.textMuted)
                Text(label).foregroundColor(editor.canLock || value == .stopApps ? c.text : c.textMuted)
                Spacer()
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier(id)
        .accessibilityAddTraits(on ? .isSelected : [])
    }
}
