import SwiftUI
import UniformTypeIdentifiers
import FlagshipAPI
import FlagshipCore

/// "API keys" on an app's page: each key's label, scope, dates and Revoke,
/// plus Create key.
struct ApiKeysSection: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable var controller: AppApiKeysController
    @State private var showCreate = false
    @State private var confirmRevoke: AppApiKey?

    var body: some View {
        let c = FSColors.scheme(scheme)
        VStack(alignment: .leading, spacing: FS.space.s3) {
            Text(AppApiKeysCopy.sectionTitle).font(.system(size: 12, weight: .semibold)).tracking(1)
                .foregroundColor(c.textMuted)
            FSCard {
                VStack(alignment: .leading, spacing: FS.space.s3) {
                    Text(AppApiKeysCopy.intro)
                        .font(FS.font.bodySm()).foregroundColor(c.textMuted)
                        .fixedSize(horizontal: false, vertical: true)
                    switch controller.state {
                    case .idle, .loading:
                        ProgressView()
                    case .failed(let msg):
                        Text(msg).font(FS.font.bodySm()).foregroundColor(c.danger)
                            .fixedSize(horizontal: false, vertical: true)
                    case .loaded(let keys):
                        if keys.isEmpty {
                            Text(AppApiKeysCopy.empty).font(FS.font.bodySm()).foregroundColor(c.text)
                                .accessibilityIdentifier("service-detail-api-keys-empty")
                        }
                        ForEach(keys) { key in keyRow(key, c: c) }
                        if let err = controller.errorMessage {
                            Text(err).font(FS.font.bodySm()).foregroundColor(c.danger)
                                .fixedSize(horizontal: false, vertical: true)
                                .accessibilityIdentifier("service-detail-api-keys-error")
                        }
                        if controller.canChange {
                            FSSecondaryButton(AppApiKeysCopy.create, block: true) { showCreate = true }
                                .accessibilityIdentifier("service-detail-api-keys-create")
                        } else {
                            Text(AppApiKeysCopy.readOnlyNote)
                                .font(FS.font.caption()).foregroundColor(c.textMuted)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("service-detail-api-keys")
        .sheet(isPresented: $showCreate, onDismiss: { controller.dismissCreatedKey() }) {
            ApiKeyCreateSheet(controller: controller) { showCreate = false }
        }
        .confirmationDialog(
            confirmRevoke.map { AppApiKeysCopy.revokeTitle($0.label) } ?? "",
            isPresented: Binding(get: { confirmRevoke != nil }, set: { if !$0 { confirmRevoke = nil } }),
            titleVisibility: .visible,
            presenting: confirmRevoke
        ) { key in
            Button("Revoke key", role: .destructive) {
                Task { await controller.revoke(keyId: key.keyId) }
            }
            Button("Cancel", role: .cancel) {}
        } message: { _ in
            Text(AppApiKeysCopy.revokeMessage)
        }
    }

    private func keyRow(_ key: AppApiKey, c: FSColors) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s2) {
            Divider()
            HStack(alignment: .top, spacing: FS.space.s3) {
                Image(systemName: "key.horizontal").foregroundColor(key.isExpired() ? c.textMuted : c.primary)
                VStack(alignment: .leading, spacing: 2) {
                    Text(key.label.isEmpty ? key.keyId : key.label)
                        .font(FS.font.bodySm().weight(.semibold)).foregroundColor(c.text)
                        .fixedSize(horizontal: false, vertical: true)
                    Text(AppApiKeysCopy.details(key))
                        .font(FS.font.caption()).foregroundColor(c.textMuted)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
                if controller.canChange {
                    let busy = controller.revokingKeyId == key.keyId
                    Button(busy ? "Revoking…" : "Revoke") { confirmRevoke = key }
                        .font(FS.font.bodySm().weight(.semibold))
                        .foregroundColor(c.danger)
                        .disabled(controller.revokingKeyId != nil)
                        .accessibilityIdentifier("service-detail-api-key-revoke")
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("service-detail-api-key-row")
    }
}

/// Create key: name and scope, then Face ID; afterwards the key,
/// shown once, with Copy.
struct ApiKeyCreateSheet: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable var controller: AppApiKeysController
    let onClose: () -> Void
    @State private var label = ""
    @State private var scope: AppApiKeyScope = .read
    @State private var copied = false

    var body: some View {
        let c = FSColors.scheme(scheme)
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: FS.space.s4) {
                    if let created = controller.createdKey {
                        shownOnce(created, c: c)
                    } else {
                        form(c: c)
                    }
                }
                .padding(FS.space.s6)
            }
            .background(c.bg.ignoresSafeArea())
            .navigationTitle(AppApiKeysCopy.createTitle)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(controller.createdKey == nil ? "Cancel" : "Done", action: onClose)
                        .disabled(controller.isCreating)
                        .accessibilityIdentifier("api-key-create-close")
                }
            }
        }
        .interactiveDismissDisabled(controller.isCreating)
    }

    @ViewBuilder
    private func form(c: FSColors) -> some View {
        Text("Name").font(FS.font.caption()).foregroundColor(c.textMuted)
        TextField(AppApiKeysCopy.labelPlaceholder, text: $label)
            .textInputAutocapitalization(.sentences)
            .padding(FS.space.s3)
            .background(c.surface)
            .overlay(RoundedRectangle(cornerRadius: FS.radius.md).stroke(c.border, lineWidth: 1))
            .accessibilityIdentifier("api-key-label")
        Text("Access").font(FS.font.caption()).foregroundColor(c.textMuted)
        Picker("Access", selection: $scope) {
            ForEach(AppApiKeyScope.allCases, id: \.self) { Text($0.label).tag($0) }
        }
        .pickerStyle(.segmented)
        .accessibilityIdentifier("api-key-scope")
        Text(scope == .read ? "Can only read: GET, HEAD and OPTIONS requests."
                            : "Can read and change anything the app allows.")
            .font(FS.font.caption()).foregroundColor(c.textMuted)
            .fixedSize(horizontal: false, vertical: true)
        if let err = controller.createError {
            Text(err).font(FS.font.bodySm()).foregroundColor(c.danger)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("api-key-create-error")
        }
        let ready = !label.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !controller.isCreating
        FSPrimaryButton(controller.isCreating ? "Creating…" : AppApiKeysCopy.create, enabled: ready, block: true) {
            Task { await controller.create(label: label, scope: scope) }
        }
        .accessibilityIdentifier("api-key-create-submit")
    }

    @ViewBuilder
    private func shownOnce(_ created: AppApiKeysController.CreatedKey, c: FSColors) -> some View {
        HStack(spacing: FS.space.s2) {
            Image(systemName: "exclamationmark.triangle.fill").foregroundColor(c.warning)
            Text(AppApiKeysCopy.shownOnceWarning)
                .font(FS.font.bodySm().weight(.semibold)).foregroundColor(c.text)
                .fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityIdentifier("api-key-shown-once-warning")
        Text(created.label).font(FS.font.caption()).foregroundColor(c.textMuted)
        Text(created.key)
            .font(FS.font.mono())
            .foregroundColor(c.text)
            .textSelection(.enabled)
            .fixedSize(horizontal: false, vertical: true)
            .padding(FS.space.s3)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(c.surface)
            .overlay(RoundedRectangle(cornerRadius: FS.radius.md).stroke(c.border, lineWidth: 1))
            .accessibilityIdentifier("api-key-secret")
        FSPrimaryButton(copied ? "Copied" : "Copy", block: true) {
            // Local only, and gone from the clipboard after 10 minutes.
            UIPasteboard.general.setItems(
                [[UTType.plainText.identifier: created.key]],
                options: [.localOnly: true, .expirationDate: Date().addingTimeInterval(600)])
            copied = true
        }
        .accessibilityIdentifier("api-key-copy")
        Text("Send it with each request:").font(FS.font.caption()).foregroundColor(c.textMuted)
        Text(created.usage)
            .font(FS.font.mono())
            .foregroundColor(c.text)
            .textSelection(.enabled)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityIdentifier("api-key-usage")
    }
}
