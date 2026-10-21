import SwiftUI

/// Shared loading + error visuals used by every screen.

struct ServerCardSkeleton: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var dim = false
    var body: some View {
        let c = FSColors.scheme(scheme)
        FSCard {
            VStack(alignment: .leading, spacing: FS.space.s2) {
                RoundedRectangle(cornerRadius: 4, style: .continuous)
                    .fill(c.surfaceSunken)
                    .frame(width: 80, height: 20)
                RoundedRectangle(cornerRadius: 4, style: .continuous)
                    .fill(c.surfaceSunken)
                    .frame(width: 240, height: 18)
                RoundedRectangle(cornerRadius: 4, style: .continuous)
                    .fill(c.surfaceSunken)
                    .frame(width: 180, height: 14)
            }
        }
        .redacted(reason: .placeholder)
        .opacity(dim ? 0.55 : 1)
        .onAppear {
            guard !reduceMotion else { return }
            withAnimation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true)) { dim = true }
        }
        .accessibilityLabel("Loading")
    }
}

struct ErrorCard: View {
    @Environment(\.colorScheme) private var scheme
    let message: String
    /// The next step: shown as "Try again" when the caller can retry.
    var retry: (() async -> Void)? = nil
    var body: some View {
        let c = FSColors.scheme(scheme)
        FSCard {
            VStack(alignment: .leading, spacing: FS.space.s2) {
                HStack(spacing: FS.space.s2) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundColor(c.danger)
                    Text("Couldn't load")
                        .font(FS.font.h4())
                        .foregroundColor(c.text)
                }
                Text(message)
                    .font(FS.font.bodySm())
                    .foregroundColor(c.textMuted)
                if let retry {
                    FSSecondaryButton(String(localized: "Try again"), block: true) { Task { await retry() } }
                        .padding(.top, FS.space.s1)
                        .accessibilityIdentifier("error-card-retry")
                }
            }
        }
    }
}
