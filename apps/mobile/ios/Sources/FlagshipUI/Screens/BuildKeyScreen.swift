import SwiftUI
import Flagship
import FlagshipAPI

/// Reusable AI-key step.
///
/// A build path that drives the BOX's own model (start-from-scratch; the
/// git-adapt pass) routes through here BEFORE it runs, so the owner can
/// PROVIDE or CONFIRM the AI key the box will use. Paths that do NOT use the
/// box's model (marketplace install, IDE/MCP — which uses the user's own
/// editor AI) skip this entirely.
///
/// Adding and choosing are separate: "Add an API key" at the top opens a form
/// that saves the key to the device-local list, and each saved key below has
/// "Use this" (which moves the build on) and a Face ID-confirmed delete.
/// `onChosen` is handed the in-memory `{provider, apiKey, baseUrl?}` — the
/// raw key never touches flagshipserver.com.
///
/// Mirrors the canonical webapp `views/build-key.js`.
public struct BuildKeyScreen: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable var vm: BuildKeyViewModel
    /// A short line for why a key is needed, e.g. "Start from scratch with AI".
    let contextLabel: String
    /// Called with the chosen in-memory credential.
    var onChosen: (LlmProviderCredential) -> Void
    /// Free AI credits (nil ⇒ the row is not offered).
    let freeAiService: FreeAiCreditsService?
    /// The box the build runs on (a free-AI credential is minted for it).
    let serverFqdn: String

    public init(
        vm: BuildKeyViewModel,
        contextLabel: String,
        freeAiService: FreeAiCreditsService? = nil,
        serverFqdn: String = "",
        onChosen: @escaping (LlmProviderCredential) -> Void
    ) {
        self.vm = vm
        self.contextLabel = contextLabel
        self.freeAiService = freeAiService
        self.serverFqdn = serverFqdn
        self.onChosen = onChosen
    }

    @State private var confirmDelete: SavedKeyStore.Entry?
    @State private var deleteError: String?
    /// Free AI is chosen for an owner with no key at most once per visit.
    @State private var autoChoseFreeAi = false

    public var body: some View {
        let c = FSColors.scheme(scheme)
        FSScreen {
            ScrollView {
                VStack(alignment: .leading, spacing: FS.space.s4) {
                    Spacer().frame(height: FS.space.s6)

                    freeAiRow(c: c)

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
                            saveOnDevice: $vm.saveOnDevice,
                            errorMessage: vm.errorMessage,
                            primaryLabel: "Add key",
                            primaryId: "build-key-add-save",
                            onPrimary: { vm.addFromForm() },
                            onCancel: {
                                vm.resetForm()
                                vm.showingForm = false
                            },
                            showCancel: !vm.saved.isEmpty
                        )
                    } else {
                        Button {
                            vm.resetForm()
                            vm.showingForm = true
                        } label: {
                            Label("Add an API key", systemImage: "plus")
                                .font(.system(size: 16, weight: .semibold))
                                .foregroundColor(c.primary)
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("build-key-add")
                    }

                    savedKeys(c: c)

                    HStack(alignment: .top, spacing: FS.space.s2) {
                        Image(systemName: "lock.shield").foregroundColor(c.primary)
                        Text("The keys are stored safely in your mobile app and your own servers.")
                            .font(FS.font.bodySm()).foregroundColor(c.textMuted)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .padding(.top, FS.space.s2)

                    Spacer().frame(height: FS.space.s8)
                }
                .padding(.horizontal, FS.space.s6)
                .fsReadingColumn()
            }
        }
        .navigationTitle("AI Key")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear {
            if vm.freeAiService == nil { vm.freeAiService = freeAiService }
            vm.reload()
        }
        .task {
            if vm.freeAiService == nil { vm.freeAiService = freeAiService }
            let auto = await vm.loadFreeAi()
            if auto && !autoChoseFreeAi {
                autoChoseFreeAi = true
                await useFreeAi()
            }
        }
        .confirmationDialog(
            "Delete this key?",
            isPresented: Binding(get: { confirmDelete != nil }, set: { if !$0 { confirmDelete = nil } }),
            titleVisibility: .visible,
            presenting: confirmDelete
        ) { e in
            Button("Delete key", role: .destructive) { Task { await delete(e) } }
        } message: { e in
            Text("\(e.label) will be removed from this phone. Builds that are already running keep working.")
        }
    }

    private func delete(_ e: SavedKeyStore.Entry) async {
        deleteError = nil
        do {
            try await BiometricGate().evaluate(reason: "Delete the AI key \(e.label)")
            vm.delete(e)
        } catch BiometricGate.GateError.notAvailable {
            vm.delete(e)
        } catch {
            deleteError = "The key wasn't deleted."
        }
    }

    private func useFreeAi() async {
        if let cred = await vm.useFreeAi(serverFqdn: serverFqdn) { onChosen(cred) }
    }

    /// "Free AI credits": first in the list; when they can't be used now, the
    /// reason instead of a Use button; gone once the promotion has ended.
    @ViewBuilder
    private func freeAiRow(c: FSColors) -> some View {
        switch vm.freeAi {
        case .available(let credits):
            FSCard {
                HStack(spacing: FS.space.s3) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(FreeAiCopy.title).font(.system(size: 15, weight: .semibold)).foregroundColor(c.text)
                        Text(FreeAiCopy.left(credits)).font(FS.font.bodySm()).foregroundColor(c.textMuted)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    if vm.freeAiBusy {
                        ProgressView()
                    } else {
                        FSPrimaryButton("Use this") { Task { await useFreeAi() } }
                            .accessibilityIdentifier("build-key-use-free-ai")
                    }
                }
            }
            .accessibilityIdentifier("build-key-free-ai")
        case .loading:
            if vm.saved.isEmpty {
                ProgressView().frame(maxWidth: .infinity)
            }
        case .blocked(let message):
            if vm.errorMessage != message {
                FSCard {
                    Text(FreeAiCopy.title).font(.system(size: 15, weight: .semibold)).foregroundColor(c.text)
                    Text(message).font(FS.font.bodySm()).foregroundColor(c.textMuted)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .accessibilityIdentifier("build-key-free-ai-blocked")
            }
        case .none:
            EmptyView()
        }
    }

    @ViewBuilder
    private func savedKeys(c: FSColors) -> some View {
        if !vm.saved.isEmpty {
            Text("Saved keys").font(FS.font.caption()).foregroundColor(c.textMuted)
                .padding(.top, FS.space.s2)
            ForEach(vm.orderedEntries) { e in
                FSCard {
                    HStack(spacing: FS.space.s3) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(e.label).font(.system(size: 15, weight: .semibold)).foregroundColor(c.text)
                                .lineLimit(1)
                            Text(vm.slug(for: e)).font(FS.font.bodySm()).foregroundColor(c.textMuted)
                                .lineLimit(1).truncationMode(.middle)
                            if e.id == vm.active?.id {
                                Text("Last used").font(FS.font.caption()).foregroundColor(c.textMuted)
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        Button { confirmDelete = e } label: {
                            Image(systemName: "trash").foregroundColor(c.danger)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Delete \(e.label)")
                        .accessibilityIdentifier("build-key-delete")
                        FSPrimaryButton("Use this") { onChosen(vm.credential(for: e)) }
                            .accessibilityIdentifier(e.id == vm.active?.id ? "build-key-confirm-active" : "build-key-use-saved")
                    }
                    AiKeyRelayRowToggle(
                        relay: Binding(get: { e.relay }, set: { vm.setRelay(e, on: $0) }),
                        identifier: "build-key-relay"
                    )
                }
            }
            if let err = deleteError {
                Text(err).font(FS.font.bodySm()).foregroundColor(c.danger)
            }
        }
    }
}

