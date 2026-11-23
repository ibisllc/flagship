#if os(iOS)
import Foundation
import AVFoundation
import UIKit
import CallKit
import PushKit
import StoreKit
import Observation
import Flagship
import FlagshipAPI
import FlagshipCore

/// Rings and runs voi.ci calls on this iPhone or iPad (docs/voici-calls.md §4, §8; voici-calls-v2.md §1.4).
///
/// CallKit and PushKit run only once this device's App Store storefront is known and is not the China mainland
/// (`callKitMode`, MIIT via App Review 5): until then no CXProvider, CXCallController or PushKit registry exists.
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
    /// Whether our running camera is the front one (the preview is mirrored).
    public private(set) var cameraFront = true
    /// The caller's camera: "on", "off" or "paused".
    public private(set) var remoteCamera = "off"
    /// No CallKit here (the China mainland storefront): calls ring only on the open app's screen.
    public private(set) var noRingMode = false
    /// While connecting: the step under way, and whether it has run longer than usual (VoiciCallConnectSteps).
    public private(set) var connectStep: VoiciCallConnectStep?
    public private(set) var connectSlow = false
    @ObservationIgnored private var steps = VoiciCallConnectSteps()
    @ObservationIgnored private var slowTask: Task<Void, Never>?
    @ObservationIgnored private var limitTask: Task<Void, Never>?
    @ObservationIgnored private var gaveUp = false

    @ObservationIgnored public var clock: () -> Date = { Date() }
    /// The owner's synced call hours, this device's copy.
    @ObservationIgnored public var ownerHours: () -> VoiciCallSettingsValue? = { CallSettingsStore.ownerHours() }

    /// A call that arrives now rings here only while fresh and inside the owner's business hours (synced, sealed;
    /// docs/voici-calls.md, option c): outside them no device rings, and the call ends as a missed call. The phone's own
    /// Do Not Disturb and Focus are CallKit's: the call is reported normally and iOS decides whether it makes a sound.
    func shouldRing(issuedAt: Int64) -> Bool {
        let ms = Int64(clock().timeIntervalSince1970 * 1000)
        return ms - issuedAt <= VoiciCalls.ringMs && VoiciCallSettingsSync.allows(ownerHours()?.hours, now: ms)
    }

    /// The WebRTC implementation: our libwebrtc build when the app was built with it (CallMediaFactory), else the stub.
    @ObservationIgnored public var mediaFactory: () -> CallMediaEngine = { CallMediaFactory.make() }

    /// This device holds its bare name for the call in progress (PhoneRouteController.callStarted).
    @ObservationIgnored private var holdsRoute = false
    @ObservationIgnored private var registry: PKPushRegistry?
    @ObservationIgnored private var provider: CXProvider?
    @ObservationIgnored private var callController: CXCallController?
    @ObservationIgnored private var mode: CallKitMode = .unknown
    @ObservationIgnored private var storefrontWatch: Task<Void, Never>?
    @ObservationIgnored private var storefrontRetry: Task<Void, Never>?
    /// The `.com` client for a call that arrives before the UI configured Messages (a VoIP push that launched the app).
    @ObservationIgnored public var fallbackClient: (any VoiciComClient)?
    /// Whether the app shows no lock screen, so "Unlock to answer" may ask Face ID for the account keys itself (set by
    /// the app). A locked app's lock screen does the unlock, which reaches the call through `unlocked()`.
    @ObservationIgnored public var mayAskForKeys: () -> Bool = { false }
    @ObservationIgnored private var openingKeys = false
    /// "Unlock to answer" (CallKit's Answer, or the in-app button, on a call that needs the account keys): the call that
    /// the next unlock answers, after the unlocked session's full request check. A call that ends first is never answered.
    @ObservationIgnored private var answerAfterUnlock: String?
    /// Waiting for that unlock: the in-app ringing screen steps aside for the lock screen.
    public private(set) var unlockPending = false
    @ObservationIgnored private var joiningAfterUnlock = false
    @ObservationIgnored private var unlockWindow: Task<Void, Never>?
    @ObservationIgnored private var session: VoiciCallSession?
    @ObservationIgnored private var media: CallMediaEngine?
    /// The call's media engine, for the call screen's video views.
    public var mediaEngine: CallMediaEngine? { media }
    @ObservationIgnored private var push: VoiciCallPush?
    @ObservationIgnored private var callUUID: UUID?
    @ObservationIgnored private var pausedByBackground = false
    @ObservationIgnored private var lastToken: String?
    @ObservationIgnored private var observer: NSObjectProtocol?
    /// The caller of the ringing call, once the push opened (for this device's call list).
    /// A page owner is ringing this account back (docs/voici-calls.md "ringing a caller back"): answering makes this
    /// device dial out to that page; the pseudonymous side never hosts.
    private(set) var ringBack: VoiciOutgoingCall?
    @ObservationIgnored private var ringing: (id: UUID, hint: VoiciRingHint?)?
    /// The ring-back that rang while locked: its push (the hint is opened after the unlock), the page the locked-names
    /// table named for it, and whether Answer was pressed (then the unlock dials).
    @ObservationIgnored private var lockedRing: (push: VoiciRingPush, cached: (username: String, pageId: String)?, answered: Bool)?
    @ObservationIgnored private var incomingPeer: VoiciCallRecord.Peer?
    @ObservationIgnored private var connectedAt: Int64?
    /// When the call connected, for the call screen's timer (set with the phase change that redraws it).
    var connectedSince: Date? { connectedAt.map { Date(timeIntervalSince1970: TimeInterval($0) / 1000) } }

    static let noRingKey = "flagship.voici.calls.noRing"
    static let modeKey = "flagship.voici.calls.callKitMode"

    /// Whether CallKit may run here (App Review 5, MIIT: no CallKit in the China mainland storefront).
    enum CallKitMode: String { case allowed, china, unknown }

    /// The rule, failing closed: the live storefront decides; without one (no App Store account, offline, StoreKit not
    /// answered yet) the last storefront this device saw; without that, a device whose region is mainland China is
    /// treated as China, and any other stays `unknown`: no CallKit, calls ring in the open app, and the storefront is
    /// asked again (every minute, at each foreground and on `Storefront.updates`) until it answers.
    nonisolated static func callKitMode(storefront: String?, stored: CallKitMode?, region: String?) -> CallKitMode {
        if let storefront, !storefront.isEmpty { return storefront.uppercased() == "CHN" ? .china : .allowed }
        if let stored, stored != .unknown { return stored }
        if region?.uppercased() == "CN" { return .china }
        return .unknown
    }

    private static var storedMode: CallKitMode? {
        let d = UserDefaults.standard
        if let raw = d.string(forKey: modeKey) { return CallKitMode(rawValue: raw) }
        // Builds before the fail-closed rule kept only `noRing`, set to true in the China storefront.
        return d.bool(forKey: noRingKey) ? .china : nil
    }

    private static var region: String? { Locale.current.region?.identifier }

    // MARK: start

    /// Called once at launch: decides the ringing mode and registers for VoIP pushes where CallKit is allowed. The
    /// remembered storefront answers at once, so a cold VoIP launch outside China reaches CallKit before StoreKit does.
    public func start() {
        CallSettingsStore.forgetRemovedSettings()
        // A page's first publish turns calls on (owner decision 2026-11-16): register this phone at once, as turning
        // calls on by hand does, instead of at the next unlock.
        MessagesStore.callsTurnedOn = { [weak self] in self?.accountChanged() }
        observer = NotificationCenter.default.addObserver(forName: VoiciCallEvents.name, object: nil, queue: .main) { [weak self] n in
            guard let call = VoiciCallEvents.call(from: n) else { return }
            Task { @MainActor in self?.ringInApp(call) }
        }
        apply(Self.callKitMode(storefront: nil, stored: Self.storedMode, region: Self.region))
        Task { await refreshStorefront() }
        storefrontWatch = Task { [weak self] in
            for await sf in Storefront.updates {
                await self?.storefront(sf.countryCode)
            }
        }
    }

    private func refreshStorefront() async {
        let code = await Storefront.current?.countryCode
        await storefront(code)
    }

    private func storefront(_ code: String?) async {
        let next = Self.callKitMode(storefront: code, stored: Self.storedMode, region: Self.region)
        if code != nil, next != .unknown { UserDefaults.standard.set(next.rawValue, forKey: Self.modeKey) }
        let was = mode
        apply(next)
        if next == .china, was != .china { await sendToken(nil) }
        if next == .unknown { retryStorefrontLater() } else { storefrontRetry?.cancel(); storefrontRetry = nil }
    }

    private func retryStorefrontLater() {
        guard storefrontRetry == nil else { return }
        storefrontRetry = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 60_000_000_000)
            guard let self, !Task.isCancelled else { return }
            self.storefrontRetry = nil
            await self.refreshStorefront()
        }
    }

    private func apply(_ next: CallKitMode) {
        mode = next
        noRingMode = next != .allowed
        if next == .allowed { startCallKit() } else { stopCallKit() }
    }

    private func startCallKit() {
        guard mode == .allowed else { return }
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
        if callController == nil { callController = CXCallController() }
        if registry == nil {
            let r = PKPushRegistry(queue: .main)
            r.delegate = self
            r.desiredPushTypes = [.voIP]
            registry = r
        }
    }

    private func stopCallKit() {
        registry?.desiredPushTypes = []
        registry = nil
        provider?.invalidate()
        provider = nil
        callController = nil
        lastToken = nil
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
        guard session == nil, push == nil, now - call.issuedAt <= VoiciCalls.ringMs else {
            voiciCallLog.notice("call not taken: \(self.session != nil || self.push != nil ? "busy" : "late", privacy: .public)")
            return
        }
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
            voiciCallLog.notice("call waits: needs-unlock")
            phase = .needsUnlock
            endAfterRingWindow(call)
            // CallKit's Answer came while this call's keys were looked up (a cold VoIP launch): unlock, then answer.
            if answerAfterUnlock == call.callId { unlockToAnswer() }
            // The account may have been unlocked while this call's keys were looked up.
            unlocked()
        }
    }

    /// A call waiting for the unlock ends with its ring window: nothing else would end it, since no room socket is open.
    private func endAfterRingWindow(_ call: VoiciCallPush) {
        unlockWindow?.cancel()
        let left = max(0, call.issuedAt + VoiciCalls.ringMs - Int64(clock().timeIntervalSince1970 * 1000))
        unlockWindow = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(left) * 1_000_000)
            guard let self, !Task.isCancelled, self.phase == .needsUnlock, self.session == nil, self.push?.callId == call.callId else { return }
            voiciCallLog.notice("call ended: not unlocked in the ring window")
            self.finish("no-answer")
        }
    }

    private func join(_ call: VoiciCallPush, _ keys: VoiciCallKeys) {
        if let who = keys.openPush(call) {
            incomingPeer = .visitor(conv: who.conv, pseudonymPub: who.from)
            callerName = keys.nicknames[who.from] ?? MessagesStore.shared.name(pseudonymPub: who.from)
            updateCallKit()
        }
        let m = mediaFactory()
        media = m
        // The caller's media arrives only through this phone's bare name: hold it while the call rings and runs, even
        // with the app in the background (CallKit answers there).
        if !holdsRoute {
            holdsRoute = true
            PhoneRouteController.callStarted()
        }
        let s = VoiciCallSession(push: call, keys: keys, media: m) { [weak self] e in self?.onSession(e) }
        session = s
        s.connect()
    }

    /// The call key of this device's account, while the setting is on (it was made and bound on an unlocked device).
    private func lockedKeys() async -> VoiciCallKeys? {
        guard let k = VoiciCallKeyStore.currentAccountKey else { return nil }
        // A VoIP push may have launched the app with no screen yet: Messages isn't configured then.
        let client = MessagesStore.shared.client ?? fallbackClient
        let ca = await client?.caKeys() ?? []
        var keys = VoiciCallKeys.locked(k, caKeys: ca, origin: Endpoints.voiciOrigin)
        // A locked device keeps no copy of the page's call mode: an anonymous call is checked against the live index.
        if let client {
            keys.liveMode = { await VoiciCallModes.liveCallMode(client: client, username: k.username, pageId: k.pageId)?.mode }
        }
        PhoneRouteController.callIdentity = (k.username, k.deviceId)
        return keys
    }

    /// The account was unlocked while a call rings: join the room now. Several unlock signals can arrive together:
    /// only one joins (a second room socket would win nothing, end this device's ring and leave `.com` thinking it is
    /// on another call).
    public func unlocked() {
        ringBackAfterUnlock()
        guard phase == .needsUnlock, let call = push, !joiningAfterUnlock else { return }
        joiningAfterUnlock = true
        Task {
            defer { joiningAfterUnlock = false }
            guard let keys = await MessagesStore.shared.callKeys(),
                  phase == .needsUnlock, session == nil, push?.callId == call.callId else { return }
            unlockWindow?.cancel()
            unlockPending = false
            phase = .ringing
            join(call, keys)
            updateCallKit()
        }
    }

    /// A ring-back answered while locked: once the account is open, its hint is opened (the page the table named is
    /// tried too, so no state read is needed) and must name that same page; then this device dials out. A hint that
    /// doesn't open, or names another page, ends the ring (`ring-back-tag-mismatch`). Before the state blob is read a
    /// hint that doesn't open may still belong to a signed-in page: wait for the next unlock signal.
    private func ringBackAfterUnlock() {
        guard let locked = lockedRing, locked.answered, let r = ringing, r.hint == nil, Keystore.messagesUMKIfCached() != nil else { return }
        let hint = MessagesStore.shared.openRing(locked.push, alsoPages: locked.cached.map { [$0.pageId] } ?? [])
        if hint == nil, locked.cached == nil, !MessagesStore.shared.stateReadThisSession { return }
        guard let hint, locked.cached.map({ $0.pageId == hint.pageId && $0.username == hint.username }) ?? true else {
            voiciCallLog.notice("ring-back ended: ring-back-tag-mismatch")
            lockedRing = nil
            ringing = nil
            provider?.reportCall(with: r.id, endedAt: nil, reason: .failed)
            return
        }
        lockedRing = nil
        ringing = (r.id, hint)
        answerRing()
    }

    /// Face ID for a locked ring-back's Answer, in the foreground only (as `openKeysToAnswer`); a locked app's own lock
    /// screen reaches the ring through `unlocked()` instead.
    private func openKeysForRing() {
        guard lockedRing?.answered == true, !openingKeys, mayAskForKeys(), UIApplication.shared.applicationState == .active,
              Keystore.messagesUMKIfCached() == nil else { return }
        openingKeys = true
        Task {
            defer { openingKeys = false }
            guard (try? await Keystore.messagesUMK(reason: String(localized: "Unlock Flagship"))) != nil else { return }
            unlocked()
        }
    }

    /// "Unlock to answer" on a call that needs the account keys: the unlock that follows answers this one call.
    func unlockToAnswer() {
        guard phase == .needsUnlock, let call = push else { return }
        answerAfterUnlock = call.callId
        unlockPending = true
        updateCallKit()
        openKeysToAnswer()
    }

    /// The account keys close when the app leaves the foreground, while the app itself may stay unlocked (no app lock):
    /// then nothing else would unlock, so one Face ID opens them, in the foreground only.
    private func openKeysToAnswer() {
        guard unlockPending, phase == .needsUnlock, !openingKeys, mayAskForKeys(),
              UIApplication.shared.applicationState == .active else { return }
        openingKeys = true
        Task {
            defer { openingKeys = false }
            if Keystore.messagesUMKIfCached() == nil {
                guard (try? await Keystore.messagesUMK(reason: String(localized: "Unlock Flagship"))) != nil else { return }
            }
            unlocked()
            await MessagesStore.shared.refresh()
            unlocked()
        }
    }

    /// The unlocked session checked the call's request: answer it if "Unlock to answer" was pressed for it (camera off).
    private func maybeAnswerAfterUnlock(_ callId: String) {
        guard answerAfterUnlock == callId, phase == .ringing, session?.request?.callId == callId else { return }
        answerAfterUnlock = nil
        voiciCallLog.notice("answering after unlock")
        Task { await answerNow() }
    }

    private func ringInApp(_ call: VoiciCallPush) {
        guard noRingMode, shouldRing(issuedAt: call.issuedAt) else { return }
        Task { await incoming(call) }
    }

    private func updateCallKit() {
        guard let id = callUUID, let provider else { return }
        let u = CXCallUpdate()
        // CallKit's screen says what the owner must do while the answered call waits for Flagship to be unlocked.
        u.localizedCallerName = unlockPending ? String(localized: "Unlock Flagship to answer") : callerName
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
        startConnectClock()
        step(.route)
        // The answer sends the caller to this phone's TURN at once, and a caller's browser tries it only once.
        let holding = await PhoneRouteController.waitUntilHolding(seconds: 8)
        if !holding { voiciCallLog.notice("answering without the bare name held") }
        step(.secure)
        if let code = await s.answer(cameraAble: cameraAble()) {
            s.leave()
            finish(code)
            return false
        }
        return true
    }

    public func answerInApp() {
        if phase == .needsUnlock { return unlockToAnswer() }
        if let id = callUUID, provider != nil, let callController {
            callController.request(CXTransaction(action: CXAnswerCallAction(call: id))) { _ in }
        } else {
            Task { await answerNow() }
        }
    }

    public func declineOrHangUp() {
        if let id = callUUID, provider != nil, let callController {
            callController.request(CXTransaction(action: CXEndCallAction(call: id))) { [weak self] err in
                guard err != nil else { return }
                Task { @MainActor in self?.endNow() }
            }
            // Hang-up always works: if CallKit's end hasn't run in 3 s, end here; if the session still hasn't, drop it.
            Task { @MainActor [weak self] in
                try? await Task.sleep(nanoseconds: 3_000_000_000)
                guard let self, self.callUUID == id else { return }
                voiciCallLog.notice("hang-up: CallKit end didn't run, ending locally")
                self.endNow()
                try? await Task.sleep(nanoseconds: 2_000_000_000)
                if self.callUUID == id { self.finish("hangup") }
            }
        } else {
            endNow()
        }
    }

    private func endNow() {
        // No call: nothing to end. CallKit resets its provider when it starts (the simulator does at every launch),
        // and an idle phone must not show "Call ended" over everything.
        if phase == .idle, session == nil, callUUID == nil { return }
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

    /// Front or back camera while ours runs.
    public func flipCamera() {
        guard cameraOn else { return }
        if media?.flipCamera() == true { cameraFront.toggle() }
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
        if on && !cameraOn { cameraFront = true }
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
        if mode == .unknown { Task { await refreshStorefront() } }
        // Answered with CallKit while the keys were closed: the app came forward to be unlocked.
        if unlockPending, phase == .needsUnlock { openKeysToAnswer() }
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

    /// The caller's name from a request alone: its visitor name, or "Anonymous caller" for a browser key. Nicknames
    /// are account data and wait for the unlock.
    nonisolated static func lockedCallerName(from: String) -> String {
        let isPseudonym = from.count == 64 && from.allSatisfy { ("0"..."9").contains($0) || ("a"..."f").contains($0) }
        guard isPseudonym, let n = try? VoiciText.voiciPseudonymName(from, prefix: String(localized: "Visitor ")) else {
            return String(localized: "Anonymous caller")
        }
        return n
    }

    /// "Show names while locked": the owner's nickname for a caller they have had calls with, from the locked-names
    /// table of the account whose call key answers (docs/voici-locked-caller-names.md). Nil when off or unknown.
    static func lockedNickname(from: String, now: Int64 = Int64(Date().timeIntervalSince1970 * 1000)) -> String? {
        guard let account = VoiciCallKeyStore.currentAccountKey?.username else { return nil }
        return VoiciLockedNames.name(for: from, in: VoiciLockedNamesStore.load(username: account), account: account, now: now)
    }

    /// The name a ring-back shows: the page while the account is unlocked (the hint opened), else the page the
    /// locked-names table matched by the push's tag, else the generic line.
    nonisolated static func ringName(hint: VoiciRingHint?, cached: (username: String, pageId: String)?) -> String {
        if let hint { return "voi.ci/\(hint.username)" }
        if let cached { return String(localized: "voi.ci/\(cached.username) is calling back") }
        return String(localized: "Someone you wrote to is calling back")
    }

    private func onSession(_ e: VoiciCallSession.Event) {
        switch e {
        case .request(let r):
            offersVideo = r.hasVideo
            // A locked phone (the call key answers) can't open the push's sealed caller, but the room's signed request
            // names the caller's key for this conversation: show its visitor name instead of "Someone on voi.ci".
            if incomingPeer == nil {
                callerName = Self.lockedNickname(from: r.from) ?? Self.lockedCallerName(from: r.from)
                updateCallKit()
            }
            maybeAnswerAfterUnlock(r.callId)
        case .won:
            phase = .connecting
            step(.path)
        case .pathOpen: step(.audio)
        case .connected:
            stopConnectClock()
            phase = .connected
            connectedAt = Int64(clock().timeIntervalSince1970 * 1000)
            if let id = callUUID { provider?.reportOutgoingCall(with: id, connectedAt: nil) }
        case .remoteCamera(let s):
            remoteCamera = s
            updateCallKit()
        case .ended(let reason): finish(reason)
        }
    }

    // MARK: ringing back (this account was the caller)

    /// A ring-back VoIP push: reported to CallKit at once (Apple requires it), named after the page when this
    /// account's thread key for one of its pages opens the hint, else "Someone on voi.ci" (the account is locked).
    private func incomingRing(_ ring: VoiciRingPush, completion: @escaping () -> Void) {
        let hint = MessagesStore.shared.openRing(ring)
        // Locked: the locked-names table may name the page by the push's tag (docs/voici-locked-caller-names.md §4).
        let cached = hint == nil ? VoiciCallKeyStore.lastAccount.flatMap { u in
            VoiciLockedNames.ringPage(for: ring, in: VoiciLockedNamesStore.load(username: u), now: Int64(Date().timeIntervalSince1970 * 1000))
        } : nil
        let id = UUID()
        let u = CXCallUpdate()
        u.remoteHandle = CXHandle(type: .generic, value: "voi.ci")
        u.localizedCallerName = Self.ringName(hint: hint, cached: cached)
        u.hasVideo = hint?.media == VoiciCalls.mediaVideo
        u.supportsHolding = false
        u.supportsDTMF = false
        // No CallKit here (no registry either, so this is a late delivery from before a switch): nothing to report to.
        guard let provider else { return completion() }
        guard ringing == nil, session == nil, push == nil, hint != nil || Keystore.messagesUMKIfCached() == nil else {
            // A second ring, or a hint none of this account's pages opens: reported, then ended at once.
            voiciCallLog.notice("ring-back not taken: \(hint == nil ? "not-ours" : "busy", privacy: .public)")
            let p = provider
            p.reportNewIncomingCall(with: id, update: u) { _ in
                Task { @MainActor in p.reportCall(with: id, endedAt: nil, reason: .failed); completion() }
            }
            return
        }
        ringing = (id, hint)
        if hint == nil {
            lockedRing = (push: ring, cached: cached, answered: false)
        } else {
            lockedRing = nil
        }
        provider.reportNewIncomingCall(with: id, update: u) { error in
            Task { @MainActor in
                if error != nil { self.ringing = nil; self.lockedRing = nil }
                completion()
            }
        }
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: UInt64(VoiciRings.ttlMs) * 1_000_000)
            if let r = self.ringing, r.id == id, self.ringBack == nil {
                self.ringing = nil
                self.lockedRing = nil
                voiciCallLog.notice("ring-back ended: unanswered")
                provider.reportCall(with: id, endedAt: nil, reason: .unanswered)
            }
        }
    }

    /// Answer on a ring-back: dial out to the page that rang (in the app's engine, else through the browser).
    private func answerRing() {
        guard let r = ringing else { return }
        guard let hint = r.hint else {
            // Locked when the push came: a ring-back dials out as this account's pseudonym, which the call key can't
            // do (D5). Answer means "unlock, then call back": the hint is opened after the unlock, within the ring time.
            guard var locked = lockedRing else {
                voiciCallLog.notice("ring-back ended: locked-no-page")
                ringing = nil
                provider?.reportCall(with: r.id, endedAt: nil, reason: .failed)
                return
            }
            locked.answered = true
            lockedRing = locked
            voiciCallLog.notice("ring-back waits: needs-unlock")
            let u = CXCallUpdate()
            u.localizedCallerName = String(localized: "Unlock Flagship to call back")
            provider?.reportCall(with: r.id, updated: u)
            openKeysForRing()
            unlocked()
            return
        }
        guard let client = MessagesStore.shared.client else { return }
        // The ring came through this conversation's channel, so the call keeps it (attaching again renews it).
        let call = VoiciOutgoingCall.live(callee: VoiciCallee(username: hint.username, pageId: hint.pageId), video: hint.media == VoiciCalls.mediaVideo,
                                          allowCallBack: true, client: client)
        ringBack = call
    }

    /// The ring-back call's screen closed.
    public func ringBackDone() {
        if let r = ringing { provider?.reportCall(with: r.id, endedAt: nil, reason: .remoteEnded) }
        ringing = nil
        ringBack = nil
    }

    /// This device's record of the call it rang for: answered here, declined here, or missed. A call another device
    /// answered isn't this device's to list; a missed call is also on `.com` (merged by the list).
    static func incomingOutcome(code: String, wasConnected: Bool) -> VoiciCallRecord.Outcome? {
        if wasConnected { return .answered }
        switch code {
        case "answered-elsewhere": return nil
        case "decline": return .declined
        case "no-answer", "cancel", "hangup", "busy": return .missed
        default: return .failed
        }
    }

    // MARK: connecting steps

    private func startConnectClock() {
        steps = VoiciCallConnectSteps()
        limitTask?.cancel()
        limitTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(VoiciCallConnectSteps.limitSeconds * 1_000_000_000))
            guard let self, !Task.isCancelled, self.phase == .connecting else { return }
            voiciCallLog.notice("call gave up connecting at step \(self.connectStep?.rawValue ?? "-", privacy: .public)")
            self.giveUp()
        }
    }

    private func step(_ s: VoiciCallConnectStep) {
        guard phase == .connecting, steps.advance(to: s) else { return }
        connectStep = s
        connectSlow = false
        slowTask?.cancel()
        slowTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(VoiciCallConnectSteps.slowSeconds * 1_000_000_000))
            guard let self, !Task.isCancelled, self.connectStep == s, self.phase == .connecting else { return }
            self.connectSlow = true
        }
    }

    private func stopConnectClock() {
        slowTask?.cancel()
        limitTask?.cancel()
        slowTask = nil
        limitTask = nil
        connectStep = nil
        connectSlow = false
    }

    /// Connecting took too long: end the call for both sides, shown as "The call couldn't connect."
    private func giveUp() {
        gaveUp = true
        session?.hangUp()
        if session != nil { finish("failed") }
    }

    private func finish(_ code: String) {
        // A call that gave up connecting ends as "failed" (CallKit: failed), whatever its hang-up said.
        let code = gaveUp ? "failed" : code
        gaveUp = false
        stopConnectClock()
        voiciCallLog.notice("call ended: \(code, privacy: .public)")
        if let call = push, let peer = incomingPeer, let outcome = Self.incomingOutcome(code: code, wasConnected: connectedAt != nil) {
            let end = Int64(clock().timeIntervalSince1970 * 1000)
            VoiciCallHistory.shared.record(VoiciCallRecord(callId: call.callId, direction: .incoming, outcome: outcome, peer: peer, video: offersVideo,
                                                           at: call.issuedAt, durationMs: connectedAt.map { end - $0 } ?? 0))
        }
        incomingPeer = nil
        connectedAt = nil
        answerAfterUnlock = nil
        unlockPending = false
        unlockWindow?.cancel()
        unlockWindow = nil
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
        if holdsRoute {
            holdsRoute = false
            PhoneRouteController.callEnded()
        }
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
        if let ring = PushNotifications.voiciRing(info) {
            MainActor.assumeIsolated { self.incomingRing(ring, completion: completion) }
            return
        }
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
                        // A malformed, late or second call, or outside the business hours: reported (Apple requires
                        // it), then ended at once.
                        let why = error != nil ? "callkit-refused" : call == nil ? "malformed-push" : busy ? "busy" : "late-or-outside-hours"
                        voiciCallLog.notice("call not taken: \(why, privacy: .public)")
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
        CallMediaFactory.prepareAudioSession()
        Task { @MainActor in
            if let r = self.ringing, r.id == action.callUUID {
                self.answerRing()
                return action.fulfill()
            }
            // Flagship is locked (the account keys are closed): CallKit's Answer means "unlock, then answer". The
            // action is fulfilled now (CallKit needs it settled promptly); the room is joined and answered after the
            // unlock, or the call ends with its ring window.
            if self.phase == .needsUnlock, self.callUUID == action.callUUID {
                self.unlockToAnswer()
                return action.fulfill()
            }
            // Answered while the call's keys are still being looked up (a cold VoIP launch): the call is answered once
            // its request is checked, or after the unlock if it turns out to need one.
            if self.phase == .ringing, self.session == nil, self.callUUID == action.callUUID, let call = self.push {
                self.answerAfterUnlock = call.callId
                return action.fulfill()
            }
            if await self.answerNow() { action.fulfill() } else { action.fail() }
        }
    }

    nonisolated public func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
        Task { @MainActor in
            if let r = self.ringing, r.id == action.callUUID {
                self.ringing = nil
                self.lockedRing = nil
                self.ringBack?.hangUp()
                return action.fulfill()
            }
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
