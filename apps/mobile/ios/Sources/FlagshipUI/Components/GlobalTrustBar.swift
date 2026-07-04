import SwiftUI
import FlagshipCore

/// The persistent alarming-RED trust sliver — a higher, non-dismissible variant
/// of `GlobalOperationsBar`. It pins to the top safe-area and the whole shell
/// slides DOWN to reveal it (the WhatsApp active-call-bar push-down). It shows
/// ONE line per failing CA cert ("Control server certificate expired · <slug>"
/// / "Relay certificate expired · <slug>"), slugged by cert-hash. While the
/// control server is untrusted it stays pinned — even after the owner overrides
/// (the override un-halts backend traffic; the red line PERSISTS so the
/// degraded state stays visible).
///
/// Hidden under the biometric lock (like the operations bar) so a degraded-
/// trust banner never shows through the lock screen.
///
/// Tapping a line opens the deliberate, biometric-gated OVERRIDE confirmation.
/// It is intentionally NOT dismissible by a swipe or an X — the only way it
/// leaves is the blessing verifying again (`markTrusted` clears `failures`).
public struct GlobalTrustBar: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(TrustCenter.self) private var trust
    @Environment(AppState.self) private var app

    @State private var overriding: TrustFailure?

    public init() {}

    public var body: some View {
        // Two failure SOURCES share the one red sliver: the control-CA class
        // (the `.com` global-halt) and the per-cert RELAY failures aggregated
        // across the user's pods (a warning + override — NOT a halt). Both hide
        // under the biometric lock.
        let controlFailures = app.isUnlocked ? trust.sliverFailures : []
        let relayFailures = app.isUnlocked ? trust.relayFailures : []
        let hasAny = !controlFailures.isEmpty || !relayFailures.isEmpty
        ZStack(alignment: .top) {
            if hasAny {
                VStack(spacing: 1) {
                    ForEach(controlFailures) { f in
                        TrustSliverLine(
                            failure: f,
                            serverCount: 0,
                            overridden: trust.overriddenCertHashes.contains(f.certHash),
                            scheme: scheme
                        ) {
                            overriding = f
                        }
                    }
                    // One line per DISTINCT faulty relay authority, spanning all
                    // affected servers; the "continuing" marker is wire-driven
                    // (a covering exception the box relayed) OR a local override.
                    ForEach(relayFailures) { rf in
                        TrustSliverLine(
                            failure: rf.trustFailure,
                            serverCount: rf.serverCount,
                            overridden: rf.overridden || trust.overriddenCertHashes.contains(rf.certHash),
                            scheme: scheme
                        ) {
                            overriding = rf.trustFailure
                        }
                    }
                }
                .transition(.move(edge: .top).combined(with: .opacity))
            }
        }
        .animation(.spring(response: 0.4, dampingFraction: 0.9), value: controlFailures)
        .animation(.spring(response: 0.4, dampingFraction: 0.9), value: relayFailures)
        .sheet(item: $overriding) { f in
            TrustOverrideSheet(failure: f, username: app.currentUser) { overriding = nil }
                .environment(trust)
        }
    }
}

private struct TrustSliverLine: View {
    let failure: TrustFailure
    /// >1 for a relay-cert failure spanning multiple servers; 0 for the
    /// single-authority control-CA class (no count shown).
    let serverCount: Int
    let overridden: Bool
    let scheme: ColorScheme
    let onTap: () -> Void

    var body: some View {
        let c = FSColors.scheme(scheme)
        Button(action: onTap) {
            HStack(spacing: FS.space.s2) {
                Image(systemName: "exclamationmark.shield.fill")
                    .font(.system(size: 13, weight: .bold))
                    .foregroundColor(.white)
                Text(failure.label)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundColor(.white)
                    .lineLimit(1)
                    .truncationMode(.middle)
                if serverCount > 1 {
                    Text("\(serverCount) servers")
                        .font(.system(size: 11, weight: .bold))
                        .foregroundColor(.white.opacity(0.9))
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(Color.white.opacity(0.18))
                        .clipShape(Capsule())
                }
                Spacer(minLength: FS.space.s2)
                if overridden {
                    Text("continuing")
                        .font(.system(size: 11, weight: .bold))
                        .foregroundColor(.white)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(Color.white.opacity(0.22))
                        .clipShape(Capsule())
                } else {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundColor(.white.opacity(0.85))
                }
            }
            .padding(.horizontal, FS.space.s4)
            .padding(.vertical, FS.space.s2)
            .frame(maxWidth: .infinity)
            .background(c.danger)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("global-trust-bar")
        .accessibilityLabel(Text(failure.label))
        .accessibilityHint(Text(overridden ? "Already continuing despite this" : "Review and choose whether to continue"))
    }
}

/// The deliberate override confirmation. Plain language; the destructive action
/// fires Face ID inside the VM.
private struct TrustOverrideSheet: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(TrustCenter.self) private var trust
    let failure: TrustFailure
    let username: String?
    let onDone: () -> Void

    @State private var vm: TrustOverrideViewModel?

    var body: some View {
        let c = FSColors.scheme(scheme)
        VStack(alignment: .leading, spacing: FS.space.s4) {
            HStack(spacing: FS.space.s2) {
                Image(systemName: "exclamationmark.shield.fill")
                    .foregroundColor(c.danger)
                Text("Continue anyway?")
                    .font(.title3.weight(.bold))
            }
            Text(failure.certClass == .control
                 ? "We couldn't verify the Flagship control server's certificate (\(failure.slug)). Connecting is paused. If you understand the risk, you can continue — this stays flagged."
                 : "We couldn't verify the relay's certificate (\(failure.slug)). If you understand the risk, you can continue — this stays flagged.")
                .font(.body)
                .foregroundColor(c.textMuted)

            if let vm, case .failed(let msg) = vm.phase {
                Text(msg).font(.footnote).foregroundColor(c.danger)
            }

            Spacer()

            FSDangerButton(
                vm?.phase == .signing ? "Continuing…" : "Continue anyway",
                block: true
            ) {
                Task {
                    if vm == nil {
                        vm = TrustOverrideViewModel(failure: failure, center: trust, username: username)
                    }
                    await vm?.confirmOverride()
                    if vm?.phase == .done { onDone() }
                }
            }

            Button("Not now", action: onDone)
                .font(.body.weight(.semibold))
                .frame(maxWidth: .infinity)
        }
        .padding(FS.space.s4)
        .presentationDetents([.medium])
    }
}
