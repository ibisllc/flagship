import SwiftUI
import FlagshipAPI
import FlagshipCore

/// CREATE path — hands the user one random handle. The ONLY affordances are
/// regenerate (rate-limited, with a live "Try again in Ns" countdown) and
/// Continue (claims the shown name in the next step). No typed field — a custom
/// name is the future paid name-change. See docs/username-suggestion-queue.md.
public struct SuggestUsernameScreen: View {
    @Environment(\.flagshipServerClient) private var server
    @State private var vm: SuggestUsernameViewModel?

    /// Continuation — called with the chosen handle when Continue is tapped.
    var onContinue: (String) -> Void

    public init(onContinue: @escaping (String) -> Void = { _ in }) {
        self.onContinue = onContinue
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
                    Text(vm?.current ?? " ")
                        .font(FS.font.h1())
                        .foregroundColor(c.text)
                        .frame(maxWidth: .infinity, alignment: .center)
                        .padding(.vertical, FS.space.s4)
                        .accessibilityIdentifier("suggest-username-name")
                }
                FSSecondaryButton(regenLabel, block: true) {
                    Task { await vm?.regenerate() }
                }
                .disabled(!(vm?.canRegenerate ?? false))
                .accessibilityIdentifier("suggest-regenerate")
                if let err = vm?.errorText {
                    FSColorReader { c in
                        Text(err).font(FS.font.caption()).foregroundColor(c.danger)
                    }
                }
                Spacer()
                FSPrimaryButton(
                    "Continue",
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
        }
    }

    private var regenLabel: String {
        let r = vm?.cooldownRemaining ?? 0
        return r > 0 ? "Try again in \(r)s" : "↻ Try another"
    }
}
