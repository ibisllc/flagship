import SwiftUI
import FlagshipAPI
import FlagshipCore

/// Small inline callout — mirrors the replace/transfer screens' tinted strip.
private struct MigrateCallout: View {
    @Environment(\.colorScheme) private var scheme
    enum Kind { case success, info, danger, warning }
    let kind: Kind
    let text: String
    var body: some View {
        let c = FSColors.scheme(scheme)
        let color: Color = {
            switch kind {
            case .success: return c.success
            case .danger: return c.danger
            case .warning: return c.warning
            case .info: return c.primary
            }
        }()
        Text(text)
            .font(FS.font.bodySm())
            .foregroundColor(c.text)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(FS.space.s3)
            .background(color.opacity(0.12))
            .clipShape(RoundedRectangle(cornerRadius: FS.radius.sm))
    }
}

/// "Migrate to new hardware" (docs/server-migration.md) — one screen, two
/// modes: no session yet → the admin-signed INITIATE ceremony; live session →
/// the 8-step progress timeline with the phase-appropriate action (hand off /
/// abort). Mirrors the webapp's migrate dialog.
public struct MigrateServerScreen: View {
    @Environment(\.colorScheme) private var scheme
    @State private var vm: MigrationViewModel
    @State private var started = false

    public init(vm: MigrationViewModel) {
        _vm = State(initialValue: vm)
    }

