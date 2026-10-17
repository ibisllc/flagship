import SwiftUI

/// The bottom of the two front-door screens, Welcome (no account) and the app
/// lock: a big primary button, the secondary option right below it, a gap,
/// then "Patent Pending" above the home indicator. One component so both
/// screens stay identical (Android FSActionFooter, webapp .action-footer).
public struct FSActionFooter: View {
    @Environment(\.colorScheme) private var scheme
    let primary: String
    let primaryEnabled: Bool
    let primaryId: String
    let secondary: String
    let secondaryId: String
    let secondaryHint: String?
    let onPrimary: () -> Void
    let onSecondary: () -> Void

    public init(
        primary: String,
        primaryEnabled: Bool = true,
        primaryId: String,
        secondary: String,
        secondaryId: String,
        secondaryHint: String? = nil,
        onPrimary: @escaping () -> Void,
        onSecondary: @escaping () -> Void
    ) {
        self.primary = primary
        self.primaryEnabled = primaryEnabled
        self.primaryId = primaryId
        self.secondary = secondary
        self.secondaryId = secondaryId
        self.secondaryHint = secondaryHint
        self.onPrimary = onPrimary
        self.onSecondary = onSecondary
    }

    public var body: some View {
        let c = FSColors.scheme(scheme)
        VStack(spacing: 0) {
            FSPrimaryButton(primary, enabled: primaryEnabled, block: true, large: true, action: onPrimary)
                .accessibilityIdentifier(primaryId)
            FSSecondaryButton(secondary, block: true, large: true, action: onSecondary)
                .accessibilityIdentifier(secondaryId)
                .accessibilityHint(secondaryHint ?? "")
                .padding(.top, FS.space.s3)
            Text("Patent Pending")
                .font(FS.font.caption())
                .foregroundColor(c.textMuted)
                .padding(.top, FS.space.s8)
                .padding(.bottom, FS.space.s4)
                .accessibilityIdentifier("patent-pending")
        }
    }
}
