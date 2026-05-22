import Foundation

/// Mach service name the privileged helper listens on and the app connects
/// to. Must match the daemon plist's Label + MachServices key.
public let kFlagshipHelperMachName = "com.flagshipserver.Burner.helper"

/// Bundle identifier of the app the helper is willing to talk to. The helper
/// pins the connecting peer's code signature to this + Apple's anchor, so
/// only the genuine signed app can drive a root disk write.
public let kFlagshipAppBundleID = "com.flagshipserver.Burner"

/// XPC contract between the app (client) and the privileged helper (root
/// daemon registered via SMAppService). The helper does the one thing that
/// genuinely needs root — the raw write of an already-prepared image to a
/// USB device. The unprivileged remaster (`prepare`) still happens in the
/// app, so the root side never reads a TCC-protected folder.
@objc public protocol FlagshipHelperProtocol {
    /// Liveness/handshake check. Replies with the helper's version string.
    func ping(withReply reply: @escaping (String) -> Void)

    /// Raw-write a prepared image to `devicePath` as root. The helper runs
    /// the bundled `flagship-burn write-image` CLI (which unmounts the disk
    /// and streams to the raw device), appending its output to `logPath` so
    /// the app can tail progress. Replies with the CLI exit code and an
    /// optional message.
    ///
    /// - nodePath:   absolute path to the `node` binary (resolved by the app)
    /// - bundlePath: absolute path to flagship-burn.mjs inside the .app
    /// - imagePath:  the prepared image in /tmp (not a protected folder)
    /// - devicePath: e.g. /dev/disk9
    /// - logPath:    a /tmp file the helper writes CLI output to
    func writeImage(nodePath: String,
                    bundlePath: String,
                    imagePath: String,
                    devicePath: String,
                    logPath: String,
                    withReply reply: @escaping (Int, String) -> Void)
}
