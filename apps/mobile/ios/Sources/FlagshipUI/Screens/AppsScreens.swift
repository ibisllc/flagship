import SwiftUI

/// Apps list + Apps detail screens (N4).
///
/// AppsListScreen — every installed app, tap → AppDetailScreen.
/// AppDetailScreen — the FINAL DESIGN per-app UX:
///
///   Where should it run?
///     ☑ home   ☑ office   ☐ garage   ☐ all current and future
///
///   Let instances talk to each other?
///     ● Yes   ○ No
///
///   [ Save ]
///
/// Plus a URLs section listing each FQDN's kind / owner / claim controls.

public struct AppsListScreen: View {
    @Environment(\.colorScheme) private var scheme
    @State private var apps: [AppSummary] = []
    var onOpenApp: (String) -> Void = { _ in }
    var onOpenVibeCode: () -> Void = { }
    var onOpenMarketplace: () -> Void = { }

    public init(
        apps: [AppSummary] = [],
        onOpenApp: @escaping (String) -> Void = { _ in },
        onOpenVibeCode: @escaping () -> Void = {},
        onOpenMarketplace: @escaping () -> Void = {}
    ) {
        self._apps = State(initialValue: apps)
        self.onOpenApp = onOpenApp
        self.onOpenVibeCode = onOpenVibeCode
        self.onOpenMarketplace = onOpenMarketplace
    }

