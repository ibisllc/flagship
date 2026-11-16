#if os(iOS)
import SwiftUI
import Flagship
import FlagshipAPI
import FlagshipCore

extension VisitorConversationModel {
    @MainActor
    static func live(callee: VoiciCallee, displayName: String, client: any VoiciComClient) -> VisitorConversationModel {
        let store = MessagesStore.shared
        let umk: () async throws -> [UInt8] = {
            if let cached = Keystore.messagesUMKIfCached() { return Array(cached) }
            return Array(try await Keystore.messagesUMK(reason: String(localized: "Open your conversation with voi.ci/\(callee.username)")))
        }
        let deps = Deps(
            client: client,
            umk: umk,
            session: { pageId, delegatePub, nonce, ttl in
                try await VoiciVisitorSession.answer(client: client, username: store.username, pageId: pageId, origin: Endpoints.voiciOrigin,
                                                     delegatePub: delegatePub, nonce: nonce, ttlMs: ttl, umk: try await umk(),
                                                     now: Int64(Date().timeIntervalSince1970 * 1000)).answer
            },
            ownPage: { store.ownPageForReveal() },
            account: store.username,
            device: store.device)
        // The sign-in book keeps "Name · voi.ci/<username>"; the settings name the person.
        let name = displayName.components(separatedBy: " · voi.ci/").first.flatMap { $0.isEmpty ? nil : $0 } ?? "voi.ci/\(callee.username)"
        return VisitorConversationModel(callee: callee, displayName: name, deps: deps)
    }
}

/// Social → a conversation this account started on someone else's page: the messages, a reply box, Call, and the
/// conversation's settings ("Show <name> who I am", Stop call-backs, Delete).
struct VisitorConversationScreen: View {
    @State var model: VisitorConversationModel
    @Environment(\.voiciComClient) private var client
    @Environment(\.dismiss) private var dismiss
    @State private var draft = ""
    @State private var sending = false
    @State private var showSettings = false
    @State private var calling: VoiciOutgoingCall?

    var body: some View {
        VStack(spacing: 0) {
            switch model.phase {
            case .loading: ProgressView().frame(maxHeight: .infinity)
            case .failed(let why): Text(verbatim: why).foregroundStyle(.secondary).padding().frame(maxHeight: .infinity)
            case .ready: thread
            }
        }
        .navigationTitle(Text(verbatim: "voi.ci/\(model.callee.username)"))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                VoiciCallButtons(callee: model.callee) { calling = $0 }
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button { showSettings = true } label: { Label("Settings", systemImage: "gearshape") }
                    .accessibilityIdentifier("visitor-thread-settings")
            }
        }
        .sheet(isPresented: $showSettings) { VisitorConversationSettings(model: model) { if model.deleted { dismiss() } } }
        .fullScreenCover(item: $calling) { c in VoiciOutgoingCallScreen(call: c) { calling = nil } }
        .task { await model.load() }
        .refreshable { try? await model.refresh() }
    }

    private var thread: some View {
        VStack(spacing: 0) {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 8) {
                    if model.messages.isEmpty {
                        Text("No messages yet.").foregroundStyle(.secondary).padding()
                    }
                    ForEach(model.messages) { m in
                        HStack {
                            if !m.fromOwner { Spacer(minLength: 48) }
                            Text(verbatim: m.text)
                                .padding(10)
                                .background(m.fromOwner ? Color(.secondarySystemBackground) : Color.accentColor.opacity(0.2), in: RoundedRectangle(cornerRadius: 14))
                            if m.fromOwner { Spacer(minLength: 48) }
                        }
                    }
                }
                .padding()
            }
            .accessibilityIdentifier("visitor-thread")
            if let note = model.note {
                Text(verbatim: note).font(.footnote).foregroundStyle(.secondary).padding(.horizontal)
            }
            HStack {
                TextField("Message", text: $draft, axis: .vertical).textFieldStyle(.roundedBorder)
                Button {
                    let text = draft
                    sending = true
                    Task {
                        if await model.send(text) { draft = "" }
                        sending = false
                    }
                } label: { Image(systemName: "arrow.up.circle.fill").font(.title2) }
                    .disabled(sending || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .accessibilityIdentifier("visitor-thread-send")
            }
            .padding()
        }
    }
}

/// The conversation's settings on the caller's side.
struct VisitorConversationSettings: View {
    let model: VisitorConversationModel
    var onClose: () -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var busy = false
    @State private var confirmDelete = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Toggle(String(localized: "Show \(model.displayName) who I am"), isOn: Binding(get: { model.revealed }, set: { on in
                        busy = true
                        Task { await model.setRevealed(on); busy = false }
                    }))
                    .disabled(busy || (!model.hasOwnPage && !model.revealed))
                    .accessibilityIdentifier("visitor-reveal")
                } footer: {
                    if model.revealed {
                        Text(verbatim: String(localized: "Turning this off hides the name, but \(model.displayName) may already have seen it."))
                    } else if model.hasOwnPage {
                        Text(verbatim: String(localized: "\(model.displayName) sees your voi.ci page name, checked by Flagship. Otherwise they only see a visitor name."))
                    } else {
                        Text("Publish your own voi.ci page to show who you are.")
                    }
                }
                Section {
                    Button("Stop call-backs") { Task { await model.stopCallBacks() } }
                        .accessibilityIdentifier("visitor-stop-call-backs")
                } footer: {
                    Text(verbatim: String(localized: "\(model.displayName) can ring you back in this conversation only while you allow it."))
                }
                Section {
                    Button("Delete conversation", role: .destructive) { confirmDelete = true }
                        .accessibilityIdentifier("visitor-delete")
                }
                if let note = model.note { Section { Text(verbatim: note).font(.footnote).foregroundStyle(.secondary) } }
            }
            .navigationTitle(Text("Settings"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss(); onClose() } } }
            .confirmationDialog("Delete this conversation?", isPresented: $confirmDelete, titleVisibility: .visible) {
                Button("Delete", role: .destructive) {
                    Task {
                        await model.delete()
                        if model.deleted { dismiss(); onClose() }
                    }
                }
            } message: {
                Text(verbatim: String(localized: "It goes from Flagship and this device. Messages already on \(model.displayName)'s device stay there."))
            }
        }
    }
}
#endif
