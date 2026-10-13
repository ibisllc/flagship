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
    /// The "Free AI credits" card (nil ⇒ not shown). Held in @State so a
    /// parent re-render doesn't reset the loaded balance.
    @State private var freeAi: FreeAiCreditsCardModel?

    public init(vm: AiKeysViewModel, freeAiService: FreeAiCreditsService? = nil) {
        self.vm = vm
        _freeAi = State(initialValue: freeAiService.map { FreeAiCreditsCardModel(service: $0) })
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

                    if let freeAi {
                        FreeAiCreditsCard(model: freeAi) {
                            vm.resetForm()
                            vm.showingForm = true
                        }
                    }

                    if vm.entries.isEmpty {
                        FSCard {
                            Text("No AI keys saved on this device yet.")
                                .font(FS.font.body()).foregroundColor(c.textMuted)
                        }
                    } else {
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
        .task { await freeAi?.load() }
    }
}

/// Settings → AI keys: how much of the free AI allowance is left. Hidden when
/// `.com` can't be asked. MIRRORS the webapp settings card and Android's
/// `FreeAiCreditsCard`.
struct FreeAiCreditsCard: View {
    @Environment(\.colorScheme) private var scheme
    let model: FreeAiCreditsCardModel
    let onAddKey: () -> Void

    var body: some View {
        let c = FSColors.scheme(scheme)
        switch model.state {
        case .loading, .hidden:
            EmptyView()
        case .unavailable:
            FSCard {
                Text(FreeAiCopy.title).font(.system(size: 15, weight: .semibold)).foregroundColor(c.text)
                Text(FreeAiCopy.unavailable).font(FS.font.bodySm()).foregroundColor(c.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .accessibilityIdentifier("free-ai-card")
        case .available(let credits):
            FSCard {
                Text(FreeAiCopy.title).font(.system(size: 15, weight: .semibold)).foregroundColor(c.text)
                Text(FreeAiCopy.balance(credits)).font(FS.font.body()).foregroundColor(c.text)
                    .accessibilityIdentifier("free-ai-balance")
                Text(FreeAiCopy.note).font(FS.font.bodySm()).foregroundColor(c.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .accessibilityIdentifier("free-ai-card")
        case .usedUp:
            FSCard {
                Text(FreeAiCopy.title).font(.system(size: 15, weight: .semibold)).foregroundColor(c.text)
                Text(FreeAiCopy.usedUpSettings).font(FS.font.bodySm()).foregroundColor(c.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
                FSPrimaryButton(FreeAiCopy.addOwnKey, block: true, action: onAddKey)
                    .accessibilityIdentifier("free-ai-add-key")
            }
            .accessibilityIdentifier("free-ai-card")
        }
    }
}
