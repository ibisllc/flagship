import SwiftUI
import FlagshipAPI
import FlagshipCore

/// What a person can do when a server's install stopped: cancel the order and
/// make the server again, or write to support with the order number. Replaces
/// a bare "Failed - ..." line on the timeline that had no way forward.
struct SetupStoppedCard: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.openURL) private var openURL
    let serial: String
    /// The box's own words for the step, already stripped of internals.
    let step: String?
    /// Why the last cancel didn't go through, when it didn't.
    let cancelError: String?
    let working: Bool
    /// Nil on a device that may not cancel (not an admin device).
    let onCancelOrder: (() -> Void)?

    var body: some View {
        let c = FSColors.scheme(scheme)
        FSCard {
            VStack(alignment: .leading, spacing: FS.space.s3) {
                Text("Setup stopped")
                    .font(FS.font.h4())
                    .foregroundColor(c.text)
                Text(SetupStoppedCard.explanation(step: step, canCancel: onCancelOrder != nil))
                    .font(FS.font.body())
                    .foregroundColor(c.textMuted)
                if let cancelError {
                    Text(cancelError)
                        .font(FS.font.bodySm())
                        .foregroundColor(c.danger)
                        .accessibilityIdentifier("setup-stopped-cancel-error")
                }
                if let onCancelOrder {
                    FSDangerButton(
                        working ? String(localized: "Cancelling…") : SetupStoppedCard.cancelLabel(afterFailure: cancelError != nil),
                        block: true,
                        large: true,
                        action: onCancelOrder
                    )
                    .disabled(working)
                    .accessibilityIdentifier("setup-stopped-start-again")
                }
                FSSecondaryButton(String(localized: "Contact us"), block: true) {
                    if let url = SupportContact.setupStoppedURL(serial: serial, step: step) { openURL(url) }
                }
                .accessibilityIdentifier("setup-stopped-contact")
            }
        }
        // .contain keeps the buttons' own ids under the card's.
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("setup-stopped")
    }

    static func explanation(step: String?, canCancel: Bool) -> String {
        var text = String(localized: "This server didn't finish installing.")
        if let step, !step.isEmpty { text += " " + (step.hasSuffix(".") ? step : step + ".") }
        text += canCancel
            ? " Cancel this order to free the name and create the server again, or contact us and we'll look at it."
            : " Contact us and we'll look at it."
        return text
    }

    static func cancelLabel(afterFailure: Bool) -> String {
        afterFailure ? CancelPendingOrder.retryLabel : String(localized: "Cancel order and start again")
    }
}
