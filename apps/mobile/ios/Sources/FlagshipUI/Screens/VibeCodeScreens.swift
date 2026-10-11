import SwiftUI
import FlagshipAPI
import FlagshipCore

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

/// D.6.3 — VibeCodeDescribeScreen. The "new service" form: name it first (its
/// web address, checked with the box as you type, so a clash shows before any
/// description is written), describe it, and choose who can open it. The AI
/// was already chosen on the provider-pick step upstream.
public struct VibeCodeDescribeScreen: View {
    /// Who can reach the built service. Raw values are the wire contract carried
    /// on `VibeCodeStartRequest.visibility` (mirrored on every client).
    public enum Visibility: String, CaseIterable, Sendable {
        case inviteOnly = "just-me"
        case anyoneWithLink = "link"
        var label: String { self == .inviteOnly ? "Invite only" : "Anyone with the link" }
        var explanation: String {
            switch self {
            case .inviteOnly: return "Only you and the people you invite on Flagship can open it."
            case .anyoneWithLink: return "Anyone with the address can open it. Where it needs to know who someone is, they sign in with Flagship."
            }
        }
    }

    @Environment(AppState.self) private var app
    @Environment(\.screensClient) private var client
    @State private var prompt: String = ""
    @State private var name: String = ""
    @State private var visibility: Visibility = .inviteOnly
    @State private var check: VibeCodeNameCheck?
    @State private var checkedSlug: String = ""
    @State private var conflict: VibeCodeNameCheck?
    @State private var starting = false
    @FocusState private var promptFocused: Bool

    /// Continuation — (prompt, chosen service name/slug, visibility raw value).
    /// Returns the box's refusal when the name turned out to be taken.
    var onBuild: (String, String, String) async -> VibeCodeNameCheck?
    var onOpenSessions: () -> Void
    public init(onBuild: @escaping (String, String, String) async -> VibeCodeNameCheck? = { _, _, _ in nil },
                onOpenSessions: @escaping () -> Void = {}) {
        self.onBuild = onBuild
        self.onOpenSessions = onOpenSessions
    }

    /// The address label the box will serve at. Lowercased; only the safe slug
    /// characters survive (the daemon is the authority, this is just the preview
    /// + what we send).
    private var slug: String {
        name.lowercased().filter { $0.isLetter || $0.isNumber || $0 == "-" }
    }
    private var currentCheck: VibeCodeNameCheck? { checkedSlug == slug ? check : nil }
    private var canBuild: Bool {
        !slug.isEmpty && !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && currentCheck?.kind != "invalid" && !starting
    }

