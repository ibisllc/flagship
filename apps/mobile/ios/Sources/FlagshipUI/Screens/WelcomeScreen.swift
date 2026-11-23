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
                            // Capped, so on tall phones the picture and the headline sit high and the leftover
                            // height goes above the buttons (design audit 2026-11-20).
                            Spacer(minLength: FS.space.s6)
                                .frame(maxHeight: FS.space.s16 + FS.space.s8)
                            WelcomeArt(maxHeight: geo.size.height * 0.4)
                                .accessibilityHidden(true)
                        }
                        // The headline sits a fixed step under the picture (the leftover height goes above the
                        // picture and above the buttons, which stay at the bottom), not adrift in the middle.
                        if typeSize.isAccessibilitySize {
                            Spacer(minLength: FS.space.s8)
                        } else {
                            Color.clear.frame(height: FS.space.s12)
                        }
                        VStack(alignment: .leading, spacing: FS.space.s3) {
                            // Never squeezed to "Your apps live…": both lines at any width and text size (the
                            // ScrollView proposes a short height while the footer is pinned to the bottom).
                            Text("Your apps live\nwhere you live.")
                                .font(FS.font.h1())
                                .fixedSize(horizontal: false, vertical: true)
                                .accessibilityAddTraits(.isHeader)
                            FSColorReader { c in
                                Text("A personal cloud you actually own. You build and approve everything from your phone; your server runs your apps.")
                                    .font(.system(.body))
                                    .fixedSize(horizontal: false, vertical: true)
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

/// The owner's welcome art (0.4): the house at the end of the path with the server glowing inside and the phone in
/// front. A day and a night painting in the app's asset catalog (WelcomeArt, Any and Dark appearances), whose edges
/// fade to transparent so they bleed into the screen: no card, border or shadow. Square, the reading column's width,
/// and at most 40 % of the screen's height, so a short phone (iPhone SE) keeps its buttons on screen.
private struct WelcomeArt: View {
    var maxHeight: CGFloat

    var body: some View {
        Image("WelcomeArt", bundle: .main)
            .resizable()
            .interpolation(.high)
            .scaledToFit()
            .frame(maxWidth: .infinity, maxHeight: max(maxHeight, 0))
    }
}
