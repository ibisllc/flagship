#if os(iOS)
import AVFoundation
import AVKit
import SwiftUI
import UIKit
#if canImport(WebRTC) && canImport(FlagshipTurn)
import WebRTC
#endif

/// What one in-call screen shows, from either side of the call (answered here, or placed from the app).
struct VoiciCallStageState {
    var name: String
    var status: String
    /// When the call connected: the timer runs from it.
    var connectedSince: Date?
    var muted: Bool
    var cameraOn: Bool
    var cameraFront: Bool
    var remoteCameraOn: Bool
    var remoteCameraPaused: Bool
    /// The call negotiated video, so the camera can be turned on.
    var offersVideo: Bool
    var over: Bool
    var media: CallMediaEngine?
}

struct VoiciCallStageActions {
    var toggleMute: () -> Void
    var toggleCamera: () -> Void
    var flipCamera: () -> Void
    var hangUp: () -> Void
    var close: () -> Void
}

/// The in-call screen (docs/voici-calls.md "Call screen"), after the conventions of the leading phone apps: the other
/// person large on a dark background with the status or timer under their name; one row of round controls (audio
/// route, mute, camera, flip) above a red end button; in video, their picture fills the screen and ours floats in a
/// corner (drag it to another corner); a tap hides or shows the controls.
struct VoiciCallStage: View {
    var state: VoiciCallStageState
    var actions: VoiciCallStageActions
    @State private var controlsHidden = false
    @State private var corner: Corner = .topTrailing
    /// Where our tile sits while only our camera runs: low, beside the controls, so it never covers the name.
    @State private var selfCorner: Corner = .bottomTrailing
    @State private var drag: CGSize = .zero

    enum Corner { case topLeading, topTrailing, bottomLeading, bottomTrailing }

    private var showsRemoteVideo: Bool { state.remoteCameraOn && remoteTrackAvailable }
    private var videoMode: Bool { showsRemoteVideo || state.cameraOn }

    var body: some View {
        GeometryReader { geo in
            ZStack {
                background
                if showsRemoteVideo { remoteVideo.ignoresSafeArea() }
                if videoMode {
                    LinearGradient(colors: [.black.opacity(0.55), .clear, .clear, .black.opacity(0.6)], startPoint: .top, endPoint: .bottom)
                        .ignoresSafeArea()
                        .opacity(controlsHidden ? 0 : 1)
                        .allowsHitTesting(false)
                }
                VStack(spacing: 0) {
                    header(compact: showsRemoteVideo)
                        .padding(.top, showsRemoteVideo ? 8 : geo.size.height * 0.1)
                    Spacer(minLength: 16)
                    controls
                        .padding(.bottom, 24)
                }
                .padding(.horizontal, 24)
                .opacity(controlsHidden && videoMode ? 0 : 1)
                if state.cameraOn { localPreview(in: geo.size) }
            }
            .contentShape(Rectangle())
            .onTapGesture {
                guard videoMode, !state.over else { return }
                withAnimation(.easeInOut(duration: 0.2)) { controlsHidden.toggle() }
            }
        }
        .preferredColorScheme(.dark)
        .onAppear { updateProximity() }
        .onChange(of: videoMode) { _, _ in
            if !videoMode { controlsHidden = false }
            updateProximity()
        }
        .onChange(of: state.over) { _, _ in updateProximity() }
        .onDisappear { UIDevice.current.isProximityMonitoringEnabled = false }
    }

    /// The screen goes dark against the ear in an audio-only call.
    private func updateProximity() {
        UIDevice.current.isProximityMonitoringEnabled = !videoMode && !state.over && state.connectedSince != nil
    }

    private var background: some View {
        LinearGradient(colors: [Color(red: 0.11, green: 0.13, blue: 0.19), Color(red: 0.03, green: 0.04, blue: 0.07)],
                       startPoint: .top, endPoint: .bottom)
            .ignoresSafeArea()
    }

