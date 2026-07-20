import Foundation

/// Where a recipe was applied. The one input to the tier badge.
public enum ServerDestination: String, Codable, Sendable, Equatable {
    case burnToUSB = "usb"
    case hostHere = "host-here"
}

/// The honest security-tier badge (docs/desktop-vm-appliance.md "Security
/// model + honest tiering"): bare metal stays the gold standard; a hosted VM
/// is labeled as such — legible, never silently equivalent.
public enum ServerTier: String, Codable, Sendable, Equatable {
    case hardware
    case hostedVM = "hosted-vm"

    public var badgeLabel: String {
        switch self {
        case .hardware: return "Appliance (hardware)"
        case .hostedVM: return "Appliance (hosted VM)"
        }
    }

    public init(destination: ServerDestination) {
        switch destination {
        case .burnToUSB: self = .hardware
        case .hostHere: self = .hostedVM
        }
    }
}
