import Foundation
import Observation
import FlagshipAPI

/// Why a retail claim stopped (docs/retail-box-setup.md §4, §7.4, §7.6). Each has one sentence the
/// app shows; Android mirrors them.
public enum RetailClaimStop: Equatable, Sendable {
    case anotherBoxNearby
    case twoBoxes
    case early
    case late
    case burst
    case contention
    case noPress
    case busy
    case windowClosed
    case alreadyClaimed
    case recipeRefused
    case outOfOrder
    case entropy
    case badReceipt
    case keyTaken
    case notAdmin
    case bluetoothOff
    case bluetoothNotAllowed
    case bluetoothUnsupported
    case linkLost
    case wrongCode
    case noAnswer
    case badLink

    public var title: String {
        switch self {
        case .anotherBoxNearby, .twoBoxes: return String(localized: "More than one box nearby")
        case .early, .badReceipt: return String(localized: "Don't continue")
        case .contention: return String(localized: "Someone else tried at the same moment")
        case .bluetoothOff, .bluetoothNotAllowed, .bluetoothUnsupported: return String(localized: "Bluetooth is needed")
        case .keyTaken: return String(localized: "This server already has a box")
        case .notAdmin: return String(localized: "Only an admin device can do this")
        default: return String(localized: "Setup stopped")
        }
    }

    public var message: String {
        switch self {
        case .anotherBoxNearby:
            return String(localized: "Another Flagship box nearby is waiting to be set up. If it is yours, unplug it and start again. If not, set this box up somewhere else or use a network cable and a screen.")
        case .twoBoxes:
            return String(localized: "A second Flagship box appeared during setup. Make sure only your box is switched on nearby, unplug it, and start again.")
        case .early:
            return String(localized: "This box reported a press before you were asked. Don't continue.")
        case .late:
            return String(localized: "The press came too late. Tap Try again and press the power button as soon as you are asked.")
        case .burst:
            return String(localized: "The box saw more than one press, or a long one. Press the power button once, briefly, when you are asked.")
        case .contention:
            return String(localized: "Another phone tried to set up this box at the same moment. Make sure nobody nearby is setting up a Flagship box, then try again.")
        case .noPress:
            return String(localized: "The box saw no press. Tap Try again and press the power button once when you are asked.")
        case .busy:
            return String(localized: "The box is busy with another setup. Wait a minute and try again.")
        case .windowClosed:
            return String(localized: "The box stopped listening. Unplug it, plug it back in and start again.")
        case .alreadyClaimed:
            return String(localized: "This box is already set up. Press its power button 5 times, quickly, then tap Try again. Setting it up erases everything on it.")
        case .recipeRefused:
            return String(localized: "The box refused this server's recipe. Start again.")
        case .outOfOrder:
            return String(localized: "The box and this phone got out of step. Start again.")
        case .entropy:
            return String(localized: "The box can't make safe keys yet. Leave it switched on for a minute and try again.")
        case .badReceipt:
            return String(localized: "The box's answer did not belong to this setup. Someone nearby may be intercepting it. Unplug the box and set it up with a screen instead.")
        case .keyTaken:
            return String(localized: "Another box is already registered for this server. Delete this server and set the box up again.")
        case .notAdmin:
            return String(localized: "Only an admin device of this account can set up a server.")
        case .bluetoothOff:
            return String(localized: "Turn on Bluetooth to find the box, then try again.")
        case .bluetoothNotAllowed:
            return String(localized: "Flagship needs Bluetooth to find the box. Allow it in Settings, then try again.")
        case .bluetoothUnsupported:
            return String(localized: "This device can't use Bluetooth to set up a box.")
        case .linkLost:
            return String(localized: "The connection to the box was lost. Start again.")
        case .wrongCode:
            return String(localized: "The box did not accept this setup code. Ask for a new one: press the box's power button 3 times with the screen attached.")
        case .noAnswer:
            return String(localized: "No box answered this setup code. It may have expired or been used. Ask for a new one.")
        case .badLink:
            return String(localized: "This isn't a Flagship setup code.")
        }
    }
}

