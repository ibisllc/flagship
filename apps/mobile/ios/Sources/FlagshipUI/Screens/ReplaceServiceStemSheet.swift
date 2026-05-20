import SwiftUI
import FlagshipAPI
import FlagshipCore

/// V2 — Replace Service URL stem confirmation sheet.
///
/// Two-stage UX:
///   1. Editable text field pre-filled with the current stem.
///   2. Inline validation hint + a danger-style Replace button that
///      stays disabled until the field is non-empty and differs from
///      the current stem.
///
/// On confirm, the parent runs the rename ceremony (signs canonical
/// bytes with the user's IRK, POSTs to .com). The sheet renders the
/// phase reactively — Signing → Posting → Failed or dismissed on
/// success.
///
/// Live links written against the OLD stem stop working the moment
/// the rename commits (.com cascade-deletes them). The body copy
/// makes that explicit so a user doesn't blindly rotate a stem people
/// are actively visiting.
struct ReplaceServiceStemSheet: View {
    @Environment(\.colorScheme) private var scheme
    @Binding var draft: String
    /// The stem currently in every URL — interpolated into the body so
    /// the user sees exactly what is being replaced.
    let currentStem: String
    let phase: ServiceDetailViewModel.RenamePhase
    let onCancel: () -> Void
    let onConfirm: () -> Void

    /// Mirrors the Worker's `DNS_LABEL_RE` in serviceRename.ts. Keep in
    /// sync — drift means the button enables for stems the server
    /// then rejects.
    private static let stemRegex =
        try! NSRegularExpression(pattern: "^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$")

    var body: some View {
        let c = FSColors.scheme(scheme)
        VStack(alignment: .leading, spacing: FS.space.s4) {
            HStack {
                Image(systemName: "arrow.triangle.2.circlepath")
                    .foregroundColor(c.danger)
                    .imageScale(.large)
                Text("Replace access URLs")
                    .font(.system(size: 22, weight: .semibold))
                    .foregroundColor(c.text)
                Spacer()
            }
            Text("This will update all the links to this service, replacing **\(currentStem)** with a new stem. All existing links break immediately, including the short link. If you have attached external domains, those stay unaffected.")
                .font(FS.font.bodySm())
                .foregroundColor(c.textMuted)

            VStack(alignment: .leading, spacing: FS.space.s2) {
                Text("NEW STEM")
                    .font(.system(size: 11, weight: .semibold))
                    .tracking(1)
                    .foregroundColor(c.textMuted)
                TextField("mynotes", text: $draft)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .font(.system(size: 16, design: .monospaced))
                    .padding(FS.space.s3)
                    .background(c.surface)
                    .overlay(
                        RoundedRectangle(cornerRadius: FS.radius.sm)
                            .stroke(c.border, lineWidth: 1)
                    )
                    .accessibilityIdentifier("replace-stem-field")
                Text("Lowercase letters, digits, and hyphens. 1–40 characters. No leading or trailing hyphen.")
                    .font(FS.font.caption())
                    .foregroundColor(c.textMuted)
            }

            if case let .failed(msg) = phase {
                Text(msg)
                    .font(FS.font.caption())
                    .foregroundColor(c.danger)
            }

            HStack(spacing: FS.space.s2) {
                Button("Cancel", action: onCancel)
                    .buttonStyle(.bordered)
                Spacer()
                FSDangerButton(buttonLabel, block: false, action: onConfirm)
                    .disabled(!canConfirm)
                    .opacity(canConfirm ? 1.0 : 0.5)
            }
            .padding(.top, FS.space.s2)
        }
        .padding(FS.space.s6)
        .background(c.bg)
    }

    private var canConfirm: Bool {
        let stem = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !stem.isEmpty, stem != currentStem, Self.isValidStem(stem) else { return false }
        switch phase {
        case .signing, .posting: return false
        default: return true
        }
    }

    /// True iff `stem` is a valid DNS-label fragment per the Worker rule.
    static func isValidStem(_ stem: String) -> Bool {
        let r = NSRange(stem.startIndex..., in: stem)
        return stemRegex.firstMatch(in: stem, range: r) != nil
    }

    private var buttonLabel: String {
        switch phase {
        case .signing: return "Signing…"
        case .posting: return "Replacing…"
        default: return "Replace"
        }
    }
}
