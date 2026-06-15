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
/// It recalls the device-local saved keys as masked slugs (one-tap recall),
/// pre-selects the active one with a clear Confirm affordance, and offers a
/// "use a different key" form with an optional "Save on this device" toggle.
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

    public init(
        vm: BuildKeyViewModel,
        contextLabel: String,
        onChosen: @escaping (LlmProviderCredential) -> Void
    ) {
        self.vm = vm
        self.contextLabel = contextLabel
        self.onChosen = onChosen
    }

    public var body: some View {
        let c = FSColors.scheme(scheme)
        FSScreen {
            ScrollView {
                VStack(alignment: .leading, spacing: FS.space.s4) {
                    Spacer().frame(height: FS.space.s6)
                    Text("AI key").font(FS.font.h2())
                    Text("\(contextLabel) uses your box's AI. Provide or confirm the AI key it should use.")
                        .font(FS.font.body()).foregroundColor(c.textMuted)
                        .fixedSize(horizontal: false, vertical: true)

                    // Reassurance — the key stays on this device; the box calls
                    // the provider directly; flagshipserver.com never sees it.
                    HStack(alignment: .top, spacing: FS.space.s2) {
                        Image(systemName: "lock.shield").foregroundColor(c.primary)
                        Text("The key stays on this device. Your box calls the provider directly with it — flagshipserver.com never sees it.")
                            .font(FS.font.bodySm()).foregroundColor(c.textMuted)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .padding(.bottom, FS.space.s1)

                    savedKeys(c: c)

                    if !vm.showingForm {
                        FSSecondaryButton("Use a different key", block: true) {
                            vm.resetForm()
                            vm.showingForm = true
                        }
                        .accessibilityIdentifier("build-key-different")
                    } else {
                        AiKeyForm(
                            vm: AiKeyFormBinding(
                                provider: $vm.formProvider,
                                apiKey: $vm.formApiKey,
                                baseUrl: $vm.formBaseUrl,
                                label: $vm.formLabel,
                                providers: vm.providers
                            ),
                            showSaveToggle: true,
                            saveOnDevice: $vm.saveOnDevice,
                            errorMessage: vm.errorMessage,
                            primaryLabel: "Use this key",
                            primaryId: "build-key-use",
                            onPrimary: {
                                if let cred = vm.credentialFromForm() { onChosen(cred) }
                            },
                            onCancel: {
                                vm.resetForm()
                                vm.showingForm = false
                            }
                        )
                    }

                    Spacer().frame(height: FS.space.s8)
                }
                .padding(.horizontal, FS.space.s6)
                .fsReadingColumn()
            }
        }
        .navigationTitle("AI key")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear { vm.reload() }
    }

    @ViewBuilder
    private func savedKeys(c: FSColors) -> some View {
        if vm.saved.isEmpty {
            FSCard {
                Text("No saved keys yet — add one below.")
                    .font(FS.font.body()).foregroundColor(c.textMuted)
            }
        } else {
            if let active = vm.active {
                FSCard {
                    Text("Confirm this key").font(.system(size: 15, weight: .semibold)).foregroundColor(c.text)
                    Text(vm.slug(for: active)).font(FS.font.bodySm()).foregroundColor(c.textMuted)
                        .lineLimit(1).truncationMode(.middle)
                    FSPrimaryButton("Use this key", block: true) {
                        onChosen(vm.credential(for: active))
                    }
                    .accessibilityIdentifier("build-key-confirm-active")
                }
            }
            ForEach(vm.otherEntries) { e in
                FSCard {
                    HStack(spacing: FS.space.s2) {
                        Text(vm.slug(for: e)).font(FS.font.bodySm()).foregroundColor(c.text)
                            .lineLimit(1).truncationMode(.middle)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        FSSecondaryButton("Use") {
                            onChosen(vm.credential(for: e))
                        }
                        .accessibilityIdentifier("build-key-use-saved")
                    }
                }
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
    public let providers: [String]
    public init(
        provider: Binding<String>,
        apiKey: Binding<String>,
        baseUrl: Binding<String>,
        label: Binding<String>,
        providers: [String]
    ) {
        self._provider = provider
        self._apiKey = apiKey
        self._baseUrl = baseUrl
        self._label = label
        self.providers = providers
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
                FSSecondaryButton("Cancel", block: true, action: onCancel)
                FSPrimaryButton(primaryLabel, block: true, action: onPrimary)
                    .accessibilityIdentifier(primaryId)
            }
        }
    }
}
