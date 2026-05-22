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

        var errorDescription: String? {
            switch self {
            case .needsApproval:
                return "Approve “Flagship Assembler” in System Settings → General → Login Items "
                    + "(under “Allow in the Background”), then click Assemble again."
            case .registrationFailed(let m):
                return "Couldn't register the privileged helper: \(m)\n"
                    + "The app must be signed with a Developer ID Application certificate and run "
                    + "from /Applications (ad-hoc/Apple-Development signatures and swift-build "
                    + "binaries are rejected by macOS)."
            }
        }
    }

    static func service() -> SMAppService {
        SMAppService.daemon(plistName: plistName)
    }

    private static func statusName(_ s: SMAppService.Status) -> String {
        switch s {
        case .notRegistered: return "notRegistered"
        case .enabled: return "enabled"
        case .requiresApproval: return "requiresApproval"
        case .notFound: return "notFound"
        @unknown default: return "unknown(\(s.rawValue))"
        }
    }

    /// Ensure the daemon is registered and enabled. Throws `.needsApproval`
    /// when the user still has to flip it on in System Settings, or
    /// `.registrationFailed` with the real SMAppService reason + status.
    static func ensureEnabled() throws {
        let s = service()
        let before = s.status
        if before == .enabled { return }
        do {
            try s.register()
        } catch {
            throw HelperError.registrationFailed(
                "\(error.localizedDescription) [status \(statusName(before))]")
        }
        if s.status == .enabled { return }
        // Registered but not yet allowed — the user must approve it.
        SMAppService.openSystemSettingsLoginItems()
        throw HelperError.needsApproval
    }

    static func makeConnection() -> NSXPCConnection {
        let c = NSXPCConnection(machServiceName: kFlagshipHelperMachName, options: .privileged)
        c.remoteObjectInterface = NSXPCInterface(with: FlagshipHelperProtocol.self)
        c.resume()
        return c
    }
}
