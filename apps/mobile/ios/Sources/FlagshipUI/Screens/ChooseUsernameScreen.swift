import SwiftUI

/// D.2.2 — ChooseUsernameScreen.
public struct ChooseUsernameScreen: View {
    @State private var username: String = ""
    @State private var status: UsernameStatus = .empty
    var onContinue: (String) -> Void
    public init(onContinue: @escaping (String) -> Void = { _ in }) {
        self.onContinue = onContinue
    }
    public var body: some View {
        FSScreen {
            VStack(alignment: .leading, spacing: FS.space.s6) {
                Spacer().frame(height: FS.space.s12)
                Text("Pick a username.").font(FS.font.h2())
                FSColorReader { c in
                    Text("This is permanent. It becomes the middle of your server's domain (e.g. home.<username>.flagship.services).")
                        .font(FS.font.body()).foregroundColor(c.textMuted)
                }
                FSField(
                    value: $username,
                    label: "Username",
                    placeholder: "harry",
                    helper: helperText,
                    error: errorText
                )
                .onChange(of: username) { newValue in
                    let lower = newValue.lowercased()
                    if lower != newValue { username = lower }
                    status = computeStatus(for: lower)
                }
                Spacer()
                FSPrimaryButton("Continue", enabled: status == .available, block: true, large: true) {
                    onContinue(username)
                }
            }
            .padding(.horizontal, FS.space.s6)
            .padding(.bottom, FS.space.s8)
        }
    }
    private var helperText: String? {
        switch status {
        case .empty: return "Letters and digits only. 1–32 characters."
        case .invalid: return nil
        case .checking: return "Checking…"
        case .available: return "Available."
        case .taken: return nil
        }
    }
    private var errorText: String? {
        switch status {
        case .invalid: return "Letters and digits only. No spaces or punctuation."
        case .taken: return "Already taken."
        default: return nil
        }
    }
    private func computeStatus(for s: String) -> UsernameStatus {
        if s.isEmpty { return .empty }
        let valid = s.range(of: "^[a-z0-9]{1,32}$", options: .regularExpression) != nil
        if !valid { return .invalid }
        // TODO: GET /api/users/check; optimistic Available
        return .available
    }
    enum UsernameStatus { case empty, invalid, checking, available, taken }
}
