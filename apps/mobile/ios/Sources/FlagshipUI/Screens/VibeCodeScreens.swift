import SwiftUI
import FlagshipAPI

/// D.6.1 — VibeCodeProviderPickScreen.
public struct VibeCodeProviderPickScreen: View {
    var promoUsed: Int = 12
    var promoCap: Int = 50
    var onPickPromo: () -> Void = {}
    var onPickBYOK: () -> Void = {}
    public init(
        promoUsed: Int = 12,
        promoCap: Int = 50,
        onPickPromo: @escaping () -> Void = {},
        onPickBYOK: @escaping () -> Void = {}
    ) {
        self.promoUsed = promoUsed
        self.promoCap = promoCap
        self.onPickPromo = onPickPromo
        self.onPickBYOK = onPickBYOK
    }
    public var body: some View {
        FSScreen {
            ScrollView {
                VStack(alignment: .leading, spacing: FS.space.s6) {
                    Spacer().frame(height: FS.space.s12)
                    Text("How would you like to build it?").font(FS.font.h2())
                    FSColorReader { c in
                        Text("Pick the AI that writes the code. You can change this any time.")
                            .font(FS.font.body())
                            .foregroundColor(c.textMuted)
                    }

                    FSCard(padding: FS.space.s6) {
                        HStack(alignment: .top) {
                            VStack(alignment: .leading, spacing: FS.space.s2) {
                                Text("Use Flagship's credits").font(FS.font.h3())
                                FSColorReader { c in
                                    Text("50 free calls a day · 200 lifetime · we cover the API bill.")
                                        .font(.system(size: 14)).foregroundColor(c.textMuted)
                                }
                            }
                            Spacer()
                            PromoBadge(used: promoUsed, cap: promoCap)
                        }
                        FSColorReader { c in
                            Text("Honest note: your prompts go directly to Anthropic, not through us.")
                                .font(.system(size: 13)).foregroundColor(c.textMuted)
                        }
                        FSPrimaryButton("Use the promo →", block: true, action: onPickPromo)
                    }

                    FSCard(padding: FS.space.s6) {
                        Text("Bring your own key").font(FS.font.h3())
                        FSColorReader { c in
                            Text("Anthropic, OpenAI, or Google. No daily limits. Your key, your bill, your choice of model.")
                                .font(.system(size: 14)).foregroundColor(c.textMuted)
                        }
                        FSSecondaryButton("Set up a key", block: true, action: onPickBYOK)
                    }
                    Spacer().frame(height: FS.space.s8)
                }
                .padding(.horizontal, FS.space.s6)
            }
        }
    }
}

private struct PromoBadge: View {
    @Environment(\.colorScheme) private var scheme
    let used: Int
    let cap: Int
    var body: some View {
        let c = FSColors.scheme(scheme)
        Text("\(used) / \(cap) today")
            .font(.system(size: 13, weight: .medium))
            .foregroundColor(c.primary)
            .padding(.horizontal, 12).padding(.vertical, 4)
            .background(c.primary.opacity(0.12))
            .clipShape(Capsule())
    }
}

/// D.6.3 — VibeCodeDescribeScreen.
public struct VibeCodeDescribeScreen: View {
    @State private var prompt: String = "A little site to track which of my houseplants I've watered, with a photo per plant. Send me a push when one's been thirsty 5+ days."
    @State private var name: String = "plants"
    var onBuild: (String) -> Void = { _ in }
    public init(onBuild: @escaping (String) -> Void = { _ in }) { self.onBuild = onBuild }

    public var body: some View {
        FSScreen {
            ScrollView {
                VStack(alignment: .leading, spacing: FS.space.s6) {
                    Spacer().frame(height: FS.space.s12)
                    Text("New app").font(FS.font.h2())
                    FSColorReader { c in
                        Text("Describe what you want. Your Flagship will build it and run it at \(name).harry.flagship.services.")
                            .font(FS.font.body()).foregroundColor(c.textMuted)
                    }

                    PromptArea(prompt: $prompt)

                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: FS.space.s2) {
                            ForEach(["Habit tracker", "Family wishlist", "Recipe jar", "Sleep journal"], id: \.self) { ex in
                                ExampleChip(text: ex)
                            }
                        }
                    }

                    FSCard {
                        LabeledRow(label: "Name", value: name)
                        LabeledRow(label: "Visible to", value: "Just me")
                        LabeledRow(label: "AI", value: "Claude (Flagship credits)")
                    }

                    FSPrimaryButton("Build it", block: true, large: true, action: { onBuild(prompt) })
                    FSColorReader { c in
                        Text("about 90 seconds")
                            .font(.system(size: 13))
                            .foregroundColor(c.textMuted)
                    }
                    Spacer().frame(height: FS.space.s8)
                }
                .padding(.horizontal, FS.space.s6)
            }
        }
    }
}

