import SwiftUI
import FlagshipAPI
import FlagshipCore

enum MessagesRoute: Hashable {
    case thread(conv: String)
}

/// The Social tab (docs/social-tab.md): the account's voi.ci page, drawn as visitors see it and edited in place, and
/// the conversations people started from it. Title row: "Your page", the Public switch, Page options. Under it,
/// Profile / Messages. Changes wait in one bar that shows only while something is unpublished.
public struct SocialTab: View {
    enum Section { case profile, messages }

    @Environment(AppState.self) private var app
    @Environment(DeepLinker.self) private var linker
    @Environment(\.voiciComClient) private var client
    @Environment(\.openURL) private var openURL
    @Environment(\.colorScheme) private var scheme
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var path: [MessagesRoute] = []
    @State private var section: Section = .profile
    @State private var segment = 0
    @State private var flow = PagePublicFlow()
    @State private var draft = PageDraft()
    @State private var showOptions = false
    private let store = MessagesStore.shared

    public init() {}

    public var body: some View {
        NavigationStack(path: $path) {
            content
                .navigationTitle(Text("Social"))
                .navigationDestination(for: MessagesRoute.self) { route in
                    switch route {
                    case .thread(let conv): ThreadScreen(conv: conv)
                    }
                }
        }
        .task(id: app.currentUser) { configure() }
        .onAppear {
            configure()
            store.startPolling()
        }
        .onDisappear {
            store.stopPolling()
            Task { await draft.commit() }
        }
        .onChange(of: linker.pending) { _, link in consume(link) }
        .task(id: linker.pending) { consume(linker.pending) }
    }

    private func configure() {
        guard let client else { return }
        store.configure(client: client, username: app.currentUser, deviceId: app.activeProfile?.deviceId, isDemo: app.isDemoAccount)
    }

    private func consume(_ link: DeepLink?) {
        switch link {
        case .messages?:
            _ = linker.consume()
            path = []
            if !store.isSampleReadOnly { section = .messages }
            Task { await store.refresh() }
        case .pageEditor?:
            _ = linker.consume()
            path = []
            section = .profile
            Task { await store.refresh() }
        default:
            break
        }
    }

