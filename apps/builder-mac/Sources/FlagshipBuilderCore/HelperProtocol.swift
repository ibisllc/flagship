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
/// genuinely needs root: the raw write of an already-prepared image to a USB
/// device. The unprivileged remaster still happens in the app.
///
/// SEC-MAC-002: the client names no path. It hands over an open file descriptor
/// for the image, which the helper copies into its own root-only staging folder
/// (so the file cannot be swapped afterwards and a root-only file cannot be
/// named), and it asks the helper to register a disk, which the helper checks
/// itself. Everything after that is an opaque random id the helper issued and
/// ties to the connecting user; the progress is read back through the same
/// connection instead of from a file the helper would have to create.
@objc public protocol FlagshipHelperProtocol {
    /// Liveness/handshake check. Replies with the helper's version string.
    func ping(withReply reply: @escaping (String) -> Void)

    /// Copy the image behind `image` (a descriptor the client opened) into the
    /// helper's staging folder. Replies with an opaque image id, the SHA-256 of
    /// the staged bytes and their size, or an empty id and the refusal.
    func stageImage(_ image: FileHandle,
                    withReply reply: @escaping (_ imageID: String, _ sha256: String, _ size: Int64, _ message: String) -> Void)

    /// Check that `bsdName` (`disk4`, never a path) is an external removable
    /// whole disk that is not the system's, and remember what the helper saw.
    /// Replies with an opaque media id, or an empty id and the refusal.
    func registerMedia(bsdName: String,
                       withReply reply: @escaping (_ mediaID: String, _ message: String) -> Void)

    /// Write the staged image to the registered disk (unmount, then stream to
    /// the raw device) after checking the disk is still the one registered.
    /// Replies 0 on success, or a non-zero code and the reason.
    func writeImage(imageID: String,
                    mediaID: String,
                    withReply reply: @escaping (Int, String) -> Void)

    /// Lines the write has produced for `imageID` from line `from` on
    /// (`FLAGSHIP_PHASE:` and `FLAGSHIP_PROGRESS:` and plain log lines), and the
    /// next index to ask for.
    func readProgress(imageID: String,
                      from: Int,
                      withReply reply: @escaping (_ next: Int, _ lines: [String]) -> Void)
}
