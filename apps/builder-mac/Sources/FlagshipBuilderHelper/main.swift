import Foundation
import FlagshipBuilderCore

/// Privileged helper daemon. Registered by the app via SMAppService and run
/// as root by launchd, it listens on a Mach service and performs the one
/// privileged step — the raw disk write — by invoking the bundled
/// `flagship-build write-image` CLI. Because it's a launchd daemon (not a
/// process spawned through the osascript auth trampoline), it runs in a
/// clean root context that can open the raw device.

let helperVersion = "2"

final class HelperService: NSObject, FlagshipHelperProtocol {
    private let clientUID: uid_t

    init(clientUID: uid_t) {
        self.clientUID = clientUID
    }

    func ping(withReply reply: @escaping (String) -> Void) {
        reply(helperVersion)
    }

    func writeImage(imagePath: String,
                    devicePath: String,
                    logPath: String,
                    withReply reply: @escaping (Int, String) -> Void) {
        // This runs as root on strings from a client: open and check every
        // object here, once, and use only what was opened (HelperPolicy).
        let diskID: String
        let image: (handle: FileHandle, size: Int64)
        let log: FileHandle
        let facts: HelperPolicy.DiskFacts
        let systemDisks: Set<String>
        do {
            diskID = try HelperPolicy.wholeDiskID(fromNode: devicePath)
            image = try HelperPolicy.openImage(path: imagePath, clientUID: clientUID)
            systemDisks = try HelperPolicy.systemWholeDisks()
            facts = try Self.facts(of: diskID, systemDisks: systemDisks, imageBytes: image.size)
            log = try HelperPolicy.createLog(path: logPath, clientUID: clientUID)
        } catch {
            reply(-1, error.localizedDescription); return
        }
        func append(_ s: String) {
            if let d = (s + "\n").data(using: .utf8) { try? log.write(contentsOf: d) }
        }

        append("FLAGSHIP_PHASE:write")
        do {
            try DiskWrite.write(image: image.handle,
                                size: Int(image.size),
                                devicePath: "/dev/" + diskID,
                                beforeOpen: {
                // The disk was unmounted; make sure it is still the same one.
                let again = try Self.facts(of: diskID, systemDisks: try HelperPolicy.systemWholeDisks(), imageBytes: image.size)
                guard again == facts else { throw HelperPolicy.Refusal.diskChanged }
            }) { frac in
                append(String(format: "FLAGSHIP_PROGRESS:%.4f", frac))
            }
            try? log.close()
            reply(0, "")
        } catch {
            append("write failed: \(error.localizedDescription)")
            try? log.close()
            reply(-1, error.localizedDescription)
        }
    }

    private static func facts(of id: String,
                              systemDisks: Set<String>,
                              imageBytes: Int64) throws -> HelperPolicy.DiskFacts {
        let plist: Data
        do { plist = try DiskEnumerator.runDiskutil(["info", "-plist", id]) }
        catch { throw HelperPolicy.Refusal.diskInfoUnavailable("diskutil") }
        return try HelperPolicy.assess(plist: plist, wantedID: id, systemDisks: systemDisks, imageBytes: imageBytes)
    }
}

final class HelperDelegate: NSObject, NSXPCListenerDelegate {
    func listener(_ listener: NSXPCListener,
                  shouldAcceptNewConnection connection: NSXPCConnection) -> Bool {
        // Only Flagship's own signed app may connect: Apple's anchor, our bundle
        // id, our Developer ID chain and our Team ID. The requirement is set
        // before the interface is exported, and the connection is refused on
        // a system too old to enforce it.
        guard #available(macOS 13.0, *) else { return false }
        connection.setCodeSigningRequirement(HelperPolicy.clientRequirement())
        connection.exportedInterface = NSXPCInterface(with: FlagshipHelperProtocol.self)
        connection.exportedObject = HelperService(clientUID: connection.effectiveUserIdentifier)
        connection.resume()
        return true
    }
}

let delegate = HelperDelegate()
let listener = NSXPCListener(machServiceName: kFlagshipHelperMachName)
listener.delegate = delegate
listener.resume()
RunLoop.current.run()