public enum RetailClaimAlarm: Equatable, Sendable {
    /// The server that came online holds another key than the box this phone paired with.
    case keyMismatch
    /// No server came online under this recipe.
    case neverOnline

    public var message: String {
        switch self {
        case .keyMismatch:
            return String(localized: "The server that came online is not the box you paired with. Someone may have intercepted the setup. Don't use it. Press the box's power button 5 times and set it up again, with a network cable. If you sent your Wi-Fi password, change it.")
        case .neverOnline:
            return String(localized: "The box you paired with never came online. Someone may have intercepted the setup. Press the box's power button 5 times and set it up again, with a network cable. If you sent your Wi-Fi password, change it.")
        }
    }
}

public enum RetailClaimCopy {
    public static func networkFailure(_ f: BoxClaim.NetworkFailure) -> String {
        switch f {
        case .noLink: return String(localized: "The box has no network. Plug the cable into your router, or choose Wi-Fi.")
        case .networkNotFound: return String(localized: "The box can't see that Wi-Fi network. Move the box closer to the router, or use a cable.")
        case .wrongPassword: return String(localized: "The Wi-Fi password was wrong. Check it and try again.")
        case .unsupportedSecurity: return String(localized: "The box can't join this kind of Wi-Fi. It needs WPA2 or WPA3 with a password. Use a cable instead.")
        case .noDhcp: return String(localized: "The network gave the box no address. Check that your router hands out addresses (DHCP).")
        case .noDns: return String(localized: "The box got an address but can't look up names. Check your router's internet connection.")
        case .captivePortal: return String(localized: "This network wants a sign-in page, which the box can't use. Use a home network or a cable.")
        case .relayUnreachable: return String(localized: "The box is online but can't reach Flagship. Your network may block outgoing connections on port 443.")
        }
    }

    public static let wifiWarning = String(localized: "Your Wi-Fi password goes to the box over Bluetooth. If someone nearby is intercepting this setup, they could read it. A network cable avoids this.")
    public static let resetInstructions = String(localized: "If this box was set up before, press its power button 5 times, quickly, then tap Try again. Setting it up erases everything on it.")
}

/// The key registration at `.com` refused (§4 step 8).
public enum RetailClaimKeyError: Error, Equatable {
    case taken
    case notAdmin
}

public struct RetailClaimDeps {
    public var username: String
    public var radio: any BoxClaimRadio
    public var mailboxLink: (_ mailboxId: String) -> any BoxClaimLink
    /// Signs the recipe (the create flow; one biometric) and returns it with its server and serial.
    public var mintRecipe: () async throws -> (json: String, serverDomain: String, serial: String)
    /// Signs `flagship/box-claim-key/v1` with the admin root and posts it; throws RetailClaimKeyError.
    public var registerKey: (BoxClaim.ClaimKey) async throws -> Void
    /// Pins the box key the receipt named (first contact from the box itself, §3 G4).
    public var pinStk: (_ serverDomain: String, _ stkPubHex: String) -> Void
    /// The STK `.com` lists for the server, once it registered.
    public var registeredStk: (_ serverDomain: String) async -> String?
    /// Opens the box over the relay with the pinned certificate: true when it holds, false on a
    /// mismatch, nil while the box has not reported a certificate yet.
    public var tlsCheck: (_ serverDomain: String) async -> Bool?
    /// The server is on the account now (Home shows it as setting up).
    public var onClaimed: (_ serverDomain: String, _ serial: String) -> Void
    public var region: String
    public var now: () -> Int64
    public var sleepMs: (Int64) async throws -> Void
    public var pauseMs: () -> Int64
    public var baselineMs: Int64 = 3_000
    public var pressHintMs: Int64 = 60_000
    public var noBoxMs: Int64 = 180_000
    public var answerTimeoutMs: Int64 = 30_000
    public var onlineTimeoutMs: Int64 = 600_000
    public var pollMs: Int64 = 5_000

