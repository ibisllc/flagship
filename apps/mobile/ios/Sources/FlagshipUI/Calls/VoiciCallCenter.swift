#if os(iOS)
import Foundation
import AVFoundation
import CallKit
import PushKit
import StoreKit
import Observation
import Flagship
import FlagshipAPI
import FlagshipCore

/// Rings and runs voi.ci calls on this iPhone or iPad (docs/voici-calls.md §4, §8; voici-calls-v2.md §1.4).
///
/// Everywhere but the China mainland storefront: a PushKit VoIP token goes to `.com`
/// (`POST /api/accounts/<u>/voici-voip-token`), every VoIP push is reported to CallKit at once (Apple requires it, even
/// for a call that already ended), and CallKit's Answer / End drive the room. In the China mainland storefront CallKit
/// is not allowed (owner decision D4): no VoIP token is registered (an old one is removed), `.com` then sends the
/// plain `voici-call` alert push, and the open app rings on its own screen (`VoiciCallScreen`). Calls there work only
/// while the app is open.
///
/// Calls start as audio. The camera is asked for only on the Camera tap, and it pauses ("Camera paused" for the caller)
/// whenever the app leaves the foreground. CallKit's `hasVideo` follows either side's camera.
@MainActor
@Observable
public final class VoiciCallCenter: NSObject {
    public static let shared = VoiciCallCenter()

    public enum Phase: Equatable { case idle, ringing, needsUnlock, connecting, connected, ended(String) }

    public private(set) var phase: Phase = .idle
    public private(set) var callerName = ""
    public private(set) var offersVideo = false
    public private(set) var muted = false
    public private(set) var cameraOn = false
    /// The caller's camera: "on", "off" or "paused".
    public private(set) var remoteCamera = "off"
    /// No CallKit here (the China mainland storefront): calls ring only on the open app's screen.
    public private(set) var noRingMode = false

    /// This device's Do Not Disturb hours (Settings → Messages → Calls); read when a call arrives.
    @ObservationIgnored public var quietHours: () -> CallQuietHours = { CallSettingsStore.quietHours() }
    @ObservationIgnored public var clock: () -> Date = { Date() }

    /// A call that arrives now rings here only outside this device's Do Not Disturb hours. A quiet device stays out of
    /// the room, so another device can answer and an unanswered call becomes a missed call.
    func shouldRing(issuedAt: Int64) -> Bool {
        let now = clock()
        let ms = Int64(now.timeIntervalSince1970 * 1000)
        return ms - issuedAt <= VoiciCalls.ringMs && !quietHours().isQuiet(at: now)
    }

    /// The WebRTC implementation: our libwebrtc build when the app was built with it (CallMediaFactory), else the stub.
    @ObservationIgnored public var mediaFactory: () -> CallMediaEngine = { CallMediaFactory.make() }

    @ObservationIgnored private var registry: PKPushRegistry?
    @ObservationIgnored private var provider: CXProvider?
    @ObservationIgnored private let callController = CXCallController()
    @ObservationIgnored private var session: VoiciCallSession?
    @ObservationIgnored private var media: CallMediaEngine?
    @ObservationIgnored private var push: VoiciCallPush?
    @ObservationIgnored private var callUUID: UUID?
    @ObservationIgnored private var pausedByBackground = false
    @ObservationIgnored private var lastToken: String?
    @ObservationIgnored private var observer: NSObjectProtocol?

    static let noRingKey = "flagship.voici.calls.noRing"

    // MARK: start

    /// Called once at launch: decides the ringing mode and registers for VoIP pushes where CallKit is allowed.
    public func start() {
        noRingMode = UserDefaults.standard.bool(forKey: Self.noRingKey)
        observer = NotificationCenter.default.addObserver(forName: VoiciCallEvents.name, object: nil, queue: .main) { [weak self] n in
            guard let call = VoiciCallEvents.call(from: n) else { return }
            Task { @MainActor in self?.ringInApp(call) }
        }
        if !noRingMode { startCallKit() }
        Task { await refreshStorefront() }
    }

    /// China mainland storefront (`CHN`): no CallKit. Remembered, so a cold VoIP launch knows before StoreKit answers.
    private func refreshStorefront() async {
        guard let code = await Storefront.current?.countryCode else { return }
        let china = code == "CHN"
        guard china != noRingMode else { return }
        noRingMode = china
        UserDefaults.standard.set(china, forKey: Self.noRingKey)
        if china {
            registry?.desiredPushTypes = []
            registry = nil
            provider?.invalidate()
            provider = nil
            await sendToken(nil)
        } else {
            startCallKit()
        }
    }

    private func startCallKit() {
        if provider == nil {
            let cfg = CXProviderConfiguration()
            cfg.supportsVideo = true
            cfg.maximumCallGroups = 1
            cfg.maximumCallsPerCallGroup = 1
            cfg.supportedHandleTypes = [.generic]
            // A visitor's call names a pseudonym only; keep it out of the phone's Recents.
            cfg.includesCallsInRecents = false
            let p = CXProvider(configuration: cfg)
            p.setDelegate(self, queue: .main)
            provider = p
        }
        if registry == nil {
            let r = PKPushRegistry(queue: .main)
            r.delegate = self
            r.desiredPushTypes = [.voIP]
            registry = r
        }
    }

