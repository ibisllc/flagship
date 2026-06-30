import Foundation
import FlagshipBurnerCore

/// WebSocket transport for a phone↔burner pairing session. Wraps a
/// `URLSessionWebSocketTask` to the relay (`/burner-pipe/<sid>?role=burner`)
/// and a `BurnerPairingEngine` (the pure protocol logic). Decoded relay
/// frames are fed to the engine; the engine's actions are carried out
/// (send frames upstream, report stage/recipe/log to the model).
///
/// The session is RESILIENT, not socket-fragile. A relay `expired` frame (the
/// ~1h auto-lock) or a `session-ended` from the phone ends it (the model
/// wipes). A transient socket drop does NOT end it: the client reconnects to
/// the same `sid` (the relay evicts the stale socket and the engine resumes).
/// A `peer-gone` is the phone stepping away — the engine holds and waits. An
/// app-level ping keeps the relay's idle TTL pushed forward while we wait/burn.
///
/// Callbacks fire on a background queue; the model hops to the main actor.
final class BurnerSessionClient: NSObject {

    let engine: BurnerPairingEngine
    private let host: String
    private var task: URLSessionWebSocketTask?
    private var urlSession: URLSession?
    private var closed = false
    /// Reconnect bookkeeping for the burner's OWN socket (a desktop network
    /// blip / relay redeploy). Reset to 0 on any successful frame.
    private var reconnectAttempts = 0
    private let maxReconnectAttempts = 40

    var onStage: ((BurnerPairingEngine.Stage) -> Void)?
    var onRecipe: ((Data) -> Void)?
    var onLog: ((String) -> Void)?
    /// (setting, grantJSON) when the phone approves a consent request.
    var onConsentGranted: ((String, String) -> Void)?
    var onConsentDenied: ((String) -> Void)?
    /// Session deadline (ms since epoch), reported once when the relay sends it.
    var onExpiresAt: ((Double) -> Void)?
    private var reportedExpiresAt = false

    var qrPayload: String { engine.qrPayload }
    var humanCodeDisplay: String { engine.humanCodeDisplay }

    init(engine: BurnerPairingEngine = BurnerPairingEngine(),
         host: String = "flagshipserver.com") {
        self.engine = engine
        self.host = host
        super.init()
    }

    func connect() {
        openSocket()
        startPing()
    }

    /// Open (or re-open, on reconnect) the WebSocket to the same relay session.
    /// The engine + keys persist across reopens so a reconnect resumes the
    /// session rather than starting a fresh pairing.
    private func openSocket() {
        guard !closed else { return }
        guard let url = URL(string: "wss://\(host)/burner-pipe/\(engine.sessionId)?role=burner") else {
            onStage?(.ended(reason: "Couldn't build the relay URL."))
            return
        }
        let cfg = URLSessionConfiguration.default
        cfg.waitsForConnectivity = true
        let s = URLSession(configuration: cfg)
        urlSession?.invalidateAndCancel()
        urlSession = s
        let t = s.webSocketTask(with: url)
        task = t
        t.resume()
        receiveLoop()
    }

    private func receiveLoop() {
        task?.receive { [weak self] result in
            guard let self = self, !self.closed else { return }
            switch result {
            case .failure:
                self.scheduleReconnect()
            case .success(let message):
                self.reconnectAttempts = 0
                let text: String?
                switch message {
                case .string(let s): text = s
                case .data(let d): text = String(data: d, encoding: .utf8)
                @unknown default: text = nil
                }
                if let text = text { self.handle(text) }
                if !self.closed { self.receiveLoop() }
            }
        }
    }

    /// A transient socket drop: reconnect to the same session with a short
    /// backoff. Only after exhausting the attempts do we give up + end (wipe).
    private func scheduleReconnect() {
        if closed { return }
        reconnectAttempts += 1
        if reconnectAttempts > maxReconnectAttempts {
            fail("Lost the connection to the relay.")
            return
        }
        if reconnectAttempts == 1 { onLog?("Reconnecting to the relay…") }
        let delay = min(2.0 * Double(reconnectAttempts), 10.0)
        Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            guard let self = self, !self.closed else { return }
            self.openSocket()
        }
    }

    private func handle(_ text: String) {
        guard let data = text.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return
        }
        for action in engine.onRelayFrame(obj) { apply(action) }
        if !reportedExpiresAt, let ms = engine.expiresAtMs {
            reportedExpiresAt = true
            onExpiresAt?(ms)
        }
    }

    private func apply(_ action: BurnerPairingEngine.Action) {
        switch action {
        case .send(let out):
            sendRaw(BurnerPairingEngine.encode(out))
        case .stage(let stage):
            onStage?(stage)
            if case .ended = stage { close() }
        case .recipe(let data):
            onRecipe?(data)
        case .consentGranted(let setting, let grantJSON):
            onConsentGranted?(setting, grantJSON)
        case .consentDenied(let setting):
            onConsentDenied?(setting)
        case .log(let message):
            onLog?(message)
        }
    }

    /// Ask the phone to approve a security-sensitive Advanced setting; the
    /// phone replies (over the session) with a signed grant or a denial.
    func requestConsent(setting: String, serverDomain: String, warning: String) {
        sendRaw(BurnerPairingEngine.encode(
            engine.consentRequest(setting: setting, serverDomain: serverDomain, warning: warning)))
    }

    /// Tell the phone the user disconnected from the burner side, so it wipes
    /// its half of the session too. Best-effort (the burner wipes regardless).
    func sendSessionEnded() {
        sendRaw("{\"kind\":\"session-ended\"}")
    }

    /// Send a pre-serialized frame to the relay (e.g. a Phase-4 consent
    /// request). The relay forwards it verbatim to the phone.
    func sendRaw(_ text: String) {
        task?.send(.string(text)) { _ in }
    }

    private func startPing() {
        Task { [weak self] in
            while true {
                try? await Task.sleep(nanoseconds: 20_000_000_000)
                guard let self = self, !self.closed else { return }
                self.sendRaw("{\"kind\":\"ping\"}")
            }
        }
    }

    private func fail(_ reason: String) {
        if closed { return }
        onStage?(.ended(reason: reason))
        close()
    }

    func close() {
        if closed { return }
        closed = true
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        urlSession?.invalidateAndCancel()
        urlSession = nil
    }
}
