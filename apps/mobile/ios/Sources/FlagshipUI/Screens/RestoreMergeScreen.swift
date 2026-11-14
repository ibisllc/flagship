import SwiftUI
import FlagshipAPI
import FlagshipCore

/// Restore apps from a backup into this server (docs/restore-into-server.md §7): checking the
/// backup, the per-app choices with the accepted defaults, progress, and the result with Undo.
struct RestoreMergeScreen: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.dismiss) private var dismiss
    @Bindable var vm: RestoreMergeViewModel
    let source: RestoreMergeViewModel.Source
    @State private var editing: RestoreMergeApp?
    @State private var started = false

    var body: some View {
        let c = FSColors.scheme(scheme)
        ScrollView {
            VStack(alignment: .leading, spacing: FS.space.s4) {
                switch vm.phase {
                case .idle, .opening:
                    progress(String(localized: "Opening the backup…"), c)
                case .sending(let f):
                    VStack(alignment: .leading, spacing: FS.space.s2) {
                        Text("Sending the backup to \(vm.serverFqdn)").font(FS.font.bodySm()).foregroundColor(c.text)
                        ProgressView(value: f)
                    }
                case .checking:
                    progress(String(localized: "Checking the backup on \(vm.serverFqdn)"), c)
                case .choosing:
                    choosing(c)
                case .restoring, .done:
                    result(c)
                case .failed(let why):
                    Text(why).font(FS.font.bodySm()).foregroundColor(c.danger)
                        .accessibilityIdentifier("rm-failed")
                }
                if let e = vm.actionError {
                    Text(e).font(FS.font.bodySm()).foregroundColor(c.danger)
                        .accessibilityIdentifier("rm-error")
                }
            }
            .padding(FS.space.s4)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .navigationTitle(String(localized: "Restore apps from a backup"))
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button(vm.phase == .done ? String(localized: "Done") : String(localized: "Cancel")) {
                    if vm.phase != .done && vm.phase != .restoring { Task { await vm.cancel() } }
                    dismiss()
                }
                .accessibilityIdentifier("rm-close")
            }
        }
        .sheet(item: $editing) { a in
            NavigationStack { RestoreMergeAppSheet(vm: vm, app: a, onDone: { editing = nil }) }
        }
        .task {
            guard !started else { return }
            started = true
            await vm.start(source)
        }
    }

    private func progress(_ text: String, _ c: FSColors) -> some View {
        HStack(spacing: FS.space.s2) {
            ProgressView()
            Text(text).font(FS.font.bodySm()).foregroundColor(c.textMuted)
        }
        .accessibilityIdentifier("rm-progress")
    }

    @ViewBuilder
    private func choosing(_ c: FSColors) -> some View {
        if let at = vm.preview?.backup.createdAt {
            Text("Backup of \(Date(timeIntervalSince1970: Double(at) / 1000).formatted(date: .abbreviated, time: .shortened))")
                .font(FS.font.bodySm()).foregroundColor(c.textMuted)
        }
        group(String(localized: "New on this server"), vm.apps(in: .new), c)
        group(String(localized: "Already on this server"), vm.apps(in: .already), c)
        group(String(localized: "A different app with the same name"), vm.apps(in: .different), c)
        FSPrimaryButton(String(localized: "Restore"), block: true) { Task { await vm.restore() } }
            .disabled(!vm.canRestore)
            .accessibilityIdentifier("rm-restore")
        if !vm.canRestore {
            Text("Choose at least one app to restore.").font(FS.font.caption()).foregroundColor(c.textMuted)
        }
    }

    @ViewBuilder
    private func group(_ title: String, _ apps: [RestoreMergeApp], _ c: FSColors) -> some View {
        if !apps.isEmpty {
            VStack(alignment: .leading, spacing: FS.space.s2) {
                FSSectionLabel(title)
                FSCard {
                    VStack(alignment: .leading, spacing: FS.space.s3) {
                        ForEach(apps) { a in
                            Button { editing = a } label: {
                                HStack(alignment: .firstTextBaseline) {
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(a.name).font(FS.font.body()).foregroundColor(c.text)
                                        Text(RestoreMergeViewModel.comparison(a)).font(FS.font.caption()).foregroundColor(c.textMuted)
                                    }
                                    Spacer()
                                    Text(RestoreMergeViewModel.actionName(vm.choices[a.archivedServiceId]?.action ?? a.recommended))
                                        .font(FS.font.bodySm()).foregroundColor(c.accent)
                                    Image(systemName: "chevron.right").foregroundColor(c.textMuted)
                                }
                            }
                            .buttonStyle(.plain)
                            .accessibilityIdentifier("rm-app-\(a.archivedServiceId)")
                        }
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func result(_ c: FSColors) -> some View {
        if vm.phase == .restoring { progress(String(localized: "Restoring…"), c) }
        FSCard {
            VStack(alignment: .leading, spacing: FS.space.s2) {
                ForEach(vm.run?.apps ?? []) { a in
                    HStack(alignment: .firstTextBaseline) {
                        Text(vm.preview?.apps.first { $0.archivedServiceId == a.archivedServiceId }?.name ?? a.targetServiceId)
                            .font(FS.font.bodySm()).foregroundColor(c.text)
                        Spacer()
                        Text(RestoreMergeViewModel.stepName(a.step)).font(FS.font.caption())
                            .foregroundColor(a.step == "failed" || a.step == "refused-changed" ? c.warning : c.textMuted)
                    }
                    .accessibilityIdentifier("rm-run-\(a.archivedServiceId)")
                }
            }
        }
        RestoreUndoPointsList(vm: vm)
    }
}

/// One app's choices: only the actions the server allows, each with what it does; the others greyed with why.
struct RestoreMergeAppSheet: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable var vm: RestoreMergeViewModel
    let app: RestoreMergeApp
    let onDone: () -> Void
    private static let order = ["install", "keep", "replace", "replace-data", "copy", "skip"]

    var body: some View {
        let c = FSColors.scheme(scheme)
        let chosen = vm.choices[app.archivedServiceId]?.action ?? app.recommended
        List {
            Section {
                Text(RestoreMergeViewModel.comparison(app)).font(FS.font.bodySm())
            }
            Section {
                ForEach(Self.order.filter { app.allowed.contains($0) || app.disallowed[$0] != nil }, id: \.self) { action in
                    let allowed = app.allowed.contains(action)
                    Button { vm.choose(app, action: action) } label: {
                        HStack(alignment: .firstTextBaseline) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(RestoreMergeViewModel.actionName(action)).foregroundColor(allowed ? c.text : c.textMuted)
                                Text(allowed ? RestoreMergeViewModel.consequence(action, app) : RestoreMergeViewModel.refusal(app.disallowed[action] ?? ""))
                                    .font(FS.font.caption()).foregroundColor(c.textMuted)
                                if action == app.recommended {
                                    Text("Suggested").font(FS.font.caption()).foregroundColor(c.accent)
                                }
                            }
                            Spacer()
                            if chosen == action { Image(systemName: "checkmark").foregroundColor(c.accent) }
                        }
                    }
                    .disabled(!allowed)
                    .accessibilityIdentifier("rm-action-\(action)")
                }
            }
            if chosen == "copy" {
                Section(String(localized: "Name of the new app")) {
                    TextField(String(localized: "Name"), text: Binding(
                        get: { vm.choices[app.archivedServiceId]?.copyName ?? "" },
                        set: { vm.setCopyName(app, $0) }
                    ))
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .accessibilityIdentifier("rm-copy-name")
                    if !RestoreMergeViewModel.validSlug(vm.choices[app.archivedServiceId]?.copyName ?? "") {
                        Text("Lowercase letters, digits and single hyphens.").font(FS.font.caption()).foregroundColor(c.danger)
                    }
                }
            }
            let notes = RestoreMergeViewModel.notes(app, action: chosen)
            if !notes.isEmpty {
                Section { ForEach(notes, id: \.self) { Text($0).font(FS.font.caption()) } }
            }
        }
        .navigationTitle(app.name)
        .toolbar { ToolbarItem(placement: .confirmationAction) { Button(String(localized: "Done")) { onDone() }.accessibilityIdentifier("rm-sheet-done") } }
    }
}