    /// The account changed or unlocked: send the current VoIP token again.
    public func accountChanged() {
        guard !noRingMode, let t = lastToken else { return }
        Task { await sendToken(t) }
    }

    private func sendToken(_ token: String?) async {
        guard let keys = await MessagesStore.shared.callKeys() else { return }
        let path = "/api/accounts/\(VoiciComPaths.seg(keys.username))/voici-voip-token"
        guard let url = URL(string: Endpoints.controlBaseUrl.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + path),
              let headers = keys.deviceHeaders(method: "POST", path: path) else { return }
        var req = URLRequest(url: url, timeoutInterval: 20)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        for (k, v) in headers { req.setValue(v, forHTTPHeaderField: k) }
        req.httpBody = Data(((try? CanonicalJson.canonicalJson(.object(["token": token.map { .string($0) } ?? .null]))) ?? "{}").utf8)
        _ = try? await VoiciCallNetwork.session.gatedData(for: req)
    }

    // MARK: ringing

    /// A VoIP push (CallKit) or an alert push reaching the open app (no CallKit).
    private func incoming(_ call: VoiciCallPush) async {
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        guard session == nil, push == nil, now - call.issuedAt <= VoiciCalls.ringMs else { return }
        push = call
        callerName = String(localized: "Someone on voi.ci")
        offersVideo = false
        remoteCamera = "off"
        phase = .ringing
        if let keys = await MessagesStore.shared.callKeys() {
            join(call, keys)
        } else if let locked = await lockedKeys() {
            // "Answer calls while Flagship is locked" is on: the call key answers; the caller stays "Someone on voi.ci".
            join(call, locked)
        } else {
            phase = .needsUnlock
        }
    }

    private func join(_ call: VoiciCallPush, _ keys: VoiciCallKeys) {
        if let who = keys.openPush(call) {
            callerName = keys.nicknames[who.from] ?? MessagesStore.shared.name(pseudonymPub: who.from)
            updateCallKit()
        }
        let m = mediaFactory()
        media = m
        let s = VoiciCallSession(push: call, keys: keys, media: m) { [weak self] e in self?.onSession(e) }
        session = s
        s.connect()
    }

    /// The call key of this device's account, while the setting is on (it was made and bound on an unlocked device).
    private func lockedKeys() async -> VoiciCallKeys? {
        guard let k = VoiciCallKeyStore.currentAccountKey else { return nil }
        let ca = await MessagesStore.shared.client?.caKeys() ?? []
        return VoiciCallKeys.locked(k, caKeys: ca, origin: Endpoints.voiciOrigin)
    }

    /// The account was unlocked while a call rings: join the room now.
    public func unlocked() {
        guard phase == .needsUnlock, let call = push else { return }
        Task {
            guard let keys = await MessagesStore.shared.callKeys() else { return }
            phase = .ringing
            join(call, keys)
        }
    }

    private func ringInApp(_ call: VoiciCallPush) {
        guard noRingMode, shouldRing(issuedAt: call.issuedAt) else { return }
        Task { await incoming(call) }
    }

    private func updateCallKit() {
        guard let id = callUUID, let provider else { return }
        let u = CXCallUpdate()
        u.localizedCallerName = callerName
        u.hasVideo = cameraOn || remoteCamera == "on"
        u.supportsDTMF = false
        u.supportsHolding = false
        u.supportsGrouping = false
        u.supportsUngrouping = false
        provider.reportCall(with: id, updated: u)
    }

    // MARK: actions

    private func cameraAble() -> Bool { AVCaptureDevice.default(for: .video) != nil }

    /// Answer (CallKit's action or the in-app button). Returns false when it can't be answered here.
    @discardableResult
    func answerNow() async -> Bool {
        guard phase == .ringing, let s = session else { return false }
        phase = .connecting
        if let code = await s.answer(cameraAble: cameraAble()) {
            s.leave()
            finish(code)
            return false
        }
        return true
    }

    public func answerInApp() {
        if let id = callUUID, provider != nil {
            callController.request(CXTransaction(action: CXAnswerCallAction(call: id))) { _ in }
        } else {
            Task { await answerNow() }
        }
    }

    public func declineOrHangUp() {
        if let id = callUUID, provider != nil {
            callController.request(CXTransaction(action: CXEndCallAction(call: id))) { _ in }
        } else {
            endNow()
        }
    }

    private func endNow() {
        guard let s = session else { return finish("hangup") }
        switch phase {
        case .ringing, .needsUnlock: s.decline()
        default: s.hangUp()
        }
    }

    public func setMuted(_ m: Bool) {
        media?.setMuted(m)
        muted = m
    }