    public var body: some View {
        let c = FSColors.scheme(scheme)
        ScrollView {
            VStack(alignment: .leading, spacing: FS.space.s4) {
                switch vm.mode {
                case .loading:
                    ProgressView("Checking for a migration in progress…")
                case .initiate:
                    initiate(c)
                case .progress:
                    progress(c)
                case .failed(let msg):
                    MigrateCallout(kind: .danger, text: msg)
                }
            }
            .padding(FS.space.s6)
        }
        .background(c.bg.ignoresSafeArea())
        .navigationTitle("Migrate server")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            if !started {
                started = true
                await vm.load()
            }
        }
        // Re-keyed on the mode so the poll starts when initiate → progress
        // (after `start()`), and SwiftUI cancels it on disappear.
        .task(id: vm.mode) {
            if vm.mode == .progress { await vm.pollLoop() }
        }
    }

    // MARK: - Initiate mode

    @ViewBuilder private func initiate(_ c: FSColors) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s4) {
            Text("Migrate \(vm.serverFqdn)")
                .font(FS.font.h2()).foregroundColor(c.text)
            if vm.backupMissing {
                MigrateCallout(
                    kind: .warning,
                    text: "No backup is enrolled for this server. The migration moves data THROUGH backup — enable backup first, or choose to keep the old disk."
                )
            } else {
                MigrateCallout(
                    kind: .info,
                    text: "Peer-backup is enrolled — the new box restores from it while this one keeps serving."
                )
            }

            Text("WHAT HAPPENS TO THE OLD BOX'S DISK?")
                .font(.system(size: 12, weight: .semibold)).tracking(1)
                .foregroundColor(c.textMuted)
            dispositionRow(c, .wipeAfterHandoff, "Wipe the old box after the new one takes over (recommended)",
                           "Keeps the old disk as a safety net until the new box proves a good restore and takes over the name, then scrubs it.")
            dispositionRow(c, .keep, "Keep the old disk (manual fallback copy)",
                           "Powers off with data intact after the hand-off — a local fallback copy.")

            if vm.disposition == .wipeAfterHandoff && vm.backupMissing {
                Text("This server has no backup — enable backup first, or keep the old disk as the fallback.")
                    .font(FS.font.caption()).foregroundColor(c.danger)
            }

            Text("The old box is wiped only after the new one has restored the data and taken over the name. If anything fails, the old box keeps serving with all its data.")
                .font(FS.font.caption()).foregroundColor(c.textMuted)

            if let err = vm.errorMessage {
                MigrateCallout(kind: .danger, text: err)
            }

            FSPrimaryButton(vm.working ? "Signing…" : "Start migration", block: true, large: true) {
                if !vm.working && !vm.startBlocked { Task { await vm.start() } }
            }
            .disabled(vm.working || vm.startBlocked)
            .accessibilityIdentifier("migrate-start")
        }
    }

    @ViewBuilder private func dispositionRow(_ c: FSColors, _ d: ServerMigrationFlow.Disposition, _ title: String, _ detail: String) -> some View {
        Button {
            vm.disposition = d
        } label: {
            HStack(alignment: .top, spacing: FS.space.s3) {
                Image(systemName: vm.disposition == d ? "largecircle.fill.circle" : "circle")
                    .foregroundColor(vm.disposition == d ? c.primary : c.textMuted)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(FS.font.body()).foregroundColor(c.text)
                    Text(detail).font(FS.font.caption()).foregroundColor(c.textMuted)
                }
                Spacer(minLength: 0)
            }
            .padding(FS.space.s3)
            .background(c.surface)
            .clipShape(RoundedRectangle(cornerRadius: FS.radius.sm))
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("migrate-disposition-\(d.rawValue)")
    }

    // MARK: - Progress mode (the 8-step timeline)

    @ViewBuilder private func progress(_ c: FSColors) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s4) {
            Text("Migrating \(vm.serverFqdn)")
                .font(FS.font.h2()).foregroundColor(c.text)

            if vm.session?.phase == "initiated" {
                MigrateCallout(
                    kind: .info,
                    text: "Next: add the NEW box via Add a server (any name — it becomes \(vm.serverFqdn) at take-over). It attaches here automatically once online."
                )
            }

            VStack(alignment: .leading, spacing: FS.space.s2) {
                ForEach(vm.steps) { step in
                    stepRow(c, step)
                }
            }
            .padding(FS.space.s3)
            .background(c.surface)
            .clipShape(RoundedRectangle(cornerRadius: FS.radius.sm))

            if !vm.waitCopy.isEmpty {
                Text(vm.waitCopy)
                    .font(FS.font.bodySm()).foregroundColor(c.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("migrate-wait-copy")
            }

            if let err = vm.errorMessage {
                MigrateCallout(kind: .danger, text: err)
            }

            if vm.session?.phase == "pre-seeded" {
                FSPrimaryButton(vm.working ? "Signing…" : "Hand off to the new box now", block: true, large: true) {
                    if !vm.working { Task { await vm.handOff() } }
                }
                .disabled(vm.working)
                .accessibilityIdentifier("migrate-hand-off")
            } else if vm.session?.phase == "ready" {
                FSPrimaryButton(vm.working ? "Signing…" : "Freeze old server and hand off", block: true, large: true) {
                    if !vm.working { Task { await vm.handOff() } }
                }
                .disabled(vm.working)
                .accessibilityIdentifier("migrate-freeze-retry")
            }

            if vm.session?.abortedAt != nil {
                MigrateCallout(kind: .warning, text: "Migration aborted — your old server stays active with all its data.")
            } else if vm.session?.done == true {
                MigrateCallout(kind: .success, text: "Migration complete — \(vm.serverFqdn) now runs on the new box.")
            }

            if vm.canAbort {
                // Secondary, not danger — aborting is the SAFE exit (mirrors
                // the webapp): the old server stays active with all its data.
                FSSecondaryButton(vm.working ? "Working…" : "Abort migration — old server stays active with all data", block: true) {
                    if !vm.working { Task { await vm.abort() } }
                }
                .disabled(vm.working)
                .accessibilityIdentifier("migrate-abort")
            }
        }
    }

    @ViewBuilder private func stepRow(_ c: FSColors, _ step: ServerMigrationTimeline.Step) -> some View {
        HStack(alignment: .center, spacing: FS.space.s3) {
            switch step.state {
            case .done:
                Image(systemName: "checkmark.circle.fill")
                    .foregroundColor(c.success)
            case .active:
                ProgressView().controlSize(.small)
            case .pending:
                Image(systemName: "circle")
                    .foregroundColor(c.textMuted)
            }
            Text(step.label)
                .font(FS.font.bodySm())
                .foregroundColor(step.state == .pending ? c.textMuted : c.text)
            Spacer(minLength: 0)
        }
        .accessibilityIdentifier("migrate-step-\(step.key)-\(stateName(step.state))")
    }

    private func stateName(_ s: ServerMigrationTimeline.StepState) -> String {
        switch s {
        case .done: return "done"
        case .active: return "active"
        case .pending: return "pending"
        }
    }
}
