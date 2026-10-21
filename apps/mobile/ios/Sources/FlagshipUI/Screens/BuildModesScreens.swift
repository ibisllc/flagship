import SwiftUI
import FlagshipAPI
import FlagshipCore

// Build-a-service multi-mode screens. The create-a-service entry opens the
// chooser, which fans into:
//   - scratch     → the existing vibe-code flow
//   - git         → BuildGitScreen (URL → verdict → install / adapt)
//   - mcp         → BuildMcpScreen (connect Cursor/Cline with your own AI)
// plus "Resume or view past builds" into BuildJournalScreen.
//
// Mirrors the canonical webapp `views/build-*.js`.

// MARK: - Chooser

/// The first screen of the create-a-service flow. Resuming comes first, so
/// an unfinished build isn't abandoned for a new one; the help sheet carries
/// the explanations the tiles leave out.
public struct BuildSourceChooserScreen: View {
    @Environment(\.colorScheme) private var scheme
    /// "Runs on: <server>" for the build; nil hides the row.
    var target: CreationTarget? = nil
    var onPickServer: (PodInfo) -> Void = { _ in }
    var activeSessions: Int = 0
    var onScratch: () -> Void = {}
    var onGit: () -> Void = {}
    var onMcp: () -> Void = {}
    var onPastBuilds: () -> Void = {}
    @State private var showHelp = false

    public init(
        target: CreationTarget? = nil,
        onPickServer: @escaping (PodInfo) -> Void = { _ in },
        activeSessions: Int = 0,
        onScratch: @escaping () -> Void = {},
        onGit: @escaping () -> Void = {},
        onMcp: @escaping () -> Void = {},
        onPastBuilds: @escaping () -> Void = {}
    ) {
        self.target = target
        self.onPickServer = onPickServer
        self.activeSessions = activeSessions
        self.onScratch = onScratch
        self.onGit = onGit
        self.onMcp = onMcp
        self.onPastBuilds = onPastBuilds
    }

    public var body: some View {
        let c = FSColors.scheme(scheme)
        FSScreen {
            ScrollView {
                VStack(alignment: .leading, spacing: FS.space.s4) {
                    Spacer().frame(height: FS.space.s4)

                    if let target { RunsOnPicker(target: target, onChange: onPickServer) }

                    Button(action: onPastBuilds) {
                        HStack(spacing: FS.space.s3) {
                            Image(systemName: "clock.arrow.circlepath").foregroundColor(c.accent)
                            Text("Resume or view past builds")
                                .font(FS.font.scaled(15, weight: .semibold)).foregroundColor(c.text)
                            Spacer()
                            if activeSessions > 0 {
                                Text("\(activeSessions)")
                                    .font(FS.font.scaled(13, weight: .bold))
                                    .foregroundColor(c.onSuccess)
                                    .padding(.horizontal, 8).padding(.vertical, 2)
                                    .background(Capsule().fill(c.success))
                                    .accessibilityLabel("\(activeSessions) active")
                            }
                            Image(systemName: "chevron.right").foregroundColor(c.textMuted)
                        }
                        .padding(FS.space.s4)
                        .background(c.surface)
                        .overlay(RoundedRectangle(cornerRadius: FS.radius.lg, style: .continuous)
                            .stroke(activeSessions > 0 ? c.success : c.border, lineWidth: 1))
                        .clipShape(RoundedRectangle(cornerRadius: FS.radius.lg, style: .continuous))
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("build-source-journal-link")

                    Text("New build").font(FS.font.caption()).foregroundColor(c.textMuted)
                        .padding(.top, FS.space.s2)

                    BuildSourceTile(
                        icon: "sparkles",
                        title: String(localized: "Start from scratch with AI"),
                        subtitle: String(localized: "Describe it in plain English. The AI writes it and deploys it for you."),
                        action: onScratch
                    )
                    .accessibilityIdentifier("build-src-scratch")

                    BuildSourceTile(
                        icon: "arrow.down.circle",
                        title: String(localized: "Import from a Git repo"),
                        subtitle: String(localized: "Paste a repo URL. If it's Flagship-ready we install it as-is, otherwise the AI adapts it."),
                        action: onGit
                    )
                    .accessibilityIdentifier("build-src-git")

                    BuildSourceTile(
                        icon: "laptopcomputer",
                        title: String(localized: "Connect your IDE"),
                        subtitle: String(localized: "Build from your own IDE (Claude Code, Cursor, VS Code or Cline) using your own AI. No model key ever touches the server."),
                        action: onMcp
                    )
                    .accessibilityIdentifier("build-src-mcp")

                    Spacer().frame(height: FS.space.s8)
                }
                .padding(.horizontal, FS.space.s6)
                .fsReadingColumn()
            }
        }
        .navigationTitle("Build a service")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { showHelp = true } label: { Image(systemName: "questionmark.circle") }
                    .accessibilityLabel("Help")
                    .accessibilityIdentifier("build-source-help")
            }
        }
        .sheet(isPresented: $showHelp) { BuildHelpSheet() }
    }
}

