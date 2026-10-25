import Foundation
import FlagshipAPI

/// Builds the owner's `flagship/browser-grant/v1` answer from the box's ask and the duration the owner
/// chose: the ask's own capabilities, origins and local network, for that duration or shorter. The box
/// grants exactly what is signed and refuses anything wider than the ask.
public enum BrowserGrantOrder {
    public static func localNetwork(_ l: BrowserGrantLocalNetworkWire?) -> BrowserGrantAnswer.LocalNetwork {
        switch l {
        case .none: return .none
        case .wholeLan?: return .wholeLan
        case .exact(let hosts)?: return .exact(hosts)
        }
    }

    /// The ask's scope, for `BrowserGrantAnswer.within`.
    public static func scope(of r: BrowserGrantRequest, duration: String? = nil) -> BrowserGrantAnswer.Scope {
        BrowserGrantAnswer.Scope(duration: duration ?? r.duration, capabilities: r.capabilities, origins: r.origins,
                                 localNetwork: localNetwork(r.localNetwork))
    }

    /// `duration` nil = the ask's own.
    public static func answer(for r: BrowserGrantRequest, serverDomain: String, decision: String, duration: String? = nil,
                              issuedAt: Int64) -> BrowserGrantAnswer {
        BrowserGrantAnswer(serverDomain: serverDomain, requestId: r.requestId, serviceId: r.serviceId,
                           decision: decision, duration: duration ?? r.duration, capabilities: r.capabilities,
                           origins: r.origins, localNetwork: localNetwork(r.localNetwork), issuedAt: issuedAt)
    }

    /// The durations to offer for this ask, shortest first.
    public static func choices(for r: BrowserGrantRequest) -> [String] {
        BrowserGrantAnswer.durationChoices(asked: r.duration)
    }
}
