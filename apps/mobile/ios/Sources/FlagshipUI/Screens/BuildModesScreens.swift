import SwiftUI
import FlagshipAPI

// Build-a-service multi-mode screens. The create-a-service entry opens the
// chooser ("how do you want to build it?"), which fans into:
//   - scratch     → the existing vibe-code flow
//   - git         → BuildGitScreen (URL → verdict → install / adapt)
//   - mcp         → BuildMcpScreen (connect Cursor/Cline with your own AI)
// plus a "View past builds" link into BuildJournalScreen.
//
// Mirrors the canonical webapp `views/build-*.js`.

// MARK: - Chooser

/// The first question of the create-a-service flow.
public struct BuildSourceChooserScreen: View {
    @Environment(\.colorScheme) private var scheme
    var onScratch: () -> Void = {}
    var onGit: () -> Void = {}
    var onMcp: () -> Void = {}
    var onPastBuilds: () -> Void = {}

    public init(
        onScratch: @escaping () -> Void = {},
        onGit: @escaping () -> Void = {},
        onMcp: @escaping () -> Void = {},
        onPastBuilds: @escaping () -> Void = {}
    ) {
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
                    Spacer().frame(height: FS.space.s8)
                    Text("How do you want to build it?").font(FS.font.h2())
                    Text("Every option ends up the same way — installed and running on your own server.")
                        .font(FS.font.body()).foregroundColor(c.textMuted)
                        .padding(.bottom, FS.space.s2)

                    BuildSourceTile(
                        icon: "sparkles",
                        title: "Start from scratch with AI",
                        subtitle: "Describe it in plain English. The AI writes it and deploys it for you.",
                        action: onScratch
                    )
                    .accessibilityIdentifier("build-src-scratch")

                    BuildSourceTile(
                        icon: "arrow.down.circle",
                        title: "Import from a Git repo",
                        subtitle: "Paste a repo URL. If it's Flagship-ready we install it as-is, otherwise the AI adapts it.",
                        action: onGit
                    )
                    .accessibilityIdentifier("build-src-git")

                    BuildSourceTile(
                        icon: "laptopcomputer",
                        title: "Connect your IDE",
                        subtitle: "Build from Cursor or Cline using your own AI. No model key ever touches the box.",
                        action: onMcp
                    )
                    .accessibilityIdentifier("build-src-mcp")

                    Button(action: onPastBuilds) {
                        HStack(spacing: 8) {
                            Image(systemName: "clock.arrow.circlepath").foregroundColor(c.primary)
                            Text("View past builds").font(.system(size: 15, weight: .semibold)).foregroundColor(c.primary)
                            Spacer()
                        }
                        .padding(.vertical, FS.space.s2)
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("build-source-journal-link")

                    Spacer().frame(height: FS.space.s8)
                }
                .padding(.horizontal, FS.space.s6)
                .fsReadingColumn()
            }
        }
        .navigationTitle("Build a service")
        .navigationBarTitleDisplayMode(.inline)
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
                    RoundedRectangle(cornerRadius: FS.radius.md)
                        .fill(c.softTint())
                        .frame(width: 40, height: 40)
                    Image(systemName: icon).foregroundColor(c.primary)
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
                RoundedRectangle(cornerRadius: FS.radius.lg).stroke(c.border, lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: FS.radius.lg))
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Git