/// Plain explanations for someone who doesn't know which option to pick.
private struct BuildHelpSheet: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.dismiss) private var dismiss

    private let items: [(String, String, String)] = [
        ("clock.arrow.circlepath", String(localized: "Resume or view past builds"),
         String(localized: "Builds still open on your server can be picked up where you left off: answer the AI, deploy, or retry a failed deploy. Older builds keep a timeline of what happened. A build stays open until your server restarts.")),
        ("sparkles", String(localized: "Start from scratch with AI"),
         String(localized: "Describe the app you want in plain English. An AI model writes the code on your server, asks you questions when it needs to, and you deploy it with one tap. You need a key from an AI provider (OpenAI, Anthropic, OpenRouter…); it is sent only to your server.")),
        ("arrow.down.circle", String(localized: "Import from a Git repo"),
         String(localized: "Paste the address of a code repository, for example on GitHub. If it is already set up for Flagship it installs as-is; otherwise the AI can adapt it for you.")),
        ("laptopcomputer", String(localized: "Connect your IDE"),
         String(localized: "For developers: work in your own IDE (Claude Code, Cursor, VS Code or Cline) with your own AI, connected to your server over MCP. No AI key is stored on the server.")),
    ]

    var body: some View {
        let c = FSColors.scheme(scheme)
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: FS.space.s5) {
                    Text("Every option ends the same way: the app is installed and running on your own server, at its own web address.")
                        .font(FS.font.body()).foregroundColor(c.textMuted)
                    ForEach(items, id: \.1) { icon, title, body in
                        HStack(alignment: .top, spacing: FS.space.s3) {
                            Image(systemName: icon).foregroundColor(c.accent).frame(width: 24)
                            VStack(alignment: .leading, spacing: 4) {
                                Text(title).font(FS.font.h4()).foregroundColor(c.text)
                                Text(body).font(FS.font.bodySm()).foregroundColor(c.textMuted)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                    }
                }
                .padding(FS.space.s6)
            }
            .background(c.bg.ignoresSafeArea())
            .navigationTitle("How building works")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
        }
        .presentationDetents([.medium, .large])
    }
}

