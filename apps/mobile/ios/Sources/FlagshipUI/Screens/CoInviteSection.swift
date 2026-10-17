import SwiftUI
import Observation
import FlagshipCore

// Co-manager invites on a shared server's app (docs/service-access-gating.md
// "Co-manager invites"): at Can manage, "Invite people" opens the panel; B
// invites at Member and withdraws only B's own invites, while the box says
// B may. Strings come from `ShareCoInviteCopy` (the webapp's words).

@Observable
@MainActor
public final class CoInviteController {
    public enum Kind: String, Sendable { case person, group }
    public enum Phase: Equatable {
        case closed
        case loading
        case loaded(ShareCoInviteState)
        case failed(String)
    }

    public let serviceRef: String
    public let appName: String
    public private(set) var phase: Phase = .closed
    public var adding: Kind?
    public private(set) var lastLink: String?
    public private(set) var busy = false
    public private(set) var withdrawing: String?
    public var errorMessage: String?

    private let fetch: @MainActor () async throws -> ShareCoInviteState
    private let make: @MainActor (_ ownerAid: String?, _ name: String, _ group: ShareCoInviteGroup?) async throws -> ShareCoInviteCreated
    private let drop: @MainActor (_ inviteId: String) async throws -> Void

    public init(serviceRef: String, appName: String,
                fetch: @escaping @MainActor () async throws -> ShareCoInviteState,
                make: @escaping @MainActor (String?, String, ShareCoInviteGroup?) async throws -> ShareCoInviteCreated,
                drop: @escaping @MainActor (String) async throws -> Void) {
        self.serviceRef = serviceRef
        self.appName = appName
        self.fetch = fetch
        self.make = make
        self.drop = drop
    }

    public convenience init(store: SharedWithMeStore, shareId: String, serviceRef: String, appName: String) {
        self.init(serviceRef: serviceRef, appName: appName,
                  fetch: { try await store.coInvites(shareId, serviceRef: serviceRef) },
                  make: { try await store.createCoInvite(shareId, serviceRef: serviceRef, ownerAid: $0, name: $1, group: $2) },
                  drop: { try await store.withdrawCoInvite(shareId, inviteId: $0) })
    }

    public var isOpen: Bool { phase != .closed }
    public var state: ShareCoInviteState? {
        if case .loaded(let s) = phase { return s }
        return nil
    }

    /// "Invite people": open (and load) the panel, or close it.
    public func toggle() async {
        if isOpen {
            phase = .closed
            adding = nil
            lastLink = nil
            errorMessage = nil
            return
        }
        await reload()
    }

    public func reload() async {
        if state == nil { phase = .loading }
        do {
            phase = .loaded(try await fetch())
        } catch {
            phase = .failed(ServerShareCopy.message(for: error))
        }
    }

    public func startAdding(_ kind: Kind) {
        adding = kind
        lastLink = nil
        errorMessage = nil
    }

    /// Create the invite; true when it was made (the link is in `lastLink`).
    @discardableResult
    public func create(name: String, maxUses: String = "10", days: String = "") async -> Bool {
        guard !busy, let kind = adding else { return false }
        busy = true
        errorMessage = nil
        defer { busy = false }
        let group = kind == .group ? ShareCoInviteGroup.fromForm(maxUses: maxUses, days: days) : nil
        do {
            let made = try await make(state?.ownerAid, name, group)
            await reload()
            adding = nil
            lastLink = made.link
            return true
        } catch {
            errorMessage = ServerShareCopy.message(for: error)
            return false
        }
    }

    /// Withdraw one of B's own invites; true when the box took it.
    @discardableResult
    public func withdraw(_ inviteId: String) async -> Bool {
        guard withdrawing == nil else { return false }
        withdrawing = inviteId
        errorMessage = nil
        defer { withdrawing = nil }
        do {
            try await drop(inviteId)
            await reload()
            return true
        } catch {
            errorMessage = ServerShareCopy.message(for: error)
            return false
        }
    }
}

