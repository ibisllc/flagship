import SwiftUI
import PhotosUI
import UIKit
import FlagshipAPI
import FlagshipCore

/// Turning the page public or taking it down (docs/voici-and-messages.md §3.3, §11.1). One flow for the Social tab's
/// Public switch, its Publish bar and Page options: the page and message rules once per device, then the one-time
/// "Everything you put on your page is public" warning per account, then the signature. Nothing is signed before
/// "Make it public"; a non-admin device never gets past the first step.
@MainActor
@Observable
final class PagePublicFlow {
    enum Action { case goPublic, publishAll }

    var showRules = false
    var showWarning = false
    var confirmRemove = false
    @ObservationIgnored private var action: Action?
    @ObservationIgnored private var rulesJustAccepted = false
    @ObservationIgnored private let warning: PagePublicWarning
    private let store: MessagesStore

    init(store: MessagesStore = .shared, warning: PagePublicWarning = PagePublicWarning()) {
        self.store = store
        self.warning = warning
    }

    /// The Public switch.
    func setPublic(_ on: Bool) {
        guard store.isAdmin, !store.isPublishing else { return }
        if on {
            guard !store.isPublic else { return }
            begin(.goPublic)
        } else if store.isPublic {
            confirmRemove = true
        }
    }

    /// The Publish bar: while the page is not public, publishing makes it public, so the same steps apply.
    func publishAll() {
        guard store.isAdmin else { return }
        if store.isPublic {
            Task { await store.publishNow() }
        } else {
            begin(.publishAll)
        }
    }

    private func begin(_ a: Action) {
        action = a
        advance()
    }

    private func advance() {
        switch PagePublicWarning.next(isAdmin: store.isAdmin, rulesAccepted: VoiciRules.accepted, acknowledged: warning.acknowledged(username: store.username)) {
        case .refuse: action = nil
        case .rules: showRules = true
        case .warning: showWarning = true
        case .publish: run()
        }
    }

    func rulesAccepted() { rulesJustAccepted = true }

    func rulesDismissed() {
        guard rulesJustAccepted else { action = nil; return }
        rulesJustAccepted = false
        advance()
    }

    func makePublic() {
        warning.acknowledge(username: store.username)
        run()
    }

    func cancel() { action = nil }

    func remove() { Task { await store.removePage() } }

    private func run() {
        guard let a = action else { return }
        action = nil
        Task {
            switch a {
            case .goPublic: await store.goPublic()
            case .publishAll: await store.publishNow()
            }
        }
    }
}

extension View {
    /// The rules sheet, the public warning and the removal confirmation for one PagePublicFlow.
    func pagePublicFlow(_ flow: PagePublicFlow) -> some View {
        modifier(PagePublicFlowModifier(flow: flow))
    }
}

private struct PagePublicFlowModifier: ViewModifier {
    @Bindable var flow: PagePublicFlow

    func body(content: Content) -> some View {
        content
            .sheet(isPresented: $flow.showRules, onDismiss: { flow.rulesDismissed() }) {
                VoiciRulesSheet { flow.rulesAccepted() }
            }
            .alert("Make your page public?", isPresented: $flow.showWarning) {
                Button("Cancel", role: .cancel) { flow.cancel() }
                Button("Make it public") { flow.makePublic() }
                    .accessibilityIdentifier("page-make-public")
            } message: {
                Text("Everything you put on your page is public. Anyone can see it, and it shows your username, which your apps and servers also use, so people can connect them.")
            }
            .alert("Remove your page from voi.ci?", isPresented: $flow.confirmRemove) {
                Button("Cancel", role: .cancel) {}
                Button("Remove", role: .destructive) { flow.remove() }
                    .accessibilityIdentifier("page-remove-confirm")
            } message: {
                Text("Visitors will see “There's no page here.” Your posts and profile stay on your devices, so you can turn it on again.")
            }
    }
}

/// The Public switch: on = visitors see the page on voi.ci. Disabled on a device that can't sign the page.
struct PagePublicToggle: View {
    let flow: PagePublicFlow
    var labelsHidden = false
    private let store = MessagesStore.shared

    var body: some View {
        Toggle(isOn: Binding(get: { store.isPublic }, set: { flow.setPublic($0) })) {
            Text("Public")
        }
        .modifier(HiddenLabel(hidden: labelsHidden))
        .disabled(!store.isAdmin || store.isPublishing)
        .accessibilityIdentifier("page-public-switch")
    }

