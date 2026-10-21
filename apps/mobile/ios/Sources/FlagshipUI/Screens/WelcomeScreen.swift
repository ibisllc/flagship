import SwiftUI
import FlagshipCore

/// D.2.1 — WelcomeScreen.
public struct WelcomeScreen: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.dynamicTypeSize) private var typeSize

    var onCreate: () -> Void = {}
    var onExisting: () -> Void = {}
    public init(onCreate: @escaping () -> Void = {}, onExisting: @escaping () -> Void = {}) {
        self.onCreate = onCreate
        self.onExisting = onExisting
    }
    public var body: some View {
        FSScreen {
            GeometryReader { geo in
                ScrollView {
                    VStack(spacing: 0) {
                        if !typeSize.isAccessibilitySize {
                            Spacer(minLength: FS.space.s6)
                            PhoneAndServerIllustration()
                                .frame(maxWidth: .infinity)
                                .accessibilityHidden(true)
                        }
                        Spacer(minLength: FS.space.s8)
                        VStack(alignment: .leading, spacing: FS.space.s3) {
                            Text("Your stuff,\non your hardware.")
                                .font(FS.font.h1())
                                .accessibilityAddTraits(.isHeader)
                            FSColorReader { c in
                                Text("A personal cloud you actually own. Your phone holds the keys, your server runs the services.")
                                    .font(.system(.body))
                                    .foregroundColor(c.textMuted)
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        Spacer(minLength: FS.space.s8)
                        // One page for both ways back in: sign in with the account
                        // name (recovery / re-pair / demo) or join with a pairing
                        // code from another device. Same footer as the app lock.
                        FSActionFooter(
                            primary: String(localized: "Create your account"),
                            primaryId: "welcome-create",
                            secondary: String(localized: "Connect to an existing account"),
                            secondaryId: "welcome-connect",
                            secondaryHint: String(localized: "Sign in with your account name, or join with a pairing code."),
                            onPrimary: onCreate,
                            onSecondary: onExisting
                        )
                    }
                    .padding(.horizontal, FS.space.s6)
                    .frame(minHeight: geo.size.height)
                    .fsReadingColumn()
                }
                .scrollBounceBehavior(.basedOnSize)
            }
        }
    }
}

/// A phone that holds the keys, a line to the server that runs the
/// services: the product in one picture, drawn with system symbols so it
/// follows the text size and both appearances.
private struct PhoneAndServerIllustration: View {
    @Environment(\.colorScheme) private var scheme
    @State private var pulse = false
    @ScaledMetric(relativeTo: .largeTitle) private var tile: CGFloat = 96

    var body: some View {
        let c = FSColors.scheme(scheme)
        HStack(spacing: 0) {
            node(symbol: "iphone", badge: "key.fill", tint: c.primary, c: c)
            link(c: c)
            node(symbol: "server.rack", badge: nil, tint: c.text, c: c)
                .overlay(alignment: .topTrailing) {
                    Circle()
                        .fill(c.success)
                        .frame(width: 12, height: 12)
                        .overlay(Circle().stroke(c.surface, lineWidth: 3))
                        .scaleEffect(pulse ? 1.15 : 0.9)
                        .offset(x: 4, y: -4)
                }
        }
        .padding(.vertical, FS.space.s6)
        .padding(.horizontal, FS.space.s4)
        .background(
            RoundedRectangle(cornerRadius: FS.radius.lg + 8, style: .continuous)
                .fill(LinearGradient(colors: [c.primary.opacity(0.10), c.surfaceSunken.opacity(0.6)],
                                     startPoint: .topTrailing, endPoint: .bottomLeading))
        )
        .overlay(RoundedRectangle(cornerRadius: FS.radius.lg + 8, style: .continuous).stroke(c.border, lineWidth: 1))
        .onAppear {
            withAnimation(.easeInOut(duration: 1.4).repeatForever(autoreverses: true)) { pulse = true }
        }
    }

    private func node(symbol: String, badge: String?, tint: Color, c: FSColors) -> some View {
        ZStack(alignment: .bottomTrailing) {
            Image(systemName: symbol)
                .font(.system(size: tile * 0.46, weight: .regular))
                .foregroundColor(tint)
                .frame(width: tile, height: tile)
                .background(c.surface, in: RoundedRectangle(cornerRadius: FS.radius.lg, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: FS.radius.lg, style: .continuous).stroke(c.border, lineWidth: 1))
            if let badge {
                Image(systemName: badge)
                    .font(.system(size: tile * 0.2, weight: .semibold))
                    .foregroundColor(c.onPrimary)
                    .frame(width: tile * 0.34, height: tile * 0.34)
                    .background(c.primaryFill, in: Circle())
                    .overlay(Circle().stroke(c.surface, lineWidth: 3))
                    .offset(x: 6, y: 6)
            }
        }
    }

    private func link(c: FSColors) -> some View {
        HStack(spacing: 5) {
            ForEach(0..<4, id: \.self) { _ in
                Circle().fill(c.textMuted.opacity(0.5)).frame(width: 4, height: 4)
            }
            Image(systemName: "lock.fill")
                .font(.system(size: 14, weight: .semibold))
                .foregroundColor(c.accent)
            ForEach(0..<4, id: \.self) { _ in
                Circle().fill(c.textMuted.opacity(0.5)).frame(width: 4, height: 4)
            }
        }
        .padding(.horizontal, FS.space.s2)
    }
}