    /// The Camera tap. Asks for the camera now (never earlier); false when it can't start.
    public func setCamera(_ on: Bool) async -> Bool {
        guard offersVideo, phase == .connecting || phase == .connected else { return false }
        if on {
            let ok = await AVCaptureDevice.requestAccess(for: .video)
            guard ok else { return false }
        }
        guard media?.setCamera(on) == true else { return false }
        pausedByBackground = false
        cameraOn = on
        session?.sendCamera(on ? "on" : "off")
        updateCallKit()
        return true
    }

    /// The app left the foreground: pause our camera (voici-calls-v2.md §1.4); audio carries on.
    public func appBackgrounded() {
        guard cameraOn else { return }
        _ = media?.setCamera(false)
        cameraOn = false
        pausedByBackground = true
        session?.sendCamera("paused")
        updateCallKit()
    }

    public func appForegrounded() {
        guard pausedByBackground else { return }
        pausedByBackground = false
        if media?.setCamera(true) == true {
            cameraOn = true
            session?.sendCamera("on")
            updateCallKit()
        }
    }

    public func dismissEnded() {
        if case .ended = phase { phase = .idle }
    }

    private func onSession(_ e: VoiciCallSession.Event) {
        switch e {
        case .request(let r): offersVideo = r.hasVideo
        case .won: phase = .connecting
        case .connected:
            phase = .connected
            if let id = callUUID { provider?.reportOutgoingCall(with: id, connectedAt: nil) }
        case .remoteCamera(let s):
            remoteCamera = s
            updateCallKit()
        case .ended(let reason): finish(reason)
        }
    }

    private func finish(_ code: String) {
        if let id = callUUID, let provider {
            let reason: CXCallEndedReason = switch code {
            case "answered-elsewhere": .answeredElsewhere
            case "decline": .declinedElsewhere
            case "no-answer", "cancel": .unanswered
            case "hangup", "limit": .remoteEnded
            default: .failed
            }
            if code != "hangup" || phase != .connected { provider.reportCall(with: id, endedAt: nil, reason: reason) }
        }
        callUUID = nil
        session = nil
        media = nil
        push = nil
        cameraOn = false
        pausedByBackground = false
        phase = .ended(code)
    }
}

// MARK: PushKit

extension VoiciCallCenter: PKPushRegistryDelegate {
    nonisolated public func pushRegistry(_ registry: PKPushRegistry, didUpdate credentials: PKPushCredentials, for type: PKPushType) {
        let hex = credentials.token.map { String(format: "%02x", $0) }.joined()
        Task { @MainActor in
            self.lastToken = hex
            await self.sendToken(hex)
        }
    }

    nonisolated public func pushRegistry(_ registry: PKPushRegistry, didInvalidatePushTokenFor type: PKPushType) {
        Task { @MainActor in
            self.lastToken = nil
            await self.sendToken(nil)
        }
    }

    /// Apple ends an app that doesn't report a VoIP push to CallKit before `completion`: report first, always.
    nonisolated public func pushRegistry(_ registry: PKPushRegistry, didReceiveIncomingPushWith payload: PKPushPayload, for type: PKPushType,
                                         completion: @escaping () -> Void) {
        let info = payload.dictionaryPayload
        MainActor.assumeIsolated {
            let id = UUID()
            let call = PushNotifications.voiciCall(info)
            let u = CXCallUpdate()
            u.remoteHandle = CXHandle(type: .generic, value: "voi.ci")
            u.localizedCallerName = String(localized: "Someone on voi.ci")
            u.hasVideo = false
            u.supportsHolding = false
            u.supportsDTMF = false
            let busy = self.session != nil || self.push != nil
            guard let provider = self.provider else { return completion() }
            provider.reportNewIncomingCall(with: id, update: u) { error in
                Task { @MainActor in
                    guard error == nil, let call, !busy, self.shouldRing(issuedAt: call.issuedAt) else {
                        // A malformed, late or second call, or Do Not Disturb here: reported (Apple requires it), then
                        // ended at once.
                        provider.reportCall(with: id, endedAt: nil, reason: call == nil || busy ? .failed : .unanswered)
                        return completion()
                    }
                    self.callUUID = id
                    await self.incoming(call)
                    completion()
                }
            }
        }
    }
}

// MARK: CallKit

extension VoiciCallCenter: CXProviderDelegate {
    nonisolated public func providerDidReset(_ provider: CXProvider) {
        Task { @MainActor in self.endNow() }
    }

    nonisolated public func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) {
        Task { @MainActor in
            if await self.answerNow() { action.fulfill() } else { action.fail() }
        }
    }

    nonisolated public func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
        Task { @MainActor in
            self.endNow()
            action.fulfill()
        }
    }

    nonisolated public func provider(_ provider: CXProvider, perform action: CXSetMutedCallAction) {
        Task { @MainActor in
            self.setMuted(action.isMuted)
            action.fulfill()
        }
    }
    /// CallKit owns the audio session: WebRTC's audio starts only once CallKit activates it, and stops with it.
    nonisolated public func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
        CallMediaFactory.audioSessionDidActivate(audioSession)
    }

    nonisolated public func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {
        CallMediaFactory.audioSessionDidDeactivate(audioSession)
    }
}
#endif
