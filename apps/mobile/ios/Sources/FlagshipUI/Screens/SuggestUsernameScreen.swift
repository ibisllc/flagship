import SwiftUI
import FlagshipAPI
import FlagshipCore

/// CREATE path — hands the user one random handle. The ONLY affordances are
/// regenerate (rate-limited, with a live "Try again in Ns" countdown) and
/// Continue (claims the shown name in the next step). No typed field: a name of
/// one's own is the paid "Choose your own account name" (ChooseAccountNameScreen).
/// See docs/username-suggestion-queue.md.
public struct SuggestUsernameScreen: View {
    @Environment(\.flagshipServerClient) private var server
    @State private var vm: SuggestUsernameViewModel?

    /// Continuation — called with the chosen handle when Continue is tapped.
    var onContinue: (String) -> Void
    /// "Choose your own account name", with the suggested name (the account is opened under it first).
    var onChooseOwn: (String) -> Void
    /// A name-grant link is waiting: go on to "Choose your own account name" as soon as a name is suggested.
    var autoChooseOwn: Bool

    public init(onContinue: @escaping (String) -> Void = { _ in }, onChooseOwn: @escaping (String) -> Void = { _ in },
                autoChooseOwn: Bool = false) {
        self.onContinue = onContinue
        self.onChooseOwn = onChooseOwn
        self.autoChooseOwn = autoChooseOwn
    }

    public var body: some View {
        FSScreen {
            VStack(alignment: .leading, spacing: FS.space.s6) {
                Spacer().frame(height: FS.space.s12)
                Text("Your handle").font(FS.font.h2())
                FSColorReader { c in
                    Text("Here's a free, random username. You can change it later.")
                        .font(FS.font.body()).foregroundColor(c.textMuted)
                }
                FSColorReader { c in
                    VStack(spacing: FS.space.s2) {
                        FSAccountAddress(name: vm?.current ?? " ", nameIdentifier: "suggest-username-name")
                        Text("Your page address, if you turn it on.")
                            .font(FS.font.bodySm())
                            .foregroundColor(c.textMuted)
                            .multilineTextAlignment(.center)
                    }
                    .frame(maxWidth: .infinity, alignment: .center)
                    .padding(.vertical, FS.space.s4)
                }
                FSSecondaryButton(regenLabel, block: true) {
                    Task { await vm?.regenerate() }
                }
                .disabled(!(vm?.canRegenerate ?? false))
                .accessibilityIdentifier("suggest-regenerate")
                FSGhostButton(String(localized: "Choose your own account name"), block: true) {
                    if let name = vm?.current { onChooseOwn(name) }
                }
                .disabled(!(vm?.canContinue ?? false))
                .accessibilityIdentifier("suggest-choose-own")
                if let err = vm?.errorText {
                    FSColorReader { c in
                        Text(err).font(FS.font.caption()).foregroundColor(c.danger)
                    }
                }
                Spacer()
                FSPrimaryButton(
                    String(localized: "Continue"),
                    enabled: vm?.canContinue ?? false,
                    block: true,
                    large: true
                ) {
                    if let name = vm?.current { onContinue(name) }
                }
            }
            .padding(.horizontal, FS.space.s6)
            .padding(.bottom, FS.space.s8)
        }
        .task {
            if vm == nil {
                vm = SuggestUsernameViewModel(
                    suggest: { [server] key in try await server.suggestUsername(deviceKey: key) }
                )
            }
            await vm?.load()
            if autoChooseOwn, let name = vm?.current { onChooseOwn(name) }
        }
    }

    private var regenLabel: String {
        let r = vm?.cooldownRemaining ?? 0
        if r >= 60 { return String(localized: "Try again in \((r + 59) / 60) min") }
        return r > 0 ? String(localized: "Try again in \(r)s") : "↻ Try another"
    }
}
