import SwiftUI
import CryptoKit
import FlagshipCore
import FlagshipAPI
import Flagship

/// Phone-as-unlock-endpoint approvals, shown inside Activity's "Server
/// approvals" section (no page of their own).
///
/// Opened by the `secret-request` push ("your box is finishing setup, open to
/// approve") or by opening the section. The requests were fetched and
/// RE-VERIFIED against the box's STK by `SecretRequestsModel`; each card shows
/// the box's device-info for a one-tap "Yes, this is my server" confirm. On
/// confirm the coordinator unseals/re-seals the LUKS key (unlock-key) or
/// IRK-signs the entitlement carrier (entitlement) and posts the reply back
/// through `.com`. The box picks it up on its poll.
struct SecretRequestsPanel: View {
    @Environment(ToastCenter.self) private var toasts
    @Environment(\.colorScheme) private var scheme
    let model: SecretRequestsModel
    /// In the accordion the list scrolls inside a bounded area; in the wide
    /// layout's detail pane it just flows.
    var bounded: Bool = true
    @ScaledMetric(relativeTo: .body) private var listMaxHeight: CGFloat = 360

    var body: some View {
        let c = FSColors.scheme(scheme)
        VStack(alignment: .leading, spacing: FS.space.s3) {
            switch model.state {
            case .idle, .loading:
                ForEach(0..<2) { _ in ServerCardSkeleton() }
            case .failed(let msg):
                ErrorCard(message: msg, retry: { await model.reload() })
            case .loaded(let requests):
                if requests.isEmpty {
                    Text(SecretRequestsModel.emptyText)
                        .font(FS.font.scaled(15)).foregroundColor(c.textMuted)
                        .accessibilityIdentifier("approvals-empty")
                } else {
                    let list = VStack(alignment: .leading, spacing: FS.space.s3) {
                        Text(SecretRequestsModel.introText)
                            .font(FS.font.bodySm())
                            .foregroundColor(c.textMuted)
                        ForEach(requests) { req in
                            SecretRequestCard(
                                request: req,
                                // First boot vs established reboot: a box that has
                                // never come online is on its FIRST boot, where
                                // this approval also authorizes it to serve, so
                                // show the full copy. Unknown defaults to it.
                                isFirstBoot: model.isFirstBoot(req.serverDomain),
                                isInFlight: model.inFlightId == req.id,
                                onApprove: { await approve(req) }
                            )
                        }
                    }
                    if bounded {
                        ScrollView { list }.frame(maxHeight: listMaxHeight)
                    } else {
                        list
                    }
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("approvals-panel")
    }

    private func approve(_ req: SecretRequestCoordinator.VerifiedRequest) async {
        switch await model.approve(req) {
        case .approved(let domain): toasts.success(String(localized: "Approved \(domain). Your server will pick it up."))
        case .alreadyAnswered: break
        case .failed(let msg): toasts.error(msg)
        }
    }
}

/// One pending request card: device-info backstop + one-tap confirm.
struct SecretRequestCard: View {
    @Environment(\.colorScheme) private var scheme
    let request: SecretRequestCoordinator.VerifiedRequest
    /// The box behind this request has never come online — its FIRST boot.
    let isFirstBoot: Bool
    let isInFlight: Bool
    let onApprove: () async -> Void

    private var purposeLabel: String {
        // On a FIRST boot the unlock approval ALSO deposits the box's entitlement
        // (consent to boot ⇒ consent to serve), so it both unlocks AND authorizes
        // the box to join the cloud — the fuller copy. On an established reboot
        // the box is already authorized, so the approval is purely a disk unlock;
        // the "…join your cloud" phrase is just noise. (The deposit still fires on
        // every approval — harmless on reboots — so this is copy only.)
        switch request.purpose {
        case .unlockKey:
            return isFirstBoot
                ? String(localized: "Unlock device and authorize it to join your cloud")
                : String(localized: "Unlock device")
        case .entitlement:  return "Authorize device to join your cloud"
        case .none:         return "Boot secret"
        }
    }

    var body: some View {
        let c = FSColors.scheme(scheme)
        FSCard {
            VStack(alignment: .leading, spacing: FS.space.s2) {
                Text(request.serverDomain).font(FS.font.mono()).foregroundColor(c.text)
                Text(purposeLabel).font(FS.font.caption()).foregroundColor(c.textMuted)

                if let info = request.deviceInfo {
                    VStack(alignment: .leading, spacing: 2) {
                        if let ip = info.ip { infoRow("IP", ip, c) }
                        if let region = info.region { infoRow(String(localized: "Region"), region, c) }
                        if let os = info.os { infoRow("OS", os, c) }
                        if let host = info.hostname { infoRow("Host", host, c) }
                    }
                    .padding(.top, FS.space.s1)
                }

                Text("Is this the machine in front of you? Only approve if you recognise it.")
                    .font(FS.font.caption())
                    .foregroundColor(c.textMuted)
                    .padding(.top, FS.space.s1)

                FSPrimaryButton(
                    isInFlight ? String(localized: "Signing…") : String(localized: "Yes, this is my server"),
                    enabled: !isInFlight,
                    block: true,
                    large: true
                ) {
                    Task { await onApprove() }
                }
                .padding(.top, FS.space.s2)
            }
        }
    }

    private func infoRow(_ label: String, _ value: String, _ c: FSColors) -> some View {
        HStack(spacing: FS.space.s2) {
            Text(label).font(FS.font.caption()).foregroundColor(c.textMuted).frame(width: 56, alignment: .leading)
            Text(value).font(FS.font.mono()).foregroundColor(c.text)
        }
    }
}
