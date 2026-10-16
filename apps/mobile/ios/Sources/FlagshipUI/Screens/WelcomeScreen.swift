import SwiftUI
import FlagshipCore

/// D.2.1 — WelcomeScreen.
public struct WelcomeScreen: View {
    @Environment(\.colorScheme) private var scheme

    var onCreate: () -> Void = {}
    var onExisting: () -> Void = {}
    public init(onCreate: @escaping () -> Void = {}, onExisting: @escaping () -> Void = {}) {
        self.onCreate = onCreate
        self.onExisting = onExisting
    }
    public var body: some View {
        FSScreen {
            VStack(spacing: 0) {
                Spacer().frame(height: FS.space.s8)
                BoxIllustration().frame(height: 220)
                Spacer()
                VStack(alignment: .leading, spacing: FS.space.s4) {
                    Text("Your stuff,\non your hardware.")
                        .font(FS.font.h1())
                    FSColorReader { c in
                        Text("A personal cloud you actually own. Your phone holds the keys, your box runs the services.")
                            .font(.system(size: 17))
                            .foregroundColor(c.textMuted)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                Spacer().frame(height: FS.space.s8)
                // One page for both ways back in: sign in with the account
                // name (recovery / re-pair / demo) or join with a pairing
                // code from another device. Same footer as the app lock.
                FSActionFooter(
                    primary: "Create your account",
                    primaryId: "welcome-create",
                    secondary: "Connect to an existing account",
                    secondaryId: "welcome-connect",
                    secondaryHint: "Sign in with your account name, or join with a pairing code.",
                    onPrimary: onCreate,
                    onSecondary: onExisting
                )
            }
            .padding(.horizontal, FS.space.s6)
            .fsReadingColumn()
        }
    }
}

private struct BoxIllustration: View {
    @Environment(\.colorScheme) private var scheme
    @State private var pulse: CGFloat = 0.5
    var body: some View {
        let c = FSColors.scheme(scheme)
        ZStack {
            RoundedRectangle(cornerRadius: FS.radius.lg)
                .fill(
                    RadialGradient(
                        colors: [c.primary.opacity(0.18), c.surfaceSunken],
                        center: .topTrailing,
                        startRadius: 8,
                        endRadius: 220
                    )
                )
                .overlay(RoundedRectangle(cornerRadius: FS.radius.lg).stroke(c.border, lineWidth: 1))
                .frame(width: 280, height: 200)

            ZStack(alignment: .bottomTrailing) {
                RoundedRectangle(cornerRadius: 8)
                    .fill(c.surface)
                    .overlay(RoundedRectangle(cornerRadius: 8).stroke(c.border, lineWidth: 1))
                    .frame(width: 160, height: 90)
                Circle()
                    .fill(c.success.opacity(pulse))
                    .frame(width: 8, height: 8)
                    .padding(10)
            }
        }
        .onAppear {
            withAnimation(.easeInOut(duration: 1.4).repeatForever(autoreverses: true)) {
                pulse = 1.0
            }
        }
    }
}