private struct PromptArea: View {
    @Environment(\.colorScheme) private var scheme
    @Binding var prompt: String
    var body: some View {
        let c = FSColors.scheme(scheme)
        ZStack(alignment: .bottomTrailing) {
            TextEditor(text: $prompt)
                .font(FS.font.body())
                .padding(10)
                .frame(height: 180)
                .background(c.surfaceSunken)
                .overlay(
                    RoundedRectangle(cornerRadius: FS.radius.sm)
                        .stroke(c.border, lineWidth: 1)
                )
                .clipShape(RoundedRectangle(cornerRadius: FS.radius.sm))
            Text("\(prompt.count)")
                .font(FS.font.mono())
                .foregroundColor(c.textMuted)
                .padding(8)
        }
    }
}

private struct ExampleChip: View {
    @Environment(\.colorScheme) private var scheme
    let text: String
    var body: some View {
        let c = FSColors.scheme(scheme)
        Text(text)
            .font(FS.font.caption())
            .foregroundColor(c.textMuted)
            .padding(.horizontal, 12).padding(.vertical, 6)
            .background(c.surfaceSunken)
            .overlay(
                RoundedRectangle(cornerRadius: FS.radius.pill).stroke(c.border, lineWidth: 1)
            )
            .clipShape(Capsule())
    }
}

private struct LabeledRow: View {
    @Environment(\.colorScheme) private var scheme
    let label: String
    let value: String
    var body: some View {
        let c = FSColors.scheme(scheme)
        HStack {
            Text(label).font(FS.font.bodySm()).foregroundColor(c.textMuted)
            Spacer()
            Text(value).font(.system(size: 14, weight: .medium)).foregroundColor(c.text)
        }
        .padding(.vertical, FS.space.s2)
    }
}

/// D.6.4 — Live vibe-code generation screen. Subscribes to the
/// WebSocket-driven frame stream and renders the running transcript +
/// build logs + final deploy URL.
public struct VibeCodeGeneratingScreen: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable var vm: VibeCodeStreamViewModel
    var onOpenApp: (String) -> Void = { _ in }
    var onInterrupt: () -> Void = {}

    public init(
        vm: VibeCodeStreamViewModel,
        onOpenApp: @escaping (String) -> Void = { _ in },
        onInterrupt: @escaping () -> Void = {}
    ) {
        self.vm = vm
        self.onOpenApp = onOpenApp
        self.onInterrupt = onInterrupt
    }

    public var body: some View {
        let c = FSColors.scheme(scheme)
        ScrollView {
            VStack(alignment: .leading, spacing: FS.space.s4) {
                header(c: c)
                transcriptCard(c: c)
                if !vm.buildLogs.isEmpty {
                    logsCard(c: c)
                }
                if let url = vm.deployedUrl, let serviceId = vm.deployedServiceId {
                    deployedCard(url: url, serviceId: serviceId, c: c)
                }
                if let err = vm.errorMessage {
                    ErrorCard(message: err)
                }
                Spacer().frame(height: FS.space.s12)
            }
            .padding(.horizontal, FS.space.s6)
            .padding(.top, FS.space.s4)
        }
        .background(c.bg.ignoresSafeArea())
        .task { vm.start() }
        .onDisappear { vm.cancel() }
        .navigationTitle("Building")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func header(c: FSColors) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s2) {
            Text(headlineText).font(FS.font.h2()).foregroundColor(c.text)
            Text("Session \(vm.sessionId)").font(FS.font.mono()).foregroundColor(c.textMuted)
        }
    }

    private var headlineText: String {
        switch vm.status {
        case .streaming: return "Generating…"
        case .building:  return "Building…"
        case .deployed:  return "Live."
        case .done:      return "Done."
        case .failed:    return "Stopped."
        }
    }

    private func transcriptCard(c: FSColors) -> some View {
        FSCard {
            VStack(alignment: .leading, spacing: FS.space.s2) {
                Text("ASSISTANT").font(FS.font.caption()).tracking(1).foregroundColor(c.textMuted)
                Text(vm.transcript.isEmpty ? "…" : vm.transcript)
                    .font(.system(size: 15))
                    .foregroundColor(c.text)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func logsCard(c: FSColors) -> some View {
        FSCard {
            VStack(alignment: .leading, spacing: 4) {
                Text("BUILD LOGS").font(FS.font.caption()).tracking(1).foregroundColor(c.textMuted)
                ForEach(vm.buildLogs.indices, id: \.self) { i in
                    Text(vm.buildLogs[i])
                        .font(FS.font.mono())
                        .foregroundColor(c.text)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
    }

    private func deployedCard(url: String, serviceId: String, c: FSColors) -> some View {
        FSCard {
            VStack(alignment: .leading, spacing: FS.space.s2) {
                HStack(spacing: FS.space.s2) {
                    Image(systemName: "checkmark.seal.fill").foregroundColor(c.success)
                    Text("Deployed").font(FS.font.h4()).foregroundColor(c.text)
                }
                Text(url).font(FS.font.mono()).foregroundColor(c.text).lineLimit(1).truncationMode(.middle)
                FSPrimaryButton("Open \(serviceId)", block: true) { onOpenApp(serviceId) }
            }
        }
    }
}
