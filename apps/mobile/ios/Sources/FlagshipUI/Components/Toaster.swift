import SwiftUI
import FlagshipCore

/// Renders the top of `ToastCenter.queue` as a transient banner near the
/// top of the screen. Multiple stacked toasts are drawn from the queue
/// in order, with a small offset so the top one is always the most
/// recent.
public struct Toaster: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(ToastCenter.self) private var center

    public init() {}

    public var body: some View {
        VStack(spacing: 8) {
            ForEach(center.queue.suffix(3)) { toast in
                ToastView(toast: toast)
                    .transition(.move(edge: .top).combined(with: .opacity))
                    .onTapGesture { center.dismiss(toast.id) }
            }
            Spacer()
        }
        .padding(.horizontal, FS.space.s4)
        .padding(.top, FS.space.s4)
        .animation(.spring(response: 0.35, dampingFraction: 0.85), value: center.queue.count)
        .allowsHitTesting(!center.queue.isEmpty)
    }
}

private struct ToastView: View {
    @Environment(\.colorScheme) private var scheme
    let toast: Toast

    var body: some View {
        let c = FSColors.scheme(scheme)
        let (icon, color) = appearance(c: c)
        HStack(alignment: .top, spacing: FS.space.s2) {
            Image(systemName: icon)
                .foregroundColor(color)
                .font(.system(size: 16, weight: .semibold))
            Text(toast.message)
                .font(FS.font.bodySm())
                .foregroundColor(c.text)
                .frame(maxWidth: .infinity, alignment: .leading)
                .multilineTextAlignment(.leading)
        }
        .padding(.horizontal, FS.space.s4)
        .padding(.vertical, FS.space.s3)
        .background(c.surface)
        .overlay(
            RoundedRectangle(cornerRadius: FS.radius.md)
                .stroke(color.opacity(0.3), lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: FS.radius.md))
        .shadow(color: Color.black.opacity(0.08), radius: 12, y: 4)
    }

    private func appearance(c: FSColors) -> (String, Color) {
        switch toast.kind {
        case .info:    return ("info.circle.fill", c.primary)
        case .success: return ("checkmark.seal.fill", c.success)
        case .warning: return ("exclamationmark.triangle.fill", c.warning)
        case .error:   return ("xmark.octagon.fill", c.danger)
        }
    }
}