    @ViewBuilder
    private var content: some View {
        if store.isSampleReadOnly {
            // A sample account's page is the operator's example (docs/sample-users.md): shown, never edited here.
            List {
                SwiftUI.Section {
                    DemoPageHeaderView {
                        if let url = URL(string: store.pageURL) { openURL(url) }
                    }
                    .accessibilityElement(children: .contain)
                    .accessibilityIdentifier("messages-demo-page")
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle(Text("Your page"))
            .refreshable { await store.refresh() }
        } else if !store.hasAccount {
            ContentUnavailableView {
                Label("Social", systemImage: RootDestination.messages.systemImage)
            }
        } else {
            VStack(spacing: 0) {
                titleRow
                sectionPicker
                switch section {
                case .profile:
                    ScrollView {
                        PageEditorView(draft: draft)
                            .padding(.horizontal, 12)
                            .padding(.top, 4)
                            .padding(.bottom, 24)
                    }
                    .scrollDismissesKeyboard(.interactively)
                    .refreshable { await store.refresh() }
                case .messages:
                    messagesList
                }
            }
            .background(Color(.systemGroupedBackground))
            .toolbar(.hidden, for: .navigationBar)
            .safeAreaInset(edge: .bottom, spacing: 0) { publishBar }
            .animation(reduceMotion ? nil : .snappy(duration: 0.22), value: draft.unpublished > 0 || store.isPublishing)
            .pagePublicFlow(flow)
            .sheet(isPresented: $showOptions) { PageOptionsSheet(flow: flow, draft: draft) }
        }
    }

    // MARK: title row

    private var titleRow: some View {
        let title = VStack(alignment: .leading, spacing: 2) {
            Text(section == .profile ? String(localized: "Your page") : String(localized: "Messages"))
                .font(.largeTitle.weight(.bold))
                .accessibilityAddTraits(.isHeader)
                .accessibilityIdentifier("social-title")
            Text(verbatim: "voi.ci/\(store.username)")
                .font(.footnote.monospaced())
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.middle)
                .textSelection(.enabled)
        }
        let controls = HStack(spacing: 6) {
            Text(store.isPublic ? String(localized: "Public") : String(localized: "Not public"))
                .font(.footnote.weight(.semibold))
                .foregroundStyle(store.isPublic ? .primary : .secondary)
                .lineLimit(1)
                .fixedSize()
                .accessibilityIdentifier("messages-page-status")
            PagePublicToggle(flow: flow, labelsHidden: true)
                .fixedSize()
                .accessibilityLabel(Text("Public"))
            Button { showOptions = true } label: {
                Image(systemName: "ellipsis")
                    .font(.body.weight(.semibold))
                    .foregroundStyle(.primary)
                    .frame(width: 32, height: 32)
                    .background(Circle().fill(Color(.tertiarySystemFill)))
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(Text("Page options"))
            .accessibilityIdentifier("page-options")
        }
        return VStack(alignment: .leading, spacing: 4) {
            if typeSize.isAccessibilitySize {
                title
                controls
            } else {
                HStack(alignment: .bottom, spacing: 8) {
                    title
                    Spacer(minLength: 8)
                    controls
                }
            }
            if !store.isAdmin {
                Text("Only an admin device can publish your page.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("page-admin-only")
            }
            if let e = store.publishError {
                Text(verbatim: e)
                    .font(.footnote)
                    .foregroundStyle(FSColors.scheme(scheme).danger)
                    .accessibilityIdentifier("page-publish-error")
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 8)
        .padding(.bottom, 6)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("social-header")
    }

    // MARK: Profile / Messages

    private var sectionPicker: some View {
        HStack(spacing: 2) {
            sectionButton(.profile, String(localized: "Profile"), id: "social-tab-profile", badge: 0)
            sectionButton(.messages, String(localized: "Messages"), id: "social-tab-messages", badge: store.requests.count)
        }
        .padding(2)
        .background(RoundedRectangle(cornerRadius: 9, style: .continuous).fill(Color(.tertiarySystemFill)))
        .padding(.horizontal, 16)
        .padding(.bottom, 10)
    }

    private func sectionButton(_ s: Section, _ title: String, id: String, badge: Int) -> some View {
        let c = FSColors.scheme(scheme)
        let on = section == s
        return Button { section = s } label: {
            HStack(spacing: 6) {
                Text(verbatim: title).font(.subheadline.weight(.semibold))
                if badge > 0 {
                    Text(badge, format: .number)
                        .font(.caption2.weight(.bold))
                        .padding(.horizontal, 5)
                        .frame(minWidth: 18, minHeight: 18)
                        .background(Capsule().fill(c.primaryFill))
                        .foregroundStyle(c.onPrimary)
                }
            }
            .foregroundStyle(.primary)
            .frame(maxWidth: .infinity, minHeight: 34)
            .background {
                if on {
                    RoundedRectangle(cornerRadius: 7, style: .continuous)
                        .fill(Color(.systemBackground))
                        .shadow(color: .black.opacity(0.12), radius: 2, y: 1)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(on ? .isSelected : [])
        .accessibilityIdentifier(id)
    }

    // MARK: Messages

    private var messagesList: some View {
        List {
            if !store.replyNotices.isEmpty && segment == 0 {
                SwiftUI.Section {
                    ForEach(store.replyNotices) { n in
                        Button {
                            store.openedReply(n)
                            openURL(n.url)
                        } label: {
                            Label {
                                Text(verbatim: String(localized: "You have a reply on voi.ci/\(n.username)"))
                                    .foregroundStyle(.primary)
                            } icon: {
                                Image(systemName: "arrowshape.turn.up.left.fill")
                            }
                        }
                        .accessibilityIdentifier("messages-reply-notice")
                    }
                } footer: {
                    Text("Your conversations with other pages are on voi.ci.")
                }
            }
            SwiftUI.Section {
                Picker("Show", selection: $segment) {
                    Text("Conversations").tag(0)
                    Text(store.requests.isEmpty ? String(localized: "Requests") : String(localized: "Requests (\(store.requests.count))")).tag(1)
                }
                .pickerStyle(.segmented)
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets())
                .accessibilityIdentifier("messages-segment")
            }
            let rows = segment == 0 ? store.accepted : store.requests
            if rows.isEmpty {
                SwiftUI.Section {
                    Text(emptyText)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .accessibilityIdentifier("messages-empty")
                }
            } else {
                SwiftUI.Section {
                    ForEach(rows) { c in
                        NavigationLink(value: MessagesRoute.thread(conv: c.conv)) { ConversationRow(c: c, store: store) }
                            .accessibilityIdentifier("messages-row-\(store.name(c))")
                    }
                }
            }
            if let err = store.lastError {
                SwiftUI.Section { Text(verbatim: err).font(.footnote).foregroundStyle(.secondary) }
            }
        }
        .listStyle(.insetGrouped)
        .contentMargins(.top, 0, for: .scrollContent)
        .refreshable { await store.refresh() }
    }

    private var emptyText: String {
        if segment == 1 { return String(localized: "No requests. New conversations wait here until you reply or accept them.") }
        return String(localized: "No messages yet. Turn on Accept messages in Page options to get them.")
    }

    // MARK: publish bar

    /// Only while something is unpublished: "N changes not published · Publish", spinning while it publishes; on a
    /// device that can't sign the page, "Waiting for an admin device to publish".
    @ViewBuilder
    private var publishBar: some View {
        let n = draft.unpublished
        if n > 0 || store.isPublishing {
            let c = FSColors.scheme(scheme)
            HStack(spacing: 10) {
                VStack(alignment: .leading, spacing: 1) {
                    Text(store.isPublishing ? String(localized: "Publishing your page…") : String(localized: "\(n) changes not published"))
                        .font(.subheadline.weight(.semibold))
                        .accessibilityIdentifier("page-pending-count")
                    if !store.isAdmin {
                        Text("Waiting for an admin device to publish")
                            .font(.footnote)
                            .opacity(0.8)
                            .accessibilityIdentifier("page-waiting-admin")
                    }
                }
                Spacer(minLength: 8)
                if store.isAdmin {
                    Button {
                        Task {
                            if await draft.commit() { flow.publishAll() }
                        }
                    } label: {
                        Group {
                            if store.isPublishing {
                                ProgressView().tint(c.onPrimary)
                            } else {
                                Text("Publish").fontWeight(.bold)
                            }
                        }
                        .padding(.horizontal, 18)
                        .frame(minWidth: 104, minHeight: 40)
                        .background(Capsule().fill(c.primaryFill))
                        .foregroundStyle(c.onPrimary)
                    }
                    .buttonStyle(.plain)
                    .disabled(store.isPublishing)
                    .accessibilityIdentifier("page-publish")
                }
            }
            .padding(.leading, 18)
            .padding(.trailing, 6)
            .padding(.vertical, 6)
            .frame(minHeight: 52)
            .foregroundStyle(Color(.systemBackground))
            .background(Capsule().fill(Color(.label)))
            .shadow(color: .black.opacity(0.22), radius: 12, y: 6)
            .padding(.horizontal, 16)
            .padding(.bottom, 8)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("page-publish-bar")
            .transition(.move(edge: .bottom).combined(with: .opacity))
        }
    }
}

/// Page options, behind the title row's ⋯: the theme, the link, Accept messages, the visitor-side settings (websites
/// signed in to, the inbox key, the rules) and Remove page.
struct PageOptionsSheet: View {
    let flow: PagePublicFlow
    @Bindable var draft: PageDraft
    private let store = MessagesStore.shared
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var scheme
    @State private var copied = false
    @State private var confirmRotate = false
    @State private var confirmRemove = false
    @State private var showRules = false

    var body: some View {
        NavigationStack {
            Form {
                Section("Theme") {
                    HStack(spacing: 10) {
                        ForEach(VoiciPageTheme.ids, id: \.self) { id in swatch(id) }
                    }
                    .padding(.vertical, 4)
                    .accessibilityElement(children: .contain)
                    .accessibilityIdentifier("page-theme")
                }
                if store.isPublic {
                    Section {
                        Button(copied ? String(localized: "Copied") : String(localized: "Copy link")) {
                            UIPasteboard.general.string = store.pageURL
                            copied = true
                            UIAccessibility.post(notification: .announcement, argument: String(localized: "Copied"))
                        }
                        .accessibilityIdentifier("page-copy-link")
                        if let url = URL(string: store.pageURL) {
                            ShareLink(item: url) { Text("Share") }
                                .accessibilityIdentifier("page-share")
                        }
                    } footer: {
                        Text(verbatim: store.pageURL)
                    }
                }
                Section {
                    Toggle("Accept messages", isOn: Binding(get: { store.acceptsMessages }, set: { on in Task { await store.setAcceptsMessages(on) } }))
                        .accessibilityIdentifier("page-accept-messages")
                } footer: {
                    Text("People with a Flagship account can write to you. They appear as visitors, not by name.")
                }
                Section {
                    NavigationLink { SignedInSitesScreen() } label: { Text("Websites you're signed in to") }
                        .accessibilityIdentifier("messages-settings-sites")
                    if store.isAdmin, store.index != nil {
                        Button("Rotate inbox key") { confirmRotate = true }
                            .accessibilityIdentifier("messages-settings-rotate")
                    }
                    Button("Page and message rules") { showRules = true }
                        .accessibilityIdentifier("messages-settings-rules")
                } footer: {
                    if store.isAdmin, store.index != nil {
                        Text("New messages are sealed to a new key. This device keeps reading the old ones.")
                    }
                }
                if store.isAdmin, store.isPublic {
                    Section {
                        Button("Remove page", role: .destructive) { confirmRemove = true }
                            .accessibilityIdentifier("page-remove")
                    }
                }
                if let e = store.lastError ?? store.publishError {
                    Section { Text(verbatim: e).font(.footnote).foregroundStyle(.secondary) }
                }
            }
            .navigationTitle(Text("Page options"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() }.accessibilityIdentifier("page-options-done") }
            }
            .confirmationDialog("Rotate your inbox key?", isPresented: $confirmRotate, titleVisibility: .visible) {
                Button("Rotate") { Task { await store.rotateInbox() } }
            } message: {
                Text("Your page is published again with the new key.")
            }
            .alert("Remove your page from voi.ci?", isPresented: $confirmRemove) {
                Button("Cancel", role: .cancel) {}
                Button("Remove", role: .destructive) {
                    flow.remove()
                    dismiss()
                }
                .accessibilityIdentifier("page-remove-confirm")
            } message: {
                Text("Visitors will see “There's no page here.” Your posts and profile stay on your devices, so you can turn it on again.")
            }
            .sheet(isPresented: $showRules) { VoiciRulesSheet {} }
        }
    }

    private func swatch(_ id: String) -> some View {
        let t = VoiciPageTheme.of(id, id == "ink" ? .dark : scheme)
        let on = draft.theme == id
        let c = FSColors.scheme(scheme)
        return Button {
            draft.theme = id
            Task { await draft.commit() }
        } label: {
            Text(verbatim: VoiciPageTheme.label(id))
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(t.ink)
                .frame(maxWidth: .infinity, minHeight: 60)
                .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(t.canvas))
                .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .strokeBorder(on ? c.text : t.ruleStrong, lineWidth: on ? 2.5 : 1))
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(on ? .isSelected : [])
        .accessibilityIdentifier("page-theme-\(id)")
    }
}

struct ConversationRow: View {
    let c: VoiciConversation
    let store: MessagesStore

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Circle()
                .fill(store.isUnread(c) ? Color.accentColor : Color.clear)
                .frame(width: 8, height: 8)
                .padding(.top, 7)
                .accessibilityLabel(store.isUnread(c) ? Text("Unread") : Text(verbatim: ""))
            VStack(alignment: .leading, spacing: 3) {
                HStack {
                    Text(verbatim: store.name(c)).font(.headline).lineLimit(1)
                    Spacer()
                    Text(Date(timeIntervalSince1970: TimeInterval(c.lastAt) / 1000), format: .relative(presentation: .named))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Text(verbatim: c.messages.last.map { oneLine($0.text) } ?? "")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
        .padding(.vertical, 2)
    }

    private func oneLine(_ s: String) -> String { s.split(whereSeparator: \.isNewline).joined(separator: " ") }
}
