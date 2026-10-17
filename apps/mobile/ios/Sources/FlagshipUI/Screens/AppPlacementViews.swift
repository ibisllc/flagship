import SwiftUI
import FlagshipAPI
import FlagshipCore

/// "Runs on: <server>" at the start of every creation flow, with a picker of
/// the account's servers. Fixed (no picker) when the flow started from a
/// server's page or there is only one server.
public struct RunsOnPicker: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(AppState.self) private var app
    @Bindable var target: CreationTarget
    var onChange: (PodInfo) -> Void = { _ in }

    public init(target: CreationTarget, onChange: @escaping (PodInfo) -> Void = { _ in }) {
        self.target = target
        self.onChange = onChange
    }

    public var body: some View {
        let c = FSColors.scheme(scheme)
        VStack(alignment: .leading, spacing: FS.space.s1) {
            HStack(spacing: FS.space.s2) {
                Image(systemName: "server.rack").foregroundColor(c.textMuted)
                Text("\(AppPlacementCopy.runsOn):").font(FS.font.body()).foregroundColor(c.textMuted)
                if target.showsPicker {
                    Menu {
                        ForEach(target.choices) { pod in
                            Button {
                                target.select(pod)
                                onChange(pod)
                            } label: {
                                if pod.fqdn.lowercased() == target.selectedFqdn {
                                    Label(menuLabel(pod), systemImage: "checkmark")
                                } else {
                                    Text(menuLabel(pod))
                                }
                            }
                        }
                    } label: {
                        HStack(spacing: 4) {
                            Text(target.selectedName).font(FS.font.scaled(16, weight: .semibold))
                            Image(systemName: "chevron.up.chevron.down").font(FS.font.scaled(12))
                        }
                        .foregroundColor(c.accent)
                    }
                    .accessibilityIdentifier("runs-on-picker")
                } else {
                    Text(target.selectedName)
                        .font(FS.font.scaled(16, weight: .semibold))
                        .foregroundColor(c.text)
                        .accessibilityIdentifier("runs-on-fixed")
                }
                Spacer()
            }
            Text(target.isPinned ? AppPlacementCopy.pinnedNote : AppPlacementCopy.pickerNote)
                .font(FS.font.caption())
                .foregroundColor(c.textMuted)
        }
        .padding(FS.space.s4)
        .background(c.surface)
        .overlay(RoundedRectangle(cornerRadius: FS.radius.lg, style: .continuous).stroke(c.border, lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: FS.radius.lg, style: .continuous))
    }

    private func menuLabel(_ pod: PodInfo) -> String {
        var label = AppPlacementCopy.serverName(pod)
        if pod.podId == app.leaderPodId { label += " (preferred)" }
        if pod.status != .online { label += " (offline)" }
        return label
    }
}

/// The read-only "Runs on <server>" line on the creation screens past the
/// chooser.
struct RunsOnLine: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(AppState.self) private var app
    @Environment(\.screensServerFqdn) private var bound

    var body: some View {
        let c = FSColors.scheme(scheme)
        let fqdn = app.screensFqdn(bound: bound).lowercased()
        let name = app.pods.first(where: { $0.fqdn.lowercased() == fqdn }).map(AppPlacementCopy.serverName)
            ?? fqdn.split(separator: ".").first.map(String.init) ?? fqdn
        Label("\(AppPlacementCopy.runsOn) \(name)", systemImage: "server.rack")
            .font(FS.font.bodySm())
            .foregroundColor(c.textMuted)
            .accessibilityIdentifier("runs-on-line")
    }
}

/// A server page's apps: each opens the app's page; an app still being copied
/// in is greyed with its progress. Polls the copies while any is underway.
struct ServerAppsSection: View {
    @Environment(\.colorScheme) private var scheme
    let controller: ServerAppsController
    var onOpenApp: (String) -> Void = { _ in }
    var onCreate: () -> Void = {}

    var body: some View {
        let c = FSColors.scheme(scheme)
        VStack(alignment: .leading, spacing: FS.space.s3) {
            Text(AppPlacementCopy.serverAppsSection)
                .font(FS.font.scaled(13, weight: .semibold)).foregroundColor(c.textMuted)
            switch controller.state {
            case .idle, .loading:
                ServerCardSkeleton()
            case .failed(let msg):
                ErrorCard(message: msg)
            case .loaded(let rows):
                if rows.isEmpty {
                    Text(AppPlacementCopy.noAppsHere).font(FS.font.bodySm()).foregroundColor(c.textMuted)
                } else {
                    VStack(spacing: FS.space.s2) {
                        ForEach(rows) { row in appRow(row, c: c) }
                    }
                }
            }
            if let note = controller.failureNote {
                Label(note, systemImage: "exclamationmark.triangle")
                    .font(FS.font.bodySm()).foregroundColor(c.warning)
                    .fixedSize(horizontal: false, vertical: true)
            }
            FSSecondaryButton(AppPlacementCopy.createHere, block: true, action: onCreate)
                .accessibilityIdentifier("server-create-app-here")
        }
        .task { await controller.load() }
        .task(id: controller.hasCopying) {
            if controller.hasCopying { await controller.pollWhileCopying() }
        }
    }

