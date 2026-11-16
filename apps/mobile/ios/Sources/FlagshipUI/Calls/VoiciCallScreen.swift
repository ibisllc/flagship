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
                .background(.regularMaterial)
        } else if visible {
            VStack(spacing: 16) {
                Spacer()
                Text(center.callerName).font(.largeTitle.weight(.semibold)).multilineTextAlignment(.center)
                Text(status).font(.body).foregroundStyle(.secondary).multilineTextAlignment(.center)
                if center.phase == .connected, center.remoteCamera == "on" {
                    Text("\(center.callerName) turned on their camera").font(.callout)
                } else if center.phase == .connected, center.remoteCamera == "paused" {
                    Text("Camera paused").font(.callout)
                }
                if cameraRefused {
                    Text("Flagship needs the camera to show your video. You can keep talking without it.").font(.callout).multilineTextAlignment(.center)
                }
                Spacer()
                controls
            }
            .padding(24)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(.regularMaterial)
            .transition(.opacity)
        }
    }

    private var visible: Bool { VoiciCallScreenModel.visible(center.phase, noRingMode: center.noRingMode) }

    private var status: String { VoiciCallScreenModel.status(center.phase) }

    @ViewBuilder private var controls: some View {
        switch center.phase {
        case .ringing:
            HStack(spacing: 24) {
                Button(role: .destructive) { center.declineOrHangUp() } label: { Text("Decline") }.buttonStyle(.borderedProminent).tint(.red)
                Button { center.answerInApp() } label: { Text("Answer") }.buttonStyle(.borderedProminent).tint(.green)
            }
        case .needsUnlock:
            Button(role: .destructive) { center.declineOrHangUp() } label: { Text("Decline") }.buttonStyle(.bordered)
        case .connecting, .connected:
            HStack(spacing: 16) {
                Button { center.setMuted(!center.muted) } label: { Text(center.muted ? String(localized: "Unmute") : String(localized: "Mute")) }.buttonStyle(.bordered)
                if center.offersVideo {
                    Button {
                        Task {
                            let want = !center.cameraOn
                            let ok = await center.setCamera(want)
                            cameraRefused = want && !ok
                        }
                    } label: { Text(center.cameraOn ? String(localized: "Camera off") : String(localized: "Camera")) }.buttonStyle(.bordered)
                }
                Button(role: .destructive) { center.declineOrHangUp() } label: { Text("Hang up") }.buttonStyle(.borderedProminent).tint(.red)
            }
        case .ended:
            Button { cameraRefused = false; center.dismissEnded() } label: { Text("Close") }.buttonStyle(.borderedProminent)
        case .idle:
            EmptyView()
        }
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

    static func status(_ phase: VoiciCallCenter.Phase) -> String {
        switch phase {
        case .ringing: return String(localized: "voi.ci call")
        case .needsUnlock: return String(localized: "Unlock Flagship to answer")
        case .connecting: return String(localized: "Connecting…")
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
