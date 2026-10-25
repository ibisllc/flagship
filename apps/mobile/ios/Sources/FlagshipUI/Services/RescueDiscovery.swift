import Foundation
import Network
import FlagshipCore

/// Finding the owner's box on this Wi-Fi with no DNS and no `.com` (docs/data-sovereignty.md 4.2):
/// boxes answer Bonjour for `_flagship._tcp` under an opaque id (`Rescue.discoveryId`, a keyed hash
/// of the server's name under its STK) that only the owner's devices can recompute. What the
/// announcement says is only ever a hint; the hello decides.
public protocol RescueDiscovery: AnyObject, Sendable {
    /// Calls `onChange` with every box seen so far: announced id → where it answers.
    func start(onChange: @escaping @Sendable ([String: RescueEndpoint]) -> Void)
    func stop()
}

public final class BonjourRescueDiscovery: RescueDiscovery, @unchecked Sendable {
    private let queue = DispatchQueue(label: "flagship.rescue-discovery")
    private var browser: NWBrowser?
    private var resolving: [String: NWConnection] = [:]
    private var found: [String: RescueEndpoint] = [:]
    private var onChange: (@Sendable ([String: RescueEndpoint]) -> Void)?

    public init() {}

    public func start(onChange: @escaping @Sendable ([String: RescueEndpoint]) -> Void) {
        queue.async { [self] in
            self.onChange = onChange
            browser?.cancel()
            let b = NWBrowser(for: .bonjour(type: Rescue.serviceType, domain: nil), using: .tcp)
            b.browseResultsChangedHandler = { [weak self] results, _ in self?.update(results) }
            b.start(queue: queue)
            browser = b
        }
    }

    public func stop() {
        queue.async { [self] in
            browser?.cancel()
            browser = nil
            resolving.values.forEach { $0.cancel() }
            resolving.removeAll()
            onChange = nil
        }
    }

    private func update(_ results: Set<NWBrowser.Result>) {
        for r in results {
            guard case let .service(name, _, _, _) = r.endpoint else { continue }
            let id = name.lowercased()
            guard found[id] == nil, resolving[id] == nil, id.utf8.count == 16 else { continue }
            // Resolve by connecting: the path's remote end is the box's address and port.
            let c = NWConnection(to: r.endpoint, using: .tcp)
            resolving[id] = c
            c.stateUpdateHandler = { [weak self, weak c] state in
                guard let self, let c else { return }
                switch state {
                case .ready:
                    if case let .hostPort(host, port)? = c.currentPath?.remoteEndpoint {
                        var h = "\(host)"
                        if let pct = h.firstIndex(of: "%") { h = String(h[..<pct]) }
                        self.found[id] = RescueEndpoint(host: h, port: Int(port.rawValue))
                        self.onChange?(self.found)
                    }
                    c.cancel()
                    self.resolving[id] = nil
                case .failed, .cancelled:
                    self.resolving[id] = nil
                default:
                    break
                }
            }
            c.start(queue: queue)
            queue.asyncAfter(deadline: .now() + 5) { [weak c] in c?.cancel() }
        }
    }
}
