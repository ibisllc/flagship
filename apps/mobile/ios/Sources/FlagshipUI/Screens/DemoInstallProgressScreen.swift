import SwiftUI
import FlagshipCore
import FlagshipAPI

/// A thin determinate progress bar for the Home list — shows on a demo
/// server still being installed. `failed` renders in the danger colour
/// (the daemon retries, so the detail page frames it as "retrying").
public struct DemoProgressBar: View {
    @Environment(\.colorScheme) private var scheme
    let fraction: Double
    let failed: Bool

    public init(fraction: Double, failed: Bool = false) {
        self.fraction = max(0, min(1, fraction))
        self.failed = failed
    }

    public var body: some View {
        let c = FSColors.scheme(scheme)
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(c.border.opacity(0.5))
                Capsule()
                    .fill(failed ? c.danger : c.primary)
                    .frame(width: geo.size.width * CGFloat(fraction))
            }
        }
        .frame(height: 4)
    }
}

/// Detail page for a demo server that's still installing — the
/// "your server is being installed" surface. Shows:
///   - the determinate progress bar,
///   - the four named steps (Booting / Registering / Securing / Ready)
///     with per-step state (done ✓ / active spinner / pending / failed),
///     where the active/failed step carries the fine-grained status
///     comment or `lastError`,
///   - the device info block (IP / location / OS / size) so the user can
///     confirm it's THEIR device, and
///   - a "Cancel this device" button (with a confirm).
///
/// `failed` is modeled as "retrying — last error: …" not a dead end,
/// because the daemon now stays up and retries ACME.
public struct DemoInstallProgressScreen: View {
    @Environment(\.colorScheme) private var scheme
    let pod: PodInfo
    var onCancel: () -> Void

    public init(pod: PodInfo, onCancel: @escaping () -> Void = {}) {
        self.pod = pod
        self.onCancel = onCancel
    }

    @State private var confirming = false

    private var block: DemoServerBlock? { pod.demoServer }

    public var body: some View {
        let c = FSColors.scheme(scheme)
        ScrollView {
            VStack(alignment: .leading, spacing: FS.space.s4) {
                Spacer().frame(height: FS.space.s2)
                VStack(alignment: .leading, spacing: FS.space.s2) {
                    Text(pod.name).font(FS.font.h2()).foregroundColor(c.text)
                    Text("Your server is being installed")
                        .font(FS.font.body()).foregroundColor(c.textMuted)
                }

                FSCard {
                    VStack(alignment: .leading, spacing: FS.space.s3) {
                        DemoProgressBar(
                            fraction: ProvisionProgress.fraction(block?.phase),
                            failed: block?.phase == "failed"
                        )
                        .accessibilityIdentifier("install-progress-bar")
                        stepList(c)
                    }
                }

                deviceInfo(c)

                FSDangerButton("Cancel this device", block: true, large: true) {
                    confirming = true
                }
                .accessibilityIdentifier("install-cancel-device-button")

                Spacer().frame(height: FS.space.s12)
            }
            .padding(.horizontal, FS.space.s6)
        }
        .background(c.bg.ignoresSafeArea())
        .navigationTitle("Installing")
        .navigationBarTitleDisplayMode(.inline)
        .confirmationDialog(
            "Cancel this device?",
            isPresented: $confirming,
            titleVisibility: .visible
        ) {
            Button("Cancel this device", role: .destructive) { onCancel() }
            Button("Keep installing", role: .cancel) {}
        } message: {
            Text("This tears down the server and stops the install. You can start over from your account at any time.")
        }
    }

    @ViewBuilder
    private func stepList(_ c: FSColors) -> some View {
        let steps = ProvisionProgress.stepStates(
            phase: block?.phase,
            lastError: block?.lastError
        )
        VStack(alignment: .leading, spacing: FS.space.s3) {
            ForEach(steps, id: \.key) { step in
                HStack(alignment: .top, spacing: FS.space.s3) {
                    stepIcon(step.state, c)
                        .frame(width: 18)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(step.label)
                            .font(FS.font.body())
                            .foregroundColor(step.state == .pending ? c.textMuted : c.text)
                        if let detail = step.detail {
                            if step.state == .failed {
                                Text("Retrying — last error: \(detail)")
                                    .font(FS.font.bodySm())
                                    .foregroundColor(c.danger)
                            } else {
                                Text(detail)
                                    .font(FS.font.bodySm())
                                    .foregroundColor(c.textMuted)
                            }
                        }
                    }
                    Spacer(minLength: 0)
                }
                .accessibilityIdentifier("install-step-\(step.key.rawValue)")
            }
        }
    }

    @ViewBuilder
    private func stepIcon(_ state: ProvisionProgress.StepState, _ c: FSColors) -> some View {
        switch state {
        case .done:
            Image(systemName: "checkmark.circle.fill").foregroundColor(c.success)
        case .active:
            ProgressView().scaleEffect(0.7).tint(c.primary)
        case .failed:
            Image(systemName: "exclamationmark.triangle.fill").foregroundColor(c.danger)
        case .pending:
            Image(systemName: "circle").foregroundColor(c.textMuted)
        }
    }

    @ViewBuilder
    private func deviceInfo(_ c: FSColors) -> some View {
        if let b = block, b.ip != nil || b.region != nil || b.image != nil || b.serverType != nil {
            FSCard {
                VStack(alignment: .leading, spacing: FS.space.s2) {
                    Text("This device")
                        .font(.system(size: 12, weight: .semibold))
                        .tracking(1)
                        .foregroundColor(c.textMuted)
                    if let ip = b.ip { infoRow("IP", ip, mono: true, c) }
                    if let region = b.region { infoRow("Location", region, mono: false, c) }
                    if let image = b.image { infoRow("OS", image, mono: false, c) }
                    if let size = b.serverType { infoRow("Size", size, mono: false, c) }
                }
            }
            .accessibilityIdentifier("install-device-info")
        }
    }

    @ViewBuilder
    private func infoRow(_ label: String, _ value: String, mono: Bool, _ c: FSColors) -> some View {
        HStack {
            Text(label).foregroundColor(c.textMuted)
            Spacer()
            Text(value)
                .font(mono ? FS.font.mono() : FS.font.body())
                .foregroundColor(c.text)
        }
    }
}
