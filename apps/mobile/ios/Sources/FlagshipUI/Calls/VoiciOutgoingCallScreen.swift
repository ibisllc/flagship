#if os(iOS)
import SwiftUI
import UIKit
import Flagship
import FlagshipAPI
import FlagshipCore

extension VoiciOutgoingCall {
    /// A call from this device to a page it knows, wired to the app: the account's visitor session (one Face ID if
    /// the account isn't unlocked), the calls' pinned network, the system browser for the fallback.
    @MainActor
    static func live(callee: VoiciCallee, video: Bool, allowCallBack: Bool = false, client: any VoiciComClient,
                     media: CallMediaEngine? = nil) -> VoiciOutgoingCall {
        let username = MessagesStore.shared.username
        let deps = Deps(
            client: client,
            media: media ?? VoiciCallCenter.shared.mediaFactory(),
            socket: LiveVoiciCallRoomSocket(),
            session: { pageId, delegatePub, nonce, ttl in
                let umk: Data
                if let cached = Keystore.messagesUMKIfCached() { umk = cached } else {
                    umk = try await Keystore.messagesUMK(reason: String(localized: "Call voi.ci/\(callee.username)"))
                }
                return try await VoiciVisitorSession.answer(client: client, username: username, pageId: pageId, origin: Endpoints.voiciOrigin,
                                                            delegatePub: delegatePub, nonce: nonce, ttlMs: ttl, umk: Array(umk),
                                                            now: Int64(Date().timeIntervalSince1970 * 1000)).answer
            },
            attachRingBack: { pageId in
                let umk: Data
                if let cached = Keystore.messagesUMKIfCached() { umk = cached } else {
                    umk = try await Keystore.messagesUMK(reason: String(localized: "Call voi.ci/\(callee.username)"))
                }
                try await MessagesStore.shared.attachRingBack(pageId: pageId, umk: Array(umk))
            },
            relay: { LiveQrRelayClient() },
            openURL: { url in await UIApplication.shared.open(url) },
            background: { work in
                let id = UIApplication.shared.beginBackgroundTask(withName: "voici-call-handoff")
                await work()
                if id != .invalid { UIApplication.shared.endBackgroundTask(id) }
            },
            history: VoiciCallHistory.shared)
        return VoiciOutgoingCall(callee: callee, video: video, allowCallBack: allowCallBack, deps: deps)
    }
}

/// The in-app screen of a call this app placed: status, Mute, Camera (video calls), Hang up; or, after the browser
/// took the call, a line saying so.
struct VoiciOutgoingCallScreen: View {
    @State var call: VoiciOutgoingCall
    var onDone: () -> Void

    var body: some View {
        VoiciCallStage(
            state: VoiciCallStageState(
                name: "voi.ci/\(call.callee.username)", status: call.statusLine,
                connectedSince: call.phase == .connected ? call.connectedSince : nil,
                muted: call.muted, cameraOn: call.cameraOn, cameraFront: call.cameraFront,
                remoteCameraOn: call.remoteCamera == "on", remoteCameraPaused: call.remoteCamera == "paused",
                offersVideo: call.video, over: call.isOver, media: call.media),
            actions: VoiciCallStageActions(
                toggleMute: { call.setMuted(!call.muted) },
                toggleCamera: { _ = call.setCamera(!call.cameraOn) },
                flipCamera: { call.flipCamera() },
                hangUp: { call.hangUp() },
                close: onDone))
        .task { await call.start() }
    }
}

/// The Calls page (Social tab's call button): "Who to call" with Call and Video call on top, then this device's calls
/// and the page's missed calls, newest first. A page this account called (or can call) has Call and Video call; a
/// visitor of this account's page is rung back from their thread, or from the row (Call back) when they never wrote.
struct VoiciCallsScreen: View {
    @Environment(\.voiciComClient) private var client
    @Environment(\.colorScheme) private var scheme
    private let store = MessagesStore.shared
    private let history = VoiciCallHistory.shared
    @State private var calling: VoiciOutgoingCall?
    @State private var note: String?
    @State private var target = ""
    @State private var targetProblem: String?
    @State private var resolving = false
    @State private var resolved: VoiciCallee?
    @State private var resolvedVideo = false
    @State private var chosen: (callee: VoiciCallee, allowCallBack: Bool)?
    @State private var opened: Opened?

