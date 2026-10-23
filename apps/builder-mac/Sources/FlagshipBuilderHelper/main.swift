import Foundation
import FlagshipBuilderCore

/// Privileged helper daemon. Registered by the app via SMAppService and run
/// as root by launchd, it listens on a Mach service and performs the one
/// privileged step, the raw disk write. Because it's a launchd daemon (not a
/// process spawned through the osascript auth trampoline), it runs in a
/// clean root context that can open the raw device.
///
/// The client names no path (SEC-MAC-002): it passes an open descriptor for the
/// image, which is copied into a root-only staging folder, and a disk name that
/// is checked here; everything after that is an opaque id this process issued.

let helperVersion = "3"
let stagingDir = "/var/db/flagship-builder-helper/stage"

final class HelperService: NSObject, FlagshipHelperProtocol {
    private let clientUID: uid_t
    private let state: HelperState

    init(clientUID: uid_t, state: HelperState) {
        self.clientUID = clientUID
        self.state = state
    }

    func ping(withReply reply: @escaping (String) -> Void) {
        reply(helperVersion)
    }

    func stageImage(_ image: FileHandle,
                    withReply reply: @escaping (String, String, Int64, String) -> Void) {
        do {
            let s = try state.stage(from: image, clientUID: clientUID)
            reply(s.id, s.sha256, s.size, "")
        } catch {
            reply("", "", 0, error.localizedDescription)
        }
        try? image.close()
    }

    func registerMedia(bsdName: String,
                       withReply reply: @escaping (String, String) -> Void) {
        do {
            guard DiskEnumerator.isWholeDiskID(bsdName) else { throw HelperPolicy.Refusal.notAWholeDiskNode(bsdName) }
            // Whether the image fits is checked at write time; registering only needs a disk that may be written at all.
            let facts = try Self.facts(of: bsdName, imageBytes: 1)
            reply(state.register(facts: facts, clientUID: clientUID).id, "")
        } catch {
            reply("", error.localizedDescription)
        }
    }

    func writeImage(imageID: String,
                    mediaID: String,
                    withReply reply: @escaping (Int, String) -> Void) {
        let image: HelperState.Staged
        let media: HelperState.Media
        do {
            image = try state.staged(id: imageID, clientUID: clientUID)
            media = try state.media(id: mediaID, clientUID: clientUID)
        } catch {
            reply(-1, error.localizedDescription); return
        }
        // One write per staged image, whatever happens next.
        defer { state.finish(imageID: imageID) }
        let diskID = media.facts.id
        let handle: FileHandle
        let facts: HelperPolicy.DiskFacts
        do {
            handle = try state.open(image)
            facts = try Self.facts(of: diskID, imageBytes: image.size)
            // The disk that answers now must be the one the app registered, not another stick in the same port.
            guard facts == media.facts else { throw HelperPolicy.Refusal.diskChanged }
        } catch {
            reply(-1, error.localizedDescription); return
        }
        func append(_ s: String) { state.append(s, imageID: imageID) }

        append("FLAGSHIP_PHASE:write")
        do {
            try DiskWrite.write(image: handle,
                                size: Int(image.size),
                                devicePath: "/dev/" + diskID,
                                beforeOpen: {
                // The disk was unmounted; make sure it is still the same one.
                let again = try Self.facts(of: diskID, imageBytes: image.size)
                guard again == facts else { throw HelperPolicy.Refusal.diskChanged }
            }) { frac in
                append(String(format: "FLAGSHIP_PROGRESS:%.4f", frac))
            }
            reply(0, "")
        } catch {
            append("write failed: \(error.localizedDescription)")
            reply(-1, error.localizedDescription)
        }
    }

    func readProgress(imageID: String,
                      from: Int,
                      withReply reply: @escaping (Int, [String]) -> Void) {
        let r = state.read(imageID: imageID, clientUID: clientUID, from: from)
        reply(r.next, r.lines)
    }

    /// Read from Disk Arbitration and the I/O Registry each time, never from a
    /// cache: the registry entry ID must still be the one registered.
    private static func facts(of id: String, imageBytes: Int64) throws -> HelperPolicy.DiskFacts {
        let systemDisks: Set<String>
        let description: DiskDescription
        do {
            systemDisks = try DiskArbitrationProbe.systemWholeDisks()
            description = try DiskArbitrationProbe.describe(bsdName: id)
        } catch {
            throw HelperPolicy.Refusal.diskInfoUnavailable("Disk Arbitration")
        }
        return try HelperPolicy.assess(description, wantedID: id, systemDisks: systemDisks, imageBytes: imageBytes)
    }
}

final class HelperDelegate: NSObject, NSXPCListenerDelegate {
    private let state = HelperState(stagingDir: stagingDir)

    func listener(_ listener: NSXPCListener,
                  shouldAcceptNewConnection connection: NSXPCConnection) -> Bool {
        // Only Flagship's own signed app may connect: Apple's anchor, our bundle
        // id, our Developer ID chain and our Team ID. The requirement is set
        // before the interface is exported, and the connection is refused on
        // a system too old to enforce it.
        guard #available(macOS 13.0, *) else { return false }
        connection.setCodeSigningRequirement(HelperPolicy.clientRequirement())
        let iface = NSXPCInterface(with: FlagshipHelperProtocol.self)
        connection.exportedInterface = iface
        connection.exportedObject = HelperService(clientUID: connection.effectiveUserIdentifier, state: state)
        connection.resume()
        return true
    }
}

// A crash or restart leaves nothing staged: the folder is emptied at start.
try? FileManager.default.removeItem(atPath: stagingDir)

let delegate = HelperDelegate()
let listener = NSXPCListener(machServiceName: kFlagshipHelperMachName)
listener.delegate = delegate
listener.resume()
RunLoop.current.run()