    @ViewBuilder
    private func appRow(_ row: ServerAppsController.Row, c: FSColors) -> some View {
        if let copying = row.copying {
            FSListRow(
                leading: .icon("square.and.arrow.down.on.square", color: c.textMuted),
                title: row.name,
                subtitle: AppPlacementCopy.copying(state: copying.state, progress: copying.progress),
                detail: row.address
            ) {
                ProgressView()
            }
            .opacity(0.5)
            .accessibilityIdentifier("server-app-copying-\(row.serviceId)")
        } else {
            Button { onOpenApp(row.serviceId) } label: {
                FSListRow(
                    leading: .icon(row.running ? "app.dashed" : "app", color: row.running ? c.success : c.textMuted),
                    title: row.name,
                    subtitle: row.address
                ) {
                    HStack(spacing: FS.space.s2) {
                        if let pill = row.state.pill { FSPill(pill.label, kind: pill.fsKind) }
                        Image(systemName: "chevron.right").foregroundColor(c.textMuted)
                    }
                }
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("server-app-\(row.serviceId)")
        }
    }
}

/// The app page's "Runs on": one row per server, ticked exactly where the
/// app is. Tick copies it there; untick removes it (after a confirm).
struct RunsOnSection: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(AppState.self) private var app
    let controller: AppRunsOnController
    @State private var confirmRemove: AppRunsOnController.Row?
    @State private var refusal: String?

    var body: some View {
        let c = FSColors.scheme(scheme)
        VStack(alignment: .leading, spacing: FS.space.s3) {
            Text(AppPlacementCopy.runsOnSection)
                .font(FS.font.scaled(13, weight: .semibold)).foregroundColor(c.textMuted)
            FSCard {
                VStack(spacing: FS.space.s3) {
                    ForEach(controller.rows) { row in
                        rowView(row, c: c)
                        if row.id != controller.rows.last?.id { Divider().background(c.border) }
                    }
                }
            }
            if let message = controller.message {
                Text(message).font(FS.font.bodySm()).foregroundColor(c.warning)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("runs-on-message")
            }
            Text(controller.canChange ? AppPlacementCopy.runsOnNote : controller.readOnlyNote)
                .font(FS.font.caption()).foregroundColor(c.textMuted)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 4)
                .accessibilityIdentifier("runs-on-note")
        }
        .task(id: controller.hasCopying) {
            if controller.hasCopying { await controller.pollWhileCopying() }
        }
        .confirmationDialog(
            confirmRemove.map { AppPlacementCopy.confirmRemoveTitle(controller.appName, $0.name) } ?? "",
            isPresented: Binding(get: { confirmRemove != nil }, set: { if !$0 { confirmRemove = nil } }),
            titleVisibility: .visible,
            presenting: confirmRemove
        ) { row in
            Button("Remove from \(row.name)", role: .destructive) {
                Task { await controller.untick(row.fqdn) }
            }
            Button("Cancel", role: .cancel) {}
        } message: { row in
            Text(AppPlacementCopy.confirmRemoveMessage(row.name))
        }
        .alert(refusal == AppPlacementCopy.adminOnlyRemove ? "Can't remove it" : "Can't remove the last copy", isPresented: Binding(get: { refusal != nil }, set: { if !$0 { refusal = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(refusal ?? "")
        }
    }

    private func rowView(_ row: AppRunsOnController.Row, c: FSColors) -> some View {
        let busy = controller.busyFqdn == row.fqdn
        let enabled = controller.canChange && controller.busyFqdn == nil && toggleable(row)
        return HStack(spacing: FS.space.s3) {
            Button { toggle(row) } label: {
                Group {
                    if busy || row.presence == .checking {
                        ProgressView().frame(width: 20, height: 20)
                    } else {
                        Image(systemName: icon(row))
                            .font(FS.font.scaled(20))
                            .foregroundColor(row.isTicked ? c.primary : c.textMuted)
                    }
                }
            }
            .buttonStyle(.plain)
            .disabled(!enabled)
            .accessibilityLabel(row.isTicked ? "Runs on \(row.name)" : "Not on \(row.name)")
            .accessibilityIdentifier("runs-on-\(row.fqdn)")

            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: FS.space.s2) {
                    Text(row.name).font(FS.font.scaled(16, weight: .semibold)).foregroundColor(c.text)
                    if row.pod.podId == app.leaderPodId { LeaderBadge() }
                }
                if let status = statusLine(row) {
                    Text(status).font(FS.font.caption()).foregroundColor(c.textMuted)
                        .lineLimit(2)
                }
            }
            Spacer()
            if row.presence == .installed, let pill = row.state?.pill {
                FSPill(pill.label, kind: pill.fsKind)
                    .accessibilityIdentifier("runs-on-state-\(row.fqdn)")
            }
        }
        .opacity(row.isCopying ? 0.6 : 1)
    }

    private func icon(_ row: AppRunsOnController.Row) -> String {
        switch row.presence {
        case .installed: return "checkmark.square.fill"
        case .copying: return "arrow.down.square"
        case .unknown: return "questionmark.square.dashed"
        case .absent, .checking: return "square"
        }
    }

    private func statusLine(_ row: AppRunsOnController.Row) -> String? {
        switch row.presence {
        case .checking: return AppPlacementCopy.checking
        case .copying(let state, let progress): return AppPlacementCopy.copying(state: state, progress: progress)
        case .unknown(let why): return why
        case .installed, .absent: return nil
        }
    }

    private func toggleable(_ row: AppRunsOnController.Row) -> Bool {
        row.presence == .installed || row.presence == .absent
    }

    private func toggle(_ row: AppRunsOnController.Row) {
        switch row.presence {
        case .absent:
            Task { await controller.tick(row.fqdn) }
        case .installed:
            if let why = controller.untickRefusal(row.fqdn) {
                refusal = why
            } else {
                confirmRemove = row
            }
        default:
            break
        }
    }
}
