import SwiftUI
import FlagshipCore

/// The global "operations" sliver — a teal strip the whole shell slides down
/// to reveal, modelled on WhatsApp's active-call bar. It shows the most
/// recently started running operation ("deploying server Home", "building blog
/// on Home") with a spinner; tapping it deep-links to that operation's own
/// screen.
///
/// Mounted as a `.safeAreaInset(edge: .top)` on the shell so it physically
/// pushes every tab down rather than floating over content. Renders nothing
/// (zero inset, no push) when there are no operations or the app is
/// biometric-locked — the latter so the inset never shifts the lock screen and
/// operation names (the user's own data) never show through it.
public struct GlobalOperationsBar: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(ActiveOperationsCenter.self) private var center
    @Environment(DeepLinker.self) private var linker
    @Environment(AppState.self) private var app

    public init() {}

    public var body: some View {
        let primary = app.isUnlocked ? center.primary : nil
        ZStack(alignment: .top) {
            if let primary {
                OperationsSliver(op: primary, extra: center.additionalCount, scheme: scheme) {
                    linker.enqueue(primary.target)
                }
                .transition(.move(edge: .top).combined(with: .opacity))
            }
        }
        // The slide-down/up of the inset rides this. Keying on the whole
        // operation (Equatable) — not just presence — also animates a swap
        // from one primary operation to another.
        .animation(.spring(response: 0.4, dampingFraction: 0.9), value: primary)
    }
}

private struct OperationsSliver: View {
    let op: ActiveOperation
    let extra: Int
    let scheme: ColorScheme
    let onTap: () -> Void

    var body: some View {
        let c = FSColors.scheme(scheme)
        Button(action: onTap) {
            HStack(spacing: FS.space.s2) {
                ProgressView()
                    .controlSize(.small)
                    .tint(.white)
                Text(op.label)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundColor(.white)
                    .lineLimit(1)
                    .truncationMode(.tail)
                Spacer(minLength: FS.space.s2)
                if extra > 0 {
                    Text("+\(extra)")
                        .font(.system(size: 12, weight: .bold))
                        .foregroundColor(.white)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(Color.white.opacity(0.22))
                        .clipShape(Capsule())
                }
                Image(systemName: "chevron.right")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundColor(.white.opacity(0.85))
            }
            .padding(.horizontal, FS.space.s4)
            .padding(.vertical, FS.space.s2)
            .frame(maxWidth: .infinity)
            .background(c.primary)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("global-operations-bar")
        .accessibilityLabel(Text(op.label))
        .accessibilityHint(Text("Opens this operation"))
    }
}
