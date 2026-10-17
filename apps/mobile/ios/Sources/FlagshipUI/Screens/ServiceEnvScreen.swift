import SwiftUI
import FlagshipAPI
import FlagshipCore

/// W10 — per-app environment-variable KV editor.
///
/// Shows the NAMES (only) of env vars set on the app, lets the owner
/// add or remove entries. The value is typed locally, signed under
/// the owner's IRK, and POSTed over the daemon's TLS once. The phone
/// NEVER persists the value, NEVER logs it, NEVER shows it after
/// dismissing the editor. The daemon's response is name-only.
@MainActor
public struct ServiceEnvScreen: View {
    @Environment(\.colorScheme) private var scheme
    @State private var names: [String] = []
    @State private var loading: Bool = true
    @State private var errorMessage: String?
    @State private var showAddSheet: Bool = false

    public let appId: String
    public let serverFqdn: String
    public let creator: String
    public let slug: String
    /// Async hook that signs one `ServiceEnvChange` under the owner's IRK. The view never holds the IRK private bytes; it
    /// delegates signing to the platform Keystore (via this closure).
    public let signEnvelope: @MainActor (ServiceEnvChange) async throws -> String
    public let client: any ScreensClient

    public init(
        appId: String,
        serverFqdn: String,
        creator: String,
        slug: String,
        client: any ScreensClient,
        signEnvelope: @escaping @MainActor (ServiceEnvChange) async throws -> String
    ) {
        self.appId = appId
        self.serverFqdn = serverFqdn
        self.creator = creator
        self.slug = slug
        self.client = client
        self.signEnvelope = signEnvelope
    }

    public var body: some View {
        let c = FSColors.scheme(scheme)
        ScrollView {
            VStack(alignment: .leading, spacing: FS.space.s4) {
                explainerCard(c: c)
                listCard(c: c)
                if let msg = errorMessage {
                    ErrorCard(message: msg)
                }
                Spacer().frame(height: FS.space.s12)
            }
            .padding(.horizontal, FS.space.s6)
            .padding(.top, FS.space.s4)
        }
        .background(c.bg.ignoresSafeArea())
        .navigationTitle("Configure environment")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    showAddSheet = true
                } label: {
                    Image(systemName: "plus.circle.fill")
                }
                .accessibilityIdentifier("service-env-add-btn")
            }
        }
        .task { await reload() }
        .sheet(isPresented: $showAddSheet) {
            AddEnvVarSheet(
                appId: appId,
                serverFqdn: serverFqdn,
                creator: creator,
                slug: slug,
                existingNames: names,
                client: client,
                signEnvelope: signEnvelope,
                onCommitted: {
                    showAddSheet = false
                    Task { await reload() }
                },
                onCancel: { showAddSheet = false }
            )
        }
    }

    private func explainerCard(c: FSColors) -> some View {
        FSCard {
            VStack(alignment: .leading, spacing: FS.space.s2) {
                Text("Environment variables").font(FS.font.h4()).foregroundColor(c.text)
                Text("Names appear here; values stay on this server. They're sealed at rest and never leave your pod.")
                    .font(FS.font.bodySm())
                    .foregroundColor(c.textMuted)
            }
        }
    }

    @ViewBuilder
    private func listCard(c: FSColors) -> some View {
        if loading {
            FSCard {
                HStack {
                    ProgressView()
                    Text("Loading…").foregroundColor(c.textMuted)
                }
            }
        } else if names.isEmpty {
            FSCard {
                VStack(alignment: .leading, spacing: FS.space.s2) {
                    Text("No env vars set").font(FS.font.body()).foregroundColor(c.text)
                    Text("Tap the + button to add one.").font(FS.font.bodySm()).foregroundColor(c.textMuted)
                }
            }
        } else {
            FSCard {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(names.enumerated()), id: \.element) { idx, name in
                        envRow(name: name, c: c)
                        if idx < names.count - 1 {
                            Divider().background(c.border)
                        }
                    }
                }
            }
        }
    }

    private func envRow(name: String, c: FSColors) -> some View {
        HStack(spacing: FS.space.s3) {
            Image(systemName: "key.fill").foregroundColor(c.textMuted)
            Text(name)
                .font(FS.font.mono())
                .foregroundColor(c.text)
                .accessibilityIdentifier("service-env-row-\(name)")
            Spacer()
            // The VALUE is not shown — by design. Pull-to-edit pops the
            // add-sheet so the user can re-type (the new value replaces
            // the old; the phone never sees the prior value).
            Button {
                Task { await unset(name: name) }
            } label: {
                Image(systemName: "trash").foregroundColor(c.danger)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Remove \(name)")
            .accessibilityIdentifier("service-env-remove-\(name)")
        }
        .padding(.vertical, FS.space.s3)
        .padding(.horizontal, FS.space.s2)
    }

    private func reload() async {
        loading = true
        errorMessage = nil
        defer { loading = false }
        do {
            let r = try await client.serviceEnvList(appId: appId)
            names = r.names
        } catch {
            errorMessage = String(describing: error)
        }
    }

    private func unset(name: String) async {
        // The signed change names this one variable, so the others stay.
        let change = ServiceEnvChange.make(serverId: serverFqdn, serviceId: appId, unset: name)
        do {
            let signature = try await signEnvelope(change)
            let _ = try await client.serviceEnvUnset(
                appId: appId,
                ServiceEnvUnsetRequest(change: change, signature: signature)
            )
            await reload()
        } catch {
            errorMessage = String(describing: error)
        }
    }
}

