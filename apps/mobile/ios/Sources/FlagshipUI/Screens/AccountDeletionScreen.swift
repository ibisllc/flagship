import SwiftUI
import Flagship
import FlagshipCore

/// Full-page IRREVERSIBLE-deletion warning — step 2 of the last-device
/// deletion ceremony (docs/account-deletion-and-name-reclaim.md §2). Reached
/// ONLY when the action is account DEATH (no cloud recovery AND this is the
/// last device, i.e. `SignOutPolicy.evaluate(...) == .deletionCeremony`),
/// after the existing confirm popup.
///
/// It is a SCREEN, not a dialog: a tap can't trigger the delete. The
/// affirmative gate is typing the exact username PLUS a biometric (the
/// biometric rides the owner-IRK derivation inside the ViewModel's `run`).
/// The opt-in checkbox controls whether the `servers-self-delete` order is
/// bundled in (default OFF, §5).
struct AccountDeletionScreen: View {
    @Environment(\.colorScheme) private var scheme
    let vm: AccountDeletionViewModel
    /// The account username the user must re-type to confirm. Compared
    /// case-insensitively (the canonical bytes lowercase it anyway).
    let username: String
    /// Routes out to the (future) transfer-a-box flow. Until that ships this
    /// is guidance only — the warning still tells the user to transfer first.
    var onTransferGuidance: () -> Void = {}

    @State private var typed: String = ""
    @State private var alsoDeleteServerContent: Bool = false

    private var typedMatches: Bool {
        typed.trimmingCharacters(in: .whitespaces).lowercased() == username.lowercased()
    }

    private var busy: Bool {
        switch vm.phase {
        case .signing, .posting, .wiping: return true
        default: return false
        }
    }

    var body: some View {
        let c = FSColors.scheme(scheme)
        ScrollView {
            VStack(alignment: .leading, spacing: FS.space.s6) {
                header(c: c)
                consequences(c: c)
                transferCallout(c: c)
                contentWipeToggle(c: c)
                confirmField(c: c)
                if case let .failed(msg) = vm.phase {
                    Text(msg)
                        .font(FS.font.bodySm())
                        .foregroundColor(c.danger)
                        .accessibilityIdentifier("account-delete-error")
                }
                FSDangerButton(
                    busy ? "Deleting…" : "Delete my account",
                    block: true,
                    large: true
                ) {
                    guard typedMatches, !busy else { return }
                    Task { await vm.run(alsoDeleteServerContent: alsoDeleteServerContent) }
                }
                .opacity(typedMatches && !busy ? 1 : 0.4)
                .allowsHitTesting(typedMatches && !busy)
                .accessibilityIdentifier("account-delete-confirm-btn")

                Spacer().frame(height: FS.space.s8)
            }
            .padding(FS.space.s6)
            .fsReadingColumn()
            .containerRelativeFrame(.horizontal)
        }
        .background(c.bg.ignoresSafeArea())
        .navigationTitle("Delete account")
        .navigationBarTitleDisplayMode(.inline)
        .accessibilityIdentifier("account-deletion-screen")
    }

    private func header(c: FSColors) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s3) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 40, weight: .medium))
                .foregroundColor(c.danger)
            Text("This permanently deletes your account")
                .font(.system(size: 22, weight: .bold))
                .foregroundColor(c.text)
            Text("There is no cloud recovery and no other device on this account, so the key on this phone is the only copy of your identity. Deleting it can't be undone.")
                .font(FS.font.bodySm())
                .foregroundColor(c.textMuted)
        }
    }

    private func consequences(c: FSColors) -> some View {
        FSCard {
            consequence(
                icon: "at",
                title: "Username “\(username)” is lost",
                detail: "It frees immediately and may be claimed by someone else.",
                c: c
            )
            Divider()
            consequence(
                icon: "server.rack",
                title: "Your servers go dark",
                detail: "They stop being reachable and manageable. If you want to keep one, transfer it first.",
                c: c
            )
            Divider()
            consequence(
                icon: "key.slash",
                title: "No recovery",
                detail: "No passkey, no other device, no reset. This is final.",
                c: c
            )
        }
    }

    private func consequence(icon: String, title: String, detail: String, c: FSColors) -> some View {
        HStack(alignment: .top, spacing: FS.space.s3) {
            Image(systemName: icon)
                .font(.system(size: 16, weight: .semibold))
                .foregroundColor(c.danger)
                .frame(width: 22)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(FS.font.bodySm()).foregroundColor(c.text)
                Text(detail).font(FS.font.caption()).foregroundColor(c.textMuted)
            }
        }
    }

    private func transferCallout(c: FSColors) -> some View {
        Button(action: onTransferGuidance) {
            HStack(spacing: FS.space.s2) {
                Image(systemName: "arrow.right.arrow.left")
                Text("Keep a server? Transfer it to another account first.")
                    .multilineTextAlignment(.leading)
                Spacer()
            }
            .font(FS.font.bodySm())
            .foregroundColor(c.primary)
        }
        .accessibilityIdentifier("account-delete-transfer-link")
    }

    private func contentWipeToggle(c: FSColors) -> some View {
        Toggle(isOn: $alsoDeleteServerContent) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Ask all my servers to delete their content")
                    .font(FS.font.bodySm()).foregroundColor(c.text)
                Text("Off by default. Sends a wipe order to every server you own — bundled with the deletion, never on its own.")
                    .font(FS.font.caption()).foregroundColor(c.textMuted)
            }
        }
        .tint(c.danger)
        .accessibilityIdentifier("account-delete-content-toggle")
    }

    private func confirmField(c: FSColors) -> some View {
        FSField(
            value: $typed,
            label: "Type your username to confirm",
            placeholder: username,
            helper: "Then confirm with your device unlock."
        )
        .accessibilityIdentifier("account-delete-confirm-field")
    }
}