    private struct HiddenLabel: ViewModifier {
        let hidden: Bool
        func body(content: Content) -> some View {
            if hidden { content.labelsHidden() } else { content }
        }
    }
}

/// voi.ci/<username> with a copy button. The button writes only the page's address; nothing is read back.
struct PageAddressRow: View {
    let username: String
    let url: String
    @State private var copied = false
    @State private var reset: Task<Void, Never>?

    var body: some View {
        HStack(spacing: 6) {
            Text(verbatim: "voi.ci/\(username)")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.middle)
                .textSelection(.enabled)
            Button {
                UIPasteboard.general.string = url
                copied = true
                UIAccessibility.post(notification: .announcement, argument: String(localized: "Copied"))
                reset?.cancel()
                reset = Task {
                    try? await Task.sleep(for: .seconds(2))
                    if !Task.isCancelled { copied = false }
                }
            } label: {
                if copied {
                    Label("Copied", systemImage: "checkmark")
                        .labelStyle(.titleAndIcon)
                        .font(.caption.weight(.semibold))
                } else {
                    Image(systemName: "doc.on.doc")
                        .font(.subheadline)
                        .accessibilityLabel(Text("Copy link"))
                }
            }
            .buttonStyle(.borderless)
            .frame(minWidth: 44, minHeight: 44)
            .contentShape(Rectangle())
            .accessibilityIdentifier("page-copy-link")
        }
    }
}

/// A sample account's page, read-only: the example the operator publishes for it. The switch shows whether it is public
/// but can't be flipped, and there is no way into the editor: this device holds no key that signs the page.
struct DemoPageHeaderView: View {
    var onView: () -> Void
    private let store = MessagesStore.shared
    @Environment(\.colorScheme) private var scheme
    @Environment(\.dynamicTypeSize) private var typeSize
    @ScaledMetric(relativeTo: .title) private var avatarSide: CGFloat = 72

    var body: some View {
        let c = FSColors.scheme(scheme)
        VStack(alignment: .leading, spacing: 14) {
            identity
            Divider()
            VStack(alignment: .leading, spacing: 2) {
                Toggle(isOn: .constant(store.isPublic)) { Text("Public") }
                    .font(.body.weight(.semibold))
                    .disabled(true)
                    .accessibilityIdentifier("demo-page-public-switch")
                Text(store.isPublic ? String(localized: "Public") : String(localized: "Not public"))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("messages-page-status")
            }
            Text("This is a sample account. Its page is an example, so you can't change it.")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("demo-page-note")
            Button(action: onView) {
                HStack {
                    Text("View page").font(.body.weight(.semibold))
                    Spacer()
                    Image(systemName: "arrow.up.right.square").font(.footnote.weight(.semibold)).foregroundStyle(.tertiary)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .foregroundStyle(c.primary)
            .frame(minHeight: 44)
            .accessibilityIdentifier("demo-page-view")
        }
        .padding(.vertical, 6)
    }

    @ViewBuilder
    private var identity: some View {
        let profile = store.published?.profile
        let name = profile.map(\.displayName).flatMap { $0.isEmpty ? nil : $0 } ?? store.username
        let avatar = PageAvatar(sha: profile?.avatar, side: avatarSide)
        let fields = VStack(alignment: .leading, spacing: 2) {
            Text(verbatim: name)
                .font(.title3.weight(.semibold))
                .lineLimit(2)
                .accessibilityIdentifier("demo-page-name")
            PageAddressRow(username: store.username, url: store.pageURL)
        }
        if typeSize.isAccessibilitySize {
            VStack(alignment: .leading, spacing: 10) { avatar; fields }
        } else {
            HStack(alignment: .center, spacing: 14) { avatar; fields }
        }
    }
}

/// A round avatar: the page photo, or an empty person silhouette until one is set.
struct PageAvatar: View {
    let sha: String?
    let side: CGFloat
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let c = FSColors.scheme(scheme)
        Group {
            if let b = sha.flatMap(VoiciImageStore.load), let img = UIImage(data: Data(b)) {
                Image(uiImage: img).resizable().scaledToFill()
            } else {
                ZStack {
                    c.surfaceSunken
                    Image(systemName: "person.fill")
                        .resizable()
                        .scaledToFit()
                        .padding(side * 0.22)
                        .offset(y: side * 0.08)
                        .foregroundStyle(c.textMuted.opacity(0.55))
                }
            }
        }
        .frame(width: side, height: side)
        .clipShape(Circle())
        .overlay(Circle().strokeBorder(c.border, lineWidth: 1))
        .accessibilityHidden(true)
    }
}
