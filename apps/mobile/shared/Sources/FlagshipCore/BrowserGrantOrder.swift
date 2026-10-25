import Foundation
import FlagshipAPI

/// Builds the owner's `flagship/browser-grant/v1` answer from exactly what the box asked: the box
/// verifies the ask's own duration, capabilities, origins and local network, so the phone never
/// signs anything wider or narrower than the request it showed.
public enum BrowserGrantOrder {
    public static func answer(for r: BrowserGrantRequest, serverDomain: String, decision: String, issuedAt: Int64) -> BrowserGrantAnswer {
        let lan: BrowserGrantAnswer.LocalNetwork
        switch r.localNetwork {
        case .none: lan = .none
        case .wholeLan?: lan = .wholeLan
        case .exact(let hosts)?: lan = .exact(hosts)
        }
        return BrowserGrantAnswer(serverDomain: serverDomain, requestId: r.requestId, serviceId: r.serviceId,
                                  decision: decision, duration: r.duration, capabilities: r.capabilities,
                                  origins: r.origins, localNetwork: lan, issuedAt: issuedAt)
    }
}
