import Foundation

/// Mirror of the JSON the Node CLI's `verify` subcommand emits on success.
/// Anything missing means the recipe didn't verify and we don't try to be
/// clever — the wizard treats missing fields as a hard error and surfaces
/// the raw stderr.
public struct VerifyResult: Codable, Equatable, Sendable {
    public let ok: Bool
    public let serverDomain: String
    public let username: String?
    public let serverName: String?
    public let expiresAt: String?
    public let installerGitRef: String?
    public let signatureValid: Bool?

    public init(ok: Bool,
                serverDomain: String,
                username: String? = nil,
                serverName: String? = nil,
                expiresAt: String? = nil,
                installerGitRef: String? = nil,
                signatureValid: Bool? = nil) {
        self.ok = ok
        self.serverDomain = serverDomain
        self.username = username
        self.serverName = serverName
        self.expiresAt = expiresAt
        self.installerGitRef = installerGitRef
        self.signatureValid = signatureValid
    }

    public static func parse(jsonText: String) -> VerifyResult? {
        // The CLI prints other lines around the JSON (in some modes); scan for
        // the first '{' and try to decode from there. Robust to a trailing
        // newline or a "shredded recipe: ..." line that occasionally appears
        // for the user-data subcommand.
        guard let start = jsonText.firstIndex(of: "{") else { return nil }
        let tail = jsonText[start...]
        let data = Data(tail.utf8)
        return try? JSONDecoder().decode(VerifyResult.self, from: data)
    }
}