    public init(username: String, radio: any BoxClaimRadio, mailboxLink: @escaping (String) -> any BoxClaimLink,
                mintRecipe: @escaping () async throws -> (json: String, serverDomain: String, serial: String),
                registerKey: @escaping (BoxClaim.ClaimKey) async throws -> Void,
                pinStk: @escaping (String, String) -> Void,
                registeredStk: @escaping (String) async -> String?,
                tlsCheck: @escaping (String) async -> Bool?,
                onClaimed: @escaping (String, String) -> Void,
                region: String,
                now: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) },
                sleepMs: @escaping (Int64) async throws -> Void = { try await Task.sleep(nanoseconds: UInt64(max(0, $0)) * 1_000_000) },
                pauseMs: @escaping () -> Int64 = { (try? BoxClaim.instructionPauseMs()) ?? 4_000 }) {
        self.username = username; self.radio = radio; self.mailboxLink = mailboxLink; self.mintRecipe = mintRecipe
        self.registerKey = registerKey; self.pinStk = pinStk; self.registeredStk = registeredStk; self.tlsCheck = tlsCheck
        self.onClaimed = onClaimed; self.region = region; self.now = now; self.sleepMs = sleepMs; self.pauseMs = pauseMs
    }
}

/// The phone side of a retail claim (docs/retail-box-setup.md §4, §7, §15.1): the presence rule,
/// the handshake, the timed press, the recipe, the receipt and key registration, the network step
/// and the internet check. Screens on iOS and Android render `phase`.
@Observable
@MainActor
public final class RetailClaimViewModel {
    public enum PlugHint: Equatable, Sendable { case waiting, pressOnce, noBox }

    public enum Phase: Equatable {
        case intro
        case scanCode
        case checkingNearby
        case plugIn(PlugHint)
        case connecting
        case getReady
        case pressNow
        case signing
        case registeringKey
        case chooseNetwork
        case scanningWifi
        case wifiList([BoxClaim.WifiNetwork])
        case wifiPassword(ssid: String)
        case wifiWarning(ssid: String)
        case connectingNetwork
        case networkFailed(BoxClaim.NetworkFailure)
        case checkingInternet(serverDomain: String)
        case done(serverDomain: String)
        case alarm(RetailClaimAlarm, serverDomain: String)
        case stopped(RetailClaimStop)
        case failed(String)
    }

    public private(set) var phase: Phase = .intro
    public private(set) var receipt: BoxClaim.Receipt?
    public private(set) var mode: BoxClaim.Mode = .open

    private let deps: RetailClaimDeps
    private var presence = BoxClaimPresence()
    private var link: (any BoxClaimLink)?
    private var channel: BoxClaim.Channel?
    private var reader: Task<Void, Never>?
    private var flow: Task<Void, Never>?
    private var hints: Task<Void, Never>?
    private var inbox: [(msg: BoxClaim.BoxMessage, at: Int64)] = []
    private var waiter: CheckedContinuation<Void, Never>?
    private var linkDead = false
    private var minted: (json: String, serverDomain: String, serial: String)?
    private var pendingWifi: BoxClaim.WiFiConfig?
    private var generation = 0

    public init(deps: RetailClaimDeps) { self.deps = deps }

    // MARK: Entry points

    /// The normal method: Bluetooth and a timed press.
    public func startBluetooth() {
        reset()
        mode = .open
        phase = .checkingNearby
        let gen = generation
        flow = Task { [weak self] in await self?.runScan(gen) }
    }

    public func showCodeScanner() {
        reset()
        phase = .scanCode
    }

    /// The sharing method: a setup code from the box's screen, claimed through the `.com` mailbox.
    public func startWithCode(_ scanned: String) {
        guard let code = BoxClaim.parseSetupCodeLink(scanned) ?? BoxClaim.normalizeSetupCode(scanned),
              let mailboxId = try? BoxClaim.setupCodeMailboxId(code) else {
            stop(.badLink)
            return
        }
        reset()
        mode = .code
        phase = .connecting
        let gen = generation
        let l = deps.mailboxLink(mailboxId)
        flow = Task { [weak self] in await self?.runClaim(link: l, code: code, gen: gen) }
    }

    public func tryAgain() {
        if mode == .code { showCodeScanner() } else { startBluetooth() }
    }

