import SwiftUI
import FlagshipAPI
import FlagshipCore

enum MessagesRoute: Hashable {
    case thread(conv: String)
    case pageEditor
    case preview
}

/// The Messages tab (docs/voici-and-messages.md §11.1): the account's voi.ci page on top, then the conversations
/// people started from it, split into Messages and Requests (a conversation is a request until the owner replies or
/// taps Accept). Text only; a visitor is the generated name or the owner's nickname, never text the visitor chose.
public struct MessagesTab: View {
    @Environment(AppState.self) private var app
    @Environment(DeepLinker.self) private var linker
    @Environment(\.voiciComClient) private var client
    @Environment(\.openURL) private var openURL
    @State private var path: [MessagesRoute] = []
    @State private var segment = 0
    private let store = MessagesStore.shared

    public init() {}

    public var body: some View {
        NavigationStack(path: $path) {
            content
                .navigationTitle(Text("Messages"))
                .navigationDestination(for: MessagesRoute.self) { route in
                    switch route {
                    case .thread(let conv): ThreadScreen(conv: conv)
                    case .pageEditor: PageEditorScreen(onPreview: { path.append(.preview) })
                    case .preview: PagePreviewScreen()
                    }
                }
        }
        .task(id: app.currentUser) { configure() }
        .onAppear {
            configure()
            store.startPolling()
        }
        .onDisappear { store.stopPolling() }
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
            Task { await store.refresh() }
        case .pageEditor?:
            _ = linker.consume()
            path = [.pageEditor]
            Task { await store.refresh() }
        default:
            break
        }
    }

    @ViewBuilder
    private var content: some View {
        if !store.hasAccount {
            ContentUnavailableView {
                Label("Messages", systemImage: "bubble.left")
            } description: {
                Text("Messages need your own Flagship account. Sample accounts can't have a page.")
            }
        } else {
            List {
                if !store.replyNotices.isEmpty {
                    Section {
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
                Section {
                    Button { path.append(.pageEditor) } label: { pageRow }
                        .accessibilityIdentifier("messages-your-page")
                }
                Section {
                    Picker("Show", selection: $segment) {
                        Text("Messages").tag(0)
                        Text(store.requests.isEmpty ? String(localized: "Requests") : String(localized: "Requests (\(store.requests.count))")).tag(1)
                    }
                    .pickerStyle(.segmented)
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets())
                    .accessibilityIdentifier("messages-segment")
                }
                let rows = segment == 0 ? store.accepted : store.requests
                if rows.isEmpty {
                    Section {
                        Text(emptyText)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .accessibilityIdentifier("messages-empty")
                    }
                } else {
                    Section {
                        ForEach(rows) { c in
                            NavigationLink(value: MessagesRoute.thread(conv: c.conv)) { ConversationRow(c: c, store: store) }
                                .accessibilityIdentifier("messages-row-\(store.name(c))")
                        }
                    }
                }
                if let err = store.lastError {
                    Section { Text(verbatim: err).font(.footnote).foregroundStyle(.secondary) }
                }
            }
            .listStyle(.insetGrouped)
            .refreshable { await store.refresh() }
        }
    }

    private var emptyText: String {
        if segment == 1 { return String(localized: "No requests. New conversations wait here until you reply or accept them.") }
        return String(localized: "No messages yet. Turn on Accept messages on your page to get them.")
    }

    private var pageRow: some View {
        HStack(spacing: 12) {
            Image(systemName: "person.crop.square")
                .font(.title2)
                .foregroundStyle(.tint)
                .frame(width: 32)
            VStack(alignment: .leading, spacing: 2) {
                Text("Your page").font(.headline).foregroundStyle(.primary)
                Text(verbatim: "voi.ci/\(app.currentUser ?? "")").font(.subheadline).foregroundStyle(.secondary)
                Text(pageStatus).font(.footnote).foregroundStyle(.secondary)
                    .accessibilityIdentifier("messages-page-status")
            }
            Spacer()
            Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(.tertiary)
        }
        .contentShape(Rectangle())
    }

    private var pageStatus: String {
        let n = store.pendingCount
        if store.index == nil { return n > 0 ? String(localized: "Not published yet") : String(localized: "No page yet") }
        if n == 1 { return String(localized: "Published · 1 change not published") }
        if n > 1 { return String(localized: "Published · \(n) changes not published") }
        return String(localized: "Published")
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