    /// What a tapped row opens: the caller's thread on this account's page, or this account's conversation on the
    /// page it called.
    enum Opened: Hashable {
        case thread(conv: String)
        case page(username: String, pageId: String, title: String)
    }

    var body: some View {
        let entries = history.entries(missed: store.missedCalls)
        let c = FSColors.scheme(scheme)
        List {
            Group {
                whoToCall
                if let note { Text(verbatim: note).font(.footnote).foregroundStyle(.secondary) }
                if entries.isEmpty {
                    Text("No calls yet. Calls you make, answer or miss show here, on this device only.")
                        .foregroundStyle(.secondary)
                        .accessibilityIdentifier("voici-calls-empty")
                }
                ForEach(entries) { r in row(r) }
            }
            .listRowBackground(c.surface)
        }
        .scrollContentBackground(.hidden)
        .background(c.bg.ignoresSafeArea())
        .navigationTitle(Text("Calls"))
        .navigationBarTitleDisplayMode(.inline)
        .accessibilityIdentifier("voici-calls-list")
        .navigationDestination(item: $opened) { o in
            switch o {
            case .thread(let conv): ThreadScreen(conv: conv)
            case .page(let u, let p, let title):
                if let client {
                    VisitorConversationScreen(model: .live(callee: VoiciCallee(username: u, pageId: p), displayName: title, client: client))
                }
            }
        }
        .fullScreenCover(item: $calling) { c in VoiciOutgoingCallScreen(call: c) { calling = nil } }
        // The call opens once the pop-up has gone (a cover can't be presented while a sheet is still closing).
        .sheet(item: $resolved, onDismiss: placeChosen) { callee in
            VoiciCallBackPrompt(callee: callee, choose: { chosen = (callee, $0); resolved = nil }, cancel: { resolved = nil })
        }
    }

    // MARK: who to call

