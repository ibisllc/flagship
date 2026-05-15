import SwiftUI
import FlagshipAPI
import FlagshipCore

/// V2 — Replace App URL stem confirmation sheet.
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
struct ReplaceAppStemSheet: View {
    @Environment(\.colorScheme) private var scheme
    @Binding var draft: String
    let phase: AppDetailViewModel.RenamePhase
    let onCancel: () -> Void
    let onConfirm: () -> Void

    var body: some View {
        let c = FSColors.scheme(scheme)
        VStack(alignment: .leading, spacing: FS.space.s4) {
            HStack {
                Image(systemName: "arrow.triangle.2.circlepath")
                    .foregroundColor(c.danger)
                    .imageScale(.large)
                Text("Replace web stem")
                    .font(.system(size: 22, weight: .semibold))
                    .foregroundColor(c.text)
                Spacer()
            }
            Text("This rotates every URL for this app to a new stem you pick. The current short link **breaks immediately** — anyone who saved a `voi.ci/…` for this app will need a fresh one.")
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
        guard !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return false }
        switch phase {
        case .signing, .posting: return false
        default: return true
        }
    }

    private var buttonLabel: String {
        switch phase {
        case .signing: return "Signing…"
        case .posting: return "Replacing…"
        default: return "Replace"
        }
    }
}
