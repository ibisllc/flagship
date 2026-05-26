import SwiftUI
import FlagshipAPI
import FlagshipCore

/// D.2.2 — ChooseUsernameScreen.
///
/// **Create-only.** As of the login redesign, demo + device-capability
/// activation moved OUT of this screen and into the username-first Join
/// flow (JoinUsernameScreen → `/api/account/resolve`). This screen now
/// only PICKS the account name (identity-first copy — no "server's
/// domain" framing). Continuing pushes the Phase-2 Open-account step,
/// which generates the UMK + signs the standalone username claim; there
/// is no longer a demo or dot-form branch on the create path. The live
/// availability check (debounced 350 ms) against the Worker's
/// `/api/users/check` still drives the available / taken / invalid
/// states.
public struct ChooseUsernameScreen: View {
    @Environment(\.flagshipServerClient) private var server
    @State private var username: String = ""
    @State private var vm: ChooseUsernameViewModel?

    /// Continuation. Called with the validated username when the CTA's
    /// tapped.
    var onContinue: (String) -> Void

    public init(
        onContinue: @escaping (String) -> Void = { _ in }
    ) {
        self.onContinue = onContinue
    }

    public var body: some View {
        FSScreen {
            VStack(alignment: .leading, spacing: FS.space.s6) {
                Spacer().frame(height: FS.space.s12)
                Text("Pick your account name.").font(FS.font.h2())
                FSColorReader { c in
                    Text("This is your identity — how people and your devices find you. It's permanent. You can add servers later, or none at all.")
                        .font(FS.font.body()).foregroundColor(c.textMuted)
                }
                FSField(
                    value: $username,
                    label: "Username",
                    placeholder: "harry",
                    helper: helperText,
                    error: errorText
                )
                .keyboardType(.asciiCapable)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled(true)
                .onChange(of: username) { _, newValue in
                    let lower = newValue.lowercased()
                    if lower != newValue { username = lower }
                }
                .task(id: username) {
                    await vm?.evaluate(username)
                }
                trademarkClaimAffordance
                Spacer()
                FSPrimaryButton(
                    "Continue",
                    enabled: vm?.status.allowsContinue ?? false,
                    block: true,
                    large: true
                ) {
                    guard vm != nil else { return }
                    onContinue(username)
                }
            }
            .padding(.horizontal, FS.space.s6)
            .padding(.bottom, FS.space.s8)
        }
        .task {
            if vm == nil { vm = ChooseUsernameViewModel(server: server) }
        }
    }

    /// Shown only in the `.taken` state: a subtle "I hold a trademark"
    /// affordance that opens a prefilled mailto to the trademarks desk
    /// (TrademarkClaim mirrors the canonical webapp message).
    @ViewBuilder private var trademarkClaimAffordance: some View {
        if case .taken = vm?.status, let url = TrademarkClaim.mailtoURL(username: username) {
            FSColorReader { c in
                Link(destination: url) {
                    Text("I hold a trademark to this name")
                        .font(FS.font.caption())
                        .foregroundColor(c.textMuted)
                        .underline()
                }
                .accessibilityIdentifier("trademark-claim-link")
            }
        }
    }

    private var helperText: String? {
        guard let status = vm?.status else { return "Letters and digits only. 1–32 characters." }
        switch status {
        case .empty:                     return "Letters and digits only. 1–32 characters."
        case .invalid:                   return nil
        case .checking:                  return "Checking…"
        case .available:                 return "Available."
        case .networkFallbackAvailable:  return "Looks OK — we'll confirm when you continue."
        case .taken:                     return nil
        }
    }

    private var errorText: String? {
        guard let status = vm?.status else { return nil }
        switch status {
        case .invalid(let reason): return reason
        case .taken:               return "Already taken."
        default:                   return nil
        }
    }
}
