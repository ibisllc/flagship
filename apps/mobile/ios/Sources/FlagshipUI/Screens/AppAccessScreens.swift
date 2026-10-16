import SwiftUI
import FlagshipAPI
import FlagshipCore

/// "Internet access" on an app's page: the rule count, the hosts waiting for
/// an answer (Allow / Deny / Ignore), and View access list.
struct InternetAccessSection: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable var controller: AppAccessController
    @State private var editor: AppAccessEditorModel?

    var body: some View {
        let c = FSColors.scheme(scheme)
        VStack(alignment: .leading, spacing: FS.space.s3) {
            Text(AppAccessCopy.sectionTitle).font(.system(size: 12, weight: .semibold)).tracking(1)
                .foregroundColor(c.textMuted)
            FSCard {
                VStack(alignment: .leading, spacing: FS.space.s3) {
                    switch controller.state {
                    case .idle, .loading:
                        ProgressView()
                    case .failed(let msg):
                        Text(msg).font(FS.font.bodySm()).foregroundColor(c.danger)
                            .fixedSize(horizontal: false, vertical: true)
                    case .loaded:
                        if let draft = controller.draft { draftCard(draft, c: c) }
                        HStack(spacing: FS.space.s2) {
                            Image(systemName: "network").foregroundColor(controller.pending.isEmpty ? c.primary : c.warning)
                            Text(AppAccessCopy.ruleCount(controller.ruleCount))
                                .font(FS.font.bodySm()).foregroundColor(c.text)
                                .fixedSize(horizontal: false, vertical: true)
                                .accessibilityIdentifier("service-detail-access-rules")
                        }
                        ForEach(controller.pending) { p in pendingRow(p, c: c) }
                        if let note = controller.readOnlyNote {
                            Text(note)
                                .font(FS.font.caption()).foregroundColor(c.textMuted)
                                .fixedSize(horizontal: false, vertical: true)
                                .accessibilityIdentifier("service-detail-access-read-only")
                        }
                        if let answer = controller.lastAnswer {
                            Text(AppAccessCopy.answered(app: controller.appName, host: answer.host, action: answer.action))
                                .font(FS.font.bodySm()).foregroundColor(c.textMuted)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        if let err = controller.errorMessage {
                            Text(err).font(FS.font.bodySm()).foregroundColor(c.danger)
                                .fixedSize(horizontal: false, vertical: true)
                                .accessibilityIdentifier("service-detail-access-error")
                        }
                        FSSecondaryButton(AppAccessCopy.viewList, block: true) {
                            editor = controller.makeEditor()
                        }
                        .accessibilityIdentifier("service-detail-access-view-list")
                    }
                }
            }
        }
        .sheet(item: $editor) { model in
            AppAccessListEditorScreen(model: model) { editor = nil }
        }
    }

    /// "This app suggests letting it reach these hosts": each host with its
    /// reason, then Review (the editor, prefilled) and Dismiss.
    private func draftCard(_ draft: AppAccessDraft, c: FSColors) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s2) {
            HStack(alignment: .top, spacing: FS.space.s2) {
                Image(systemName: "list.bullet.clipboard").foregroundColor(c.warning)
                Text(AppAccessCopy.draftTitle)
                    .font(FS.font.bodySm().weight(.semibold)).foregroundColor(c.text)
                    .fixedSize(horizontal: false, vertical: true)
            }
            DraftHostsList(hosts: draft.hosts)
            Text(AppAccessCopy.draftNote)
                .font(FS.font.caption()).foregroundColor(c.textMuted)
                .fixedSize(horizontal: false, vertical: true)
            if controller.canChange {
                HStack(spacing: FS.space.s2) {
                    FSPrimaryButton(AppAccessCopy.review, enabled: !controller.isDismissingDraft) {
                        editor = controller.makeDraftEditor()
                    }
                    .accessibilityIdentifier("service-detail-access-draft-review")
                    FSGhostButton(controller.isDismissingDraft ? "…" : AppAccessCopy.dismissDraft) {
                        Task { await controller.dismissDraft() }
                    }
                    .disabled(controller.isDismissingDraft)
                    .accessibilityIdentifier("service-detail-access-draft-dismiss")
                }
            }
            Divider()
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("service-detail-access-draft")
    }

    private func pendingRow(_ p: AppAccessPendingHost, c: FSColors) -> some View {
        let busy = controller.busyHost == p.host
        return VStack(alignment: .leading, spacing: FS.space.s2) {
            Divider()
            Text(AppAccessCopy.wantsToReach(app: controller.appName, host: p.host))
                .font(FS.font.bodySm().weight(.semibold)).foregroundColor(c.text)
                .fixedSize(horizontal: false, vertical: true)
            Text(AppAccessCopy.source(p.source, attempts: p.attempts))
                .font(FS.font.caption()).foregroundColor(c.textMuted)
            if controller.canChange {
                HStack(spacing: FS.space.s2) {
                    FSPrimaryButton(busy ? "…" : "Allow", enabled: controller.busyHost == nil) {
                        Task { await controller.answer(host: p.host, action: .allow) }
                    }
                    .accessibilityIdentifier("service-detail-access-allow")
                    FSSecondaryButton("Deny") {
                        Task { await controller.answer(host: p.host, action: .deny) }
                    }
                    .disabled(controller.busyHost != nil)
                    .accessibilityIdentifier("service-detail-access-deny")
                    FSGhostButton("Ignore") {
                        Task { await controller.ignore(host: p.host) }
                    }
                    .disabled(controller.busyHost != nil)
                    .accessibilityIdentifier("service-detail-access-ignore")
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("service-detail-access-pending")
    }
}

/// The suggested hosts, each with the app's reason when it gave one.
struct DraftHostsList: View {
    @Environment(\.colorScheme) private var scheme
    let hosts: [AppAccessDraftHost]

    var body: some View {
        let c = FSColors.scheme(scheme)
        VStack(alignment: .leading, spacing: FS.space.s2) {
            ForEach(hosts) { h in
                VStack(alignment: .leading, spacing: 2) {
                    Text(h.host).font(FS.font.mono()).foregroundColor(c.text)
                        .fixedSize(horizontal: false, vertical: true)
                    if let why = h.why {
                        Text(why).font(FS.font.caption()).foregroundColor(c.textMuted)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("access-draft-host")
            }
        }
    }
}

/// The access list as text. Parses as you type; each error shows its line;
/// Save (Face ID, then the signed order) stays off while there are errors.
struct AppAccessListEditorScreen: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable var model: AppAccessEditorModel
    let onClose: () -> Void

    var body: some View {
        let c = FSColors.scheme(scheme)
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: FS.space.s4) {
                    if let note = model.note {
                        Text(note)
                            .font(FS.font.bodySm().weight(.semibold)).foregroundColor(c.text)
                            .fixedSize(horizontal: false, vertical: true)
                            .accessibilityIdentifier("access-list-note")
                    }
                    Text(AppAccessCopy.editorHelp)
                        .font(FS.font.bodySm()).foregroundColor(c.textMuted)
                        .fixedSize(horizontal: false, vertical: true)
                    TextEditor(text: $model.text)
                        .font(FS.font.mono())
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .frame(minHeight: 220)
                        .padding(FS.space.s2)
                        .background(c.surface)
                        .overlay(RoundedRectangle(cornerRadius: FS.radius.md)
                            .stroke(model.lineErrors.isEmpty ? c.border : c.danger, lineWidth: 1))
                        .disabled(!model.canSaveAtAll)
                        .accessibilityIdentifier("access-list-editor")
                    if model.lineErrors.isEmpty {
                        Text(AppAccessCopy.ruleCount(model.ruleCount))
                            .font(FS.font.caption()).foregroundColor(c.textMuted)
                    } else {
                        VStack(alignment: .leading, spacing: 4) {
                            ForEach(Array(model.lineErrors.enumerated()), id: \.offset) { _, e in
                                Text(AppAccessCopy.lineError(e))
                                    .font(FS.font.bodySm()).foregroundColor(c.danger)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                        .accessibilityIdentifier("access-list-errors")
                    }
                    if let err = model.errorMessage {
                        Text(err).font(FS.font.bodySm()).foregroundColor(c.danger)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    if model.saved && !model.hasChanges {
                        Text("Saved. The server now uses this list.")
                            .font(FS.font.bodySm()).foregroundColor(c.textMuted)
                    }
                }
                .padding(FS.space.s6)
            }
            .background(c.bg.ignoresSafeArea())
            .navigationTitle(AppAccessCopy.editorTitle)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(model.saved && !model.hasChanges ? "Done" : "Cancel", action: onClose)
                }
                if model.canSaveAtAll {
                    ToolbarItem(placement: .confirmationAction) {
                        Button(model.isSaving ? "Saving…" : "Save") {
                            Task { if await model.save() { onClose() } }
                        }
                        .disabled(!model.canSave)
                        .accessibilityIdentifier("access-list-save")
                    }
                }
            }
        }
    }
}

/// "<App> wants to reach <host>": Allow / Deny / Not now, then the
/// confirmation with Close and View access list.
public struct AppAccessAlertSheet: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable var center: AppAccessAlertCenter

    public init(center: AppAccessAlertCenter) { self.center = center }

    public var body: some View {
        let c = FSColors.scheme(scheme)
        Group {
            if let editor = center.editor {
                AppAccessListEditorScreen(model: editor) { center.editorClosed() }
            } else if let item = center.current {
                if let draft = item.draft {
                    draftContent(draft, item: item, c: c)
                } else if let request = item.request {
                    content(request, item: item, c: c)
                }
            }
        }
        .presentationDetents(center.editor == nil ? [.medium, .large] : [.large])
        .interactiveDismissDisabled({
            switch center.stage {
            case .working, .opening: return true
            default: return false
            }
        }())
    }

    /// "<App> suggests an access list": the hosts with their reasons, then
    /// Review (that app's editor with the draft) or Not now.
    private func draftContent(_ d: AppAccessDraftEntry, item: AppAccessAlertCenter.Item, c: FSColors) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s4) {
            Image(systemName: "list.bullet.clipboard").font(.system(size: 34)).foregroundColor(c.warning)
            Text(AppAccessCopy.suggestsList(app: d.appName))
                .font(FS.font.h3()).foregroundColor(c.text)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("access-alert-draft-title")
            Text(item.serverDomain)
                .font(FS.font.bodySm()).foregroundColor(c.textMuted)
                .fixedSize(horizontal: false, vertical: true)
            ScrollView {
                DraftHostsList(hosts: d.hosts).frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(maxHeight: 220)
            Text(AppAccessCopy.draftNote)
                .font(FS.font.bodySm()).foregroundColor(c.textMuted)
                .fixedSize(horizontal: false, vertical: true)
            if case .failed(let msg) = center.stage {
                Text(msg).font(FS.font.bodySm()).foregroundColor(c.danger)
                    .fixedSize(horizontal: false, vertical: true)
                FSPrimaryButton("Close", block: true) { center.close() }
            } else {
                let opening = center.stage == .opening
                FSPrimaryButton(opening ? "Opening…" : AppAccessCopy.review, enabled: !opening, block: true) {
                    Task { await center.reviewDraft() }
                }
                .accessibilityIdentifier("access-alert-draft-review")
                FSGhostButton("Not now", block: true) { center.notNow() }
                    .disabled(opening)
                    .accessibilityIdentifier("access-alert-not-now")
            }
            Spacer(minLength: 0)
        }
        .padding(FS.space.s6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(c.bg.ignoresSafeArea())
    }

    private func content(_ r: AppAccessRequest, item: AppAccessAlertCenter.Item, c: FSColors) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s4) {
            Image(systemName: "network.badge.shield.half.filled").font(.system(size: 34)).foregroundColor(c.warning)
            switch center.stage {
            case .done(let action):
                Text(AppAccessCopy.answered(app: r.appName, host: r.host, action: action))
                    .font(FS.font.h3()).foregroundColor(c.text)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("access-alert-done")
                FSPrimaryButton("Close", block: true) { center.close() }
                FSSecondaryButton(AppAccessCopy.viewList, block: true) {
                    Task { await center.viewAccessList() }
                }
            default:
                Text(AppAccessCopy.wantsToReach(app: r.appName, host: r.host))
                    .font(FS.font.h3()).foregroundColor(c.text)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("access-alert-title")
                Text("\(AppAccessCopy.source(r.source, attempts: r.attempts)) · \(item.serverDomain)")
                    .font(FS.font.bodySm()).foregroundColor(c.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
                Text("Only allow hosts you expect this app to need. Your answer goes into its access list.")
                    .font(FS.font.bodySm()).foregroundColor(c.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
                if case .failed(let msg) = center.stage {
                    Text(msg).font(FS.font.bodySm()).foregroundColor(c.danger)
                        .fixedSize(horizontal: false, vertical: true)
                }
                let working: Bool = { if case .working = center.stage { return true }; return false }()
                FSPrimaryButton(center.stage == .working(.allow) ? "Allowing…" : "Allow", enabled: !working, block: true) {
                    Task { await center.allow() }
                }
                .accessibilityIdentifier("access-alert-allow")
                FSSecondaryButton(center.stage == .working(.deny) ? "Denying…" : "Deny", block: true) {
                    Task { await center.deny() }
                }
                .disabled(working)
                .accessibilityIdentifier("access-alert-deny")
                FSGhostButton("Not now", block: true) { center.notNow() }
                    .disabled(working)
                    .accessibilityIdentifier("access-alert-not-now")
            }
            Spacer(minLength: 0)
        }
        .padding(FS.space.s6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(c.bg.ignoresSafeArea())
    }
}