/// The app's "Invite people" card on a shared server (Can manage only).
struct CoInviteSection: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(ToastCenter.self) private var toasts
    @Bindable var controller: CoInviteController

    @State private var name = ""
    @State private var maxUses = "10"
    @State private var days = ""
    @State private var confirmWithdraw: ShareCoInvite?

    var body: some View {
        let c = FSColors.scheme(scheme)
        VStack(alignment: .leading, spacing: FS.space.s3) {
            FSSectionLabel("Invite people")
            FSCard {
                VStack(alignment: .leading, spacing: FS.space.s3) {
                    FSSecondaryButton(ShareCoInviteCopy.open, block: true) {
                        Task { await controller.toggle() }
                    }
                    .accessibilityIdentifier("co-invite-open")
                    switch controller.phase {
                    case .closed:
                        EmptyView()
                    case .loading:
                        ProgressView()
                    case .failed(let msg):
                        Text(msg).font(FS.font.bodySm()).foregroundColor(c.danger)
                            .fixedSize(horizontal: false, vertical: true)
                            .accessibilityIdentifier("co-invite-error")
                    case .loaded(let state):
                        panel(state, c: c)
                    }
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("co-invite-section")
        .confirmationDialog(ShareCoInviteCopy.withdrawTitle,
                            isPresented: Binding(get: { confirmWithdraw != nil }, set: { if !$0 { confirmWithdraw = nil } }),
                            titleVisibility: .visible, presenting: confirmWithdraw) { inv in
            Button(ShareCoInviteCopy.withdraw, role: .destructive) {
                Task {
                    if await controller.withdraw(inv.inviteId) { toasts.success(ShareCoInviteCopy.withdrawn) }
                }
            }
            .accessibilityIdentifier("co-invite-withdraw-confirm")
        } message: { _ in
            Text(ShareCoInviteCopy.withdrawMessage(controller.appName))
        }
    }

    @ViewBuilder
    private func panel(_ state: ShareCoInviteState, c: FSColors) -> some View {
        if state.canInvite {
            Text(ShareCoInviteCopy.line).font(FS.font.bodySm()).foregroundColor(c.textMuted)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("co-invite-line")
            HStack(spacing: FS.space.s2) {
                FSSecondaryButton(ShareCoInviteCopy.addPerson) { begin(.person) }
                    .accessibilityIdentifier("co-invite-add-person")
                FSSecondaryButton(ShareCoInviteCopy.addGroup) { begin(.group) }
                    .accessibilityIdentifier("co-invite-add-group")
            }
            if let kind = controller.adding { form(kind, c: c) }
            if let link = controller.lastLink {
                InviteShareCard(title: "Invite link", subtitle: ShareCoInviteCopy.linkLine, link: link, idPrefix: "co-invite-share")
            }
        } else {
            Text(state.whyText).font(FS.font.bodySm()).foregroundColor(c.textMuted)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("co-invite-why")
        }
        if let e = controller.errorMessage {
            Text(e).font(FS.font.bodySm()).foregroundColor(c.danger).fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("co-invite-error")
        }
        Text(ShareCoInviteCopy.yours).font(FS.font.scaled(15, weight: .semibold)).foregroundColor(c.text)
        if state.invites.isEmpty {
            Text(ShareCoInviteCopy.none).font(FS.font.bodySm()).foregroundColor(c.textMuted)
                .accessibilityIdentifier("co-invite-none")
        } else {
            ForEach(state.invites) { inv in row(inv, canWithdraw: state.canInvite, c: c) }
        }
    }

    private func row(_ inv: ShareCoInvite, canWithdraw: Bool, c: FSColors) -> some View {
        HStack(spacing: FS.space.s2) {
            Text("\(inv.displayName) · \(ShareCoInviteCopy.statusText(inv))")
                .font(FS.font.bodySm()).foregroundColor(c.text)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("co-invite-row-\(inv.inviteId)")
            Spacer()
            if canWithdraw {
                Button(ShareCoInviteCopy.withdraw) { confirmWithdraw = inv }
                    .buttonStyle(.bordered)
                    .tint(c.danger)
                    .disabled(controller.withdrawing != nil)
                    .accessibilityIdentifier("co-invite-withdraw-\(inv.inviteId)")
            }
        }
    }

    private func form(_ kind: CoInviteController.Kind, c: FSColors) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s2) {
            FSField(value: $name,
                    label: "\(kind == .group ? ShareCoInviteCopy.groupNameLabel : ShareCoInviteCopy.nameLabel) (\(ShareCoInviteCopy.nameHint))",
                    placeholder: kind == .group ? ShareCoInviteCopy.groupNamePlaceholder : ShareCoInviteCopy.namePlaceholder)
                .accessibilityIdentifier("co-invite-name")
            if kind == .group {
                FSField(value: $maxUses, label: "\(ShareCoInviteCopy.maxUsesLabel) (\(ShareCoInviteCopy.maxUsesHint))", placeholder: "10",
                        keyboard: .numberPad)
                    .accessibilityIdentifier("co-invite-max-uses")
                FSField(value: $days, label: "\(ShareCoInviteCopy.daysLabel) (\(ShareCoInviteCopy.daysHint))", placeholder: "30",
                        keyboard: .numberPad)
                    .accessibilityIdentifier("co-invite-days")
            }
            Text(ShareCoInviteCopy.rankLine).font(FS.font.caption()).foregroundColor(c.textMuted)
            FSPrimaryButton(controller.busy ? "Creating…" : ShareCoInviteCopy.create, enabled: !controller.busy, block: true) {
                Task {
                    if await controller.create(name: name, maxUses: maxUses, days: days) {
                        name = ""
                        toasts.success(ShareCoInviteCopy.created)
                    }
                }
            }
            .accessibilityIdentifier("co-invite-create")
        }
    }

    private func begin(_ kind: CoInviteController.Kind) {
        name = ""
        maxUses = "10"
        days = ""
        controller.startAdding(kind)
    }
}