public struct BuildGitScreen: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable var vm: BuildGitViewModel
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
        onBuildWithAI: @escaping () -> Void = {}
    ) {
        self.vm = vm
        self.onViewJournal = onViewJournal
        self.onFallBackToScratch = onFallBackToScratch
        self.onBuildWithAI = onBuildWithAI
    }

    public var body: some View {
        let c = FSColors.scheme(scheme)
        FSScreen {
            ScrollView {
                VStack(alignment: .leading, spacing: FS.space.s4) {
                    Spacer().frame(height: FS.space.s6)
                    Text("Import from a Git repo").font(FS.font.h2())
                    Text("Paste a repo URL. We clone it on your box and check whether it's ready to run as a Flagship service.")
                        .font(FS.font.body()).foregroundColor(c.textMuted)

                    FSField(value: $vm.gitUrl, label: "Repository URL",
                            placeholder: "https://github.com/you/app", keyboard: .URL)
                    FSField(value: $vm.ref, label: "Branch or tag (optional)",
                            placeholder: "main")

                    FSPrimaryButton(checkLabel, enabled: vm.canCheck && !checking, block: true) {
                        Task { await vm.checkRepo() }
                    }
                    .accessibilityIdentifier("build-git-check")

                    verdict(c: c)

                    if let err = vm.errorMessage {
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
    }

    private var checking: Bool {
        if case .checking = vm.phase { return true }
        return false
    }
    private var checkLabel: String { checking ? "Cloning…" : "Check repo" }

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
                    }
                    Text("\(r.reason) — \(r.fileCount) file\(r.fileCount == 1 ? "" : "s").")
                        .font(FS.font.bodySm()).foregroundColor(c.textMuted)
                    FSPrimaryButton("Install it", block: true) { Task { await vm.deploy() } }
                        .accessibilityIdentifier("build-git-deploy")
                    journalLink(c: c)
                }
            } else {
                FSCard {
                    Text("Not Flagship-ready yet").font(FS.font.h4()).foregroundColor(c.text)
                    Text(r.reason).font(FS.font.bodySm()).foregroundColor(c.textMuted)
                        .fixedSize(horizontal: false, vertical: true)
                    FSSecondaryButton("Build with AI instead", block: true) { onBuildWithAI() }
                        .accessibilityIdentifier("build-git-adapt")
                    Text("The AI rewrites this repo into a Flagship service — adds the manifest, removes its own login, and wires it to your box's data layer.")
                        .font(FS.font.bodySm()).foregroundColor(c.textMuted)
                        .fixedSize(horizontal: false, vertical: true)
                    journalLink(c: c)
                }
            }
        case .adapting:
            FSCard {
                HStack(spacing: FS.space.s2) {
                    ProgressView()
                    Text("Adapting…").font(FS.font.body()).foregroundColor(c.textMuted)
                }
            }
        case .adapted(let n):
            FSCard {
                HStack(spacing: FS.space.s2) {
                    Image(systemName: "checkmark.seal.fill").foregroundColor(c.success)
                    Text("Adapted").font(FS.font.h4()).foregroundColor(c.text)
                }
                Text("The AI rewrote this repo into a Flagship service\(n > 0 ? " (\(n) file\(n == 1 ? "" : "s"))" : "").")
                    .font(FS.font.bodySm()).foregroundColor(c.textMuted)
                FSPrimaryButton("Install it", block: true) { Task { await vm.deploy() } }
                    .accessibilityIdentifier("build-git-deploy")
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
            }
        }
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
                    Text("Your editor's agent builds against your box using your OWN AI subscription. No model key is stored on the box.")
                        .font(FS.font.body()).foregroundColor(c.textMuted)

                    if vm.connection == nil {
                        FSPrimaryButton(vm.isCreating ? "Creating…" : "Create a connection",
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
                Text("Paste this into your IDE's MCP settings (Cursor: Settings → MCP; Cline: MCP servers). The key works only for this build.")
                    .font(FS.font.bodySm()).foregroundColor(c.textMuted)
                    .fixedSize(horizontal: false, vertical: true)

                CopyableRow(label: "URL", value: conn.url, mono: true) {
                    onCopy(conn.url, "URL copied")
                }
                CopyableRow(label: "Key", value: conn.key, mono: true) {
                    onCopy(conn.key, "Key copied")
                }

                FSSecondaryButton("Copy IDE config", block: true) {
                    onCopy(vm.ideConfigJson, "Config copied")
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
                    .clipShape(RoundedRectangle(cornerRadius: FS.radius.sm))
                }

                HStack(spacing: FS.space.s2) {
                    FSSecondaryButton(vm.isRotating ? "Regenerating…" : "Regenerate key", block: true) {
                        Task { await vm.rotateKey() }
                    }
                    .accessibilityIdentifier("build-mcp-rotate")
                    FSSecondaryButton("View journal", block: true) {
                        if let id = vm.buildId { onViewJournal(id) }
                    }
                }

                Text("Your editor's agent writes files, validates, requests any secrets (value-free), and deploys. You can also deploy here once it's done:")
                    .font(FS.font.bodySm()).foregroundColor(c.textMuted)
                    .fixedSize(horizontal: false, vertical: true)

                FSPrimaryButton(vm.isDeploying ? "Deploying…" : "Deploy now",
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
            Text("The editor and its AI never see the value — you set it here on your box. Open Configure environment on the service after it's deployed and enter each value there.")
                .font(FS.font.bodySm()).foregroundColor(c.textMuted)
                .fixedSize(horizontal: false, vertical: true)
            ForEach(vm.envRequests) { req in
                VStack(alignment: .leading, spacing: 2) {
                    HStack {
                        Text(req.name).font(FS.font.mono()).foregroundColor(c.text)
                        Spacer()
                        if req.currentlySet {
                            FSPill("Set", kind: .online)
                        } else {
                            FSPill("Needs you", kind: .idle)
                        }
                    }
                    if let why = req.why, !why.isEmpty {
                        Text(why).font(FS.font.bodySm()).foregroundColor(c.textMuted)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .padding(.vertical, 2)
            }
            FSSecondaryButton("Refresh", block: true) {
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
                Image(systemName: "doc.on.doc").foregroundColor(c.primary)
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

    public init(vm: BuildJournalViewModel) {
        self.vm = vm
    }

    public var body: some View {
        let c = FSColors.scheme(scheme)
        FSScreen {
            ScrollView {
                VStack(alignment: .leading, spacing: FS.space.s4) {
                    Spacer().frame(height: FS.space.s6)
                    if vm.openedBuildId == nil {
                        Text("Past builds").font(FS.font.h2())
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
                        detailBody(c: c)
                    }
                    Spacer().frame(height: FS.space.s8)
                }
                .padding(.horizontal, FS.space.s6)
                .fsReadingColumn()
            }
        }
        .navigationTitle("Build journal")
        .navigationBarTitleDisplayMode(.inline)
    }

    @ViewBuilder
    private func listBody(c: FSColors) -> some View {
        switch vm.list {
        case .idle, .loading:
            ProgressView().frame(maxWidth: .infinity)
        case .failed(let msg):
            ErrorCard(message: msg)
        case .loaded(let builds):
            if builds.isEmpty {
                FSCard {
                    Text("No builds yet.").font(FS.font.body()).foregroundColor(c.textMuted)
                }
            } else {
                ForEach(builds) { b in
                    Button(action: { Task { await vm.loadDetail(buildId: b.buildId) } }) {
                        FSListRow(
                            leading: .icon(modeIcon(b.mode), color: c.primary),
                            title: b.serviceId ?? b.mode.capitalized,
                            subtitle: "\(b.mode) · \(b.entryCount) step\(b.entryCount == 1 ? "" : "s") · last: \(b.lastKind)",
                            detail: nil
                        ) {
                            Image(systemName: "chevron.right").foregroundColor(c.textMuted)
                        }
                    }
                    .buttonStyle(.plain)
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
            .font(.system(size: 11, weight: .medium))
            .foregroundColor(c.textMuted)
            .padding(.horizontal, 8).padding(.vertical, 2)
            .background(c.surfaceSunken)
            .clipShape(Capsule())
    }
}
