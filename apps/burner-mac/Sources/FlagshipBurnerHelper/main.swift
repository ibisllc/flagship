import Foundation
import FlagshipBurnerCore

/// Privileged helper daemon. Registered by the app via SMAppService and run
/// as root by launchd, it listens on a Mach service and performs the one
/// privileged step — the raw disk write — by invoking the bundled
/// `flagship-burn write-image` CLI. Because it's a launchd daemon (not a
/// process spawned through the osascript auth trampoline), it runs in a
/// clean root context that can open the raw device.

let helperVersion = "1"

final class HelperService: NSObject, FlagshipHelperProtocol {
    func ping(withReply reply: @escaping (String) -> Void) {
        reply(helperVersion)
    }

    func writeImage(imagePath: String,
                    devicePath: String,
                    logPath: String,
                    withReply reply: @escaping (Int, String) -> Void) {
        // Validate inputs defensively — this runs as root.
        guard FileManager.default.fileExists(atPath: imagePath) else {
            reply(-1, "image not found at \(imagePath)"); return
        }
        guard devicePath.hasPrefix("/dev/disk") else {
            reply(-1, "refusing non-/dev/disk device: \(devicePath)"); return
        }

        FileManager.default.createFile(atPath: logPath, contents: nil)
        let log = FileHandle(forWritingAtPath: logPath)
        func append(_ s: String) {
            if let d = (s + "\n").data(using: .utf8) { log?.write(d) }
        }

        append("FLAGSHIP_PHASE:write")
        do {
            try DiskWrite.write(imagePath: imagePath, devicePath: devicePath) { frac in
                append(String(format: "FLAGSHIP_PROGRESS:%.4f", frac))
            }
            try? log?.close()
            reply(0, "")
        } catch {
            append("write failed: \(error.localizedDescription)")
            try? log?.close()
            reply(-1, error.localizedDescription)
        }
    }
}

final class HelperDelegate: NSObject, NSXPCListenerDelegate {
    func listener(_ listener: NSXPCListener,
                  shouldAcceptNewConnection connection: NSXPCConnection) -> Bool {
        // Only accept connections from our own signed app. Pinning the
        // bundle id under Apple's anchor means an attacker would need an
        // Apple-issued cert AND our bundle id to connect.
        let req = "identifier \"\(kFlagshipAppBundleID)\" and anchor apple generic"
        if #available(macOS 13.0, *) {
            connection.setCodeSigningRequirement(req)
        }
        connection.exportedInterface = NSXPCInterface(with: FlagshipHelperProtocol.self)
        connection.exportedObject = HelperService()
        connection.resume()
        return true
    }
}

let delegate = HelperDelegate()
let listener = NSXPCListener(machServiceName: kFlagshipHelperMachName)
listener.delegate = delegate
listener.resume()
RunLoop.current.run()