/// The kept copies a restore left: each with its end date, Undo and Delete now (both signed).
struct RestoreUndoPointsList: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable var vm: RestoreMergeViewModel
    @State private var confirming: (point: RestoreMergeUndoPoint, discard: Bool)?

    var body: some View {
        let c = FSColors.scheme(scheme)
        if !vm.undoPoints.isEmpty {
            VStack(alignment: .leading, spacing: FS.space.s2) {
                FSSectionLabel(String(localized: "Earlier copies kept by a restore"))
                ForEach(vm.undoPoints) { p in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(p.name).font(FS.font.bodySm()).foregroundColor(c.text)
                        Text("Kept until \(Date(timeIntervalSince1970: Double(p.expiresAt) / 1000).formatted(date: .abbreviated, time: .omitted))")
                            .font(FS.font.caption()).foregroundColor(c.textMuted)
                        HStack(spacing: FS.space.s3) {
                            Button(String(localized: "Undo")) { confirming = (p, false) }
                                .accessibilityIdentifier("rm-undo-\(p.serviceId)")
                            Spacer()
                            Button(String(localized: "Delete now"), role: .destructive) { confirming = (p, true) }
                                .accessibilityIdentifier("rm-discard-\(p.serviceId)")
                        }
                        .font(FS.font.bodySm())
                        .disabled(!vm.isAdminDevice || vm.busyUndo == p.id)
                    }
                }
                if !vm.isAdminDevice {
                    Text(RestoreMergeViewModel.adminOnly).font(FS.font.caption()).foregroundColor(c.textMuted)
                }
            }
            .alert(
                confirming?.discard == true ? String(localized: "Delete the earlier copy?") : String(localized: "Put the earlier copy back?"),
                isPresented: Binding(get: { confirming != nil }, set: { if !$0 { confirming = nil } })
            ) {
                Button(confirming?.discard == true ? String(localized: "Delete") : String(localized: "Undo"), role: .destructive) {
                    if let x = confirming { Task { await vm.undo(x.point, discard: x.discard) } }
                    confirming = nil
                }
                .accessibilityIdentifier("rm-confirm")
                Button(String(localized: "Cancel"), role: .cancel) { confirming = nil }
            } message: {
                if let x = confirming {
                    if x.discard {
                        Text("The copy of \(x.point.name) from before the restore is deleted. This can't be undone.")
                    } else {
                        Text("Changes to \(x.point.name) since \(Date(timeIntervalSince1970: Double(x.point.keptAt) / 1000).formatted(date: .abbreviated, time: .shortened)) are lost.")
                    }
                }
            }
        }
    }
}