    public func cancel() {
        if let link, let ch = channel, let rec = try? ch.seal(Array(BoxClaim.PhoneMessage.abort.jsonText.utf8)) {
            Task { try? await link.send(BoxClaim.encodeMessage(kind: BoxClaim.frameRecord, payload: rec)) }
        }
        reset()
        phase = .intro
    }

    // MARK: Network step

    public func useCable() {
        pendingWifi = nil
        send(.network(nil))
        phase = .connectingNetwork
    }

    public func useWifi() {
        phase = .scanningWifi
        send(.wifiScan)
    }

    public func pickNetwork(_ ssid: String) {
        phase = .wifiPassword(ssid: ssid)
    }

    /// Checks the password's shape, then shows the warning before anything leaves the phone.
    public func submitPassword(ssid: String, password: String) -> Bool {
        let cfg = BoxClaim.WiFiConfig(ssid: ssid, psk: password, regulatoryRegion: deps.region, issuedAt: deps.now())
        guard cfg.isValid else { return false }
        pendingWifi = cfg
        phase = .wifiWarning(ssid: ssid)
        return true
    }

    public func sendWifi() {
        guard let cfg = pendingWifi else { return }
        send(.network(cfg))
        phase = .connectingNetwork
    }

    public func retryNetwork() {
        phase = .chooseNetwork
    }

    // MARK: Internals

    private func reset() {
        generation += 1
        flow?.cancel(); reader?.cancel(); hints?.cancel()
        flow = nil; reader = nil; hints = nil
        deps.radio.stopScan()
        link?.close()
        link = nil; channel = nil; inbox = []; linkDead = false
        waiter?.resume(); waiter = nil
        presence = BoxClaimPresence()
        minted = nil; receipt = nil; pendingWifi = nil
    }

    private func stop(_ s: RetailClaimStop) {
        let ch = channel, l = link
        reset()
        if let l, let ch, let rec = try? ch.seal(Array(BoxClaim.PhoneMessage.abort.jsonText.utf8)) {
            Task { try? await l.send(BoxClaim.encodeMessage(kind: BoxClaim.frameRecord, payload: rec)); l.close() }
        }
        phase = .stopped(s)
    }

    private func runScan(_ gen: Int) async {
        do {
            try await deps.radio.startScan { [weak self] adverts in
                Task { @MainActor in self?.onAdverts(adverts, gen) }
            }
        } catch let e as BoxClaimRadioError {
            guard gen == generation else { return }
            switch e {
            case .bluetoothOff: stop(.bluetoothOff)
            case .notAllowed: stop(.bluetoothNotAllowed)
            default: stop(.bluetoothUnsupported)
            }
            return
        } catch {
            if gen == generation { stop(.bluetoothUnsupported) }
            return
        }
        try? await deps.sleepMs(deps.baselineMs)
        guard gen == generation, phase == .checkingNearby else { return }
        presence.endBaseline()
        phase = .plugIn(.waiting)
        hints = Task { [weak self, deps] in
            try? await deps.sleepMs(deps.pressHintMs)
            await MainActor.run { if let self, gen == self.generation, self.phase == .plugIn(.waiting) { self.phase = .plugIn(.pressOnce) } }
            try? await deps.sleepMs(deps.noBoxMs - deps.pressHintMs)
            await MainActor.run { if let self, gen == self.generation, case .plugIn = self.phase { self.phase = .plugIn(.noBox) } }
        }
    }

    private func onAdverts(_ adverts: [BoxClaimAdvert], _ gen: Int) {
        guard gen == generation, mode == .open else { return }
        switch presence.observe(adverts) {
        case .waiting:
            break
        case .anotherBoxNearby:
            stop(.anotherBoxNearby)
        case .twoBoxes:
            stop(.twoBoxes)
        case .one(let advert):
            guard case .plugIn = phase, link == nil else { return }
            hints?.cancel()
            phase = .connecting
            flow = Task { [weak self] in
                guard let self else { return }
                do {
                    let l = try await self.deps.radio.connect(advert)
                    await self.runClaim(link: l, code: nil, gen: gen)
                } catch {
                    if gen == self.generation { self.stop(.linkLost) }
                }
            }
        }
    }

