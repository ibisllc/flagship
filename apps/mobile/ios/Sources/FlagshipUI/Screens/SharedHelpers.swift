import SwiftUI

/// Shared loading + error visuals used by every screen.

struct ServerCardSkeleton: View {
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        let c = FSColors.scheme(scheme)
        FSCard {
            VStack(alignment: .leading, spacing: FS.space.s2) {
                RoundedRectangle(cornerRadius: 4)
                    .fill(c.surfaceSunken)
                    .frame(width: 80, height: 20)
                RoundedRectangle(cornerRadius: 4)
                    .fill(c.surfaceSunken)
                    .frame(width: 240, height: 18)
                RoundedRectangle(cornerRadius: 4)
                    .fill(c.surfaceSunken)
                    .frame(width: 180, height: 14)
            }
        }
        .redacted(reason: .placeholder)
    }
}

struct ErrorCard: View {
    @Environment(\.colorScheme) private var scheme
    let message: String
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
            }
        }
    }
}
