import Foundation

/// Before Studio makes a server (a hosted VM, a remastered ISO or a USB stick), check that the signed
/// box release the install will download is published. The bootstrap (SEC-INSTALL-001) fetches
/// `<control host>/build/iso/flagship-box-<commit12>-<arch>.{tar.gz,manifest.json}` and stops for good
/// when it is missing, so a recipe naming a release the control plane doesn't serve yet could never
/// finish (2026-11-02, home.serene-parrot). Contract: the `artifactPreflight` section of
/// apps/desktop-shared/golden/vm-core-vectors.json, shared with the Windows and Linux Studios.
public enum ArtifactPreflight {
    public enum Verdict: String, Sendable {
        case published, missing, unreachable
    }

    public static let timeoutSeconds: TimeInterval = 15

    public static var missingMessage: String {
        String(localized: "This server can't be installed yet: its software package isn't published on flagshipserver.com. Update Flagship Studio and the Flagship app, or try again later.")
    }

    public static var unreachableMessage: String {
        String(localized: "Couldn't check that this server's software package is published on flagshipserver.com. Check your internet connection and try again.")
    }

    /// The refusal for a verdict; nil when the install may go ahead.
    public static func message(for verdict: Verdict) -> String? {
        switch verdict {
        case .published: return nil
        case .missing: return missingMessage
        case .unreachable: return unreachableMessage
        }
    }

    /// The manifest the bootstrap will download, or nil when the recipe names no exact commit or the
    /// architecture is one no box runs (the bootstrap would refuse those too).
    public static func manifestURL(controlHost: String, commit: String, arch: String) -> URL? {
        guard commit.count == 40,
              commit.allSatisfy({ ("0"..."9").contains($0) || ("a"..."f").contains($0) }),
              arch == IsoArch.amd64.rawValue || arch == IsoArch.arm64.rawValue else { return nil }
        return URL(string: "https://\(controlHost)/build/iso/flagship-box-\(commit.prefix(12))-\(arch).manifest.json")
    }

    /// nil status = no answer (timeout, DNS, TLS, offline).
    public static func verdict(httpStatus: Int?) -> Verdict {
        guard let status = httpStatus else { return .unreachable }
        if (200..<300).contains(status) { return .published }
        if status == 404 || status == 410 { return .missing }
        return .unreachable
    }

    /// One HEAD for the manifest of `commit` on `arch`, against the control plane Studio follows.
    public static func check(commit: String, arch: IsoArch,
                             environment: [String: String] = ProcessInfo.processInfo.environment,
                             session: URLSession = .shared) async -> Verdict {
        guard let url = manifestURL(controlHost: ControlPlane.host(environment: environment),
                                    commit: commit, arch: arch.rawValue) else { return .missing }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData,
                                 timeoutInterval: timeoutSeconds)
        request.httpMethod = "HEAD"
        do {
            let (_, response) = try await session.data(for: request)
            return verdict(httpStatus: (response as? HTTPURLResponse)?.statusCode)
        } catch {
            return .unreachable
        }
    }
}
