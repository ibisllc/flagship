#if os(iOS)
import SwiftUI
import FlagshipCore

/// The app's own call screen (docs/voici-calls.md §8; voici-calls-v2.md §1.4), above everything while a call rings or
/// runs: the ringing screen where there is no CallKit (the China mainland storefront), and the in-call controls (Mute,
/// Camera, Hang up) everywhere once the app is open. CallKit draws the system screens itself.
public struct VoiciCallScreen: View {
    @State private var center = VoiciCallCenter.shared
    @State private var cameraRefused = false

    public init() {}

    public var body: some View {
        if let call = center.ringBack {
            VoiciOutgoingCallScreen(call: call) { center.ringBackDone() }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if visible {
            Group {
                switch center.phase {
                case .ringing, .needsUnlock: ringing
                default: inCall
                }
            }
            .transition(.opacity)
        }
    }

    /// The ringing screen where there's no CallKit (the China mainland storefront): the same stage, Decline and Answer.
    private var ringing: some View {
        VoiciRingingStage(name: center.callerName, status: status, canAnswer: center.phase == .ringing,
                          decline: { center.declineOrHangUp() }, answer: { center.answerInApp() })
    }

    private var inCall: some View {
        VStack(spacing: 0) {
            VoiciCallStage(
                state: VoiciCallStageState(
                    name: center.callerName, status: inCallStatus,
                    connectedSince: center.phase == .connected ? center.connectedSince : nil,
                    muted: center.muted, cameraOn: center.cameraOn, cameraFront: center.cameraFront,
                    remoteCameraOn: center.remoteCamera == "on", remoteCameraPaused: center.remoteCamera == "paused",
                    offersVideo: center.offersVideo, over: isOver, media: center.mediaEngine),
                actions: VoiciCallStageActions(
                    toggleMute: { center.setMuted(!center.muted) },
                    toggleCamera: {
                        Task {
                            let want = !center.cameraOn
                            let ok = await center.setCamera(want)
                            cameraRefused = want && !ok
                        }
                    },
                    flipCamera: { center.flipCamera() },
                    hangUp: { center.declineOrHangUp() },
                    close: { cameraRefused = false; center.dismissEnded() }))
        }
        .overlay(alignment: .top) {
            if cameraRefused {
                Text("Flagship needs the camera to show your video. You can keep talking without it.")
                    .font(.callout).foregroundStyle(CallStageColors.ink).multilineTextAlignment(.center)
                    .padding(12).background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 12)).padding()
                    .onTapGesture { cameraRefused = false }
            }
        }
    }

    private var isOver: Bool {
        if case .ended = center.phase { return true }
        return false
    }

    private var inCallStatus: String {
        if center.phase == .connecting, center.connectSlow { return status + "\n" + String(localized: "This is taking longer than usual") }
        return status
    }

    private var visible: Bool { VoiciCallScreenModel.visible(center.phase, noRingMode: center.noRingMode) }

    private var status: String { VoiciCallScreenModel.status(center.phase, step: center.connectStep) }

}

/// The ringing screen's look, apart from the call center so the gym can draw it.
struct VoiciRingingStage: View {
    var name: String
    var status: String
    var canAnswer: Bool
    var decline: () -> Void
    var answer: () -> Void

    var body: some View {
        ZStack {
            CallStageColors.canvas.ignoresSafeArea()
            GeometryReader { geo in
            VStack(spacing: 12) {
                CallStageAvatar(name: name, size: 112)
                Text(verbatim: name).font(.largeTitle.weight(.semibold)).foregroundStyle(CallStageColors.ink)
                    .lineLimit(2).multilineTextAlignment(.center).minimumScaleFactor(0.7)
                Text(verbatim: status).font(.title3).foregroundStyle(CallStageColors.ink.opacity(0.75)).multilineTextAlignment(.center)
                Label("End-to-end encrypted · quantum-safe", systemImage: "lock.fill")
                    .font(.footnote)
                    .foregroundStyle(CallStageColors.ink.opacity(0.55))
                    .padding(.top, 4)
                Spacer(minLength: 16)
                HStack {
                    CallRoundButton(symbol: "phone.down.fill", title: String(localized: "Decline"), style: .end, action: decline)
                        .frame(maxWidth: .infinity)
                    if canAnswer {
                        CallRoundButton(symbol: "phone.fill", title: String(localized: "Answer"), style: .answer, action: answer)
                            .frame(maxWidth: .infinity)
                    }
                }
                .padding(.bottom, 24)
            }
            .padding(.top, geo.size.height * 0.1)
            .padding(.horizontal, 24)
            }
        }
        .preferredColorScheme(.dark)
    }
}

/// What the call screen shows for each phase (pure, so the view-model tests can pin it).
enum VoiciCallScreenModel {
    static func visible(_ phase: VoiciCallCenter.Phase, noRingMode: Bool) -> Bool {
        switch phase {
        case .idle: return false
        case .ringing, .needsUnlock: return noRingMode
        default: return true
        }
    }

    static func status(_ phase: VoiciCallCenter.Phase, step: VoiciCallConnectStep? = nil) -> String {
        switch phase {
        case .ringing: return String(localized: "voi.ci call")
        case .needsUnlock: return String(localized: "Unlock Flagship to answer")
        case .connecting:
            switch step {
            case .route: return String(localized: "Opening your line…")
            case .secure: return String(localized: "Securing the line (quantum-safe)…")
            case .path: return String(localized: "Opening a direct path…")
            case .audio: return String(localized: "Starting audio…")
            case nil: return String(localized: "Connecting…")
            }
        case .connected: return String(localized: "Quantum-safe call")
        case .idle: return ""
        case .ended(let code):
            switch code {
            case "answered-elsewhere": return String(localized: "Answered on another device")
            case "media-unavailable": return String(localized: "This version of Flagship can't connect calls yet.")
            case "failed": return String(localized: "The call couldn't connect.")
            case "limit": return String(localized: "Calls end after 60 minutes.")
            default: return String(localized: "Call ended")
            }
        }
    }
}
#endif
