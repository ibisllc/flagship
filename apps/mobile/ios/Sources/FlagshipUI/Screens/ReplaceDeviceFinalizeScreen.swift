import SwiftUI
import FlagshipCore

/// B7 — Replace-device FINALIZE screen.
///
/// Reached after `ReplaceDeviceViewModel.initiate` returns `.pending`
/// (or re-entered while a rotation is in flight). Shows the 24-hour grace
/// countdown, gates the "Complete replacement" button until the window
/// elapses, fires `complete()` on tap, and renders the terminal
/// completed / failed states.
///
/// The VM owns the ceremony + all keystore/network effects; this screen
/// is the thin presentation + a local wall-clock tick for the countdown
/// (same `@State nowMs` pattern the companion-ticket sheet uses). The
/// grace-elapsed gate is `ReplaceDeviceViewModel.graceElapsed(...)` so the
/// button's enabled-state is unit-tested independent of SwiftUI.
public struct ReplaceDeviceFinalizeScreen: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.dismiss) private var dismiss

    @Bindable var vm: ReplaceDeviceViewModel
    /// Server-reported deadline carried on the route. nil when this launch
    /// doesn't know it (cold re-entry) — the screen then offers Complete
    /// immediately and leans on the server's 425 to keep the user waiting.
    let completesAt: Int64?
    /// Called once the rotation latches locally (phase `.completed`). The
    /// shell typically signs the stale session out — the IRK just rotated.
    var onCompleted: () -> Void

    @State private var nowMs: Int64 = Int64(Date().timeIntervalSince1970 * 1000)

    public init(
        vm: ReplaceDeviceViewModel,
        completesAt: Int64?,
        onCompleted: @escaping () -> Void = {}
    ) {
        self.vm = vm
        self.completesAt = completesAt
        self.onCompleted = onCompleted
    }

    public var body: some View {
        let c = FSColors.scheme(scheme)
        ScrollView {
            VStack(alignment: .leading, spacing: FS.space.s6) {
                header(c: c)
                switch vm.phase {
                case .completed:
                    completedCard(c: c)
                case .completing:
                    workingCard("Finishing the swap…", c: c)
                case .signing, .posting:
                    workingCard("Re-confirming…", c: c)
                default:
                    pendingBody(c: c)
                }
            }
            .padding(FS.space.s6)
        }
        .navigationTitle("Replace device")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear {
            // Re-seat the VM into `.pending` so a re-entered screen shows
            // the countdown even if the VM was freshly constructed.
            if let completesAt { vm.resume(completesAt: completesAt) }
        }
        .task {
            // Tick the wall clock so the countdown + button-gate refresh.
            while !Task.isCancelled {
                nowMs = Int64(Date().timeIntervalSince1970 * 1000)
                try? await Task.sleep(nanoseconds: 1_000_000_000)
            }
        }
        .onChange(of: phaseIsCompleted) { _, done in
            if done { onCompleted() }
        }
    }

    // MARK: - Sections

    private func header(c: FSColors) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s2) {
            Image(systemName: "arrow.triangle.2.circlepath.circle.fill")
                .font(.system(size: 40))
                .foregroundColor(c.primary)
            Text("Replacing this device")
                .font(FS.font.h3())
                .foregroundColor(c.text)
            Text("This rotates your account's identity key. Once the grace window ends, every other device on the account must re-pair the next time it opens — including this phone. Your pods keep running and your apps stay installed.")
                .font(FS.font.bodySm())
                .foregroundColor(c.textMuted)
        }
    }

    @ViewBuilder
    private func pendingBody(c: FSColors) -> some View {
        FSCard {
            VStack(alignment: .leading, spacing: FS.space.s3) {
                if let completesAt {
                    countdown(completesAt: completesAt, c: c)
                } else {
                    Text("Grace window in progress")
                        .font(FS.font.h4())
                        .foregroundColor(c.text)
                    Text("We don't have the exact deadline on this device. You can try to complete now — if the 24-hour window hasn't passed yet, the server will ask you to wait.")
                        .font(FS.font.bodySm())
                        .foregroundColor(c.textMuted)
                }

                Text("During this window, another device on your account can object and cancel the replacement.")
                    .font(FS.font.caption())
                    .foregroundColor(c.textMuted)

                FSPrimaryButton(
                    "Complete replacement",
                    enabled: completeEnabled,
                    block: true,
                    large: true
                ) {
                    Task { await vm.complete() }
                }
                .accessibilityIdentifier("replace-finalize-complete")

                if !completeEnabled, let completesAt, !graceElapsed(completesAt) {
                    Text("Available once the countdown reaches zero.")
                        .font(FS.font.caption())
                        .foregroundColor(c.textMuted)
                        .frame(maxWidth: .infinity, alignment: .center)
                }
            }
        }

        if case let .failed(msg) = vm.phase {
            failureCard(msg, c: c)
        }
    }

    private func countdown(completesAt: Int64, c: FSColors) -> some View {
        let elapsed = graceElapsed(completesAt)
        return VStack(alignment: .leading, spacing: FS.space.s1) {
            Text(elapsed ? "Grace window complete" : "Takes effect in")
                .font(FS.font.caption())
                .foregroundColor(c.textMuted)
            Text(elapsed ? "Ready to complete" : remainingLabel(completesAt))
                .font(.system(size: 30, weight: .semibold, design: .rounded))
                .monospacedDigit()
                .foregroundColor(elapsed ? c.success : c.text)
                .accessibilityIdentifier("replace-finalize-countdown")
        }
    }

    private func completedCard(c: FSColors) -> some View {
        FSCard {
            VStack(alignment: .leading, spacing: FS.space.s2) {
                Label("Replacement complete", systemImage: "checkmark.seal.fill")
                    .font(FS.font.h4())
                    .foregroundColor(c.success)
                Text("Your identity key has rotated. Other devices on this account will be asked to re-pair the next time they open the app.")
                    .font(FS.font.bodySm())
                    .foregroundColor(c.textMuted)
                FSPrimaryButton("Done", block: true, large: true) {
                    onCompleted()
                    dismiss()
                }
                .accessibilityIdentifier("replace-finalize-done")
            }
        }
    }

    private func workingCard(_ label: String, c: FSColors) -> some View {
        FSCard {
            HStack(spacing: FS.space.s3) {
                ProgressView()
                Text(label)
                    .font(FS.font.body())
                    .foregroundColor(c.text)
            }
        }
    }

    private func failureCard(_ msg: String, c: FSColors) -> some View {
        FSCard {
            VStack(alignment: .leading, spacing: FS.space.s2) {
                Label("Couldn't complete", systemImage: "exclamationmark.triangle.fill")
                    .font(FS.font.h4())
                    .foregroundColor(c.danger)
                Text(msg)
                    .font(FS.font.bodySm())
                    .foregroundColor(c.textMuted)
                    .accessibilityIdentifier("replace-finalize-error")
            }
        }
    }

    // MARK: - Derived

    private var phaseIsCompleted: Bool {
        if case .completed = vm.phase { return true }
        return false
    }

    /// The Complete button is enabled when the grace window has elapsed,
    /// or when we don't know the deadline (cold re-entry) — in which case
    /// the server's 425 is the backstop. Disabled while a leg is already
    /// in flight.
    private var completeEnabled: Bool {
        switch vm.phase {
        case .signing, .posting, .completing, .completed:
            return false
        default:
            break
        }
        guard let completesAt else { return true }
        return graceElapsed(completesAt)
    }

    private func graceElapsed(_ completesAt: Int64) -> Bool {
        ReplaceDeviceViewModel.graceElapsed(
            completesAt: completesAt,
            now: Date(timeIntervalSince1970: TimeInterval(nowMs) / 1000)
        )
    }

    private func remainingLabel(_ completesAt: Int64) -> String {
        let remainingMs = max(0, completesAt - nowMs)
        let secs = Int(remainingMs / 1000)
        let fmt = DateComponentsFormatter()
        fmt.allowedUnits = secs >= 3600 ? [.hour, .minute, .second] : [.minute, .second]
        fmt.unitsStyle = .positional
        fmt.zeroFormattingBehavior = [.pad]
        return fmt.string(from: TimeInterval(secs)) ?? "\(secs)s"
    }
}
