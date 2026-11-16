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
    static func live(callee: VoiciCallee, video: Bool, client: any VoiciComClient, media: CallMediaEngine? = nil) -> VoiciOutgoingCall {
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
        return VoiciOutgoingCall(callee: callee, video: video, deps: deps)
    }
}

/// The in-app screen of a call this app placed: status, Mute, Camera (video calls), Hang up; or, after the browser
/// took the call, a line saying so.
struct VoiciOutgoingCallScreen: View {
    @State var call: VoiciOutgoingCall
    var onDone: () -> Void

    var body: some View {
        VStack(spacing: 24) {
            Spacer()
            Image(systemName: call.video ? "video.fill" : "phone.fill").font(.system(size: 44)).foregroundStyle(.secondary)
            Text(verbatim: "voi.ci/\(call.callee.username)").font(.title2.weight(.semibold))
            Text(verbatim: call.statusLine)
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
                .accessibilityIdentifier("voici-outgoing-status")
            if call.remoteCamera == "paused" { Text("Camera paused").font(.footnote).foregroundStyle(.secondary) }
            Spacer()
            if call.isOver {
                Button("Done", action: onDone).buttonStyle(.borderedProminent).accessibilityIdentifier("voici-outgoing-done")
            } else {
                HStack(spacing: 20) {
                    Button(call.muted ? String(localized: "Unmute") : String(localized: "Mute")) { call.setMuted(!call.muted) }
                        .buttonStyle(.bordered)
                    if call.video {
                        Button(call.cameraOn ? String(localized: "Camera off") : String(localized: "Camera")) { _ = call.setCamera(!call.cameraOn) }
                            .buttonStyle(.bordered)
                    }
                    Button(role: .destructive) { call.hangUp() } label: { Label("Hang up", systemImage: "phone.down.fill") }
                        .buttonStyle(.borderedProminent)
                        .accessibilityIdentifier("voici-outgoing-hangup")
                }
            }
        }
        .padding(24)
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

/// "Call" and "Video call" for a page this account can call.
struct VoiciCallButtons: View {
    let callee: VoiciCallee
    var onCall: (VoiciOutgoingCall) -> Void
    @Environment(\.voiciComClient) private var client

    var body: some View {
        HStack(spacing: 12) {
            Button { start(video: false) } label: { Label("Call", systemImage: "phone") }
                .accessibilityIdentifier("voici-call-audio")
            Button { start(video: true) } label: { Label("Video call", systemImage: "video") }
                .accessibilityIdentifier("voici-call-video")
        }
        .labelStyle(.iconOnly)
        .buttonStyle(.borderless)
        .disabled(client == nil)
    }

    private func start(video: Bool) {
        guard let client else { return }
        onCall(VoiciOutgoingCall.live(callee: callee, video: video, client: client))
    }
}
#endif