private struct BuildSourceTile: View {
    @Environment(\.colorScheme) private var scheme
    let icon: String
    let title: String
    let subtitle: String
    let action: () -> Void
    var body: some View {
        let c = FSColors.scheme(scheme)
        Button(action: action) {
            HStack(alignment: .top, spacing: FS.space.s3) {
                ZStack {
                    RoundedRectangle(cornerRadius: FS.radius.md, style: .continuous)
                        .fill(c.softTint())
                        .frame(width: 40, height: 40)
                    Image(systemName: icon).foregroundColor(c.accent)
                }
                VStack(alignment: .leading, spacing: 4) {
                    Text(title).font(FS.font.h4()).foregroundColor(c.text)
                    Text(subtitle).font(FS.font.bodySm()).foregroundColor(c.textMuted)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                Image(systemName: "chevron.right").foregroundColor(c.textMuted)
            }
            .padding(FS.space.s4)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(c.surface)
            .overlay(
                RoundedRectangle(cornerRadius: FS.radius.lg, style: .continuous).stroke(c.border, lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: FS.radius.lg, style: .continuous))
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Git

public struct BuildGitScreen: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(AppState.self) private var app
    @Environment(\.screensClient) private var client
    @Environment(\.screensServerFqdn) private var bound
    @Bindable var vm: BuildGitViewModel
    @State private var nameCheck: VibeCodeNameCheck?
    @State private var checkedSlug = ""
    /// A taken name sends the owner to the build that holds it.
    var onOpenSessions: () -> Void = {}
    /// Open this build's journal timeline.
    var onViewJournal: (String) -> Void = { _ in }
    /// 503 fall-back hook: the box has no model wired → start from scratch.
    var onFallBackToScratch: () -> Void = {}
    /// "Build with AI instead" on a non-fit repo: route through the AI-key
    /// step FIRST so the owner provides/confirms the key the adapt pass uses.
    /// The host runs `vm.adapt(credential:)` once a key is chosen.
    var onBuildWithAI: () -> Void = {}

    public init(
        vm: BuildGitViewModel,
        onViewJournal: @escaping (String) -> Void = { _ in },
        onFallBackToScratch: @escaping () -> Void = {},
        onBuildWithAI: @escaping () -> Void = {},
        onOpenSessions: @escaping () -> Void = {}
    ) {
        self.vm = vm
        self.onViewJournal = onViewJournal
        self.onFallBackToScratch = onFallBackToScratch
        self.onBuildWithAI = onBuildWithAI
        self.onOpenSessions = onOpenSessions
    }

    private var server: String {
        let user = app.currentUser ?? "you"
        return bound ?? app.sessionPod?.fqdn ?? app.leaderPod?.fqdn ?? "\(user).flagship.services"
    }
    private var currentCheck: VibeCodeNameCheck? { checkedSlug == vm.slug ? nameCheck : nil }
    private var nameRefused: Bool { currentCheck.map { !$0.ok } ?? false }

    public var body: some View {
        let c = FSColors.scheme(scheme)
        FSScreen {
            ScrollView {
                VStack(alignment: .leading, spacing: FS.space.s4) {
                    Spacer().frame(height: FS.space.s4)

                    RunsOnLine()

                    FSField(value: $vm.gitUrl, label: String(localized: "Repository URL"),
                            placeholder: "https://github.com/you/app", keyboard: .URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled(true)
                    FSField(value: $vm.ref, label: String(localized: "Branch or tag (optional)"),
                            placeholder: "main")
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled(true)

                    VStack(alignment: .leading, spacing: FS.space.s2) {
                        FSField(value: $vm.name, label: String(localized: "Name (optional)"),
                                placeholder: String(localized: "From the repo's name"))
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled(true)
                            .accessibilityIdentifier("build-git-name")
                        (Text("https://").foregroundColor(c.textMuted)
                         + Text(addressLabel).foregroundColor(c.primary).fontWeight(.semibold)
                         + Text(".\(server)").foregroundColor(c.textMuted))
                            .font(FS.font.bodySm())
                            .lineLimit(2)
                            .accessibilityIdentifier("build-git-address")
                        nameStatus(c: c)
                    }

                    if !vm.showsVerdict {
                        FSPrimaryButton(checkLabel, enabled: vm.canCheck && !checking && !nameRefused, block: true) {
                            Task { await vm.checkRepo() }
                        }
                        .accessibilityIdentifier("build-git-check")
                    }

                    verdict(c: c)

                    if let err = vm.errorMessage, !showsNotReadyCard {
                        ErrorCard(message: err)
                    }
                    Spacer().frame(height: FS.space.s8)
                }
                .padding(.horizontal, FS.space.s6)
                .fsReadingColumn()
            }
        }
        .navigationTitle("Git import")
        .navigationBarTitleDisplayMode(.inline)
        .onChange(of: vm.shouldFallBackToScratch) { _, fall in
            if fall { onFallBackToScratch() }
        }
        .task(id: vm.slug) {
            let s = vm.slug
            guard !s.isEmpty else { return }
            try? await Task.sleep(for: .milliseconds(350))
            guard !Task.isCancelled else { return }
            let result = (try? await client.vibeCodeNameCheck(name: s)) ?? .unknown
            if s == vm.slug {
                nameCheck = result
                checkedSlug = s
            }
        }
        .sheet(item: $vm.adapterFileURL) { url in
            ShareSheet(items: [url]) { vm.adapterFileURL = nil }
        }
        .alert("That name is taken",
               isPresented: Binding(get: { vm.conflict != nil }, set: { if !$0 { vm.conflict = nil } }),
               presenting: vm.conflict) { c in
            if c.kind == "session" {
                Button("Open build sessions") { onOpenSessions() }
                Button("Pick another name", role: .cancel) {}
            } else {
                Button("Pick another name", role: .cancel) {}
            }
        } message: { c in
            Text(VibeCodeDescribeScreen.conflictMessage(c, name: vm.slug))
        }
    }

    /// The label the address will have: the typed name, the one the box
    /// chose, or a stand-in until the repo is checked.
    private var addressLabel: String {
        if !vm.slug.isEmpty { return vm.slug }
        return vm.assignedName ?? "<repo name>"
    }

    @ViewBuilder
    private func nameStatus(c: FSColors) -> some View {
        if let ch = currentCheck, !ch.ok {
            Label(ch.kind == "invalid" ? (ch.message ?? String(localized: "That can't be a web address."))
                  : VibeCodeDescribeScreen.conflictMessage(ch, name: vm.slug),
                  systemImage: "exclamationmark.triangle.fill")
                .font(FS.font.bodySm()).foregroundColor(c.danger)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("build-git-name-taken")
        } else if let ch = currentCheck, ch.ok, ch.name != nil {
            Label("Available", systemImage: "checkmark.circle.fill")
                .font(FS.font.bodySm()).foregroundColor(c.success)
        } else if vm.slug.isEmpty {
            Text("Leave it blank to name it after the repo\(vm.ref.isEmpty ? "" : " and branch").")
                .font(FS.font.bodySm()).foregroundColor(c.textMuted)
        }
    }

    /// A repo without a manifest gets the plain sentence; a broken manifest
    /// keeps the box's reason, which says what is wrong with it.
    static func notReadyText(_ r: BuildGitResponse) -> String {
        r.reason.hasPrefix("no flagship.app.json") ? notAdaptedText : r.reason
    }
    static let notAdaptedText = String(localized: "This repo is not yet adapted for Flagship.")
    static let adaptButton = String(localized: "Use AI to adapt and deploy")
    static let runAgainButton = String(localized: "Run the AI again")
    static let deployKeptButton = String(localized: "Deploy it")
    static let shareToggle = String(localized: "Anonymously share your adaptation")
    static let shareNote = String(localized: "Others can then install this repo without AI. Nothing about you or your server is included.")
    static let checkAgain = String(localized: "Check again")

    /// The not-ready card shows an adapt failure inside itself.
    private var showsNotReadyCard: Bool {
        if case .verdict(let r) = vm.phase { return !r.fit }
        return false
    }

    private var checking: Bool {
        if case .checking = vm.phase { return true }
        return false
    }
    private var checkLabel: String { checking ? String(localized: "Cloning…") : String(localized: "Check repo") }

    @ViewBuilder
    private func verdict(c: FSColors) -> some View {
        switch vm.phase {
        case .idle, .checking:
            EmptyView()
        case .verdict(let r):
            if r.fit {
                FSCard {
                    HStack(spacing: FS.space.s2) {
                        Image(systemName: "checkmark.seal.fill").foregroundColor(c.success)
                        Text("Flagship-ready").font(FS.font.h4()).foregroundColor(c.text)
                        Spacer(minLength: FS.space.s2)
                        checkAgainButton(c: c)
                    }
                    Text(r.fileCount == 1 ? String(localized: "\(r.reason) — \(r.fileCount) file.") : String(localized: "\(r.reason) — \(r.fileCount) files."))
                        .font(FS.font.bodySm()).foregroundColor(c.textMuted)
                    FSPrimaryButton(String(localized: "Install it"), block: true) { Task { await vm.deploy() } }
                        .accessibilityIdentifier("build-git-deploy")
                    journalLink(c: c)
                }
            } else {
                FSCard {
                    HStack(alignment: .top, spacing: FS.space.s2) {
                        Text(Self.notReadyText(r)).font(FS.font.body()).foregroundColor(c.text)
                            .fixedSize(horizontal: false, vertical: true)
                        Spacer(minLength: FS.space.s2)
                        checkAgainButton(c: c)
                    }
                    if let err = vm.errorMessage {
                        Text(err).font(FS.font.bodySm()).foregroundColor(c.danger)
                            .fixedSize(horizontal: false, vertical: true)
                            .textSelection(.enabled)
                            .accessibilityIdentifier("build-git-adapt-error")
                    }
                    if vm.relayFailed {
                        FSSecondaryButton(AiKeyRelayCopy.turnOff, block: true) { vm.turnRelayOffForAdaptKey() }
                            .accessibilityIdentifier("build-git-relay-off")
                    }
                    if vm.keptFiles {
                        // The box kept what the cut-off run wrote: put it live as is.
                        FSSecondaryButton(Self.deployKeptButton, block: true) { Task { await vm.deploy() } }
                            .accessibilityIdentifier("build-git-deploy-kept")
                    }
                    if vm.sealed {
                        // This build went to the box to go live; a new AI run
                        // needs a new build.
                        FSPrimaryButton(Self.checkAgain, enabled: vm.canCheck && !nameRefused, block: true) {
                            Task { await vm.checkRepo() }
                        }
                        .accessibilityIdentifier("build-git-check-again-sealed")
                    } else {
                        FSPrimaryButton(vm.keptFiles ? Self.runAgainButton : Self.adaptButton, block: true) { onBuildWithAI() }
                            .accessibilityIdentifier("build-git-adapt")
                        VStack(alignment: .leading, spacing: FS.space.s1) {
                            Toggle(Self.shareToggle, isOn: $vm.share)
                                .font(FS.font.body())
                                .tint(c.accent)
                                .accessibilityIdentifier("build-git-share")
                            Text(Self.shareNote)
                                .font(FS.font.bodySm()).foregroundColor(c.textMuted)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    journalLink(c: c)
                }
            }
        case .adapting(let progress, let stage):
            FSCard {
                HStack(spacing: FS.space.s2) {
                    ProgressView()
                    Text(BuildGitViewModel.adaptingText(stage: stage)).font(FS.font.body()).foregroundColor(c.textMuted)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("build-git-adapting")
                }
                if let progress, !progress.isEmpty {
                    Text(progress).font(FS.font.bodySm()).foregroundColor(c.textMuted)
                        .lineLimit(2)
                        .accessibilityIdentifier("build-git-progress")
                }
                Text("This can take several minutes. You can leave this screen; Build sessions shows how it went.")
                    .font(FS.font.bodySm()).foregroundColor(c.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
            }
        case .adapted(let n):
            FSCard {
                HStack(spacing: FS.space.s2) {
                    Image(systemName: "checkmark.seal.fill").foregroundColor(c.success)
                    Text("Adapted").font(FS.font.h4()).foregroundColor(c.text)
                }
                Text(n == 0 ? String(localized: "The AI rewrote this repo into a Flagship service.") : n == 1 ? String(localized: "The AI rewrote this repo into a Flagship service (\(n) file).") : String(localized: "The AI rewrote this repo into a Flagship service (\(n) files)."))
                    .font(FS.font.bodySm()).foregroundColor(c.textMuted)
                FSPrimaryButton(String(localized: "Install it"), block: true) { Task { await vm.deploy() } }
                    .accessibilityIdentifier("build-git-deploy")
                adapterExport(c: c)
                journalLink(c: c)
            }
        case .deploying:
            FSCard {
                HStack(spacing: FS.space.s2) {
                    ProgressView()
                    Text("Installing…").font(FS.font.body()).foregroundColor(c.textMuted)
                }
            }
        case .installed(let url):
            FSCard {
                HStack(spacing: FS.space.s2) {
                    Image(systemName: "checkmark.seal.fill").foregroundColor(c.success)
                    Text("Installed").font(FS.font.h4()).foregroundColor(c.text)
                }
                Link(destination: URL(string: url) ?? URL(string: "https://flagship.services")!) {
                    Text(url).font(FS.font.mono()).foregroundColor(c.primary)
                        .lineLimit(1).truncationMode(.middle)
                }
                adapterExport(c: c)
            }
        }
    }

    /// For the repo's author: the file to commit so every Flagship server
    /// runs the repo this way.
    @ViewBuilder
    private func adapterExport(c: FSColors) -> some View {
        FSSecondaryButton(vm.exportingAdapter ? String(localized: "Preparing…") : String(localized: "Get flagship.app.json"), block: true) {
            Task { await vm.exportAdapter() }
        }
        .accessibilityIdentifier("build-git-export")
        Text("Is this your repo? Commit this file at its root and every Flagship server will run it this way.")
            .font(FS.font.bodySm()).foregroundColor(c.textMuted)
            .fixedSize(horizontal: false, vertical: true)
    }

    /// Stands in for "Check repo" while a verdict card hides it.
    private func checkAgainButton(c: FSColors) -> some View {
        Button {
            Task { await vm.checkRepo() }
        } label: {
            Image(systemName: "arrow.clockwise")
                .font(FS.font.scaled(17, weight: .semibold))
                .foregroundColor(vm.canCheck && !nameRefused ? c.primary : c.textMuted)
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!vm.canCheck || nameRefused)
        .padding(.vertical, -FS.space.s2)
        .accessibilityLabel(Self.checkAgain)
        .accessibilityIdentifier("build-git-check-again")
    }

    @ViewBuilder
    private func journalLink(c: FSColors) -> some View {
        if let id = vm.buildId {
            Button(action: { onViewJournal(id) }) {
                Text("View build journal →").font(FS.font.bodySm()).foregroundColor(c.primary)
            }
            .buttonStyle(.plain)
        }
    }
}

// MARK: - MCP

public struct BuildMcpScreen: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable var vm: BuildMcpViewModel
    var onViewJournal: (String) -> Void = { _ in }
    /// Copy a string to the pasteboard + surface a confirmation.
    var onCopy: (String, String) -> Void = { _, _ in }

    public init(
        vm: BuildMcpViewModel,
        onViewJournal: @escaping (String) -> Void = { _ in },
        onCopy: @escaping (String, String) -> Void = { _, _ in }
    ) {
        self.vm = vm
        self.onViewJournal = onViewJournal
        self.onCopy = onCopy
    }

    public var body: some View {
        let c = FSColors.scheme(scheme)
        FSScreen {
            ScrollView {
                VStack(alignment: .leading, spacing: FS.space.s4) {
                    Spacer().frame(height: FS.space.s6)
                    Text("Connect your IDE").font(FS.font.h2())
                    if vm.editingName == nil { RunsOnLine() }
                    if let name = vm.editingName {
                        Text("Your editor's agent changes \(name) on your server, starting from its current code, using your own AI subscription. Deploying from the IDE replaces the running version; its address and data stay the same.")
                            .font(FS.font.body()).foregroundColor(c.textMuted)
                            .fixedSize(horizontal: false, vertical: true)
                    } else {
                        Text("Your editor's agent builds against your server using your OWN AI subscription. No model key is stored on the server.")
                            .font(FS.font.body()).foregroundColor(c.textMuted)
                    }

                    if vm.connection == nil {
                        FSPrimaryButton(vm.isCreating ? String(localized: "Creating…") : String(localized: "Create a connection"),
                                        enabled: !vm.isCreating, block: true) {
                            Task { await vm.createConnection() }
                        }
                        .accessibilityIdentifier("build-mcp-create")
                    } else {
                        connectionCard(c: c)
                    }

                    if let err = vm.errorMessage {
                        ErrorCard(message: err)
                    }
                    Spacer().frame(height: FS.space.s8)
                }
                .padding(.horizontal, FS.space.s6)
                .fsReadingColumn()
            }
        }
        .navigationTitle("Connect IDE")
        .navigationBarTitleDisplayMode(.inline)
    }

    @ViewBuilder
    private func connectionCard(c: FSColors) -> some View {
        if let conn = vm.connection {
            FSCard {
                Text("Add this to your IDE's own settings, not a file in your project (the address names your server). The key works only for this build.")
                    .font(FS.font.bodySm()).foregroundColor(c.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("build-mcp-user-settings")

                CopyableRow(label: "URL", value: conn.url, mono: true) {
                    onCopy(conn.url, String(localized: "URL copied"))
                }
                CopyableRow(label: String(localized: "Key"), value: conn.key, mono: true) {
                    onCopy(conn.key, String(localized: "Key copied"))
                }

                if vm.ideChoices.count > 1 {
                    Picker("IDE", selection: $vm.selectedIde) {
                        ForEach(vm.ideChoices) { ide in Text(ide.name).tag(ide.id) }
                    }
                    .pickerStyle(.segmented)
                    .accessibilityIdentifier("build-mcp-ide-picker")
                }
                if let whereText = vm.currentIde?.where, !whereText.isEmpty {
                    Text(whereText)
                        .font(FS.font.bodySm()).foregroundColor(c.textMuted)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("build-mcp-ide-where")
                }

                FSSecondaryButton(String(localized: "Copy IDE config"), block: true) {
                    onCopy(vm.ideConfigJson, String(localized: "Config copied"))
                }
                .accessibilityIdentifier("build-mcp-copy-config")

                if !vm.ideConfigJson.isEmpty {
                    ScrollView(.horizontal, showsIndicators: false) {
                        Text(vm.ideConfigJson)
                            .font(FS.font.mono())
                            .foregroundColor(c.text)
                            .padding(FS.space.s3)
                    }
                    .background(c.surfaceSunken)
                    .clipShape(RoundedRectangle(cornerRadius: FS.radius.sm, style: .continuous))
                    .accessibilityIdentifier("build-mcp-ide-config")
                }

                if let command = vm.ideCommand {
                    Text("Or run:").font(FS.font.bodySm()).foregroundColor(c.textMuted)
                    ScrollView(.horizontal, showsIndicators: false) {
                        Text(command)
                            .font(FS.font.mono())
                            .foregroundColor(c.text)
                            .padding(FS.space.s3)
                            .accessibilityIdentifier("build-mcp-ide-command")
                    }
                    .background(c.surfaceSunken)
                    .clipShape(RoundedRectangle(cornerRadius: FS.radius.sm, style: .continuous))
                    FSSecondaryButton(String(localized: "Copy command"), block: true) {
                        onCopy(command, String(localized: "Command copied"))
                    }
                    .accessibilityIdentifier("build-mcp-copy-command")
                }

                HStack(spacing: FS.space.s2) {
                    FSSecondaryButton(vm.isRotating ? String(localized: "Regenerating…") : String(localized: "Regenerate key"), block: true) {
                        Task { await vm.rotateKey() }
                    }
                    .accessibilityIdentifier("build-mcp-rotate")
                    FSSecondaryButton(String(localized: "View journal"), block: true) {
                        if let id = vm.buildId { onViewJournal(id) }
                    }
                }

                Text("Your editor's agent writes files, validates, requests any secrets (value-free), and deploys. You can also deploy here once it's done:")
                    .font(FS.font.bodySm()).foregroundColor(c.textMuted)
                    .fixedSize(horizontal: false, vertical: true)

                FSPrimaryButton(vm.isDeploying ? String(localized: "Deploying…") : String(localized: "Deploy now"),
                                enabled: !vm.isDeploying, block: true) {
                    Task { await vm.deploy() }
                }
                .accessibilityIdentifier("build-mcp-deploy")

                if let url = vm.deployedUrl {
                    Link(destination: URL(string: url) ?? URL(string: "https://flagship.services")!) {
                        Text(url).font(FS.font.mono()).foregroundColor(c.primary)
                            .lineLimit(1).truncationMode(.middle)
                    }
                }

                envRequests(c: c)
            }
        }
    }

    @ViewBuilder
    private func envRequests(c: FSColors) -> some View {
        if !vm.envRequests.isEmpty {
            Divider().padding(.vertical, FS.space.s2)
            Text("Your IDE asked for these secrets")
                .font(FS.font.caption()).foregroundColor(c.text)
            // VALUE-FREE: the editor + its AI never see or send the value —
            // you set it on your box from Configure environment after the
            // service is installed; it never travels through your IDE.
            Text("The editor and its AI never see the value — you set it here on your server. Open Configure environment on the service after it's deployed and enter each value there.")
                .font(FS.font.bodySm()).foregroundColor(c.textMuted)
                .fixedSize(horizontal: false, vertical: true)
            ForEach(vm.envRequests) { req in
                VStack(alignment: .leading, spacing: 2) {
                    HStack {
                        Text(req.name).font(FS.font.mono()).foregroundColor(c.text)
                        Spacer()
                        if req.currentlySet {
                            FSPill(String(localized: "Set"), kind: .online)
                        } else {
                            FSPill(String(localized: "Needs you"), kind: .idle)
                        }
                    }
                    if let why = req.why, !why.isEmpty {
                        Text(why).font(FS.font.bodySm()).foregroundColor(c.textMuted)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .padding(.vertical, 2)
            }
            FSSecondaryButton(String(localized: "Refresh"), block: true) {
                Task { await vm.refreshEnvRequests() }
            }
        }
    }
}

private struct CopyableRow: View {
    @Environment(\.colorScheme) private var scheme
    let label: String
    let value: String
    var mono: Bool = false
    let onCopy: () -> Void
    var body: some View {
        let c = FSColors.scheme(scheme)
        HStack(spacing: FS.space.s2) {
            Text(label).font(FS.font.caption()).foregroundColor(c.textMuted)
                .frame(width: 36, alignment: .leading)
            Text(value)
                .font(mono ? FS.font.mono() : FS.font.bodySm())
                .foregroundColor(c.text)
                .lineLimit(1).truncationMode(.middle)
                .frame(maxWidth: .infinity, alignment: .leading)
            Button(action: onCopy) {
                Image(systemName: "doc.on.doc").foregroundColor(c.accent)
            }
            .buttonStyle(.plain)
        }
        .padding(.vertical, 2)
    }
}

// MARK: - Journal

public struct BuildJournalScreen: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable var vm: BuildJournalViewModel
    /// Open a chat: its session id and, when the list spans servers, the
    /// server it runs on.
    var onResume: (String, String?) -> Void = { _, _ in }
    /// Open a kept git build on its server, to run the AI again or deploy.
    var onOpenGitBuild: (String, String?) -> Void = { _, _ in }
    @State private var confirmDiscard: VibeCodeSessionMeta?
    @State private var confirmDiscardBuild: BuildSummary?

    public init(vm: BuildJournalViewModel, onResume: @escaping (String, String?) -> Void = { _, _ in },
                onOpenGitBuild: @escaping (String, String?) -> Void = { _, _ in }) {
        self.vm = vm
        self.onResume = onResume
        self.onOpenGitBuild = onOpenGitBuild
    }

    public var body: some View {
        let c = FSColors.scheme(scheme)
        FSScreen {
            ScrollView {
                VStack(alignment: .leading, spacing: FS.space.s4) {
                    Spacer().frame(height: FS.space.s6)
                    if vm.openedBuildId == nil {
                        listBody(c: c)
                    } else {
                        Button(action: { Task { await vm.loadList() } }) {
                            HStack(spacing: 4) {
                                Image(systemName: "chevron.left")
                                Text("All builds")
                            }
                            .font(FS.font.bodySm()).foregroundColor(c.primary)
                        }
                        .buttonStyle(.plain)
                        Text("Build timeline").font(FS.font.h2())
                        failureCard(c: c)
                        detailBody(c: c)
                    }
                    Spacer().frame(height: FS.space.s8)
                }
                .padding(.horizontal, FS.space.s6)
                .fsReadingColumn()
            }
        }
        .navigationTitle("Build sessions")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await vm.loadList() }
        .confirmationDialog(
            "Discard this build?",
            isPresented: Binding(get: { confirmDiscard != nil }, set: { if !$0 { confirmDiscard = nil } }),
            titleVisibility: .visible,
            presenting: confirmDiscard
        ) { session in
            Button("Discard build", role: .destructive) { Task { await vm.discard(session) } }
        } message: { session in
            Text(Self.discardMessage(session))
        }
        .confirmationDialog(
            "Discard this build?",
            isPresented: Binding(get: { confirmDiscardBuild != nil }, set: { if !$0 { confirmDiscardBuild = nil } }),
            titleVisibility: .visible,
            presenting: confirmDiscardBuild
        ) { b in
            Button("Discard build", role: .destructive) { Task { await vm.discard(build: b) } }
        } message: { b in
            Text("This deletes what was imported or written on your server. Its name, \"\(b.displayName)\", becomes free again.")
        }
    }

    /// "Started 2m ago · on Home" when the list spans servers.
    static func subtitle(_ base: String, on server: String?) -> String {
        server.map { String(localized: "\(base) · on \($0)") } ?? base
    }

    static func unreachableNote(_ names: [String]) -> String {
        let list = names.joined(separator: ", ")
        return names.count == 1 ? String(localized: "Couldn't reach \(list), so its builds aren't listed.")
            : String(localized: "Couldn't reach \(list), so their builds aren't listed.")
    }

    static func discardMessage(_ session: VibeCodeSessionMeta) -> String {
        let freed = session.name.map { " Its name, \"\($0)\", becomes free again." } ?? ""
        return String(localized: "This stops the AI and deletes what it has written on your server.\(freed)")
    }

    @ViewBuilder
    private func listBody(c: FSColors) -> some View {
        switch vm.list {
        case .idle, .loading:
            ProgressView().frame(maxWidth: .infinity)
        case .failed(let msg):
            ErrorCard(message: msg)
        case .loaded(let builds):
            let open = vm.openBuilds(builds)
            if !vm.unreachableServers.isEmpty {
                Text(Self.unreachableNote(vm.unreachableServers))
                    .font(FS.font.caption()).foregroundColor(c.warning)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("build-sessions-unreachable")
            }
            if !vm.liveSessions.isEmpty || !open.isEmpty {
                Text(vm.spansServers ? String(localized: "Open on your servers") : "Open on your server")
                    .font(FS.font.caption()).foregroundColor(c.textMuted)
                ForEach(open) { b in
                    Button(action: { Task { await vm.loadDetail(buildId: b.buildId) } }) {
                        FSListRow(
                            leading: .icon(modeIcon(b.mode), color: c.accent),
                            title: b.displayName,
                            subtitle: Self.subtitle(String(localized: "Started \(Self.timeString(b.startedAt))"), on: vm.serverName(forBuild: b.buildId)),
                            detail: nil,
                            below: { FSPill(b.methodLabel, kind: .idle) }
                        ) {
                            Image(systemName: "chevron.right").foregroundColor(c.textMuted)
                        }
                    }
                    .buttonStyle(.plain)
                    HStack {
                        Spacer()
                        Button("Discard…", role: .destructive) { confirmDiscardBuild = b }
                            .font(FS.font.bodySm())
                            .accessibilityIdentifier("build-discard-\(b.buildId)")
                    }
                    .padding(.top, -FS.space.s2)
                }
                ForEach(vm.liveSessions) { session in
                    Button(action: { onResume(session.sessionId, vm.sessionServer[session.sessionId]) }) {
                        FSListRow(
                            leading: .icon("sparkles", color: session.isActive ? c.success : c.textMuted),
                            title: vm.name(for: session, builds: builds),
                            subtitle: Self.subtitle(String(localized: "Started \(Self.timeString(session.startedAt))"),
                                                    on: vm.serverName(forSession: session.sessionId)),
                            detail: nil,
                            below: {
                                HStack(spacing: FS.space.s2) {
                                    FSPill(Self.sessionLabel(session.status), kind: Self.sessionPill(session.status))
                                    FSPill(BuildSummary.methodLabel("scratch"), kind: .idle)
                                }
                            }
                        ) {
                            Text(Self.sessionAction(session.status))
                                .font(FS.font.scaled(14, weight: .semibold))
                                .foregroundColor(session.isActive ? c.success : c.accent)
                        }
                        .overlay(RoundedRectangle(cornerRadius: FS.radius.md, style: .continuous)
                            .stroke(session.isActive ? c.success.opacity(0.6) : .clear, lineWidth: 1))
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("build-session-\(session.sessionId)")
                    if session.canDiscard {
                        HStack {
                            Spacer()
                            Button("Discard…", role: .destructive) { confirmDiscard = session }
                                .font(FS.font.bodySm())
                                .accessibilityIdentifier("build-session-discard-\(session.sessionId)")
                        }
                        .padding(.top, -FS.space.s2)
                    }
                }
                if let err = vm.discardError {
                    ErrorCard(message: err)
                }
            }
            let ended = vm.endedBuilds(builds)
            if !ended.isEmpty {
                Text("Past builds").font(FS.font.caption()).foregroundColor(c.textMuted)
                    .padding(.top, vm.liveSessions.isEmpty && open.isEmpty ? 0 : FS.space.s2)
            }
            if builds.isEmpty && vm.liveSessions.isEmpty && open.isEmpty {
                FSCard {
                    Text("No builds yet.").font(FS.font.body()).foregroundColor(c.textMuted)
                }
            } else {
                ForEach(ended) { b in
                    Button(action: { Task { await vm.loadDetail(buildId: b.buildId) } }) {
                        FSListRow(
                            leading: .icon(modeIcon(b.mode), color: c.accent),
                            title: b.displayName,
                            subtitle: Self.subtitle((b.entryCount == 1 ? String(localized: "Started \(Self.timeString(b.startedAt)) · \(b.entryCount) step") : String(localized: "Started \(Self.timeString(b.startedAt)) · \(b.entryCount) steps")),
                                                    on: vm.serverName(forBuild: b.buildId)),
                            detail: nil,
                            below: { FSPill(b.methodLabel, kind: .idle) }
                        ) {
                            Image(systemName: "chevron.right").foregroundColor(c.textMuted)
                        }
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    /// A kept build whose last run failed (a restart cut off the AI or the
    /// go-live): the box's sentence, and a way back into the build.
    @ViewBuilder
    private func failureCard(c: FSColors) -> some View {
        if let id = vm.openedBuildId, let reason = vm.openedFailure {
            FSCard {
                Text(reason).font(FS.font.body()).foregroundColor(c.danger)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("build-journal-failed-reason")
                if vm.openedMode == "git" {
                    FSPrimaryButton(vm.openedSealed ? String(localized: "Deploy it again") : String(localized: "Run the AI again or deploy"), block: true) {
                        onOpenGitBuild(id, vm.buildServer[id])
                    }
                    .accessibilityIdentifier("build-journal-open-git")
                }
            }
        }
    }

    @ViewBuilder
    private func detailBody(c: FSColors) -> some View {
        switch vm.detail {
        case .idle, .loading:
            ProgressView().frame(maxWidth: .infinity)
        case .failed(let msg):
            ErrorCard(message: msg)
        case .loaded(let entries):
            if entries.isEmpty {
                FSCard {
                    Text("No steps recorded for this build.").font(FS.font.body()).foregroundColor(c.textMuted)
                }
            } else {
                FSCard {
                    ForEach(entries) { e in
                        VStack(alignment: .leading, spacing: 4) {
                            HStack(spacing: FS.space.s2) {
                                Text(Self.timeString(e.ts)).font(FS.font.caption()).foregroundColor(c.textMuted)
                                JournalBadge(text: e.kind)
                                JournalBadge(text: e.actor)
                            }
                            Text(e.summary).font(FS.font.body()).foregroundColor(c.text)
                                .fixedSize(horizontal: false, vertical: true)
                            if let d = e.detail, !d.isEmpty {
                                Text(d).font(FS.font.bodySm()).foregroundColor(c.textMuted)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                            if e.seq != entries.last?.seq {
                                Divider().padding(.top, 2)
                            }
                        }
                        .padding(.vertical, 4)
                    }
                }
            }
        }
    }

    static func sessionLabel(_ status: String) -> String {
        switch status {
        case "streaming": return String(localized: "AI is working")
        case "awaiting-tool-response": return String(localized: "Waiting for you")
        case "ready-to-deploy": return String(localized: "Ready to deploy")
        case "deploying": return String(localized: "Deploying")
        case "deployed": return String(localized: "Deployed")
        case "cancelled": return String(localized: "Cancelled")
        case "failed": return String(localized: "Failed")
        default: return String(localized: "Stopped")
        }
    }

    /// What opening the chat does: carry on with it, watch it run, or look.
    static func sessionAction(_ status: String) -> String {
        switch status {
        case "awaiting-tool-response", "ready-to-deploy", "failed": return String(localized: "Continue")
        case "streaming", "deploying": return String(localized: "Resume")
        default: return String(localized: "Open")
        }
    }

    static func sessionPill(_ status: String) -> FSPillKind {
        switch status {
        case "awaiting-tool-response", "ready-to-deploy": return .pending
        case "streaming", "deploying": return .provisioning
        case "deployed": return .online
        case "failed": return .offline
        default: return .idle
        }
    }

    private func modeIcon(_ mode: String) -> String {
        switch mode {
        case "git": return "arrow.down.circle"
        case "mcp": return "laptopcomputer"
        default:    return "sparkles"
        }
    }

    private static func timeString(_ ms: Int64) -> String {
        let d = Date(timeIntervalSince1970: Double(ms) / 1000)
        let f = DateFormatter()
        f.dateStyle = .short
        f.timeStyle = .short
        return f.string(from: d)
    }
}

private struct JournalBadge: View {
    @Environment(\.colorScheme) private var scheme
    let text: String
    var body: some View {
        let c = FSColors.scheme(scheme)
        Text(text)
            .font(FS.font.scaled(11, weight: .medium))
            .foregroundColor(c.textMuted)
            .padding(.horizontal, 8).padding(.vertical, 2)
            .background(c.surfaceSunken)
            .clipShape(Capsule())
    }
}