/// Bindings bundle for the shared AI-key entry form (so both the build step
/// and the Settings manager reuse one form view).
public struct AiKeyFormBinding {
    @Binding public var provider: String
    @Binding public var apiKey: String
    @Binding public var baseUrl: String
    @Binding public var label: String
    @Binding public var relay: Bool
    public let providers: [String]
    public init(
        provider: Binding<String>,
        apiKey: Binding<String>,
        baseUrl: Binding<String>,
        label: Binding<String>,
        relay: Binding<Bool>,
        providers: [String]
    ) {
        self._provider = provider
        self._apiKey = apiKey
        self._baseUrl = baseUrl
        self._label = label
        self._relay = relay
        self.providers = providers
    }
}

/// The words for the per-key Flagship relay setting, shared by the add form
/// and the key lists.
public enum AiKeyRelayCopy {
    public static let toggle = "Send through the Flagship relay"
    public static let note = "Better for your anonymity: the AI provider sees Flagship's address, not yours."
    public static let on = "Through the Flagship relay"
    public static let off = "Direct"
    public static let turnOff = "Turn the relay off for this key"
    public static let turnedOff = "The relay is off for this key. Try again."
    public static func caption(_ relay: Bool) -> String { relay ? on : off }
}

/// The relay switch on a saved key's row, captioned with where its calls go.
struct AiKeyRelayRowToggle: View {
    @Environment(\.colorScheme) private var scheme
    @Binding var relay: Bool
    let identifier: String