    /// A voi.ci page (its username or link) today; phone numbers later, so the field is named for the person.
    private var whoToCall: some View {
        Section {
            TextField(text: $target, prompt: Text("Username or voi.ci link")) { Text("Who to call") }
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .keyboardType(.URL)
                .submitLabel(.go)
                .onSubmit { Task { await call(video: false) } }
                .onChange(of: target) { _, _ in targetProblem = nil }
                .accessibilityIdentifier("voici-call-target")
            HStack(spacing: 12) {
                Button { Task { await call(video: false) } } label: {
                    Label("Call", systemImage: "phone.fill").frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .buttonBorderShape(.roundedRectangle(radius: FS.radius.sm))
                .foregroundStyle(FSColors.light.onPrimary)
                .accessibilityIdentifier("voici-call-target-audio")
                Button { Task { await call(video: true) } } label: {
                    Label("Video call", systemImage: "video.fill").frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                .buttonBorderShape(.roundedRectangle(radius: FS.radius.sm))
                .foregroundStyle(FSColors.scheme(scheme).text)
                .accessibilityIdentifier("voici-call-target-video")
            }
            .disabled(client == nil || resolving || target.trimmingCharacters(in: .whitespaces).isEmpty)
            if resolving { ProgressView().frame(maxWidth: .infinity) }
        } header: {
            Text("Who to call")
        } footer: {
            if let targetProblem {
                Text(verbatim: targetProblem).foregroundStyle(.red).accessibilityIdentifier("voici-call-target-problem")
            }
        }
    }

    /// Finds the page behind what was typed (checked under its account's key, as a call checks it), then asks the
    /// call-back question and places the call through the same flow as a row's Call button.
    private func call(video: Bool) async {
        guard let client, !resolving else { return }
        guard let username = VoiciCallTarget.username(from: target, voiciHost: Endpoints.voiciHost) else {
            targetProblem = String(localized: "Enter a voi.ci username, like voi.ci/alex.")
            return
        }
        resolving = true
        defer { resolving = false }
        do {
            let keys = try await client.accountKeys(username: username)
            guard let raw = try await client.page(username: username),
                  case .ok(let idx) = VoiciPage.checkVoiciPageIndex(raw, username: username, sensitiveKind: keys.sensitive.kind, sensitivePub: keys.sensitive.pub) else {
                targetProblem = String(localized: "There's no page at voi.ci/\(username).")
                return
            }
            guard idx.takesCalls else {
                targetProblem = String(localized: "voi.ci/\(username) doesn't take calls.")
                return
            }
            targetProblem = nil
            resolvedVideo = video
            resolved = VoiciCallee(username: username, pageId: idx.pageId)
        } catch {
            targetProblem = String(localized: "There's no page at voi.ci/\(username).")
        }
    }

    private func placeChosen() {
        guard let client, let c = chosen else { return }
        chosen = nil
        calling = VoiciOutgoingCall.live(callee: c.callee, video: resolvedVideo, allowCallBack: c.allowCallBack, client: client)
    }

    private func row(_ r: VoiciCallRecord) -> some View {
        HStack {
            Image(systemName: icon(r)).foregroundStyle(r.outcome == .missed ? Color.red : Color.secondary)
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: name(r))
                Text(verbatim: Self.detail(r)).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            if let p = r.callablePage {
                VoiciCallButtons(callee: VoiciCallee(username: p.username, pageId: p.pageId)) { calling = $0 }
            } else if let back = Self.callBack(r, hasThread: { store.conversation($0) != nil }, canRingBack: store.canRingBack(conv:pseudonymPub:threadPub:)) {
                // A caller who never wrote, while their conversation still allows call-backs: ring them back here, as
                // the thread's Call would (there is no thread to open).
                Button("Call back") { ringBack(back, video: r.video) }
                    .buttonStyle(.borderless)
                    .accessibilityIdentifier("voici-calls-call-back")
            } else if case .visitor(let conv, let pseudonym) = r.peer, pseudonym.isEmpty {
                // An anonymous caller (no account): the owner can block that conversation from calling again.
                Button(store.anonBlocked.contains(conv) ? String(localized: "Unblock") : String(localized: "Block")) {
                    Task { note = await store.setAnonBlocked(conv: conv, !store.anonBlocked.contains(conv)) }
                }
                .buttonStyle(.borderless)
                .accessibilityIdentifier("voici-calls-block")
            }
        }
        .contentShape(Rectangle())
        // The row's own Call / Block buttons keep their taps; the rest of the row opens the conversation.
        .onTapGesture { if let o = Self.opens(r, hasThread: { store.conversation($0) != nil }, title: name(r)) { opened = o } }
        .accessibilityIdentifier("voici-calls-row")
    }

    /// A visitor who can be rung back from their row: an incoming call from a visitor (not anonymous) with no thread
    /// here, whose call left their thread key, while their conversation still allows call-backs.
    struct CallBack: Equatable {
        let conv: String
        let pseudonymPub: String
        let threadPub: String
    }

    static func callBack(_ r: VoiciCallRecord, hasThread: (String) -> Bool, canRingBack: (String, String, String) -> Bool) -> CallBack? {
        guard r.direction == .incoming, case .visitor(let conv, let pseudonym) = r.peer, !pseudonym.isEmpty, !hasThread(conv),
              let threadPub = r.threadPub, !threadPub.isEmpty, canRingBack(conv, pseudonym, threadPub) else { return nil }
        return CallBack(conv: conv, pseudonymPub: pseudonym, threadPub: threadPub)
    }

    /// The thread screen's ring-back, with the same sentences (ThreadScreen.ringBack).
    private func ringBack(_ b: CallBack, video: Bool) {
        Task {
            switch await store.callVisitor(conv: b.conv, video: video, threadPub: b.threadPub) {
            case .rang: note = String(localized: "Ringing \(store.name(pseudonymPub: b.pseudonymPub)). When they answer, their phone calls you here.")
            case .noRingBack: note = String(localized: "They didn't allow call-backs in this conversation.")
            case .failed(let code): note = code == "locked" ? String(localized: "Unlock Flagship and try again.") : VoiciOutgoingCall.sentence(code)
            }
        }
    }

    /// Nil when there is nothing to open: an anonymous caller, or a caller who never wrote (no thread here).
    static func opens(_ r: VoiciCallRecord, hasThread: (String) -> Bool, title: String) -> Opened? {
        switch r.peer {
        case .page(let u, let p): return .page(username: u, pageId: p, title: title)
        case .visitor(let conv, let pseudonym):
            return !pseudonym.isEmpty && hasThread(conv) ? .thread(conv: conv) : nil
        }
    }

    private func name(_ r: VoiciCallRecord) -> String {
        switch r.peer {
        case .page(let u, _): return "voi.ci/\(u)"
        case .visitor(_, let p): return p.isEmpty ? String(localized: "Anonymous caller") : store.name(pseudonymPub: p)
        }
    }

    private func icon(_ r: VoiciCallRecord) -> String {
        switch (r.direction, r.outcome) {
        case (_, .missed): return "phone.down"
        case (.incoming, _): return r.video ? "video" : "phone.arrow.down.left"
        case (.outgoing, _): return r.video ? "video" : "phone.arrow.up.right"
        }
    }

    static func detail(_ r: VoiciCallRecord) -> String {
        let when = Date(timeIntervalSince1970: TimeInterval(r.at) / 1000).formatted(date: .abbreviated, time: .shortened)
        switch (r.direction, r.outcome) {
        case (.incoming, .missed): return String(localized: "Missed call · \(when)")
        case (.incoming, .declined): return String(localized: "Declined · \(when)")
        case (.incoming, .answered):
            if let length = SocialActivity.callLength(r.durationMs) { return String(localized: "Incoming call · \(when) · \(length)") }
            return String(localized: "Incoming call · \(when)")
        case (.incoming, _): return String(localized: "Incoming call · \(when)")
        case (.outgoing, .browser): return String(localized: "Opened in your browser · \(when)")
        case (.outgoing, .noAnswer): return String(localized: "No answer · \(when)")
        case (.outgoing, .declined): return String(localized: "Couldn't take your call · \(when)")
        case (.outgoing, .failed): return String(localized: "Didn't connect · \(when)")
        case (.outgoing, .answered):
            if let length = SocialActivity.callLength(r.durationMs) { return String(localized: "Outgoing call · \(when) · \(length)") }
            return String(localized: "Outgoing call · \(when)")
        case (.outgoing, _): return String(localized: "Outgoing call · \(when)")
        }
    }
}

/// "Call" and "Video call" for a page this account can call. Before the call, the call-back pop-up (VoiciCallBackPrompt).
struct VoiciCallButtons: View {
    let callee: VoiciCallee
    var onCall: (VoiciOutgoingCall) -> Void
    @Environment(\.voiciComClient) private var client
    @State private var asking: Bool?
    @State private var chosen: (video: Bool, allowCallBack: Bool)?

