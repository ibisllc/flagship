import Foundation
import Observation
import FlagshipAPI
import FlagshipCore

/// P6 — drives the per-app invite issuance form. Mints a fresh 16-byte
/// `opaqueTag` locally, calls `appInviteIssue(_:)`, persists the local
/// label (display name / channel / sent-to memo / notes) into the
/// `InviteLabelBook`, and surfaces `{ secret, expiresAt }` so the screen
/// can build the share URL + open the system share sheet.
///
/// Privacy invariant: the daemon only ever sees `opaqueTag` + the
/// owner-supplied `contextNote`. The local label fields stay on this
/// device.
@MainActor
@Observable
public final class InviteIssueViewModel {
    public enum Phase: Equatable, Sendable {
        case idle
        case issuing
        case issued(secret: String, expiresAt: Int64, shareUrl: String)
        case failed(String)
    }

    public var displayName: String = ""
    public var role: String = "member"
    public var channel: String = "other"
    public var sentTo: String = ""
    public var notes: String = ""
    public var contextNote: String = ""

    public private(set) var phase: Phase = .idle

    /// The opaqueTag minted at submit-time. Kept here so the manage
    /// screen test rig can assert the same tag flowed into the wire
    /// request + the label-book row.
    public private(set) var lastOpaqueTag: String?

    public let serviceId: String
    public let appUrl: String
    private let client: any ScreensClient
    private let labelBook: any InviteLabelBook
    private let tagMint: @Sendable () -> String
    private let now: @Sendable () -> Int64

    public init(
        serviceId: String,
        appUrl: String,
        client: any ScreensClient,
        labelBook: any InviteLabelBook,
        tagMint: @escaping @Sendable () -> String = { InviteUtil.generateOpaqueTag() },
        now: @escaping @Sendable () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }
    ) {
        self.serviceId = serviceId
        self.appUrl = appUrl
        self.client = client
        self.labelBook = labelBook
        self.tagMint = tagMint
        self.now = now
    }

    public func issue() async {
        let trimmedDisplay = displayName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedDisplay.isEmpty else {
            phase = .failed("label is required (kept local)")
            return
        }
        let trimmedRole = role.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedRole.isEmpty else {
            phase = .failed("role is required")
            return
        }
        let tag = tagMint()
        lastOpaqueTag = tag
        phase = .issuing
        let trimmedContext = contextNote.trimmingCharacters(in: .whitespacesAndNewlines)
        let wireContextNote: String? = trimmedContext.isEmpty ? nil : trimmedContext
        let req = AppInviteIssueRequest(
            serviceId: serviceId,
            role: trimmedRole,
            opaqueTag: tag,
            contextNote: wireContextNote
        )
        do {
            let resp = try await client.appInviteIssue(req)
            // Persist the local label BEFORE surfacing the share URL —
            // if the user backgrounds the app mid-share-sheet, the
            // label still survives for the manage view.
            labelBook.put(
                serviceId: serviceId,
                opaqueTagHex: tag,
                label: InviteLabel(
                    displayName: trimmedDisplay,
                    channel: channel,
                    sentTo: sentTo,
                    notes: notes,
                    sentAt: now()
                )
            )
            let shareUrl = InviteUtil.buildShareUrl(
                appUrl: appUrl,
                secretHex: resp.secret,
                serviceId: serviceId
            )
            phase = .issued(secret: resp.secret, expiresAt: resp.expiresAt, shareUrl: shareUrl)
        } catch {
            phase = .failed(error.localizedDescription)
        }
    }

    public func reset() {
        phase = .idle
        lastOpaqueTag = nil
    }
}