    var body: some View {
        let c = FSColors.scheme(scheme)
        Toggle(isOn: $relay) {
            Text(AiKeyRelayCopy.caption(relay)).font(FS.font.bodySm()).foregroundColor(c.textMuted)
        }
        .tint(c.primary)
        .accessibilityLabel(AiKeyRelayCopy.toggle)
        .accessibilityValue(AiKeyRelayCopy.caption(relay))
        .accessibilityIdentifier(identifier)
    }
}

/// The "use a different key" / "add a key" entry form — provider picker +
/// optional baseUrl + a SECURE key field + optional label + (optionally) a
/// "Save on this device" toggle. Plaintext lives ONLY in the secure field.
struct AiKeyForm: View {
    @Environment(\.colorScheme) private var scheme
    let vm: AiKeyFormBinding
    let showSaveToggle: Bool
    @Binding var saveOnDevice: Bool
    let errorMessage: String?
    let primaryLabel: String
    let primaryId: String
    let onPrimary: () -> Void
    let onCancel: () -> Void
    var showCancel: Bool = true

    var body: some View {
        let c = FSColors.scheme(scheme)
        FSCard {
            VStack(alignment: .leading, spacing: FS.space.s2) {
                Text("Provider").font(FS.font.caption()).foregroundColor(c.text)
                Picker("Provider", selection: vm.$provider) {
                    ForEach(vm.providers, id: \.self) { p in
                        Text(p.capitalized).tag(p)
                    }
                }
                .pickerStyle(.menu)
                .accessibilityIdentifier("ai-key-provider")
            }
            FSField(value: vm.$apiKey, label: "API key",
                    placeholder: "sk-…", secure: true)
                .accessibilityIdentifier("ai-key-field")
            FSField(value: vm.$baseUrl, label: "Base URL (optional)",
                    placeholder: "https://…", keyboard: .URL)
            FSField(value: vm.$label, label: "Label (optional)",
                    placeholder: "e.g. Personal")
            Toggle(isOn: vm.$relay) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(AiKeyRelayCopy.toggle).font(FS.font.body()).foregroundColor(c.text)
                    Text(AiKeyRelayCopy.note)
                        .font(FS.font.bodySm()).foregroundColor(c.textMuted)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .tint(c.primary)
            .accessibilityIdentifier("ai-key-relay-toggle")
            if showSaveToggle {
                Toggle(isOn: $saveOnDevice) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Save on this device").font(FS.font.body()).foregroundColor(c.text)
                        Text("Recall it next time and manage it in Settings. Stays on this device.")
                            .font(FS.font.bodySm()).foregroundColor(c.textMuted)
                    }
                }
                .tint(c.primary)
                .accessibilityIdentifier("ai-key-save-toggle")
            }
            if let err = errorMessage {
                Text(err).font(FS.font.bodySm()).foregroundColor(c.danger)
            }
            HStack(spacing: FS.space.s2) {
                if showCancel { FSSecondaryButton("Cancel", block: true, action: onCancel) }
                FSPrimaryButton(primaryLabel, block: true, action: onPrimary)
                    .accessibilityIdentifier(primaryId)
            }
        }
    }
}
