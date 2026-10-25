import SwiftUI
import Observation
import FlagshipAPI
import FlagshipCore

/// N12: an imported app checks its upstream repo. The box compares three trees and opens a build holding
/// the merge; nothing goes live until the owner deploys that build.
public enum UpstreamSyncCopy {
    public static func check(_ repo: String) -> String { String(localized: "Check for updates from \(repo)") }
    public static func checking(_ repo: String) -> String { String(localized: "Checking \(repo)…") }
    public static func upToDate(_ repo: String) -> String { String(localized: "You already run the latest version from \(repo).") }
    public static func title(_ repo: String) -> String { String(localized: "Update from \(repo)") }
    public static func version(_ commit: String) -> String { String(localized: "Version \(String(commit.prefix(12)))") }
    public static let refPlaceholder = String(localized: "Branch, tag or commit (optional)")
    public static let checkButton = String(localized: "Check for updates")
    public static func fromUpstream(_ n: Int) -> String { String(localized: "\(n) files updated from upstream") }
    public static func yoursKept(_ n: Int) -> String { String(localized: "\(n) of your changes kept") }
    public static func alreadyMatch(_ n: Int) -> String { String(localized: "\(n) files already match") }
    public static func conflicts(_ n: Int) -> String { String(localized: "\(n) conflicts: your version was kept") }
    public static let conflictsNote = String(localized: "Resolve them in the build before you deploy, or deploy with your version.")
    public static let newPermissions = String(localized: "New permissions")
    public static let newPermissionsNote = String(localized: "This update changes what the app is allowed to do. Review before you deploy.")
    public static let nothingLive = String(localized: "Nothing goes live until you deploy.")
    public static let reviewAndDeploy = String(localized: "Review and deploy")
    public static let discard = String(localized: "Discard")
    public static let notImported = String(localized: "This app wasn't imported from a repo on this server, so it can't check for updates.")

    public static func adds(_ items: [String]) -> String { String(localized: "Adds: \(items.joined(separator: ", "))") }
    public static func removes(_ items: [String]) -> String { String(localized: "Removes: \(items.joined(separator: ", "))") }

    public static func section(_ s: String) -> String {
        switch s {
        case "network.egress": return String(localized: "Internet access")
        case "network.subdomain": return String(localized: "Web addresses")
        case "data.stores": return String(localized: "Data stores")
        case "browser.domains": return String(localized: "Browser sites")
        case "access": return String(localized: "Public pages")
        case "runtime": return String(localized: "Runtime")
        case "distribution": return String(localized: "Distribution")
        default: return s
        }
    }

    public static func message(for error: Error) -> String {
        if case ScreensClientError.http(404, _) = error { return notImported }
        return ScreensClientError.boxReason(error) ?? ScreensClientError.userFacing(error)
    }
}

@Observable
@MainActor
public final class UpstreamSyncViewModel {
    public enum Phase: Equatable {
        case ask
        case checking
        case upToDate
        case proposal(AppSyncResponse)
        case failed(String)
    }

    public var ref = ""
    public private(set) var phase: Phase = .ask
    public let serviceId: String
    public let repo: String
    private let client: any ScreensClient

    public init(serviceId: String, repo: String, client: any ScreensClient) {
        self.serviceId = serviceId
        self.repo = repo
        self.client = client
    }

    public func check() async {
        if phase == .checking { return }
        phase = .checking
        let r = ref.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            let resp = try await client.appSync(serviceId: serviceId, AppSyncRequest(ref: r.isEmpty ? nil : r))
            // Up to date: the box opened no build, so there is nothing to discard.
            if resp.upToDate { phase = .upToDate }
            else if resp.buildId != nil, resp.proposal != nil { phase = .proposal(resp) }
            else { phase = .failed(ScreensClientError.userFacing(ScreensClientError.decoding("no proposal"))) }
        } catch {
            phase = .failed(UpstreamSyncCopy.message(for: error))
        }
    }

    /// The build the box opened for a proposal, while the owner hasn't taken it to review.
    public var openBuildId: String? {
        if case .proposal(let r) = phase { return r.buildId }
        return nil
    }

    /// Forget the build a proposal opened (Discard, or closing the sheet without reviewing).
    public func discard() async {
        guard let id = openBuildId else { return }
        phase = .ask
        try? await client.buildDiscard(buildId: id)
    }
}