    @ViewBuilder private func header(compact: Bool) -> some View {
        VStack(spacing: compact ? 4 : 12) {
            if !compact { avatar(size: 112) }
            Text(verbatim: state.name)
                .font(compact ? .title3.weight(.semibold) : .largeTitle.weight(.semibold))
                .foregroundStyle(.white)
                .lineLimit(2)
                .multilineTextAlignment(.center)
                .minimumScaleFactor(0.7)
            statusLine
                .font(compact ? .subheadline : .title3)
                .foregroundStyle(.white.opacity(0.75))
                .multilineTextAlignment(.center)
            if !compact {
                Label("End-to-end encrypted · quantum-safe", systemImage: "lock.fill")
                    .font(.footnote)
                    .foregroundStyle(.white.opacity(0.55))
                    .padding(.top, 4)
            }
            if state.remoteCameraPaused {
                Label("Camera paused", systemImage: "video.slash.fill").font(.footnote).foregroundStyle(.white.opacity(0.75))
            }
        }
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder private var statusLine: some View {
        if let since = state.connectedSince, !state.over {
            TimelineView(.periodic(from: since, by: 1)) { ctx in
                Text(verbatim: Self.elapsed(from: since, to: ctx.date)).monospacedDigit()
            }
        } else {
            Text(verbatim: state.status)
        }
    }

    /// m:ss, or h:mm:ss after an hour, with the locale's digits.
    static func elapsed(from: Date, to: Date) -> String {
        let s = max(0, Int(to.timeIntervalSince(from)))
        let f = DateComponentsFormatter()
        f.unitsStyle = .positional
        f.zeroFormattingBehavior = .pad
        f.allowedUnits = s >= 3600 ? [.hour, .minute, .second] : [.minute, .second]
        let out = f.string(from: TimeInterval(s)) ?? ""
        return s < 600 && out.count > 1 && out.first.map({ !$0.isLetter && $0.wholeNumberValue == 0 }) == true ? String(out.dropFirst()) : out
    }

    private func avatar(size: CGFloat) -> some View {
        CallStageAvatar(name: state.name, size: size)
    }

    @ViewBuilder private var controls: some View {
        if state.over {
            CallRoundButton(symbol: "xmark", title: String(localized: "Close"), style: .plain, action: actions.close)
                .accessibilityIdentifier("voici-call-close")
        } else {
            VStack(spacing: 28) {
                HStack(alignment: .top, spacing: 0) {
                    AudioRouteButton().frame(maxWidth: .infinity)
                    CallRoundButton(symbol: state.muted ? "mic.slash.fill" : "mic.fill",
                                    title: state.muted ? String(localized: "Unmute") : String(localized: "Mute"),
                                    style: state.muted ? .selected : .plain, action: actions.toggleMute)
                        .accessibilityIdentifier("voici-call-mute")
                        .frame(maxWidth: .infinity)
                    if state.offersVideo {
                        CallRoundButton(symbol: state.cameraOn ? "video.fill" : "video.slash.fill",
                                        title: state.cameraOn ? String(localized: "Camera off") : String(localized: "Camera"),
                                        style: state.cameraOn ? .selected : .plain, action: actions.toggleCamera)
                            .accessibilityIdentifier("voici-call-camera")
                            .frame(maxWidth: .infinity)
                    }
                    if state.cameraOn {
                        CallRoundButton(symbol: "arrow.triangle.2.circlepath.camera", title: String(localized: "Flip"),
                                        style: .plain, action: actions.flipCamera)
                            .accessibilityIdentifier("voici-call-flip")
                            .frame(maxWidth: .infinity)
                    }
                }
                CallRoundButton(symbol: "phone.down.fill", title: String(localized: "End"), style: .end, action: actions.hangUp)
                    .accessibilityIdentifier("voici-call-end")
            }
        }
    }

    // MARK: video

    private var remoteTrackAvailable: Bool {
        #if canImport(WebRTC) && canImport(FlagshipTurn)
        return (state.media as? WebRTCCallMediaEngine)?.remoteVideo != nil
        #else
        return false
        #endif
    }

    @ViewBuilder private var remoteVideo: some View {
        #if canImport(WebRTC) && canImport(FlagshipTurn)
        if let track = (state.media as? WebRTCCallMediaEngine)?.remoteVideo {
            RemoteVideoView(track: track).accessibilityLabel(Text("Their camera"))
        }
        #endif
    }

    @ViewBuilder private func localPreview(in size: CGSize) -> some View {
        let w: CGFloat = 104
        let h = w * 16 / 9
        let pad: CGFloat = 16
        let at = showsRemoteVideo ? corner : selfCorner
        let x = (at == .topLeading || at == .bottomLeading) ? pad + w / 2 : size.width - pad - w / 2
        let topY = 96 + h / 2
        // Clear of the controls (a row of round buttons over End, about 240 pt with their labels).
        let y = (at == .topLeading || at == .topTrailing) ? topY : size.height - 256 - h / 2
        localVideo
            .frame(width: w, height: h)
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(.white.opacity(0.25), lineWidth: 1))
            .shadow(radius: 8)
            .position(x: x + drag.width, y: y + drag.height)
            .gesture(DragGesture()
                .onChanged { drag = $0.translation }
                .onEnded { v in
                    let end = CGPoint(x: x + v.predictedEndTranslation.width, y: y + v.predictedEndTranslation.height)
                    let left = end.x < size.width / 2
                    let top = end.y < size.height / 2
                    withAnimation(.spring(response: 0.35, dampingFraction: 0.8)) {
                        let picked: Corner = top ? (left ? .topLeading : .topTrailing) : (left ? .bottomLeading : .bottomTrailing)
                        if showsRemoteVideo { corner = picked } else { selfCorner = picked }
                        drag = .zero
                    }
                })
            .accessibilityLabel(Text("Your camera"))
    }

