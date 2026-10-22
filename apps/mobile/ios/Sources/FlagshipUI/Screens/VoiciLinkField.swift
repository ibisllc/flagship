import SwiftUI
import UIKit
import Flagship
import FlagshipAPI
import FlagshipCore

/// "Your link" on a service's page (docs/named-links.md): `voi.ci/` and an
/// editable name that holds the random code until an admin picks a custom one.
/// See `VoiciLinkViewModel` for the rules and the one line shown under it.
public struct VoiciLinkField: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.nameDibsClient) private var nameDibs
    @State private var vm: VoiciLinkViewModel
    @State private var text: String
    private let username: String
    /// The link state the page last loaded; a newer one replaces the field's.
    private let incoming: VoiciLinkState

    public init(vm: VoiciLinkViewModel, username: String) {
        _vm = State(initialValue: vm)
        _text = State(initialValue: vm.typed)
        self.username = username
        self.incoming = vm.link
    }

    /// The field for one service's loaded links, or nil when `.com` sent no link state (an older `.com`).
    public static func make(
        client: any VoiciNameClient,
        username: String,
        links: AppLinksResponse,
        onChanged: @escaping (VoiciLinkState) -> Void
    ) -> VoiciLinkField? {
        guard let state = links.link, let code = links.shortCode else { return nil }
        let model = VoiciLinkViewModel(
            client: client, username: username, serviceId: links.serviceId,
            link: state, shortCode: code, admin: Keystore.hasAdminRoot
        )
        model.onChanged = onChanged
        return VoiciLinkField(vm: model, username: username)
    }

    public var body: some View {
        let c = FSColors.scheme(scheme)
        let message = vm.message
        VStack(alignment: .leading, spacing: FS.space.s2) {
            FSSectionLabel(String(localized: "Your link"))
            HStack(spacing: FS.space.s2) {
                Text("voi.ci/")
                    .font(.system(size: 16, weight: .semibold, design: .monospaced))
                    .foregroundColor(c.textMuted)
                TextField("", text: $text)
                    .font(.system(size: 16, weight: .semibold, design: .monospaced))
                    .foregroundColor(c.text)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .disabled(!vm.isEditable)
                    .onChange(of: text) { vm.edit(text) }
                    .accessibilityIdentifier("voici-link-input")
                Button {
                    UIPasteboard.general.string = vm.shortUrl
                } label: {
                    Image(systemName: "doc.on.doc").foregroundColor(c.textMuted)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(String(localized: "Copy short link"))
            }
            .onChange(of: vm.typed) { if text != vm.typed { text = vm.typed } }
            .onChange(of: incoming) { vm.adopt(link: incoming) }

            if !message.text.isEmpty {
                Text(message.text)
                    .font(FS.font.bodySm())
                    .foregroundColor(color(message.tone, c))
                    .accessibilityIdentifier("voici-link-message")
            }

            HStack(spacing: FS.space.s2) {
                if message.canSave {
                    FSPrimaryButton(String(localized: "Save")) { Task { await vm.requestSave() } }
                        .accessibilityIdentifier("voici-link-save")
                }
                if message.action == .dibs {
                    FSSecondaryButton(String(localized: "I own it")) { vm.ownIt() }
                        .accessibilityIdentifier("voici-link-own-it")
                }
                if message.action == .freeUp {
                    FSSecondaryButton(String(localized: "Free one up")) { Task { await vm.openFreeUp() } }
                        .accessibilityIdentifier("voici-link-free-up")
                }
                if vm.showsUseDefault {
                    FSSecondaryButton(String(localized: "Use default")) { Task { await vm.requestUseDefault() } }
                        .accessibilityIdentifier("voici-link-use-default")
                }
            }

            if vm.showsReleaseNote {
                Text("Unused for 60 days, it's released.")
                    .font(FS.font.caption())
                    .foregroundColor(c.textMuted)
            }
        }
        .modifier(ReplaceVoiciLinkDialog(vm: vm, whileFreeUpOpen: false))
        .sheet(isPresented: Binding(get: { vm.showsFreeUp }, set: { vm.showsFreeUp = $0 })) {
            freeUpSheet(c)
        }
        .sheet(isPresented: Binding(get: { vm.dibsName != nil }, set: { if !$0 { vm.dibsName = nil } })) {
            NavigationStack {
                NameDibsScreen(
                    vm: NameDibsViewModel(client: nameDibs, username: username, kind: .link, presetName: vm.dibsName ?? ""),
                    onDone: { Task { await vm.dibsFinished() } }
                )
            }
        }
    }

    private func freeUpSheet(_ c: FSColors) -> some View {
        NavigationStack {
            List {
                ForEach(vm.freeUpNames ?? []) { row in
                    HStack {
                        Text("voi.ci/\(row.name)")
                            .font(.system(.body, design: .monospaced))
                            .foregroundColor(c.text)
                        Spacer()
                        Button(String(localized: "Use default")) {
                            Task { await vm.requestUseDefault(listed: row) }
                        }
                        .font(FS.font.bodySm())
                    }
                }
            }
            .navigationTitle(String(localized: "Your names"))
            .navigationBarTitleDisplayMode(.inline)
            .modifier(ReplaceVoiciLinkDialog(vm: vm, whileFreeUpOpen: true))
        }
        .presentationDetents([.medium])
    }

    private func color(_ tone: VoiciLinkMessage.Tone, _ c: FSColors) -> Color {
        switch tone {
        case .ok: return c.success
        case .bad: return c.danger
        case .info, .none: return c.textMuted
        }
    }
}

/// The confirm before a live custom name stops working. The page and the
/// "Free one up" sheet each carry one, and only the one on top is armed.
private struct ReplaceVoiciLinkDialog: ViewModifier {
    let vm: VoiciLinkViewModel
    let whileFreeUpOpen: Bool

    func body(content: Content) -> some View {
        content.confirmationDialog(
            Text("Replace voi.ci/\(vm.pendingChange?.replacing ?? "")? It stops working now and can't be taken back."),
            isPresented: Binding(
                get: { vm.pendingChange != nil && vm.showsFreeUp == whileFreeUpOpen },
                set: { if !$0 { vm.cancelPending() } }
            ),
            titleVisibility: .visible,
            presenting: vm.pendingChange
        ) { change in
            Button("Replace", role: .destructive) { Task { await vm.confirmPending(change) } }
            Button("Cancel", role: .cancel) {}
        }
    }
}