    private func startReader(_ l: any BoxClaimLink, gen: Int) {
        reader = Task { [weak self] in
            while !Task.isCancelled {
                do {
                    let raw = try await l.receive()
                    await MainActor.run { self?.deliver(raw, gen) }
                } catch {
                    await MainActor.run {
                        guard let self, gen == self.generation else { return }
                        self.linkDead = true
                        self.waiter?.resume(); self.waiter = nil
                    }
                    return
                }
            }
        }
    }

    private var handshakeInbox: [[UInt8]] = []

    private func deliver(_ raw: [UInt8], _ gen: Int) {
        guard gen == generation, let (kind, payload) = try? BoxClaim.decodeMessage(raw) else { return }
        let at = deps.now()
        if kind == BoxClaim.frameHandshake {
            handshakeInbox.append(payload)
        } else if let ch = channel, let obj = try? ch.openJson(payload), let m = try? BoxClaim.BoxMessage.parse(obj) {
            inbox.append((m, at))
        } else {
            linkDead = true
        }
        waiter?.resume(); waiter = nil
    }

    /// Waits until something arrives or `timeoutMs` passes.
    private func waitForInput(_ timeoutMs: Int64, gen: Int) async {
        let t = Task { [weak self, deps] in
            try? await deps.sleepMs(timeoutMs)
            await MainActor.run { if let self, gen == self.generation { self.waiter?.resume(); self.waiter = nil } }
        }
        await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
            if waiter != nil { waiter?.resume() }
            waiter = c
        }
        t.cancel()
    }

    private func nextHandshake(timeoutMs: Int64, gen: Int) async -> [UInt8]? {
        let deadline = deps.now() + timeoutMs
        while gen == generation {
            if !handshakeInbox.isEmpty { return handshakeInbox.removeFirst() }
            if linkDead || deps.now() >= deadline { return nil }
            await waitForInput(deadline - deps.now(), gen: gen)
        }
        return nil
    }

    private func next(timeoutMs: Int64, gen: Int) async -> (msg: BoxClaim.BoxMessage, at: Int64)? {
        let deadline = deps.now() + timeoutMs
        while gen == generation {
            if !inbox.isEmpty { return inbox.removeFirst() }
            if linkDead || deps.now() >= deadline { return nil }
            await waitForInput(deadline - deps.now(), gen: gen)
        }
        return nil
    }

    private func send(_ m: BoxClaim.PhoneMessage) {
        guard let l = link, let ch = channel, let rec = try? ch.seal(Array(m.jsonText.utf8)) else { return }
        let gen = generation
        Task { [weak self] in
            do { try await l.send(BoxClaim.encodeMessage(kind: BoxClaim.frameRecord, payload: rec)) } catch {
                await MainActor.run { if let self, gen == self.generation { self.stop(.linkLost) } }
            }
        }
        if case .network = m { listenForNetwork(gen) }
        if case .wifiScan = m { listenForWifiList(gen) }
    }

    private static func json(_ o: [String: Any]) -> [UInt8] {
        Array((try? JSONSerialization.data(withJSONObject: o, options: [.sortedKeys])) ?? Data())
    }

    private func runClaim(link l: any BoxClaimLink, code: String?, gen: Int) async {
        guard gen == generation else { l.close(); return }
        link = l
        handshakeInbox = []
        startReader(l, gen: gen)
        do {
            let start = try BoxClaim.PhoneStart(mode: code == nil ? .open : .code, code: code)
            try await l.send(BoxClaim.encodeMessage(kind: BoxClaim.frameHandshake, payload: Self.json(start.hello.json)))
            guard let acceptBytes = await nextHandshake(timeoutMs: deps.answerTimeoutMs, gen: gen) else {
                if gen == generation { stop(code == nil ? .linkLost : .noAnswer) }
                return
            }
            let (finish, pending) = try start.finish(accept: try JSONSerialization.jsonObject(with: Data(acceptBytes)))
            try await l.send(BoxClaim.encodeMessage(kind: BoxClaim.frameHandshake, payload: Self.json(finish)))
            guard let readyBytes = await nextHandshake(timeoutMs: deps.answerTimeoutMs, gen: gen) else {
                if gen == generation { stop(code == nil ? .linkLost : .wrongCode) }
                return
            }
            let ch = try pending.confirm(ready: try JSONSerialization.jsonObject(with: Data(readyBytes)))
            guard gen == generation else { return }
            channel = ch
            try await press(l, ch, gen: gen)
        } catch let e as BoxClaimError {
            guard gen == generation else { return }
            switch e.code {
            case "confirm-failed", "wrong-code": stop(code == nil ? .badReceipt : .wrongCode)
            case "mode-mismatch": stop(.badReceipt)
            default: stop(.linkLost)
            }
        } catch is CancellationError {
        } catch {
            if gen == generation { stop(.linkLost) }
        }
    }

    private func stopFor(_ r: BoxClaim.PressRefusal) -> RetailClaimStop {
        switch r {
        case .noPress: return .noPress
        case .burst, .longPress: return .burst
        case .late: return .late
        case .contention: return .contention
        case .notArmed, .busy: return .busy
        }
    }

    private func stopFor(_ r: BoxClaim.Refusal) -> RetailClaimStop {
        switch r {
        case .noGrant, .windowClosed: return .windowClosed
        case .recipeInvalid, .recipeExpired: return .recipeRefused
        case .alreadyClaimed: return .alreadyClaimed
        case .entropy: return .entropy
        case .outOfOrder: return .outOfOrder
        }
    }

    private func press(_ l: any BoxClaimLink, _ ch: BoxClaim.Channel, gen: Int) async throws {
        let armSentAt = deps.now()
        send(.arm)
        if mode == .code {
            guard let r = await next(timeoutMs: deps.answerTimeoutMs, gen: gen) else { if gen == generation { stop(.linkLost) }; return }
            guard case .pressResult(true, _) = r.msg else {
                if case .pressResult(false, let reason?) = r.msg { stop(stopFor(reason)) } else if case .refused(let why) = r.msg { stop(stopFor(why)) } else { stop(.outOfOrder) }
                return
            }
            return try await claim(l, ch, gen: gen)
        }
        phase = .getReady
        try await deps.sleepMs(deps.pauseMs())
        guard gen == generation else { return }
        let instructionAt = deps.now()
        phase = .pressNow
        let deadline = armSentAt + BoxClaim.pressWindowMs + BoxClaim.powerKeyBurstEndMs + 5_000
        var pressed = false
        while gen == generation {
            guard let r = await next(timeoutMs: max(0, deadline - deps.now()), gen: gen) else {
                if gen == generation { stop(linkDead ? .linkLost : .noPress) }
                return
            }
            switch r.msg {
            case .armed:
                continue
            case .press(let atMs, let count, let long):
                let v = BoxClaim.judgePressReport(armSentAt: armSentAt, instructionAt: instructionAt, atMs: atMs, count: count, long: long, receivedAt: r.at)
                switch v {
                case .ok: pressed = true
                case .early: stop(.early); return
                case .late: stop(.late); return
                case .burst: stop(.burst); return
                }
            case .pressResult(let ok, let reason):
                if ok && pressed { return try await claim(l, ch, gen: gen) }
                if ok { stop(.early); return }
                stop(reason.map(stopFor) ?? .noPress)
                return
            case .refused(let why):
                stop(stopFor(why)); return
            default:
                stop(.outOfOrder); return
            }
        }
    }

    private func claim(_ l: any BoxClaimLink, _ ch: BoxClaim.Channel, gen: Int) async throws {
        phase = .signing
        let m: (json: String, serverDomain: String, serial: String)
        do {
            m = try await deps.mintRecipe()
        } catch {
            if gen == generation {
                if (error as? RetailClaimKeyError) == .notAdmin { stop(.notAdmin) } else { abortQuietly(); phase = .failed(UserErrorText.of(error)) }
            }
            return
        }
        guard gen == generation else { return }
        minted = m
        send(.claim(recipe: m.json))
        guard let r = await next(timeoutMs: deps.answerTimeoutMs * 2, gen: gen) else { if gen == generation { stop(.linkLost) }; return }
        let receiptWire: [String: AnyHashable]
        switch r.msg {
        case .receipt(let w): receiptWire = w
        case .refused(let why): stop(stopFor(why)); return
        default: stop(.outOfOrder); return
        }
        let rc: BoxClaim.Receipt
        do {
            rc = try BoxClaim.verifyReceipt(receiptWire.mapValues { $0.base }, transcriptHex: ch.transcriptHex, mode: mode,
                                            serverDomain: m.serverDomain, serial: m.serial)
        } catch {
            stop(.badReceipt); return
        }
        receipt = rc
        deps.pinStk(m.serverDomain, rc.stkPubHex)
        phase = .registeringKey
        do {
            try await deps.registerKey(BoxClaim.ClaimKey(username: deps.username, serial: m.serial, serverDomain: m.serverDomain,
                                                         stkPubHex: rc.stkPubHex, issuedAt: deps.now()))
        } catch RetailClaimKeyError.taken {
            if gen == generation { stop(.keyTaken) }
            return
        } catch RetailClaimKeyError.notAdmin {
            if gen == generation { stop(.notAdmin) }
            return
        } catch {
            if gen == generation { abortQuietly(); phase = .failed(UserErrorText.of(error)) }
            return
        }
        guard gen == generation else { return }
        deps.onClaimed(m.serverDomain, m.serial)
        deps.radio.stopScan()
        if mode == .code { useCable() } else { phase = .chooseNetwork }
    }

    private func abortQuietly() {
        let ch = channel, l = link
        reset()
        if let l, let ch, let rec = try? ch.seal(Array(BoxClaim.PhoneMessage.abort.jsonText.utf8)) {
            Task { try? await l.send(BoxClaim.encodeMessage(kind: BoxClaim.frameRecord, payload: rec)); l.close() }
        }
    }

    private func listenForWifiList(_ gen: Int) {
        Task { [weak self] in
            guard let self else { return }
            while gen == self.generation {
                guard let r = await self.next(timeoutMs: 30_000, gen: gen) else {
                    if gen == self.generation, self.phase == .scanningWifi { self.phase = .wifiList([]) }
                    return
                }
                if case .wifiList(let nets) = r.msg {
                    self.phase = .wifiList(nets.sorted { $0.signal > $1.signal })
                    return
                }
            }
        }
    }

    private func listenForNetwork(_ gen: Int) {
        Task { [weak self] in
            guard let self else { return }
            while gen == self.generation {
                guard let r = await self.next(timeoutMs: 120_000, gen: gen) else {
                    if gen == self.generation, self.phase == .connectingNetwork { self.phase = .networkFailed(.relayUnreachable) }
                    return
                }
                switch r.msg {
                case .networkStatus("connecting", _, _):
                    continue
                case .networkStatus("online", _, _):
                    await self.internetCheck(gen)
                    return
                case .networkStatus(_, _, let f?):
                    self.phase = .networkFailed(f)
                    return
                case .refused(let why):
                    self.stop(self.stopFor(why))
                    return
                default:
                    continue
                }
            }
        }
    }

    private func internetCheck(_ gen: Int) async {
        guard let m = minted, let rc = receipt else { return }
        phase = .checkingInternet(serverDomain: m.serverDomain)
        link?.close()
        let deadline = deps.now() + deps.onlineTimeoutMs
        while gen == generation && deps.now() < deadline {
            if let stk = await deps.registeredStk(m.serverDomain) {
                guard gen == generation else { return }
                if stk.lowercased() != rc.stkPubHex.lowercased() {
                    phase = .alarm(.keyMismatch, serverDomain: m.serverDomain)
                    return
                }
                switch await deps.tlsCheck(m.serverDomain) {
                case false?:
                    if gen == generation { phase = .alarm(.keyMismatch, serverDomain: m.serverDomain) }
                    return
                case true?:
                    if gen == generation { phase = .done(serverDomain: m.serverDomain) }
                    return
                case nil:
                    break
                }
            }
            try? await deps.sleepMs(deps.pollMs)
        }
        guard gen == generation else { return }
        if await deps.registeredStk(m.serverDomain) == rc.stkPubHex.lowercased() {
            phase = .done(serverDomain: m.serverDomain)
        } else {
            phase = .alarm(.neverOnline, serverDomain: m.serverDomain)
        }
    }
}
