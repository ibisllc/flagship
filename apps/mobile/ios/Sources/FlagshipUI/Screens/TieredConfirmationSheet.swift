import SwiftUI
import FlagshipCore

/// Two-tier confirmation, assembled from existing idioms (the TransferCallout
/// colored strip + the AccountDeletion / TransferGiver "type the domain"
/// pattern). Built in Slice C, reusable everywhere a confirm gate is needed.
///
/// - `.benign` — a colored callout ("here's what this grants you") + a single
///   affirmative button. For lightweight grants (invite / knock / access).
/// - `.severe` — danger color + **type-to-confirm** (the user re-types the exact
///   `confirmPhrase`) + the affirmative button. For irreversible actions
///   (transfer take-over, replace, wipe).
///
/// Load-bearing rule — WHAT YOU SEE IS WHAT YOU SIGN: the `title` / `message`
/// the sheet renders and the `confirmPhrase` it gates on must be derived from the
/// SAME parsed bytes the caller then signs. The sheet never fabricates effects.
public enum ConfirmSeverity: Equatable, Sendable {
    case benign
    case severe
}

public struct TieredConfirmationSheet: View {
    @Environment(\.colorScheme) private var scheme

    let severity: ConfirmSeverity
    let title: String
    let message: String
    /// For `.severe` — the exact (case-insensitive) string the user must type to
    /// arm the button (e.g. the server FQDN). Ignored for `.benign`.
    let confirmPhrase: String?
    let confirmFieldLabel: String
    let actionTitle: String
    let busy: Bool
    let onConfirm: () -> Void

    @State private var typed: String = ""

    public init(
        severity: ConfirmSeverity,
        title: String,
        message: String,
        confirmPhrase: String? = nil,
        confirmFieldLabel: String = "Type to confirm",
        actionTitle: String,
        busy: Bool = false,
        onConfirm: @escaping () -> Void
    ) {
        self.severity = severity
        self.title = title
        self.message = message
        self.confirmPhrase = confirmPhrase
        self.confirmFieldLabel = confirmFieldLabel
        self.actionTitle = actionTitle
        self.busy = busy
        self.onConfirm = onConfirm
    }

    /// `.severe` with no phrase still requires nothing typed — but by convention a
    /// take-over always passes a phrase. Armed when benign, or when the typed text
    /// matches the phrase (case-insensitive, whitespace-trimmed).
    private var armed: Bool {
        guard severity == .severe, let phrase = confirmPhrase, !phrase.isEmpty else { return true }
        return typed.trimmingCharacters(in: .whitespaces).lowercased() == phrase.lowercased()
    }

    public var body: some View {
        let c = FSColors.scheme(scheme)
        let accent: Color = severity == .severe ? c.danger : c.primary
        VStack(alignment: .leading, spacing: FS.space.s4) {
            HStack(spacing: FS.space.s2) {
                Image(systemName: severity == .severe ? "exclamationmark.triangle.fill" : "info.circle.fill")
                    .foregroundColor(accent)
                Text(title)
                    .font(FS.font.h3())
                    .foregroundColor(c.text)
            }
            Text(message)
                .font(FS.font.bodySm())
                .foregroundColor(c.text)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(FS.space.s3)
                .background(accent.opacity(0.12))
                .clipShape(RoundedRectangle(cornerRadius: FS.radius.sm))

            if severity == .severe, let phrase = confirmPhrase, !phrase.isEmpty {
                VStack(alignment: .leading, spacing: FS.space.s2) {
                    Text(confirmFieldLabel)
                        .font(FS.font.bodySm()).foregroundColor(c.textMuted)
                    TextField(phrase, text: $typed)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .padding(FS.space.s3)
                        .background(c.surface)
                        .clipShape(RoundedRectangle(cornerRadius: FS.radius.sm))
                        .accessibilityIdentifier("tiered-confirm-field")
                }
            }

            confirmButton(accent: accent)
        }
    }

    @ViewBuilder
    private func confirmButton(accent: Color) -> some View {
        let label = busy ? "Working…" : actionTitle
        Group {
            if severity == .severe {
                FSDangerButton(label, block: true) {
                    if armed && !busy { onConfirm() }
                }
            } else {
                FSPrimaryButton(label, block: true) {
                    if armed && !busy { onConfirm() }
                }
            }
        }
        .opacity(armed && !busy ? 1 : 0.4)
        .allowsHitTesting(armed && !busy)
        .accessibilityIdentifier("tiered-confirm-action")
    }
}