    @ViewBuilder private var localVideo: some View {
        #if canImport(WebRTC) && canImport(FlagshipTurn)
        if let session = (state.media as? WebRTCCallMediaEngine)?.localCaptureSession {
            LocalPreviewView(session: session)
        } else {
            Color.black
        }
        #else
        Color.black
        #endif
    }
}

/// The other person's initial in a large circle, the same on the ringing and the in-call screens.
struct CallStageAvatar: View {
    var name: String
    var size: CGFloat

    var body: some View {
        let initial = name.trimmingCharacters(in: .whitespaces).first.map { String($0).uppercased() } ?? "?"
        ZStack {
            Circle().fill(LinearGradient(colors: [Color(white: 0.45), Color(white: 0.28)], startPoint: .top, endPoint: .bottom))
            Text(verbatim: initial).font(FS.font.glyph(size * 0.42, weight: .medium)).foregroundStyle(.white)
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

/// One round control with its label under it.
struct CallRoundButton: View {
    enum Style { case plain, selected, end, answer }
    var symbol: String
    var title: String
    var style: Style
    var action: () -> Void
    @ScaledMetric(relativeTo: .body) private var size: CGFloat = 68

    var body: some View {
        Button(action: action) {
            VStack(spacing: 8) {
                Image(systemName: symbol)
                    .font(FS.font.glyph(size * 0.36, weight: .medium))
                    .frame(width: size, height: size)
                    .foregroundStyle(style == .selected ? Color.black : Color.white)
                    .background(Circle().fill(fill))
                Text(verbatim: title)
                    .font(.footnote)
                    .foregroundStyle(.white)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text(verbatim: title))
    }

    private var fill: AnyShapeStyle {
        switch style {
        case .plain: AnyShapeStyle(.ultraThinMaterial)
        case .selected: AnyShapeStyle(Color.white)
        case .end: AnyShapeStyle(Color.red)
        case .answer: AnyShapeStyle(Color.green)
        }
    }
}

/// The audio route control (iPhone, Speaker, AirPods and other Bluetooth): the system's own route menu.
struct AudioRouteButton: View {
    @ScaledMetric(relativeTo: .body) private var size: CGFloat = 68

    var body: some View {
        VStack(spacing: 8) {
            ZStack {
                Circle().fill(.ultraThinMaterial)
                Image(systemName: "speaker.wave.2.fill").font(FS.font.glyph(size * 0.36, weight: .medium)).foregroundStyle(.white)
                RoutePicker().frame(width: size, height: size).opacity(0.02)
            }
            .frame(width: size, height: size)
            Text("Audio").font(.footnote).foregroundStyle(.white).lineLimit(1)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(Text("Audio"))
        .accessibilityIdentifier("voici-call-audio-route")
    }

    private struct RoutePicker: UIViewRepresentable {
        func makeUIView(context: Context) -> AVRoutePickerView {
            let v = AVRoutePickerView()
            v.prioritizesVideoDevices = false
            return v
        }
        func updateUIView(_ uiView: AVRoutePickerView, context: Context) {}
    }
}

#if canImport(WebRTC) && canImport(FlagshipTurn)
/// The other side's camera, filling the screen.
private struct RemoteVideoView: UIViewRepresentable {
    let track: RTCVideoTrack

    func makeUIView(context: Context) -> RTCMTLVideoView {
        let v = RTCMTLVideoView(frame: .zero)
        v.videoContentMode = .scaleAspectFill
        v.backgroundColor = .black
        track.add(v)
        context.coordinator.attached = v
        return v
    }

    func updateUIView(_ uiView: RTCMTLVideoView, context: Context) {}

    static func dismantleUIView(_ uiView: RTCMTLVideoView, coordinator: Coordinator) {
        coordinator.track.remove(uiView)
    }

    func makeCoordinator() -> Coordinator { Coordinator(track: track) }

    final class Coordinator {
        let track: RTCVideoTrack
        weak var attached: RTCMTLVideoView?
        init(track: RTCVideoTrack) { self.track = track }
    }
}

/// Our own camera, small (the preview layer mirrors the front camera by itself).
private struct LocalPreviewView: UIViewRepresentable {
    let session: AVCaptureSession

    func makeUIView(context: Context) -> RTCCameraPreviewView {
        let v = RTCCameraPreviewView(frame: .zero)
        v.captureSession = session
        v.backgroundColor = .black
        return v
    }

    func updateUIView(_ uiView: RTCCameraPreviewView, context: Context) {
        if uiView.captureSession !== session { uiView.captureSession = session }
    }
}
#endif
#endif
