import Foundation
import IOKit.ps

enum HostPower {
    /// True on a MacBook: its lid can sleep the Mac however Studio asks.
    static let hasInternalBattery: Bool = {
        guard let info = IOPSCopyPowerSourcesInfo()?.takeRetainedValue(),
              let list = IOPSCopyPowerSourcesList(info)?.takeRetainedValue() as? [CFTypeRef] else {
            return false
        }
        return list.contains { source in
            guard let desc = IOPSGetPowerSourceDescription(info, source)?.takeUnretainedValue()
                    as? [String: Any] else { return false }
            return desc[kIOPSTypeKey] as? String == kIOPSInternalBatteryType
        }
    }()
}
