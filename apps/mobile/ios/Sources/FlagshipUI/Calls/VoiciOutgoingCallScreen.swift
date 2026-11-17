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

/// The Calls list (Social tab): this device's calls and the page's missed calls, newest first. A page this account
/// called (or can call) has Call and Video call; a visitor of this account's page can't be called back yet.
struct VoiciCallsScreen: View {
    @Environment(\.voiciComClient) private var client
    private let store = MessagesStore.shared
    private let history = VoiciCallHistory.shared
    @State private var calling: VoiciOutgoingCall?
    @State private var note: String?

    var body: some View {
        let entries = history.entries(missed: store.missedCalls)
        List {
            if let note { Text(verbatim: note).font(.footnote).foregroundStyle(.secondary) }
            if entries.isEmpty {
                Text("No calls yet. Calls you make, answer or miss show here, on this device only.")
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("voici-calls-empty")
            }
            ForEach(entries) { r in row(r) }
        }
        .navigationTitle(Text("Calls"))
        .navigationBarTitleDisplayMode(.inline)
        .accessibilityIdentifier("voici-calls-list")
        .fullScreenCover(item: $calling) { c in VoiciOutgoingCallScreen(call: c) { calling = nil } }
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
            } else if case .visitor(let conv, let pseudonym) = r.peer, pseudonym.isEmpty {
                // An anonymous caller (no account): the owner can block that conversation from calling again.
                Button(store.anonBlocked.contains(conv) ? String(localized: "Unblock") : String(localized: "Block")) {
                    Task { note = await store.setAnonBlocked(conv: conv, !store.anonBlocked.contains(conv)) }
                }
                .buttonStyle(.borderless)
                .accessibilityIdentifier("voici-calls-block")
            }
        }
        .accessibilityIdentifier("voici-calls-row")
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
        case (.incoming, _): return String(localized: "Incoming call · \(when)")
        case (.outgoing, .browser): return String(localized: "Opened in your browser · \(when)")
        case (.outgoing, .noAnswer): return String(localized: "No answer · \(when)")
        case (.outgoing, .declined): return String(localized: "Couldn't take your call · \(when)")
        case (.outgoing, .failed): return String(localized: "Didn't connect · \(when)")
        case (.outgoing, _): return String(localized: "Outgoing call · \(when)")
        }
    }
}

/// "Call" and "Video call" for a page this account can call. Before the call, the call-back pop-up (docs/voici-calls.md,
/// owner additions, as Android): "Call and allow call-back" attaches this conversation's ring-back channel, "Call
/// without call-back" doesn't. The page owner never learns who this account is either way.
struct VoiciCallButtons: View {
    let callee: VoiciCallee
    var onCall: (VoiciOutgoingCall) -> Void
    @Environment(\.voiciComClient) private var client
    @State private var asking: Bool?

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
        .confirmationDialog(Text(verbatim: String(localized: "Let voi.ci/\(callee.username) call you back?")),
                            isPresented: Binding(get: { asking != nil }, set: { if !$0 { asking = nil } }), titleVisibility: .visible) {
            Button("Call and allow call-back") { start(allowCallBack: true) }
                .accessibilityIdentifier("voici-call-allow-back")
            Button("Call without call-back") { start(allowCallBack: false) }
                .accessibilityIdentifier("voici-call-no-back")
            Button("Cancel", role: .cancel) { asking = nil }
        } message: {
            Text(verbatim: String(localized: "voi.ci/\(callee.username) won't learn who you are. Flagship will know this conversation can ring your phone."))
        }
    }

    private func start(allowCallBack: Bool) {
        guard let client, let video = asking else { return }
        asking = nil
        onCall(VoiciOutgoingCall.live(callee: callee, video: video, allowCallBack: allowCallBack, client: client))
    }
}
#endif
