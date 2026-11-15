import SwiftUI
import FlagshipCore

/// An organization's invitation: who invited the person, under which name, then Join; after it, the
/// 6-digit code to read to the inviter (docs/enterprise-accounts.md §7).
public struct OrgJoinScreen: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable var vm: OrgJoinViewModel
    let onDone: () -> Void

    public init(vm: OrgJoinViewModel, onDone: @escaping () -> Void) { self.vm = vm; self.onDone = onDone }

    public var body: some View {
        let c = FSColors.scheme(scheme)
        List {
            switch vm.phase {
            case .loading:
                Section { ProgressView().frame(maxWidth: .infinity) }
            case .failed(let m):
                Section { Text(m).font(FS.font.body()).foregroundColor(c.danger) }
            case let .ready(orgName, pseudonym, isAdminRole):
                Section {
                    Text("\(orgName) invited you to join as \(pseudonym)").font(FS.font.body()).foregroundColor(c.text)
                    Text("The organization knows you only by this name. It can't see your own account or your servers.")
                        .font(FS.font.bodySm()).foregroundColor(c.textMuted)
                    if isAdminRole {
                        Text("You'll be an admin. This phone makes a key that only it holds for this organization.")
                            .font(FS.font.bodySm()).foregroundColor(c.textMuted)
                    }
                }
                Section {
                    Button("Join") { Task { await vm.accept() } }
                        .disabled(vm.busy)
                        .accessibilityIdentifier("org-join-accept")
                }
            case .accepted(let code):
                Section {
                    Text(code).font(.system(.largeTitle, design: .monospaced)).frame(maxWidth: .infinity).accessibilityIdentifier("org-join-code")
                    Text("Read this code to the person who invited you. They admit you once it matches theirs.")
                        .font(FS.font.bodySm()).foregroundColor(c.textMuted)
                }
            }
        }
        .navigationTitle("Join an organization")
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { onDone() } } }
        .task { await vm.load() }
    }
}