    var body: some View {
        HStack(spacing: 12) {
            Button { asking = false } label: { Label("Call", systemImage: "phone") }
                .accessibilityIdentifier("voici-call-audio")
            Button { asking = true } label: { Label("Video call", systemImage: "video") }
                .accessibilityIdentifier("voici-call-video")
        }
        .labelStyle(.iconOnly)
        .buttonStyle(.borderless)
        .disabled(client == nil)
        // The call opens once the pop-up has gone (a cover can't be presented while a sheet is still closing).
        .sheet(isPresented: Binding(get: { asking != nil }, set: { if !$0 { asking = nil } }), onDismiss: startChosen) {
            VoiciCallBackPrompt(callee: callee, choose: { allow in chosen = asking.map { ($0, allow) }; asking = nil }, cancel: { asking = nil })
        }
    }

    private func startChosen() {
        guard let client, let c = chosen else { return }
        chosen = nil
        onCall(VoiciOutgoingCall.live(callee: callee, video: c.video, allowCallBack: c.allowCallBack, client: client))
    }
}

/// The call-back question before a call (docs/voici-calls.md, owner wording 2026-11-23): "Let brisk-quartz call you
/// back?", "brisk-quartz won't learn who you are." with an info button that opens "About call-backs", then "Call and
/// allow call-back" (attaches this conversation's ring-back channel) or "Call without call-back".
struct VoiciCallBackPrompt: View {
    let callee: VoiciCallee
    var choose: (Bool) -> Void
    var cancel: () -> Void
    @State private var about = false

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 16) {
                Text(verbatim: String(localized: "Let \(callee.username) call you back?"))
                    .font(.title3.weight(.semibold))
                    .accessibilityAddTraits(.isHeader)
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(verbatim: String(localized: "\(callee.username) won't learn who you are."))
                    Button { about = true } label: { Image(systemName: "info.circle") }
                        .buttonStyle(.borderless)
                        .accessibilityLabel(Text("About call-backs"))
                        .accessibilityIdentifier("voici-call-back-about")
                }
                .foregroundStyle(.secondary)
                Spacer(minLength: 0)
                Button { choose(true) } label: { Text("Call and allow call-back").frame(maxWidth: .infinity) }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                    .accessibilityIdentifier("voici-call-allow-back")
                Button { choose(false) } label: { Text("Call without call-back").frame(maxWidth: .infinity) }
                    .buttonStyle(.bordered)
                    .controlSize(.large)
                    .accessibilityIdentifier("voici-call-no-back")
            }
            .padding()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel", action: cancel) }
            }
            .navigationDestination(isPresented: $about) {
                VoiciCallBackAbout(username: callee.username, visitorName: Self.visitorName(pageId: callee.pageId))
            }
        }
        .presentationDetents([.medium, .large])
    }

    /// This account's visitor name on the page ("Visitor 4F3A"), when the account key is open; nil otherwise (no Face
    /// ID just to show it).
    @MainActor
    static func visitorName(pageId: String) -> String? {
        guard let umk = Keystore.messagesUMKIfCached(),
              let p = try? VoiciMessages.deriveMessagesPseudonymKey(messagesSecret: VoiciMessages.deriveMessagesSecret(umk: Array(umk)), pageId: pageId)
        else { return nil }
        return try? VoiciText.voiciPseudonymName(CanonicalJson.hex(p.publicKey), prefix: String(localized: "Visitor "))
    }
}

/// "About call-backs": what the page sees, the note Flagship keeps and when it goes.
struct VoiciCallBackAbout: View {
    let username: String
    let visitorName: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                ForEach(Array(Self.points(username: username, visitorName: visitorName).enumerated()), id: \.offset) { _, p in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(verbatim: "•").accessibilityHidden(true)
                        Text(verbatim: p).fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding()
        }
        .navigationTitle(Text("About call-backs"))
        .navigationBarTitleDisplayMode(.inline)
        .accessibilityIdentifier("voici-call-back-about-text")
    }

    static func points(username: String, visitorName: String?) -> [String] {
        [
            visitorName.map { String(localized: "\(username) sees only your visitor name, \($0) (or a nickname they gave you), never your account.") }
                ?? String(localized: "\(username) sees only a visitor name (or a nickname they gave you), never your account."),
            String(localized: "Flagship keeps a note linking this conversation to your Flagship account, so it can ring your phone. It never sees your messages or hears your calls."),
            String(localized: "The note is deleted when you tap “Stop call-backs”, when \(username) blocks you or removes the page, or 90 days after you last called them with call-back on."),
            String(localized: "Calling without call-back leaves no note, and \(username) can't call you back, unless you allowed it on an earlier call."),
        ]
    }
}
#endif
