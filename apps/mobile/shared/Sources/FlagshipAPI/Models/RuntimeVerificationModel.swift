import Foundation

/// The server page's "Runtime" section (release plan G2): the Node.js the box runs, its official source, the
/// checksum Flagship publishes for it and the state of Node's and Flagship's signatures. The box reports it on
/// server-detail (`runtime`, packages/server-daemon/src/runtimeVerification.ts); this only presents it, like the
/// webapp's lib/runtimeVerification.js, and passes the same vectors
/// (packages/protocol/test-vectors/runtime-verification/).
public struct RuntimeVerificationView: Codable, Equatable, Sendable {
    public struct Upstream: Codable, Equatable, Sendable {
        public var status: String
        public var signer: String?
    }

    public struct Flagship: Codable, Equatable, Sendable {
        /// verified, not-published, unavailable, expired, or a refusal reason.
        public var status: String
        public var expectedArchiveSha256: String?
        public var sequence: Int64?
        public var release: String?
        public var version: String?
        public var validUntil: Int64?
        public var matchesLock: Bool?
        public var checkedAt: Int64?
    }

    public var runtime: String
    public var version: String
    public var activeVersion: String
    public var target: String
    public var officialUrl: String
    public var sourceUrl: String
    public var shasumsUrl: String
    public var archiveFile: String
    public var expectedArchiveSha256: String
    public var expectedExecutableSha256: String
    public var executablePath: String
    public var localExecutableSha256: String?
    public var matchesLock: Bool
    public var upstream: Upstream?
    public var flagship: Flagship?
    public var lockSha256: String
    public var pageUrl: String
    public var manifestUrl: String

    enum CodingKeys: String, CodingKey {
        case runtime, version, activeVersion, target, officialUrl, sourceUrl, shasumsUrl, archiveFile
        case expectedArchiveSha256, expectedExecutableSha256, executablePath, localExecutableSha256, matchesLock
        case upstream, flagship, lockSha256, pageUrl, manifestUrl
    }

    // Lenient on purpose: a malformed section must never stop the whole server page from loading;
    // `isUsable` hides it instead, as the webapp's runtimeView does.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        func str(_ k: CodingKeys) -> String { (try? c.decodeIfPresent(String.self, forKey: k)) ?? "" }
        runtime = str(.runtime)
        let v = try? c.decodeIfPresent(String.self, forKey: .version)
        version = v ?? ""
        versionPresent = v != nil
        activeVersion = str(.activeVersion)
        target = str(.target)
        officialUrl = str(.officialUrl)
        sourceUrl = str(.sourceUrl)
        shasumsUrl = str(.shasumsUrl)
        archiveFile = str(.archiveFile)
        expectedArchiveSha256 = str(.expectedArchiveSha256)
        expectedExecutableSha256 = str(.expectedExecutableSha256)
        executablePath = str(.executablePath)
        localExecutableSha256 = try? c.decodeIfPresent(String.self, forKey: .localExecutableSha256)
        matchesLock = (try? c.decodeIfPresent(Bool.self, forKey: .matchesLock)) ?? false
        upstream = try? c.decodeIfPresent(Upstream.self, forKey: .upstream)
        flagship = try? c.decodeIfPresent(Flagship.self, forKey: .flagship)
        lockSha256 = str(.lockSha256)
        pageUrl = str(.pageUrl)
        manifestUrl = str(.manifestUrl)
    }

    private var versionPresent = true

    /// False for a section the page can't show (no version or no Flagship status).
    public var isUsable: Bool { versionPresent && flagship != nil }

    public enum Tone: String, Sendable { case good, neutral, bad }

    public struct Pill: Equatable, Sendable {
        public let tone: Tone
        public let label: String
    }

    public struct Note: Equatable, Sendable {
        public let tone: Tone
        public let text: String
    }

    public struct Command: Equatable, Sendable {
        public let title: String
        public let text: String
    }

    public static func platformLabel(_ target: String) -> String {
        switch target {
        case "linux-amd64": return "Linux x86-64"
        case "linux-arm64": return "Linux ARM64"
        default: return target
        }
    }

    public var platform: String { Self.platformLabel(target) }

    private var flagshipCode: String { flagship?.status ?? "" }

    public var flagshipStatus: Pill {
        switch flagshipCode {
        case "verified": return Pill(tone: .good, label: String(localized: "Verified"))
        case "not-published": return Pill(tone: .neutral, label: String(localized: "Not published yet"))
        case "unavailable": return Pill(tone: .neutral, label: String(localized: "Can't reach flagshipserver.com"))
        case "expired": return Pill(tone: .bad, label: String(localized: "Expired"))
        default: return Pill(tone: .bad, label: String(localized: "Refused"))
        }
    }

    public var upstreamStatus: Pill {
        upstream?.status == "verified-at-release"
            ? Pill(tone: .good, label: String(localized: "Checked when this release was built"))
            : Pill(tone: .neutral, label: String(localized: "Not checked"))
    }

    private var hasLocal: Bool { !(localExecutableSha256 ?? "").isEmpty }

    public var localStatus: Pill {
        guard hasLocal else { return Pill(tone: .neutral, label: String(localized: "Not checked")) }
        return matchesLock
            ? Pill(tone: .good, label: String(localized: "Matches"))
            : Pill(tone: .bad, label: String(localized: "Does not match"))
    }

    public var notes: [Note] {
        var out: [Note] = []
        if hasLocal && !matchesLock {
            out.append(Note(tone: .bad, text: String(localized: "This server runs a Node.js that is not the one its release locks.")))
        }
        let s = flagshipCode
        if !["verified", "not-published", "unavailable", "expired"].contains(s) {
            out.append(Note(tone: .bad, text: String(localized: "Flagship's signed runtime manifest was refused (\(s)).")))
        }
        if s == "verified" && flagship?.matchesLock == false {
            out.append(Note(tone: .neutral, text: String(localized: "This release locks a newer Node.js than the published manifest.")))
        }
        return out
    }

    /// The checksum Flagship published, falling back to the release's own lock.
    public var expectedChecksum: String { flagship?.expectedArchiveSha256 ?? expectedArchiveSha256 }

    /// "Check it yourself": plain shell, the same on every client.
    public var commands: [Command] {
        let sums = shasumsUrl.split(separator: "/", omittingEmptySubsequences: false).last.map(String.init) ?? shasumsUrl
        let sig = "\(sums).sig"
        return [
            Command(title: String(localized: "1. Node's signed checksum list"), text: [
                "curl -fsSLO \(officialUrl)",
                "curl -fsSLO \(shasumsUrl)",
                "curl -fsSLO \(shasumsUrl).sig",
                "gpg --verify \(sig) \(sums)",
                "grep ' \(archiveFile)$' \(sums)",
                "sha256sum \(archiveFile)",
                "# \(expectedArchiveSha256)",
            ].joined(separator: "\n")),
            Command(title: String(localized: "2. Flagship's signed manifest"), text: [
                "curl -fsS \(manifestUrl) -o runtime-manifest.json",
                "jq -j .lockJson runtime-manifest.json | sha256sum",
                "# \(lockSha256)",
                "git clone https://github.com/ibisllc/flagship && cd flagship && npm ci",
                "npx tsx tools/box-artifact/runtime-manifest.ts verify --manifest ../runtime-manifest.json",
            ].joined(separator: "\n")),
            Command(title: String(localized: "3. On the server (with debug access on)"), text: [
                "sha256sum \(executablePath)",
                "# \(expectedExecutableSha256)",
                "\(executablePath) --version",
                "# v\(version)",
            ].joined(separator: "\n")),
        ]
    }
}
