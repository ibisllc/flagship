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

    func writeImage(nodePath: String,
                    bundlePath: String,
                    imagePath: String,
                    devicePath: String,
                    logPath: String,
                    withReply reply: @escaping (Int, String) -> Void) {
        // Validate inputs defensively — this runs as root.
        guard FileManager.default.isExecutableFile(atPath: nodePath) else {
            reply(-1, "node not found at \(nodePath)"); return
        }
        guard FileManager.default.fileExists(atPath: bundlePath) else {
            reply(-1, "burner bundle not found at \(bundlePath)"); return
        }
        guard FileManager.default.fileExists(atPath: imagePath) else {
            reply(-1, "image not found at \(imagePath)"); return
        }
        guard devicePath.hasPrefix("/dev/disk") else {
            reply(-1, "refusing non-/dev/disk device: \(devicePath)"); return
        }

        FileManager.default.createFile(atPath: logPath, contents: nil)
        guard let log = FileHandle(forWritingAtPath: logPath) else {
            reply(-1, "cannot open log at \(logPath)"); return
        }

        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: nodePath)
        proc.arguments = [bundlePath, "write-image", imagePath, "--device", devicePath, "--yes"]
        proc.standardOutput = log
        proc.standardError = log
        do {
            try proc.run()
            proc.waitUntilExit()
            try? log.close()
            reply(Int(proc.terminationStatus), proc.terminationStatus == 0 ? "" : "write-image exited \(proc.terminationStatus)")
        } catch {
            try? log.close()
            reply(-1, "spawn failed: \(error.localizedDescription)")
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
