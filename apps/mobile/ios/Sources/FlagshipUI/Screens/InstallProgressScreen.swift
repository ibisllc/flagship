import SwiftUI

/// Live install-progress UI. Renders the five-step provisioning
/// timeline as the SSE stream emits events. On `.ready` shows the
/// new FQDN + a finish CTA; on `.failed` surfaces the reason.
public struct InstallProgressScreen: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable var vm: InstallProgressViewModel
    var onFinish: (String) -> Void = { _ in }

    public init(vm: InstallProgressViewModel, onFinish: @escaping (String) -> Void = { _ in }) {
        self.vm = vm
        self.onFinish = onFinish
    }

    public var body: some View {
        let c = FSColors.scheme(scheme)
        ScrollView {
            VStack(alignment: .leading, spacing: FS.space.s6) {
                header(c: c)
                steps(c: c)
                if let reason = vm.failedReason {
                    FSCard {
                        VStack(alignment: .leading, spacing: FS.space.s2) {
                            HStack {
                                Image(systemName: "exclamationmark.triangle.fill").foregroundColor(c.danger)
                                Text("Provisioning failed").font(FS.font.h4()).foregroundColor(c.text)
                            }
                            Text(reason).font(FS.font.bodySm()).foregroundColor(c.textMuted)
                        }
                    }
                } else if vm.isDone, let fqdn = vm.serverFqdn {
                    FSCard {
                        VStack(alignment: .leading, spacing: FS.space.s3) {
                            HStack(spacing: FS.space.s2) {
                                Image(systemName: "checkmark.seal.fill").foregroundColor(c.success)
                                Text("Live and serving").font(FS.font.h4()).foregroundColor(c.text)
                            }
                            Text(fqdn).font(FS.font.mono()).foregroundColor(c.text)
                        }
                    }
                    FSPrimaryButton("Finish", block: true, large: true) {
                        onFinish(fqdn)
                    }
                }
                Spacer().frame(height: FS.space.s12)
            }
            .padding(.horizontal, FS.space.s6)
            .padding(.top, FS.space.s8)
        }
        .background(c.bg.ignoresSafeArea())
        .navigationTitle("Provisioning")
        .navigationBarTitleDisplayMode(.inline)
        .task { vm.start() }
        .onDisappear { vm.cancel() }
    }

    private func header(c: FSColors) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s2) {
            Text("Bringing up").font(FS.font.h2()).foregroundColor(c.text)
            Text("Serial \(vm.serial)").font(FS.font.mono()).foregroundColor(c.textMuted)
        }
    }

    private func steps(c: FSColors) -> some View {
        FSCard {
            VStack(spacing: FS.space.s4) {
                ForEach(InstallProgressViewModel.Step.allCases, id: \.self) { step in
                    stepRow(step, c: c)
                    if step != InstallProgressViewModel.Step.allCases.last {
                        Divider().background(c.border).padding(.leading, 36)
                    }
                }
            }
        }
    }

    private func stepRow(_ step: InstallProgressViewModel.Step, c: FSColors) -> some View {
        let isDone = isStepDone(step)
        let isActive = !isDone && nextStep == step
        return HStack(spacing: FS.space.s3) {
            ZStack {
                Circle()
                    .stroke(isDone ? c.success : (isActive ? c.primary : c.border), lineWidth: 2)
                    .frame(width: 24, height: 24)
                if isDone {
                    Image(systemName: "checkmark").font(.system(size: 12, weight: .bold)).foregroundColor(c.success)
                } else if isActive {
                    Circle().fill(c.primary).frame(width: 8, height: 8)
                }
            }
            Text(step.title)
                .foregroundColor(isDone || isActive ? c.text : c.textMuted)
                .font(.system(size: 16, weight: isActive ? .semibold : .regular))
            Spacer()
            if isActive { ProgressView().controlSize(.small) }
        }
    }

    /// Highest index among completed steps (-1 if none).
    private var furthestDoneIndex: Int {
        vm.completed
            .compactMap { InstallProgressViewModel.Step.allCases.firstIndex(of: $0) }
            .max() ?? -1
    }

    /// A step is done if it (or any LATER step) has been observed — so an
    /// unreliable earlier beacon that never lands (e.g. the pre-WiFi
    /// `d-i-started`) doesn't leave a spinner stranded behind the frontier.
    private func isStepDone(_ step: InstallProgressViewModel.Step) -> Bool {
        guard let i = InstallProgressViewModel.Step.allCases.firstIndex(of: step) else { return false }
        return vm.completed.contains(step) || i < furthestDoneIndex
    }

    private var nextStep: InstallProgressViewModel.Step? {
        InstallProgressViewModel.Step.allCases.first(where: { !isStepDone($0) })
    }
}