    public var body: some View {
        let user = app.currentUser ?? "you"
        let server = app.sessionPod?.fqdn ?? app.leaderPod?.fqdn ?? "\(user).flagship.services"
        return FSScreen {
            ScrollView {
                VStack(alignment: .leading, spacing: FS.space.s6) {
                    Spacer().frame(height: FS.space.s4)

                    VStack(alignment: .leading, spacing: FS.space.s2) {
                        FSField(
                            value: $name,
                            label: "Name",
                            placeholder: "plant-tracker"
                        )
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled(true)
                        .accessibilityIdentifier("describe-name-field")
                        FSColorReader { c in
                            (Text("https://").foregroundColor(c.textMuted)
                             + Text(slug.isEmpty ? "<name>" : slug).foregroundColor(c.primary).fontWeight(.semibold)
                             + Text(".\(server)").foregroundColor(c.textMuted))
                                .font(FS.font.bodySm())
                                .lineLimit(2)
                                .accessibilityIdentifier("describe-address")
                        }
                        nameStatus
                    }

                    VStack(alignment: .leading, spacing: FS.space.s2) {
                        FSColorReader { c in
                            Text("What should it do?").font(FS.font.bodySm()).foregroundColor(c.textMuted)
                        }
                        PromptArea(prompt: $prompt, focused: $promptFocused)
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: FS.space.s2) {
                                ForEach(Self.examples, id: \.0) { ex in
                                    Button(action: { prompt = ex.1 }) { ExampleChip(text: ex.0) }
                                        .buttonStyle(.plain)
                                }
                            }
                        }
                    }

                    FSColorReader { c in
                        VStack(alignment: .leading, spacing: FS.space.s2) {
                            Text("Who can open it").font(FS.font.bodySm()).foregroundColor(c.textMuted)
                            Picker("Who can open it", selection: $visibility) {
                                ForEach(Visibility.allCases, id: \.self) { v in
                                    Text(v.label).tag(v)
                                }
                            }
                            .pickerStyle(.segmented)
                            .accessibilityIdentifier("describe-visibility")
                            Text(visibility.explanation)
                                .font(FS.font.bodySm()).foregroundColor(c.textMuted)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }

                    FSPrimaryButton(starting ? "Starting…" : "Build it", enabled: canBuild, block: true, large: true, action: build)
                        .accessibilityIdentifier("describe-build")
                    FSColorReader { c in
                        Text("about 90 seconds")
                            .font(.system(size: 13))
                            .foregroundColor(c.textMuted)
                    }
                    Spacer().frame(height: FS.space.s8)
                }
                .padding(.horizontal, FS.space.s6)
            }
            // A long description pushes "Build it" below the keyboard. Let a
            // scroll dismiss it, AND give an explicit "Done" key so the button
            // is always reachable (a dead "Build it" under the keyboard is a
            // real UX trap).
            .scrollDismissesKeyboard(.interactively)
            .toolbar {
                ToolbarItemGroup(placement: .keyboard) {
                    Spacer()
                    Button("Done") { promptFocused = false }
                        .accessibilityIdentifier("describe-keyboard-done")
                }
            }
        }
        .navigationTitle("New Service")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: slug) {
            guard !slug.isEmpty else { return }
            try? await Task.sleep(for: .milliseconds(350))
            guard !Task.isCancelled else { return }
            await runCheck(slug)
        }
        .alert(conflictTitle, isPresented: Binding(get: { conflict != nil }, set: { if !$0 { conflict = nil } }),
               presenting: conflict) { c in
            if c.kind == "session" {
                Button("Open build sessions") { onOpenSessions() }
                Button("Pick another name", role: .cancel) {}
            } else {
                Button("Pick another name", role: .cancel) {}
            }
        } message: { c in
            Text(Self.conflictMessage(c, name: slug))
        }
    }

    private var conflictTitle: String { "That name is taken" }

    static let examples: [(String, String)] = [
        ("Habit tracker", "A habit tracker: I tick off my daily habits and see my streaks for the last month."),
        ("Family wishlist", "A family wishlist: everyone keeps a list, and the others can quietly mark what they'll buy."),
        ("Recipe jar", "A recipe jar: save recipes with a photo, ingredients and steps, and search them by ingredient."),
        ("Sleep journal", "A sleep journal: log when I went to bed, when I woke up and how I slept, with a weekly chart."),
    ]

    static func conflictMessage(_ c: VibeCodeNameCheck, name: String) -> String {
        let n = c.name ?? name
        switch c.kind {
        case "session":
            return "A build session already uses \"\(n)\". To use the name for a new build, open Build sessions and discard that one first."
        case "app":
            return "You already have a service called \"\(n)\". Pick another name."
        default:
            return c.message ?? "Pick another name."
        }
    }

    @ViewBuilder
    private var nameStatus: some View {
        FSColorReader { c in
            if let ch = currentCheck, !ch.ok {
                Label(ch.kind == "invalid" ? (ch.message ?? "That can't be a web address.") : Self.conflictMessage(ch, name: slug),
                      systemImage: "exclamationmark.triangle.fill")
                    .font(FS.font.bodySm()).foregroundColor(c.danger)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("describe-name-taken")
            } else if let ch = currentCheck, ch.ok, ch.name != nil {
                Label("Available", systemImage: "checkmark.circle.fill")
                    .font(FS.font.bodySm()).foregroundColor(c.success)
            }
        }
    }

    private func runCheck(_ s: String) async {
        let result = (try? await client.vibeCodeNameCheck(name: s)) ?? .unknown
        if s == slug {
            check = result
            checkedSlug = s
        }
    }

    private func build() {
        promptFocused = false
        let s = slug
        starting = true
        Task {
            defer { starting = false }
            if currentCheck == nil { await runCheck(s) }
            if let ch = currentCheck, !ch.ok {
                if ch.kind != "invalid" { conflict = ch }
                return
            }
            if let refused = await onBuild(prompt, s, visibility.rawValue) {
                check = refused
                checkedSlug = s
                conflict = refused
            }
        }
    }
}

private struct PromptArea: View {
    @Environment(\.colorScheme) private var scheme
    @Binding var prompt: String
    var focused: FocusState<Bool>.Binding
    var body: some View {
        let c = FSColors.scheme(scheme)
        ZStack(alignment: .bottomTrailing) {
            TextEditor(text: $prompt)
                .focused(focused)
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
