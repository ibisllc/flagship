import SwiftUI
import FlagshipCore

/// D.2.1 — WelcomeScreen.
public struct WelcomeScreen: View {
    // Dev-mode escape hatch — see `secretTap`. The live/mock toggle
    // otherwise lives in Settings, which is unreachable before sign-in;
    // tapping the box illustration 3× flips it from the cover page.
    @Environment(DeveloperSettings.self) private var dev
    @Environment(ToastCenter.self) private var toasts
    @Environment(\.colorScheme) private var scheme
    @State private var tapCount: Int = 0

    var onCreate: () -> Void = {}
    var onExisting: () -> Void = {}
    public init(onCreate: @escaping () -> Void = {}, onExisting: @escaping () -> Void = {}) {
        self.onCreate = onCreate
        self.onExisting = onExisting
    }
    public var body: some View {
        FSScreen {
            VStack(spacing: 0) {
                modeBadge
                    .frame(maxWidth: .infinity, alignment: .trailing)
                    .padding(.top, FS.space.s2)
                Spacer().frame(height: FS.space.s8)
                BoxIllustration().frame(height: 220)
                    .contentShape(Rectangle())
                    .onTapGesture { secretTap() }
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
                VStack(spacing: FS.space.s3) {
                    FSPrimaryButton("Create your account", block: true, large: true, action: onCreate)
                    // Drives the WebAuthn-PRF recovery flow on a
                    // fresh install — pulls the wrapped UMK off
                    // flagshipserver.com using a passkey that's
                    // either synced via iCloud Keychain or held on
                    // a YubiKey / 1Password / etc. After unwrap,
                    // the user chooses Keep-both-devices /
                    // Replace-lost-device / Wipe-&-restart.
                    FSGhostButton("I already have an account", block: true, large: true, action: onExisting)
                }
                Spacer().frame(height: FS.space.s8)
            }
            .padding(.horizontal, FS.space.s6)
        }
    }

    /// 3 taps on the box illustration toggles live↔mock and reveals the
    /// in-Settings developer menu. Reachable WITHOUT signing in, so a
    /// stranded live build can fall back to the on-device mock.
    private func secretTap() {
        tapCount += 1
        guard tapCount >= 3 else { return }
        tapCount = 0
        dev.useLiveClient.toggle()
        dev.unlocked = true
        toasts.info(
            dev.useLiveClient
                ? "You're now in LIVE mode — data comes from flagshipserver.com."
                : "You're now in MOCK mode — sign in as “demo” (nothing is created)."
        )
    }

    /// Shown ONLY in mock mode. Live is the normal mode and needs no
    /// chrome; the badge is a loud reminder that you're on fake data,
    /// plus the mock login hint. (Switching modes still fires a toast.)
    @ViewBuilder private var modeBadge: some View {
        if !dev.useLiveClient {
            let tint = FSColors.scheme(scheme).warning
            HStack(spacing: 6) {
                Circle().fill(tint).frame(width: 7, height: 7)
                Text("MOCK · sign in as “demo”")
                    .font(FS.font.caption())
                    .foregroundColor(tint)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .background(Capsule().fill(tint.opacity(0.14)))
            .accessibilityLabel("Mock data mode")
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
