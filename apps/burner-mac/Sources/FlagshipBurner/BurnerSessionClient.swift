import Foundation
import FlagshipBurnerCore

/// WebSocket transport for a phone↔burner pairing session. Wraps a
/// `URLSessionWebSocketTask` to the relay (`/burner-pipe/<sid>?role=burner`)
/// and a `BurnerPairingEngine` (the pure protocol logic). Decoded relay
/// frames are fed to the engine; the engine's actions are carried out
/// (send frames upstream, report stage/recipe/log to the model).
///
/// The live socket IS the gate: a close/error or an `expired`/`peer-gone`
/// frame ends the session, and the model re-locks the burner. An app-level
/// ping keeps the relay's idle TTL pushed forward while we wait/burn.
///
/// Callbacks fire on a background queue; the model hops to the main actor.
final class BurnerSessionClient: NSObject {

    let engine: BurnerPairingEngine
    private let host: String
    private var task: URLSessionWebSocketTask?
    private var urlSession: URLSession?
    private var closed = false

    var onStage: ((BurnerPairingEngine.Stage) -> Void)?
    var onRecipe: ((Data) -> Void)?
    var onLog: ((String) -> Void)?

    var qrPayload: String { engine.qrPayload }
    var humanCodeDisplay: String { engine.humanCodeDisplay }

    init(engine: BurnerPairingEngine = BurnerPairingEngine(),
         host: String = "flagshipserver.com") {
        self.engine = engine
        self.host = host
        super.init()
    }

    func connect() {
        guard let url = URL(string: "wss://\(host)/burner-pipe/\(engine.sessionId)?role=burner") else {
            onStage?(.ended(reason: "Couldn't build the relay URL."))
            return
        }
        let cfg = URLSessionConfiguration.default
        cfg.waitsForConnectivity = true
        let s = URLSession(configuration: cfg)
        urlSession = s
        let t = s.webSocketTask(with: url)
        task = t
        t.resume()
        receiveLoop()
        startPing()
    }

    private func receiveLoop() {
        task?.receive { [weak self] result in
            guard let self = self, !self.closed else { return }
            switch result {
            case .failure:
                self.fail("Connection to the relay was lost.")
            case .success(let message):
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

    private func handle(_ text: String) {
        guard let data = text.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return
        }
        for action in engine.onRelayFrame(obj) { apply(action) }
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
        case .log(let message):
            onLog?(message)
        }
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
