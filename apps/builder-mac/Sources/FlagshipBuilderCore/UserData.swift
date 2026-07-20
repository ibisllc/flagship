import Foundation

/// Thin façade over the SINGLE canonical preseed / user-data generator (run via
/// `PreseedEngine` / JavaScriptCore). This file USED to carry a full ~2,200-line
/// Swift re-implementation of the generator (a second copy of a
/// security-critical, signed-bootstrap path that could drift from the canonical
/// TypeScript). That body is GONE — these two functions now marshal their
/// arguments into the engine's `burnOpts` and delegate. The ISO surgery lives in
/// `Remaster.swift` (NOT the generator) and is untouched.
///
/// `recipeJSON` is the raw, already signature-verified recipe bytes (the engine
/// does NOT re-verify). The signed blob is authoritative for disk-encryption and
/// boot-unlock mode; the unsigned `debugGrant` sibling drives the box-side debug
/// gate — so `bootUnlockMode` / `debugMode` here are recipe-driven and the legacy
/// parameters are kept only for source-compatibility.
public enum UserData {
    public static let defaultRepoURL = "https://github.com/ibisllc/flagship.git"

    /// The dedicated boot worker (boot.flagshipserver.com). Identical to the
    /// engine's DEFAULT_BOOT_HOST.
    public static let defaultBootHost = "https://boot.flagshipserver.com"

    /// Ubuntu autoinstall user-data for the verified recipe.
    public static func autoinstallYAML(recipeJSON: Data,
                                       installerGitRef: String,
                                       repoURL: String = defaultRepoURL,
                                       encryptRoot: Bool = true,
                                       bootUnlockMode: String = "auto",
                                       bootHost: String = defaultBootHost,
                                       wifiSSID: String? = nil,
                                       wifiPassword: String? = nil,
                                       debugMode: Bool = false) throws -> String {
        try PreseedEngine.shared.buildUserData(
            recipeJSON: recipeJSON,
            burnOpts: burnOptions(installerGitRef: installerGitRef,
                                  repoURL: repoURL,
                                  encryptRoot: encryptRoot,
                                  bootHost: bootHost,
                                  wifiSSID: wifiSSID,
                                  wifiPassword: wifiPassword))
    }

    /// Debian d-i preseed.cfg for the verified recipe — the twin of
    /// autoinstallYAML for the debian ISO path.
    public static func debianPreseed(recipeJSON: Data,
                                     installerGitRef: String,
                                     repoURL: String = defaultRepoURL,
                                     encryptRoot: Bool = true,
                                     bootUnlockMode: String = "auto",
                                     bootHost: String = defaultBootHost,
                                     wifiSSID: String? = nil,
                                     wifiPassword: String? = nil,
                                     debugMode: Bool = false) throws -> String {
        try PreseedEngine.shared.buildPreseed(
            recipeJSON: recipeJSON,
            burnOpts: burnOptions(installerGitRef: installerGitRef,
                                  repoURL: repoURL,
                                  encryptRoot: encryptRoot,
                                  bootHost: bootHost,
                                  wifiSSID: wifiSSID,
                                  wifiPassword: wifiPassword))
    }

    private static func burnOptions(installerGitRef: String,
                                    repoURL: String,
                                    encryptRoot: Bool,
                                    bootHost: String,
                                    wifiSSID: String?,
                                    wifiPassword: String?) -> PreseedEngine.BurnOptions {
        let trimmedRef = installerGitRef.trimmingCharacters(in: .whitespacesAndNewlines)
        return PreseedEngine.BurnOptions(
            encryptRoot: encryptRoot,
            wifiSSID: wifiSSID,
            wifiPassword: wifiPassword,
            // A blank ref is dropped (BurnOptions.json) so the engine falls back
            // to the signed blob's installerGitRef, then "main".
            installerGitRef: trimmedRef.isEmpty ? nil : trimmedRef,
            flagshipRepoUrl: repoURL,
            bootHost: bootHost)
    }
}
