import Foundation

/// Talks to the server's ISO-manifest endpoint to decide which base ISO the
/// builder should hold. The builder is a DUMB EXECUTOR: it reports the version +
/// sha256 of whatever it has cached (or `nil` if it has nothing) and the server
/// replies with either an order to download a specific URL/sha/version or `null`
/// meaning "keep what you've got". The client never compares shas to decide;
/// it just obeys the order and then verifies the bytes it downloads.
///
/// LOCKED WIRE CONTRACT:
///   POST https://flagshipserver.com/api/iso-manifest
///   Request:  { "platform":"mac", "builderVersion":"<s>",
///               "current": { "version":"<s>", "sha256":"<hex64>" } | null,
///               "arch": "amd64" | "arm64" (OPTIONAL; absent = "amd64") }
///   Response: { "download": { "url","sha256","version","sizeBytes","attestation" } }
///        or:  { "download": null }
///   `download: null` means "keep what you've got" — UNLESS the requested arch
///   has no blessed manifest at all, in which case it means "nothing to offer";
///   the caller distinguishes the two by whether it has a cached base.

/// Base-ISO architecture. Burning always targets amd64 (real boxes are x86);
/// arm64 exists solely for the host-a-VM path, where Virtualization.framework
/// boots native-arch guests only.
public enum IsoArch: String, Codable, CaseIterable, Sendable {
    case amd64
    case arm64
}

/// What the builder currently holds in its cache, reported verbatim to the server.
public struct IsoManifestCurrent: Codable, Equatable, Sendable {
    public let version: String
    public let sha256: String

    public init(version: String, sha256: String) {
        self.version = version
        self.sha256 = sha256
    }
}

/// The request body POSTed to /api/iso-manifest.
public struct IsoManifestRequest: Codable, Equatable, Sendable {
    public let platform: String
    public let builderVersion: String
    public let current: IsoManifestCurrent?
    public let arch: IsoArch

    public init(platform: String = "mac", builderVersion: String,
                current: IsoManifestCurrent?, arch: IsoArch = .amd64) {
        self.platform = platform
        self.builderVersion = builderVersion
        self.current = current
        self.arch = arch
    }

    // Hand-rolled Codable: amd64 is encoded as an ABSENT `arch` key so the
    // burn-path request stays byte-identical to the pre-arch wire format
    // (absent = amd64 server-side, the back-compat default).
    private enum CodingKeys: String, CodingKey {
        case platform, builderVersion, current, arch
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        platform = try c.decode(String.self, forKey: .platform)
        builderVersion = try c.decode(String.self, forKey: .builderVersion)
        current = try c.decodeIfPresent(IsoManifestCurrent.self, forKey: .current)
        arch = try c.decodeIfPresent(IsoArch.self, forKey: .arch) ?? .amd64
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(platform, forKey: .platform)
        try c.encode(builderVersion, forKey: .builderVersion)
        try c.encodeIfPresent(current, forKey: .current)
        if arch != .amd64 { try c.encode(arch, forKey: .arch) }
    }
}

/// The server's "download this exact ISO" order.
public struct IsoManifestDownload: Codable, Equatable, Sendable {
    public let url: String
    public let sha256: String
    public let version: String
    public let sizeBytes: Int
    public let attestation: String

    public init(url: String, sha256: String, version: String, sizeBytes: Int, attestation: String) {
        self.url = url
        self.sha256 = sha256
        self.version = version
        self.sizeBytes = sizeBytes
        self.attestation = attestation
    }
}

/// The response body. Exactly one shape: `download` is either an order or null.
public struct IsoManifestResponse: Codable, Equatable, Sendable {
    public let download: IsoManifestDownload?

    public init(download: IsoManifestDownload?) {
        self.download = download
    }
}

public enum IsoManifestError: LocalizedError {
    case offline(String)
    case httpStatus(Int)
    case decode(String)

    public var errorDescription: String? {
        switch self {
        case .offline(let why):
            return "Couldn't reach the base-image service — check your internet connection. (\(why))"
        case .httpStatus(let code):
            return "The base-image service returned HTTP \(code)."
        case .decode(let why):
            return "The base-image service sent a response we couldn't read. (\(why))"
        }
    }
}

public struct IsoManifestClient: Sendable {
    public static let endpoint = URL(string: "https://flagshipserver.com/api/iso-manifest")!

    private let endpoint: URL
    private let session: URLSession

    public init(endpoint: URL = IsoManifestClient.endpoint, session: URLSession = .shared) {
        self.endpoint = endpoint
        self.session = session
    }

    /// POST the manifest request and decode the reply. Throws `IsoManifestError`
    /// on transport, HTTP, or decode failure.
    public func fetch(_ request: IsoManifestRequest) async throws -> IsoManifestResponse {
        var req = URLRequest(url: endpoint)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        req.timeoutInterval = 30
        do {
            req.httpBody = try JSONEncoder().encode(request)
        } catch {
            throw IsoManifestError.decode("could not encode request: \(error.localizedDescription)")
        }

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: req)
        } catch let e as URLError {
            throw IsoManifestError.offline(e.localizedDescription)
        }
        if let http = response as? HTTPURLResponse, !(200...299).contains(http.statusCode) {
            throw IsoManifestError.httpStatus(http.statusCode)
        }
        do {
            return try JSONDecoder().decode(IsoManifestResponse.self, from: data)
        } catch {
            throw IsoManifestError.decode(error.localizedDescription)
        }
    }
}