/// Modal text-entry sheet for a single NAME + VALUE pair. The value is
/// kept in @State only for the lifetime of the sheet — dismissing
/// drops it. The send path POSTs once over TLS to the daemon and
/// never echoes the value back.
@MainActor
private struct AddEnvVarSheet: View {
    @Environment(\.colorScheme) private var scheme
    @State private var name: String = ""
    @State private var value: String = ""
    @State private var submitting: Bool = false
    @State private var errorMessage: String?

    let appId: String
    let serverFqdn: String
    let creator: String
    let slug: String
    let existingNames: [String]
    let client: any ScreensClient
    let signEnvelope: @MainActor (ServiceEnvChange) async throws -> String
    let onCommitted: () -> Void
    let onCancel: () -> Void

    var body: some View {
        let c = FSColors.scheme(scheme)
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: FS.space.s4) {
                    FSCard {
                        VStack(alignment: .leading, spacing: FS.space.s3) {
                            FSColorReader { c2 in
                                Text("Name").font(FS.font.caption()).foregroundColor(c2.textMuted)
                            }
                            TextField("e.g. OPENAI_API_KEY", text: $name)
                                .font(FS.font.mono())
                                .autocorrectionDisabled()
                                .textInputAutocapitalization(.never)
                                .padding(.horizontal, 12).frame(minHeight: 44)
                                .background(c.surfaceSunken)
                                .overlay(RoundedRectangle(cornerRadius: FS.radius.sm, style: .continuous).stroke(c.border, lineWidth: 1))
                                .clipShape(RoundedRectangle(cornerRadius: FS.radius.sm, style: .continuous))
                                .accessibilityIdentifier("service-env-name-field")
                            FSColorReader { c2 in
                                Text("Value").font(FS.font.caption()).foregroundColor(c2.textMuted)
                            }
                            SecureField("paste your secret here", text: $value)
                                .font(FS.font.mono())
                                .autocorrectionDisabled()
                                .textInputAutocapitalization(.never)
                                .padding(.horizontal, 12).frame(minHeight: 44)
                                .background(c.surfaceSunken)
                                .overlay(RoundedRectangle(cornerRadius: FS.radius.sm, style: .continuous).stroke(c.border, lineWidth: 1))
                                .clipShape(RoundedRectangle(cornerRadius: FS.radius.sm, style: .continuous))
                                .accessibilityIdentifier("service-env-value-field")
                            Text("The value is sent once to your server. The Flagship phone app does not save it.")
                                .font(FS.font.caption())
                                .foregroundColor(c.textMuted)
                        }
                    }
                    if let msg = errorMessage {
                        ErrorCard(message: msg)
                    }
                    FSPrimaryButton(
                        submitting ? "Sending…" : "Save",
                        enabled: !submitting && !name.isEmpty && !value.isEmpty,
                        block: true
                    ) {
                        Task { await submit() }
                    }
                    .accessibilityIdentifier("service-env-save-btn")
                    Spacer().frame(height: FS.space.s12)
                }
                .padding(.horizontal, FS.space.s6)
                .padding(.top, FS.space.s4)
            }
            .background(c.bg.ignoresSafeArea())
            .navigationTitle("New environment variable")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancel", role: .cancel) { onCancel() }
                }
            }
        }
    }

    private func submit() async {
        submitting = true
        errorMessage = nil
        defer { submitting = false }
        // One signed change naming this variable and its value's SHA-256; the
        // box keeps every other variable as it is.
        if let why = ServiceEnvChange.nameError(name) {
            errorMessage = why
            return
        }
        let change = ServiceEnvChange.make(serverId: serverFqdn, serviceId: appId, set: name, value: value)
        do {
            let signature = try await signEnvelope(change)
            let _ = try await client.serviceEnvSet(
                appId: appId,
                ServiceEnvSetRequest(change: change, value: value, signature: signature)
            )
            // Drop the in-memory value so a screenshot/snapshot of the
            // dismissed sheet doesn't expose it.
            value = ""
            onCommitted()
        } catch {
            errorMessage = String(describing: error)
        }
    }
}
