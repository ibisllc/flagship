#if DEBUG
#if os(iOS)
import SwiftUI

/// Gym-only: the call screen drawn over the app with made-up state, for screenshots (no call, no media engine).
///
///   -smoke-call-stage connecting|connected|camera|ended|ringing|outgoing
public struct GymCallStagePreview: View {
    public static var requested: String? { GymSweepSeams.value(ProcessInfo.processInfo.arguments, "-smoke-call-stage") }

    private let kind: String
    @State private var since = Date().addingTimeInterval(-272)

    public init() { kind = Self.requested ?? "connected" }

    public var body: some View {
        if kind == "ringing" {
            VoiciRingingStage(name: "Anna Lindqvist", status: VoiciCallScreenModel.status(.ringing), canAnswer: true,
                              decline: {}, answer: {})
        } else {
            VoiciCallStage(state: state, actions: VoiciCallStageActions(toggleMute: {}, toggleCamera: {}, flipCamera: {}, hangUp: {}, close: {}))
        }
    }

    private var state: VoiciCallStageState {
        let name = kind == "outgoing" ? "voi.ci/river-otter" : "Anna Lindqvist"
        switch kind {
        case "connecting", "outgoing":
            return VoiciCallStageState(name: name, status: VoiciCallScreenModel.status(.connecting, step: .path), connectedSince: nil,
                                       muted: false, cameraOn: false, cameraFront: true, remoteCameraOn: false, remoteCameraPaused: false,
                                       offersVideo: true, over: false, media: nil)
        case "camera":
            return VoiciCallStageState(name: name, status: "", connectedSince: since, muted: true, cameraOn: true, cameraFront: true,
                                       remoteCameraOn: false, remoteCameraPaused: false, offersVideo: true, over: false, media: nil)
        case "ended":
            return VoiciCallStageState(name: name, status: VoiciCallScreenModel.status(.ended("")), connectedSince: since,
                                       muted: false, cameraOn: false, cameraFront: true, remoteCameraOn: false, remoteCameraPaused: false,
                                       offersVideo: false, over: true, media: nil)
        default:
            return VoiciCallStageState(name: name, status: "", connectedSince: since, muted: false, cameraOn: false, cameraFront: true,
                                       remoteCameraOn: false, remoteCameraPaused: false, offersVideo: true, over: false, media: nil)
        }
    }
}
#endif
#endif