public struct UpstreamSyncSheet: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.dismiss) private var dismiss
    @Bindable var vm: UpstreamSyncViewModel
    var onReview: (String) -> Void

    public init(vm: UpstreamSyncViewModel, onReview: @escaping (String) -> Void) {
        self.vm = vm
        self.onReview = onReview
    }

    public var body: some View {
        let c = FSColors.scheme(scheme)
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: FS.space.s4) {
                    switch vm.phase {
                    case .ask, .failed:
                        ask(c: c)
                    case .checking:
                        HStack(spacing: FS.space.s2) {
                            ProgressView()
                            Text(UpstreamSyncCopy.checking(vm.repo)).font(FS.font.body()).foregroundColor(c.text)
                                .accessibilityIdentifier("sync-checking")
                        }
                    case .upToDate:
                        Label(UpstreamSyncCopy.upToDate(vm.repo), systemImage: "checkmark.circle.fill")
                            .font(FS.font.h4()).foregroundColor(c.success)
                            .fixedSize(horizontal: false, vertical: true)
                            .accessibilityIdentifier("sync-up-to-date")
                        FSPrimaryButton(String(localized: "Close"), block: true) { close() }
                            .accessibilityIdentifier("sync-close")
                    case .proposal(let r):
                        proposal(r, c: c)
                    }
                }
                .padding(FS.space.s6)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .background(c.bg.ignoresSafeArea())
            .navigationTitle(UpstreamSyncCopy.title(vm.repo))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(String(localized: "Cancel")) { close() }.disabled(vm.phase == .checking)
                }
            }
        }
        .interactiveDismissDisabled(vm.phase == .checking || vm.openBuildId != nil)
    }

    private func close() {
        Task {
            await vm.discard()
            dismiss()
        }
    }

    @ViewBuilder
    private func ask(c: FSColors) -> some View {
        Text(UpstreamSyncCopy.check(vm.repo)).font(FS.font.h4()).foregroundColor(c.text)
            .fixedSize(horizontal: false, vertical: true)
        TextField(UpstreamSyncCopy.refPlaceholder, text: $vm.ref)
            .autocorrectionDisabled(true)
            .textInputAutocapitalization(.never)
            .fsInputBox()
            .accessibilityIdentifier("sync-ref")
        Text(UpstreamSyncCopy.nothingLive).font(FS.font.bodySm()).foregroundColor(c.textMuted)
        if case .failed(let msg) = vm.phase {
            Text(msg).font(FS.font.bodySm()).foregroundColor(c.danger)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("sync-error")
        }
        FSPrimaryButton(UpstreamSyncCopy.checkButton, block: true) { Task { await vm.check() } }
            .accessibilityIdentifier("sync-check")
    }

    @ViewBuilder
    private func proposal(_ r: AppSyncResponse, c: FSColors) -> some View {
        let p = r.proposal ?? SyncProposal()
        if let commit = r.candidateCommit {
            Text(UpstreamSyncCopy.version(commit)).font(FS.font.mono()).foregroundColor(c.textMuted)
                .accessibilityIdentifier("sync-version")
        }
        if !p.capabilityChanges.isEmpty {
            FSCard {
                VStack(alignment: .leading, spacing: FS.space.s2) {
                    Label(UpstreamSyncCopy.newPermissions, systemImage: "exclamationmark.shield.fill")
                        .font(FS.font.h4()).foregroundColor(c.warning)
                    Text(UpstreamSyncCopy.newPermissionsNote).font(FS.font.bodySm()).foregroundColor(c.text)
                        .fixedSize(horizontal: false, vertical: true)
                    ForEach(p.capabilityChanges, id: \.self) { ch in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(UpstreamSyncCopy.section(ch.section)).font(FS.font.bodySm().weight(.semibold)).foregroundColor(c.text)
                            if !ch.added.isEmpty {
                                Text(UpstreamSyncCopy.adds(ch.added)).font(FS.font.mono()).foregroundColor(c.warning)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                            if !ch.removed.isEmpty {
                                Text(UpstreamSyncCopy.removes(ch.removed)).font(FS.font.mono()).foregroundColor(c.textMuted)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                    }
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("sync-permissions")
        }
        FSCard {
            VStack(alignment: .leading, spacing: FS.space.s2) {
                Text(UpstreamSyncCopy.fromUpstream(p.takeUpstream.count)).font(FS.font.body()).foregroundColor(c.text)
                    .accessibilityIdentifier("sync-from-upstream")
                Text(UpstreamSyncCopy.yoursKept(p.localChanged.count)).font(FS.font.body()).foregroundColor(c.text)
                    .accessibilityIdentifier("sync-yours-kept")
                if !p.alreadyApplied.isEmpty {
                    Text(UpstreamSyncCopy.alreadyMatch(p.alreadyApplied.count)).font(FS.font.bodySm()).foregroundColor(c.textMuted)
                }
            }
        }
        if !p.conflicts.isEmpty {
            FSCard {
                VStack(alignment: .leading, spacing: FS.space.s2) {
                    Text(UpstreamSyncCopy.conflicts(p.conflicts.count)).font(FS.font.h4()).foregroundColor(c.danger)
                        .accessibilityIdentifier("sync-conflicts")
                    ForEach(p.conflicts, id: \.self) { path in
                        Text(path).font(FS.font.mono()).foregroundColor(c.text).textSelection(.enabled)
                    }
                    Text(UpstreamSyncCopy.conflictsNote).font(FS.font.bodySm()).foregroundColor(c.textMuted)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        Text(UpstreamSyncCopy.nothingLive).font(FS.font.bodySm()).foregroundColor(c.textMuted)
            .accessibilityIdentifier("sync-nothing-live")
        FSPrimaryButton(UpstreamSyncCopy.reviewAndDeploy, block: true) {
            guard let id = r.buildId else { return }
            dismiss()
            onReview(id)
        }
        .accessibilityIdentifier("sync-review")
        FSSecondaryButton(UpstreamSyncCopy.discard, block: true) { close() }
            .accessibilityIdentifier("sync-discard")
    }
}
