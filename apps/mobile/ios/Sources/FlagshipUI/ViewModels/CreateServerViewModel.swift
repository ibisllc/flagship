import Foundation
import Observation
import FlagshipAPI
import FlagshipCore

/// Orchestrates the create-server flow against FlagshipServerClient:
/// mints a build code, exposes the ISO download URL, and yields the
/// serial for the subsequent install-events SSE subscription.
@Observable
@MainActor
public final class CreateServerViewModel {
    public enum Phase: Sendable {
        case form              // user fills in name + description
        case minting           // POST /api/build-codes/mint in flight
        case codeReady(MintBuildCodeResponse)
        case failed(String)
    }

    public var phase: Phase = .form
    public var name: String = ""
    public var description: String = ""

    private let username: String
    private let client: any FlagshipServerClient

    public init(username: String, client: any FlagshipServerClient) {
        self.username = username
        self.client = client
    }

    public var canSubmit: Bool {
        !name.trimmingCharacters(in: .whitespaces).isEmpty
    }

    public func mint() async {
        guard canSubmit else { return }
        phase = .minting
        do {
            let resp = try await client.mintBuildCode(.init(
                username: username,
                podName: name,
                podDescription: description.isEmpty ? nil : description
            ))
            phase = .codeReady(resp)
        } catch {
            phase = .failed(error.localizedDescription)
        }
    }
}
