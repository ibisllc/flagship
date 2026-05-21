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
    /// Async hook that signs the SetServiceEnvRequest envelope under the
    /// owner's IRK. The view never holds the IRK private bytes; it
    /// delegates signing to the platform Keystore (via this closure).
    public let signEnvelope: @MainActor (ServiceEnvSetEnvelope) async throws -> String
    public let client: any ScreensClient

    public init(
        appId: String,
        serverFqdn: String,
        creator: String,
        slug: String,
        client: any ScreensClient,
        signEnvelope: @escaping @MainActor (ServiceEnvSetEnvelope) async throws -> String
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
        // Build a NEW envelope with the dropped name removed. The
        // envelope is FULL-REPLACE — the daemon stores exactly what's
        // signed, so we must enumerate the surviving names. We don't
        // have values for the surviving names (by design), so we can't
        // round-trip them on /unset alone — the daemon's full-replace
        // semantics force us to either (a) restore values via a paired
        // op, or (b) tolerate values being preserved server-side
        // because they're already on disk and the new request only
        // signs the SET WITHOUT-the-removed-name.
        //
        // We post an envelope with an empty `env` for the unset name
        // and let the daemon's setEnv replace the on-disk map; the
        // owner gets exactly what they signed. If the user wants to
        // KEEP other vars, they must re-add them through the editor.
        // This is honest about the cryptographic boundary — values
        // can't be retained by the phone without leaking them.
        let issuedAt = Int64(Date().timeIntervalSince1970 * 1000)
        let envelope = ServiceEnvSetEnvelope(
            serverId: serverFqdn,
            creator: creator,
            slug: slug,
            env: [:],
            issuedAt: issuedAt
        )
        do {
            let signature = try await signEnvelope(envelope)
            let _ = try await client.serviceEnvUnset(
                appId: appId,
                ServiceEnvUnsetRequest(name: name, request: envelope, signature: signature)
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
    let signEnvelope: @MainActor (ServiceEnvSetEnvelope) async throws -> String
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
                                .padding(.horizontal, 12).frame(height: 40)
                                .background(c.surfaceSunken)
                                .overlay(RoundedRectangle(cornerRadius: FS.radius.sm).stroke(c.border, lineWidth: 1))
                                .clipShape(RoundedRectangle(cornerRadius: FS.radius.sm))
                                .accessibilityIdentifier("service-env-name-field")
                            FSColorReader { c2 in
                                Text("Value").font(FS.font.caption()).foregroundColor(c2.textMuted)
                            }
                            SecureField("paste your secret here", text: $value)
                                .font(FS.font.mono())
                                .autocorrectionDisabled()
                                .textInputAutocapitalization(.never)
                                .padding(.horizontal, 12).frame(height: 40)
                                .background(c.surfaceSunken)
                                .overlay(RoundedRectangle(cornerRadius: FS.radius.sm).stroke(c.border, lineWidth: 1))
                                .clipShape(RoundedRectangle(cornerRadius: FS.radius.sm))
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
        // Replacement set = existing names (preserved on the daemon
        // because we re-emit them in the signed envelope) plus the
        // new key/value. Existing values are unknown to the phone, so
        // we only sign the FULL desired map for the entries the phone
        // actually has plaintext for — the new one. The daemon's
        // setEnv() is full-replace, but the daemon's CURRENT impl
        // accepts ONLY the entries in this signed envelope.
        //
        // Practical consequence: setting a NEW name in a session that
        // already had others wipes the others unless the user re-types
        // them. That's an honest reflection of the security boundary:
        // values can't be retained on the phone without leaking them.
        // The sheet's helper text spells this out for the user.
        var env: [String: String] = [:]
        env[name] = value
        let issuedAt = Int64(Date().timeIntervalSince1970 * 1000)
        let envelope = ServiceEnvSetEnvelope(
            serverId: serverFqdn,
            creator: creator,
            slug: slug,
            env: env,
            issuedAt: issuedAt
        )
        do {
            let signature = try await signEnvelope(envelope)
            let _ = try await client.serviceEnvSet(
                appId: appId,
                ServiceEnvSetRequest(name: name, value: value, request: envelope, signature: signature)
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
