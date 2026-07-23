import Foundation
import Observation
import Flagship
import FlagshipAPI
import FlagshipCore

/// Backs the phone side of desktop-initiated companion docking.
@MainActor
@Observable
public final class CompanionDockViewModel {
    public private(set) var state: LoadingState<CompanionListResponse> = .idle
    public private(set) var stagedApproval: CompanionDockApprovalLink.Payload?
    public private(set) var approvalPending = false
    public private(set) var approvalError: String?
    public private(set) var approvalComplete = false
    public private(set) var revokePending: Set<String> = []

    private let client: any ScreensClient
    private let expectedServerDomain: String?
    private let authenticate: @MainActor @Sendable (String) async throws -> Void

    public init(
        client: any ScreensClient,
        expectedServerDomain: String? = nil,
        authenticate: @escaping @MainActor @Sendable (String) async throws -> Void = { reason in
            try await BiometricGate().evaluate(reason: reason)
        }
    ) {
        self.client = client
        self.expectedServerDomain = expectedServerDomain?.lowercased()
        self.authenticate = authenticate
    }

    public func load() async {
        state = .loading
        do {
            state = .loaded(try await client.companionList())
        } catch {
            state = .failed(error.localizedDescription)
        }
    }

    @discardableResult
    public func stageApproval(link raw: String) -> Bool {
        approvalError = nil
        approvalComplete = false
        guard let parsed = CompanionDockApprovalLink.parse(raw) else {
            stagedApproval = nil
            approvalError = "This isn't a valid Flagship docking link."
            return false
        }
        if let expectedServerDomain, parsed.serverDomain != expectedServerDomain {
            stagedApproval = nil
            approvalError = "Switch to \(parsed.serverDomain) in Flagship, then scan this code again."
            return false
        }
        stagedApproval = parsed
        return true
    }

    public func clearApproval() {
        stagedApproval = nil
        approvalError = nil
        approvalComplete = false
    }

    public func approve() async {
        guard let stagedApproval, !approvalPending else { return }
        approvalPending = true
        approvalError = nil
        defer { approvalPending = false }
        do {
            try await authenticate("Dock this browser to your Flagship account")
            _ = try await client.companionApproveDock(
                CompanionDockApproveRequest(
                    requestId: stagedApproval.requestId,
                    approvalSecret: stagedApproval.approvalSecret
                )
            )
            approvalComplete = true
            self.stagedApproval = nil
            await load()
        } catch {
            approvalError = error.localizedDescription
        }
    }

    public func revoke(tokenPrefix: String) async {
        revokePending.insert(tokenPrefix)
        defer { revokePending.remove(tokenPrefix) }
        do {
            _ = try await client.companionRevoke(
                CompanionRevokeRequest(tokenPrefix: tokenPrefix)
            )
            if case .loaded(let list) = state {
                state = .loaded(
                    CompanionListResponse(
                        companions: list.companions.filter { $0.tokenPrefix != tokenPrefix }
                    )
                )
            }
        } catch {
            state = .failed(error.localizedDescription)
        }
    }
}
