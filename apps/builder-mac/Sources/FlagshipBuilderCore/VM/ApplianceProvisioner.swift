import CryptoKit
import Darwin
import Foundation

public struct ApplianceBaseManifest: Codable, Equatable, Sendable {
    public let version: Int
    public let arch: IsoArch
    public let installerGitRef: String
    public let sha256: String
    public let sizeBytes: UInt64
    public let virtualSizeBytes: UInt64

    public init(version: Int = 1,
                arch: IsoArch,
                installerGitRef: String,
                sha256: String,
                sizeBytes: UInt64,
                virtualSizeBytes: UInt64) {
        self.version = version
        self.arch = arch
        self.installerGitRef = installerGitRef
        self.sha256 = sha256
        self.sizeBytes = sizeBytes
        self.virtualSizeBytes = virtualSizeBytes
    }
}

public enum ApplianceProvisionError: LocalizedError, Equatable {
    case baseMissing(String)
    case manifestMissing(String)
    case invalidManifest(String)
    case architectureMismatch(expected: IsoArch, got: IsoArch)
    case gitRefMismatch(expected: String, got: String)
    case sizeMismatch(expected: UInt64, got: UInt64)
    case checksumMismatch(expected: String, got: String)
    case targetTooSmall(required: UInt64, configured: UInt64)

    public var errorDescription: String? {
        switch self {
        case .baseMissing(let path):
            return "The prebuilt VM image is missing: \(path)"
        case .manifestMissing(let path):
            return "The prebuilt VM image manifest is missing: \(path)"
        case .invalidManifest(let reason):
            return "The prebuilt VM image manifest is invalid: \(reason)"
        case .architectureMismatch(let expected, let got):
            return "The prebuilt VM image is for \(got.rawValue), but this Mac needs \(expected.rawValue)."
        case .gitRefMismatch(let expected, let got):
            return "The prebuilt VM image contains installer ref \(got), but this recipe requires \(expected)."
        case .sizeMismatch(let expected, let got):
            return "The prebuilt VM image has \(got) bytes, but its manifest declares \(expected)."
        case .checksumMismatch(let expected, let got):
            return "The prebuilt VM image failed its integrity check (expected \(expected.prefix(12))…, got \(got.prefix(12))…)."
        case .targetTooSmall(let required, let configured):
            return "The hosted-server disk is too small for this image (needs \(required) bytes; configured for \(configured))."
        }
    }
}

public struct ApplianceProvisioner: Sendable {
    public let baseURL: URL
    public let manifest: ApplianceBaseManifest

    public static func load(baseURL: URL,
                            manifestURL: URL? = nil,
                            expectedArch: IsoArch,
                            installerGitRef: String) throws -> ApplianceProvisioner {
        let fm = FileManager.default
        guard fm.fileExists(atPath: baseURL.path) else {
            throw ApplianceProvisionError.baseMissing(baseURL.path)
        }
        let resolvedManifest = manifestURL
            ?? URL(fileURLWithPath: baseURL.path + ".json")
        guard fm.fileExists(atPath: resolvedManifest.path) else {
            throw ApplianceProvisionError.manifestMissing(resolvedManifest.path)
        }
        let manifest: ApplianceBaseManifest
        do {
            manifest = try JSONDecoder().decode(
                ApplianceBaseManifest.self, from: Data(contentsOf: resolvedManifest))
        } catch {
            throw ApplianceProvisionError.invalidManifest(error.localizedDescription)
        }
        guard manifest.version == 1,
              manifest.sha256.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil,
              manifest.sizeBytes > 0,
              manifest.virtualSizeBytes >= manifest.sizeBytes else {
            throw ApplianceProvisionError.invalidManifest("unsupported version or malformed size/checksum")
        }
        guard manifest.arch == expectedArch else {
            throw ApplianceProvisionError.architectureMismatch(expected: expectedArch, got: manifest.arch)
        }
        guard manifest.installerGitRef == installerGitRef else {
            throw ApplianceProvisionError.gitRefMismatch(
                expected: installerGitRef, got: manifest.installerGitRef)
        }
        let attrs = try fm.attributesOfItem(atPath: baseURL.path)
        let actualSize = (attrs[.size] as? NSNumber)?.uint64Value ?? 0
        guard actualSize == manifest.sizeBytes else {
            throw ApplianceProvisionError.sizeMismatch(expected: manifest.sizeBytes, got: actualSize)
        }
        let actualSha = try sha256OfFile(baseURL)
        guard actualSha == manifest.sha256 else {
            throw ApplianceProvisionError.checksumMismatch(
                expected: manifest.sha256, got: actualSha)
        }
        return ApplianceProvisioner(baseURL: baseURL, manifest: manifest)
    }

    public func provision(config: VMConfig,
                          layout: VMBundleLayout,
                          recipe: Data,
                          bootstrap: String) throws {
        guard config.mainDiskSizeBytes >= manifest.virtualSizeBytes else {
            throw ApplianceProvisionError.targetTooSmall(
                required: manifest.virtualSizeBytes, configured: config.mainDiskSizeBytes)
        }
        let diskURL = layout.diskImageURL(config.name)
        let seedURL = layout.applianceSeedURL(config.name)
        try Self.cloneOrCopy(baseURL, to: diskURL)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: diskURL.path)
        let disk = try FileHandle(forWritingTo: diskURL)
        defer { try? disk.close() }
        try disk.truncate(atOffset: config.mainDiskSizeBytes)

        let seed = try ApplianceSeed.encode(recipe: recipe, bootstrap: bootstrap)
        try seed.write(to: seedURL, options: [.atomic])
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: seedURL.path)
    }

    static func cloneOrCopy(_ source: URL, to destination: URL) throws {
        let result = source.path.withCString { src in
            destination.path.withCString { dst in Darwin.clonefile(src, dst, 0) }
        }
        if result == 0 { return }
        try? FileManager.default.removeItem(at: destination)
        try FileManager.default.copyItem(at: source, to: destination)
    }

    static func sha256OfFile(_ url: URL) throws -> String {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        var hasher = SHA256()
        while true {
            let chunk = try handle.read(upToCount: 1 << 20) ?? Data()
            if chunk.isEmpty { break }
            hasher.update(data: chunk)
        }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }
}
