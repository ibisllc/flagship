import SwiftUI
import FlagshipAPI
import FlagshipCore

/// One conversation (docs/voici-and-messages.md §11.1, §12.1): bubbles of plain text, never HTML. https links are
/// found by the shared strict matcher and open only after "Open <host>?" with the full address shown. Reply at the
/// bottom; Rename, Accept, Block, Report and Delete in the menu.
struct ThreadScreen: View {
    let conv: String
    @Environment(\.dismiss) private var dismiss
    private let store = MessagesStore.shared
    @State private var draft = ""
    @State private var sending = false
    @State private var renaming = false
    @State private var newName = ""
    @State private var confirmBlock = false
    @State private var confirmDelete = false
    @State private var reporting: VoiciThreadMessage?
    @State private var reported = false
    @State private var opening: URL?
    @State private var note: String?

    var body: some View {
        Group {
            if let c = store.conversation(conv) {
                thread(c)
            } else {
                ContentUnavailableView("This conversation is gone", systemImage: "bubble.left")
            }
        }
        .navigationBarTitleDisplayMode(.inline)
    }

    private func thread(_ c: VoiciConversation) -> some View {
        let blocked = store.state.blocks.contains(c.pseudonymPub)
        return VStack(spacing: 0) {
            messageList(c)
            if let note {
                Text(verbatim: note).font(.footnote).foregroundStyle(.secondary).padding(.horizontal).padding(.top, 4)
                    .accessibilityIdentifier("thread-note")
            }
            if blocked {
                Text("You blocked this visitor. Their messages don't reach you.")
                    .font(.footnote).foregroundStyle(.secondary).padding()
            } else {
                compose(c)
            }
        }
        .navigationTitle(Text(verbatim: store.name(c)))
        .toolbar { ToolbarItem(placement: .topBarTrailing) { menu(c, blocked: blocked) } }
        .task { await store.markRead(c) }
        .alert("Rename", isPresented: $renaming) {
            TextField("Name", text: $newName).accessibilityIdentifier("thread-rename-field")
            Button("Cancel", role: .cancel) {}
            Button("Save") {
                Task { note = await store.rename(c, to: newName) }
            }
        } message: {
            Text("Only you see this name, on your devices.")
        }
        .confirmationDialog("Block this visitor?", isPresented: $confirmBlock, titleVisibility: .visible) {
            Button("Block", role: .destructive) { Task { await store.setBlocked(c, true) } }
        } message: {
            Text("They won't be told. Their new messages won't reach you.")
        }
        .confirmationDialog("Delete this conversation?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Delete", role: .destructive) {
                Task {
                    await store.delete(c)
                    dismiss()
                }
            }
        } message: {
            Text("It goes from all your devices. A new message from them starts a new request.")
        }
        .sheet(item: $reporting) { m in
            ReportSheet(message: m) { reason in
                Task {
                    reported = await store.report(m, reason: reason)
                    reporting = nil
                }
            }
        }
        .alert("Reported", isPresented: $reported) {
            Button("OK") {}
        } message: {
            Text("Thanks. Flagship will look at it. You can also block this visitor.")
        }
        .alert(openingTitle, isPresented: Binding(get: { opening != nil }, set: { if !$0 { opening = nil } })) {
            Button("Cancel", role: .cancel) { opening = nil }
            Button("Open") {
                if let u = opening { UIApplication.shared.open(u) }
                opening = nil
            }
        } message: {
            Text(verbatim: opening?.absoluteString ?? "")
        }
    }

    private var openingTitle: String {
        String(localized: "Open \(opening?.host() ?? "")?")
    }

    private func menu(_ c: VoiciConversation, blocked: Bool) -> some View {
        Menu {
            Button { newName = store.state.nicknames[c.pseudonymPub]?.name ?? ""; renaming = true } label: { Label("Rename", systemImage: "pencil") }
                .accessibilityIdentifier("thread-rename")
            if store.isRequest(c) {
                Button { Task { await store.accept(c) } } label: { Label("Accept", systemImage: "checkmark.circle") }
                    .accessibilityIdentifier("thread-accept")
            }
            if blocked {
                Button { Task { await store.setBlocked(c, false) } } label: { Label("Unblock", systemImage: "hand.raised.slash") }
            } else {
                Button(role: .destructive) { confirmBlock = true } label: { Label("Block", systemImage: "hand.raised") }
                    .accessibilityIdentifier("thread-block")
            }
            if let last = c.messages.last(where: { !$0.fromOwner }) {
                Button(role: .destructive) { reporting = last } label: { Label("Report", systemImage: "exclamationmark.bubble") }
                    .accessibilityIdentifier("thread-report")
            }
            Button(role: .destructive) { confirmDelete = true } label: { Label("Delete conversation", systemImage: "trash") }
        } label: {
            Image(systemName: "ellipsis.circle").accessibilityLabel(Text("More"))
        }
        .accessibilityIdentifier("thread-menu")
    }

    /// Split out of `thread(_:)`: as one expression it timed out the CI type checker.
    private func messageList(_ c: VoiciConversation) -> some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 8) {
                    if c.hasGap {
                        Text("Some messages haven't arrived yet")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .padding(.vertical, 4)
                    }
                    ForEach(c.messages) { m in
                        bubble(m, last: m.id == c.messages.last(where: \.fromOwner)?.id)
                            .id(m.id)
                    }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
            }
            .onAppear { if let last = c.messages.last { proxy.scrollTo(last.id, anchor: .bottom) } }
            .onChange(of: c.messages.count) { _, _ in
                if let last = c.messages.last { withAnimation { proxy.scrollTo(last.id, anchor: .bottom) } }
            }
        }
    }

    private func bubble(_ m: VoiciThreadMessage, last: Bool) -> some View {
        VStack(alignment: m.fromOwner ? .trailing : .leading, spacing: 2) {
            HStack {
                if m.fromOwner { Spacer(minLength: 48) }
                Text(Self.attributed(m.text))
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(m.fromOwner ? Color.accentColor.opacity(0.18) : Color(.secondarySystemBackground),
                                in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                    .textSelection(.enabled)
                    .environment(\.openURL, OpenURLAction { url in
                        opening = url
                        return .handled
                    })
                    .contextMenu {
                        if !m.fromOwner {
                            Button(role: .destructive) { reporting = m } label: { Label("Report", systemImage: "exclamationmark.bubble") }
                        }
                    }
                    .accessibilityIdentifier(m.fromOwner ? "bubble-owner" : "bubble-visitor")
                if !m.fromOwner { Spacer(minLength: 48) }
            }
            if m.fromOwner && last {
                Text(receipt(m.receipt)).font(.caption2).foregroundStyle(.secondary).padding(.horizontal, 4)
                    .accessibilityIdentifier("thread-receipt")
            }
        }
    }

    private func receipt(_ r: VoiciThreadMessage.Receipt) -> String {
        switch r {
        case .sent: return String(localized: "Sent")
        case .delivered: return String(localized: "Delivered")
        case .deliveredToPhone: return String(localized: "Delivered to their phone")
        }
    }

    /// Plain text, with each https link the shared matcher finds made tappable (the tap is confirmed first).
    static func attributed(_ text: String) -> AttributedString {
        var out = AttributedString()
        let units = Array(text.utf16)
        var at = 0
        for m in VoiciText.findVoiciLinks(text) where m.start >= at && m.end <= units.count {
            out += AttributedString(String(decoding: units[at..<m.start], as: UTF16.self))
            var link = AttributedString(String(decoding: units[m.start..<m.end], as: UTF16.self))
            if let u = URL(string: m.url) {
                link.link = u
                link.underlineStyle = .single
            }
            out += link
            at = m.end
        }
        out += AttributedString(String(decoding: units[at...], as: UTF16.self))
        return out
    }

    private func compose(_ c: VoiciConversation) -> some View {
        HStack(alignment: .bottom, spacing: 8) {
            TextField("Reply", text: $draft, axis: .vertical)
                .lineLimit(1...6)
                .fsInputBox()
                .accessibilityIdentifier("thread-compose")
                .onChange(of: draft) { _, v in if v.count > 2_000 { draft = String(v.prefix(2_000)) } }
            Button {
                let text = draft.trimmingCharacters(in: .whitespacesAndNewlines).precomposedStringWithCanonicalMapping
                guard !text.isEmpty else { return }
                sending = true
                Task {
                    if await store.reply(to: c.conv, text: text) {
                        draft = ""
                        note = nil
                    } else {
                        note = store.lastError
                    }
                    sending = false
                }
            } label: {
                Image(systemName: "arrow.up.circle.fill").font(.title)
            }
            .disabled(sending || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || c.threadPub.isEmpty)
            .accessibilityLabel(Text("Send"))
            .accessibilityIdentifier("thread-send")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(.bar)
    }
}

/// Why a message is reported (§9.2). The 0.3 apps send the signed message, not its text.
struct ReportSheet: View {
    let message: VoiciThreadMessage
    let onReport: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var reason = "spam"

    private let reasons: [(String, String)] = [
        ("spam", String(localized: "Spam")), ("harassment", String(localized: "Harassment")),
        ("impersonation", String(localized: "Pretending to be someone")), ("illegal", String(localized: "Illegal content")),
        ("other", String(localized: "Something else")),
    ]

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker("Reason", selection: $reason) {
                        ForEach(reasons, id: \.0) { Text($0.1).tag($0.0) }
                    }
                    .pickerStyle(.inline)
                    .labelsHidden()
                } footer: {
                    Text("Flagship gets this message as it was sent, sealed. It can then see which account sent it, not what it says.")
                }
            }
            .navigationTitle(Text("Report"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Report") { onReport(reason) }.accessibilityIdentifier("report-send")
                }
            }
        }
        .presentationDetents([.medium, .large])
    }
}
