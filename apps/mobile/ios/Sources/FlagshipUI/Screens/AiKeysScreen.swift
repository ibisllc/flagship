import SwiftUI
import Flagship
import FlagshipAPI

/// Settings → AI keys. Views saved keys as masked slugs, adds a new one, and
/// deletes. No full key is ever shown. Reuses `AiKeyForm` from the build
/// AI-key step (sans the "Save on this device" toggle — adding here always
/// saves).
///
/// Mirrors the webapp Settings providers manager (`renderProviders`).
public struct AiKeysScreen: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable var vm: AiKeysViewModel
    /// The "Flagship Inference" entry, always first. Held in @State so a
    /// parent re-render doesn't reset the loaded balance.
    @State private var freeAi: FreeAiCreditsCardModel
    @Environment(\.screensClient) private var client
    /// Flagship Inference's catalog from `.com` (nil hides its default-model row).
    private let catalog: (@MainActor () async -> InferenceCatalogResponse?)?

    public init(vm: AiKeysViewModel, freeAiService: FreeAiCreditsService? = nil,
                catalog: (@MainActor () async -> InferenceCatalogResponse?)? = nil) {
        self.vm = vm
        self.catalog = catalog
        _freeAi = State(initialValue: FreeAiCreditsCardModel(service: freeAiService))
    }

    public var body: some View {
        let c = FSColors.scheme(scheme)
        FSScreen {
            ScrollView {
                VStack(alignment: .leading, spacing: FS.space.s4) {
                    Spacer().frame(height: FS.space.s4)
                    Text("AI keys power app builds but stay on this phone. Your server sends them only to the provider; Flagship never sees them.")
                        .font(FS.font.bodySm()).foregroundColor(c.textMuted)
                        .fixedSize(horizontal: false, vertical: true)

                    FlagshipInferenceEntry(
                        state: freeAi.state,
                        isDefault: vm.flagshipInferenceIsDefault,
                        onMakeDefault: { vm.makeFlagshipInferenceDefault() },
                        onAddKey: {
                            vm.resetForm()
                            vm.showingForm = true
                        },
                        defaultModel: catalog.map { load in
                            DefaultModelRow(keyId: SavedKeyStore.flagshipInferenceId) { .flagship(await load()) }
                        }
                    )

                    if !vm.entries.isEmpty {
                        ForEach(vm.entries) { e in
                            FSCard {
                                HStack(spacing: FS.space.s2) {
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(vm.slug(for: e))
                                            .font(FS.font.body()).foregroundColor(c.text)
                                            .lineLimit(1).truncationMode(.middle)
                                        if e.id == vm.activeId {
                                            Text("Default for new builds")
                                                .font(FS.font.bodySm()).foregroundColor(c.primary)
                                        }
                                    }
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    Button(role: .destructive) {
                                        vm.delete(id: e.id)
                                    } label: {
                                        Image(systemName: "trash").foregroundColor(c.danger)
                                    }
                                    .buttonStyle(.plain)
                                    .accessibilityIdentifier("ai-key-delete")
                                }
                                AiKeyRelayRowToggle(
                                    relay: Binding(get: { e.relay }, set: { vm.setRelay(id: e.id, on: $0) }),
                                    identifier: "ai-key-relay"
                                )
                                DefaultModelRow(keyId: e.id) { [client] in
                                    let cred = VibeCodeCredentialSelection.compatible(with: e.credential).credential ?? e.credential
                                    let r = await ModelMenuCache.models(for: cred) { try await client.aiModels($0) }
                                    return r.kind == "flagship" ? .flagship(r.catalog) : .own(r)
                                }
                                if e.id != vm.activeId {
                                    Button(action: { vm.setActive(id: e.id) }) {
                                        Text("Make default").font(FS.font.bodySm()).foregroundColor(c.primary)
                                    }
                                    .buttonStyle(.plain)
                                }
                            }
                        }
                    }

                    if vm.showingForm {
                        AiKeyForm(
                            vm: AiKeyFormBinding(
                                provider: $vm.formProvider,
                                apiKey: $vm.formApiKey,
                                baseUrl: $vm.formBaseUrl,
                                label: $vm.formLabel,
                                relay: $vm.formRelay,
                                providers: vm.providers
                            ),
                            showSaveToggle: false,
                            saveOnDevice: .constant(true),
                            errorMessage: vm.errorMessage,
                            primaryLabel: "Save key",
                            primaryId: "ai-key-add-save",
                            onPrimary: { _ = vm.addFromForm() },
                            onCancel: {
                                vm.resetForm()
                                vm.showingForm = false
                            }
                        )
                    } else {
                        FSPrimaryButton("Add an AI key", block: true) {
                            vm.resetForm()
                            vm.showingForm = true
                        }
                        .accessibilityIdentifier("ai-key-add")
                    }

                    Spacer().frame(height: FS.space.s8)
                }
                .padding(.horizontal, FS.space.s6)
                .fsReadingColumn()
            }
        }
        .navigationTitle("AI keys")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear { vm.reload() }
        .task { await freeAi.load() }
    }
}

/// Settings → AI keys: the built-in "Flagship Inference" provider. Always
/// listed first and never deletable; this week's top-up and the starter
/// reserve, or why free AI can't be used now (disabled, but still listed once
/// the promotion has ended). MIRRORS the webapp settings entry and Android's
/// `FlagshipInferenceEntry`.
struct FlagshipInferenceEntry: View {
    @Environment(\.colorScheme) private var scheme
    let state: FreeAiEntryState
    let isDefault: Bool
    let onMakeDefault: () -> Void
    let onAddKey: () -> Void
    var defaultModel: DefaultModelRow? = nil

    var body: some View {
        let c = FSColors.scheme(scheme)
        FSCard {
            HStack(spacing: FS.space.s2) {
                FlagshipInferenceLabel(status: status, lastUsed: isDefault,
                                       lastUsedText: "Default for new builds", usable: state.isUsable)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if case .loading = state { ProgressView() }
            }
            if state.isUsable && !isDefault {
                Button(action: onMakeDefault) {
                    Text("Make default").font(FS.font.bodySm()).foregroundColor(c.primary)
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("free-ai-make-default")
            }
            if state.isUsable, let defaultModel { defaultModel }
            if case .disabled(_, true) = state {
                FSPrimaryButton(FreeAiCopy.addOwnKey, block: true, action: onAddKey)
                    .accessibilityIdentifier("free-ai-add-key")
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(FreeAiCopy.providerTitle)
        .accessibilityHint(FreeAiCopy.builtInAccessibility)
        .accessibilityIdentifier("free-ai-card")
    }

    private var status: String? {
        switch state {
        case .loading: return nil
        case .usable(let c): return FreeAiCopy.balance(c)
        case .disabled(let m, _): return m
        }
    }
}

/// Settings: the model a chat with this key starts with. Saved per key.
struct DefaultModelRow: View {
    @Environment(\.colorScheme) private var scheme
    @State private var menu: ModelMenuModel

    init(keyId: String, loader: @escaping @MainActor () async -> ModelMenuModel.Source) {
        let m = ModelMenuModel(initial: DefaultModelStore.choice(for: keyId), loader: loader)
        m.onChange = { DefaultModelStore.set($0, for: keyId) }
        _menu = State(initialValue: m)
    }

    var body: some View {
        let c = FSColors.scheme(scheme)
        HStack(spacing: FS.space.s2) {
            Text("Default model").font(FS.font.bodySm()).foregroundColor(c.textMuted)
            Spacer(minLength: 0)
            ModelMenuButton(menu: menu, identifier: "ai-key-default-model")
        }
    }
}
