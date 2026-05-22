import Foundation
import ServiceManagement
import FlagshipBurnerCore

/// Registers + talks to the privileged helper daemon. The daemon is shipped
/// inside the .app (Contents/MacOS/FlagshipBurnerHelper) with its launchd
/// plist in Contents/Library/LaunchDaemons; SMAppService registers it the
/// first time, which the user approves once in System Settings.
enum HelperClient {
    /// Must match the plist file name placed in Contents/Library/LaunchDaemons.
    static let plistName = "com.flagshipserver.Burner.helper.plist"

    enum HelperError: LocalizedError {
        case needsApproval
        case registrationFailed(String)
        case unsupported

        var errorDescription: String? {
            switch self {
            case .needsApproval:
                return "Approve “Flagship Assembler” in System Settings → General → Login Items "
                    + "(under “Allow in the Background”), then click Assemble again."
            case .registrationFailed(let m):
                return "Couldn't register the privileged helper: \(m). The app must be "
                    + "code-signed for this to work."
            case .unsupported:
                return "The privileged helper requires macOS 13 or later."
            }
        }
    }

    static func service() -> SMAppService {
        SMAppService.daemon(plistName: plistName)
    }

    /// Ensure the daemon is registered and enabled. Throws `.needsApproval`
    /// when the user still has to flip it on in System Settings.
    static func ensureEnabled() throws {
        let s = service()
        switch s.status {
        case .enabled:
            return
        case .requiresApproval:
            SMAppService.openSystemSettingsLoginItems()
            throw HelperError.needsApproval
        case .notRegistered:
            do {
                try s.register()
            } catch {
                throw HelperError.registrationFailed(error.localizedDescription)
            }
            if s.status != .enabled {
                SMAppService.openSystemSettingsLoginItems()
                throw HelperError.needsApproval
            }
        case .notFound:
            throw HelperError.registrationFailed("daemon plist not found in the app bundle")
        @unknown default:
            throw HelperError.registrationFailed("unexpected status \(s.status.rawValue)")
        }
    }

    static func makeConnection() -> NSXPCConnection {
        let c = NSXPCConnection(machServiceName: kFlagshipHelperMachName, options: .privileged)
        c.remoteObjectInterface = NSXPCInterface(with: FlagshipHelperProtocol.self)
        c.resume()
        return c
    }
}
