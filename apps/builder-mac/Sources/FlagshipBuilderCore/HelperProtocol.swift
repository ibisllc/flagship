import Foundation

/// Mach service name the privileged helper listens on and the app connects
/// to. Must match the daemon plist's Label + MachServices key.
public let kFlagshipHelperMachName = "com.flagshipserver.Builder.helper"

/// Bundle identifier of the app the helper is willing to talk to. The helper
/// pins the connecting peer's code signature to this + Apple's anchor, so
/// only the genuine signed app can drive a root disk write.
public let kFlagshipAppBundleID = "com.flagshipserver.Builder"

/// XPC contract between the app (client) and the privileged helper (root
/// daemon registered via SMAppService). The helper does the one thing that
/// genuinely needs root — the raw write of an already-prepared image to a
/// USB device. The unprivileged remaster (`prepare`) still happens in the
/// app, so the root side never reads a TCC-protected folder.
@objc public protocol FlagshipHelperProtocol {
    /// Liveness/handshake check. Replies with the helper's version string.
    func ping(withReply reply: @escaping (String) -> Void)

    /// Raw-write a prepared image to `devicePath` as root (unmount + stream
    /// to /dev/rdiskN, natively). Progress is appended to `logPath` as
    /// `FLAGSHIP_PROGRESS:<0..1>` lines so the app can tail it. Replies with
    /// 0 on success (or a non-zero code) and an optional message.
    ///
    /// - imagePath:  the prepared image in /tmp (not a protected folder)
    /// - devicePath: e.g. /dev/disk9
    /// - logPath:    a /tmp file the helper appends progress to
    func writeImage(imagePath: String,
                    devicePath: String,
                    logPath: String,
                    withReply reply: @escaping (Int, String) -> Void)
}