    public var body: some View {
        let c = FSColors.scheme(scheme)
        ScrollView {
            VStack(alignment: .leading, spacing: FS.space.s8) {
                VStack(alignment: .leading, spacing: FS.space.s2) {
                    Text("Apps")
                        .font(.system(size: 32, weight: .medium))
                        .foregroundColor(c.text)
                    Text(apps.isEmpty ? "Nothing installed yet." : "\(apps.count) installed")
                        .font(.system(size: 17))
                        .foregroundColor(c.textMuted)
                }
                .padding(.top, FS.space.s10)

                if apps.isEmpty {
                    FSCard {
                        VStack(alignment: .leading, spacing: FS.space.s3) {
                            Text("Build your first app")
                                .font(.system(size: 22, weight: .semibold))
                                .foregroundColor(c.text)
                            Text("Describe what you want in plain English. The AI writes it; the daemon runs it.")
                                .font(.system(size: 16))
                                .foregroundColor(c.textMuted)
                            FSPrimaryButton("Vibe-code an app", block: true, action: onOpenVibeCode)
                            FSGhostButton("Browse marketplace", block: true, action: onOpenMarketplace)
                        }
                    }
                } else {
                    VStack(spacing: FS.space.s3) {
                        ForEach(apps) { app in
                            Button(action: { onOpenApp(app.appId) }) {
                                AppRowView(app: app)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
            }
            .padding(.horizontal, FS.space.s6)
        }
        .background(c.bg.ignoresSafeArea())
    }
}

private struct AppRowView: View {
    @Environment(\.colorScheme) private var scheme
    let app: AppSummary
    var body: some View {
        let c = FSColors.scheme(scheme)
        FSCard {
            HStack {
                VStack(alignment: .leading, spacing: FS.space.s1) {
                    Text(app.name)
                        .font(.system(size: 17, weight: .semibold))
                        .foregroundColor(c.text)
                    HStack(spacing: FS.space.s2) {
                        FSPill(
                            app.runningPodCount > 0 ? "Running on \(app.runningPodCount)" : "Stopped",
                            kind: app.runningPodCount > 0 ? .online : .idle,
                        )
                        if app.siblingsEnabled {
                            FSPill("Siblings on", kind: .provisioning)
                        }
                    }
                }
                Spacer()
            }
        }
    }
}

public struct AppDetailScreen: View {
    @Environment(\.colorScheme) private var scheme
    let app: AppDetail
    let pods: [PodSummary]
    let urls: [UrlEntry]
    @State private var policy: InstallPolicy
    @State private var siblingsEnabled: Bool
    var onSave: (InstallPolicy, Bool) -> Void = { _, _ in }
    var onClaim: (String) -> Void = { _ in }
    var onRelease: (String) -> Void = { _ in }
    var onUninstall: () -> Void = { }

    public init(
        app: AppDetail,
        pods: [PodSummary],
        urls: [UrlEntry],
        onSave: @escaping (InstallPolicy, Bool) -> Void = { _, _ in },
        onClaim: @escaping (String) -> Void = { _ in },
        onRelease: @escaping (String) -> Void = { _ in },
        onUninstall: @escaping () -> Void = { }
    ) {
        self.app = app
        self.pods = pods
        self.urls = urls
        self._policy = State(initialValue: app.policy)
        self._siblingsEnabled = State(initialValue: app.siblingsEnabled)
        self.onSave = onSave
        self.onClaim = onClaim
        self.onRelease = onRelease
        self.onUninstall = onUninstall
    }

    public var body: some View {
        let c = FSColors.scheme(scheme)
        ScrollView {
            VStack(alignment: .leading, spacing: FS.space.s6) {
                VStack(alignment: .leading, spacing: FS.space.s2) {
                    Text(app.name)
                        .font(.system(size: 32, weight: .medium))
                        .foregroundColor(c.text)
                    Text("by \(app.creator)")
                        .font(.system(size: 17))
                        .foregroundColor(c.textMuted)
                }
                .padding(.top, FS.space.s10)

                section("Where should it run?") {
                    FSCard {
                        VStack(alignment: .leading, spacing: FS.space.s2) {
                            ForEach(pods) { pod in
                                Toggle(isOn: Binding(
                                    get: { policy.specificPods.contains(pod.podId) || policy.allCurrentAndFuture },
                                    set: { on in
                                        if policy.allCurrentAndFuture { return }
                                        if on { policy.specificPods.insert(pod.podId) }
                                        else { policy.specificPods.remove(pod.podId) }
                                    },
                                )) {
                                    VStack(alignment: .leading) {
                                        Text(pod.label)
                                            .font(.system(size: 16))
                                            .foregroundColor(c.text)
                                        Text(pod.fqdn)
                                            .font(.system(size: 13))
                                            .foregroundColor(c.textMuted)
                                    }
                                }
                                .disabled(policy.allCurrentAndFuture)
                            }
                            Toggle(isOn: $policy.allCurrentAndFuture) {
                                Text("Run on all current and future boxes")
                                    .font(.system(size: 16))
                                    .foregroundColor(c.text)
                            }
                        }
                    }
                }

                section("Let instances talk to each other?") {
                    FSCard {
                        Picker("", selection: $siblingsEnabled) {
                            Text("Yes").tag(true)
                            Text("No").tag(false)
                        }
                        .pickerStyle(.segmented)
                        if app.siblingsEnabled != siblingsEnabled {
                            Text(siblingsEnabled
                                 ? "Saving will re-open vibe-code with this app's files. The AI will rewrite it to be sibling-aware."
                                 : "Saving will re-open vibe-code. The AI will rewrite it as per-pod independent state.")
                                .font(.system(size: 13))
                                .foregroundColor(c.textMuted)
                        }
                    }
                }

                section("URLs") {
                    VStack(spacing: FS.space.s3) {
                        ForEach(urls) { url in
                            UrlRowView(url: url, onClaim: onClaim, onRelease: onRelease)
                        }
                    }
                }

                FSPrimaryButton("Save", block: true) { onSave(policy, siblingsEnabled) }
                FSGhostButton("Uninstall", block: true, action: onUninstall)
                Spacer().frame(height: FS.space.s12)
            }
            .padding(.horizontal, FS.space.s6)
        }
        .background(c.bg.ignoresSafeArea())
    }

    @ViewBuilder
    private func section<C: View>(_ label: String, @ViewBuilder content: () -> C) -> some View {
        let c = FSColors.scheme(scheme)
        VStack(alignment: .leading, spacing: FS.space.s3) {
            Text(label.uppercased())
                .font(.system(size: 12, weight: .semibold))
                .tracking(1)
                .foregroundColor(c.textMuted)
            content()
        }
    }
}

private struct UrlRowView: View {
    @Environment(\.colorScheme) private var scheme
    let url: UrlEntry
    let onClaim: (String) -> Void
    let onRelease: (String) -> Void
    var body: some View {
        let c = FSColors.scheme(scheme)
        FSCard {
            HStack(alignment: .center) {
                VStack(alignment: .leading, spacing: FS.space.s1) {
                    Text(url.fqdn)
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundColor(c.text)
                    HStack(spacing: FS.space.s2) {
                        FSPill(url.kind, kind: .idle)
                        FSPill(
                            url.ownedBy == nil ? "Unclaimed"
                            : url.ownedBy == "self" ? "On this pod"
                            : "On \(url.ownedBy!)",
                            kind: url.ownedBy == "self" ? .online : .idle,
                        )
                    }
                }
                Spacer()
                if url.canClaim && url.ownedBy != "self" {
                    FSGhostButton("Claim") { onClaim(url.fqdn) }
                } else if url.ownedBy == "self" && url.kind != "canonical" {
                    FSGhostButton("Release") { onRelease(url.fqdn) }
                }
            }
        }
    }
}

public struct AppSummary: Identifiable {
    public let id: String
    public let appId: String
    public let name: String
    public let runningPodCount: Int
    public let siblingsEnabled: Bool
    public init(appId: String, name: String, runningPodCount: Int, siblingsEnabled: Bool) {
        self.id = appId
        self.appId = appId
        self.name = name
        self.runningPodCount = runningPodCount
        self.siblingsEnabled = siblingsEnabled
    }
}

public struct AppDetail {
    public let appId: String
    public let name: String
    public let creator: String
    public let siblingsEnabled: Bool
    public let policy: InstallPolicy
    public init(appId: String, name: String, creator: String, siblingsEnabled: Bool, policy: InstallPolicy) {
        self.appId = appId
        self.name = name
        self.creator = creator
        self.siblingsEnabled = siblingsEnabled
        self.policy = policy
    }
}

public struct InstallPolicy {
    public var specificPods: Set<String>
    public var allCurrentAndFuture: Bool
    public init(specificPods: Set<String> = [], allCurrentAndFuture: Bool = false) {
        self.specificPods = specificPods
        self.allCurrentAndFuture = allCurrentAndFuture
    }
}

public struct PodSummary: Identifiable {
    public let id: String
    public let podId: String
    public let label: String
    public let fqdn: String
    public init(podId: String, label: String, fqdn: String) {
        self.id = podId
        self.podId = podId
        self.label = label
        self.fqdn = fqdn
    }
}

public struct UrlEntry: Identifiable {
    public let id: String
    public let fqdn: String
    public let kind: String
    public let ownedBy: String?
    public let canClaim: Bool
    public init(fqdn: String, kind: String, ownedBy: String?, canClaim: Bool) {
        self.id = fqdn
        self.fqdn = fqdn
        self.kind = kind
        self.ownedBy = ownedBy
        self.canClaim = canClaim
    }
}
