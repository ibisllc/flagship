import XCTest
import SwiftUI
@testable import FlagshipCore
@testable import FlagshipUI
@testable import FlagshipAPI

/// Pure-logic coverage for the WhatsApp-inspired redesign primitives:
/// monogram initials, the Home status-filter chips, the Apps owner-filter
/// chips, and the shared PodStatusStyle label/kind mapping. These drive the
/// presentation the three hero screens render — keeping them green guarantees
/// the restyle never silently reclassifies a server or hides a row.
final class UIRedesignComponentsTests: XCTestCase {

    // ─── fsInitials (FSMonogram / FSProfileCard) ───────────────────────────

    func test_initials_takesFirstTwoAlphanumerics_uppercased() {
        XCTAssertEqual(fsInitials("harry"), "HA")
        XCTAssertEqual(fsInitials("Harry Winner"), "HA")
        XCTAssertEqual(fsInitials("demo1234"), "DE")
        XCTAssertEqual(fsInitials("a"), "A")
    }

    func test_initials_skipsLeadingSymbols() {
        XCTAssertEqual(fsInitials("@bob"), "BO")
        XCTAssertEqual(fsInitials("  jo"), "JO")
    }

    func test_initials_fallsBackForEmptyOrSymbolOnly() {
        XCTAssertEqual(fsInitials(""), "?")
        XCTAssertEqual(fsInitials("…"), "?")
    }

    // ─── HomeStatusFilter ──────────────────────────────────────────────────

    private func pod(_ status: PodInfo.Status, fqdn: String = "box.harry.flagship.services",
                     cameOnline: Bool = true, registeredAt: Int64 = 0,
                     name: String = "box", description: String? = nil) -> PodInfo {
        PodInfo(podId: PodInfo.podId(forFqdn: fqdn), name: name, description: description,
                fqdn: fqdn, status: status, cameOnline: cameOnline, registeredAt: registeredAt)
    }

    func test_homeFilter_all_matchesEverything() {
        let p = pod(.pending)
        let live = p.livenessState(hasLiveUnlockRequest: false)
        XCTAssertTrue(HomeStatusFilter.all.matches(pod: p, liveness: live))
    }

    func test_homeFilter_online_onlyLiveServers() {
        let online = pod(.online)
        let offline = pod(.offline)
        XCTAssertTrue(HomeStatusFilter.online.matches(pod: online, liveness: online.livenessState(hasLiveUnlockRequest: false)))
        XCTAssertFalse(HomeStatusFilter.online.matches(pod: offline, liveness: offline.livenessState(hasLiveUnlockRequest: false)))
    }

    func test_homeFilter_pending_bucketsWaitingAndComingOnline() {
        // A pending (pre-registration) pod classifies comingOnline.
        let pending = pod(.pending)
        XCTAssertTrue(HomeStatusFilter.pending.matches(pod: pending, liveness: pending.livenessState(hasLiveUnlockRequest: false)))
        // A box with a live unlock request is waitingForApproval → pending bucket.
        let waiting = pod(.offline, cameOnline: false)
        XCTAssertTrue(HomeStatusFilter.pending.matches(pod: waiting, liveness: waiting.livenessState(hasLiveUnlockRequest: true)))
    }

    func test_homeFilter_offline_bucketsDeadAndOffline() {
        // Registered long ago, never checked in → dead.
        let dead = pod(.unknown, cameOnline: false, registeredAt: 1)
        XCTAssertEqual(dead.livenessState(hasLiveUnlockRequest: false), .dead)
        XCTAssertTrue(HomeStatusFilter.offline.matches(pod: dead, liveness: dead.livenessState(hasLiveUnlockRequest: false)))
        // A live-but-offline server.
        let off = pod(.offline)
        XCTAssertTrue(HomeStatusFilter.offline.matches(pod: off, liveness: off.livenessState(hasLiveUnlockRequest: false)))
        // An online server is NOT in the offline bucket.
        let on = pod(.online)
        XCTAssertFalse(HomeStatusFilter.offline.matches(pod: on, liveness: on.livenessState(hasLiveUnlockRequest: false)))
    }

    func test_homeFilter_allCasesCoverEveryServer_noServerVanishes() {
        // Every pod must appear under .all and under at least one specific chip,
        // so switching chips can never strand a server with no way to see it.
        let pods = [pod(.online), pod(.offline), pod(.pending),
                    pod(.unknown, cameOnline: false, registeredAt: 1)]
        for p in pods {
            let live = p.livenessState(hasLiveUnlockRequest: false)
            XCTAssertTrue(HomeStatusFilter.all.matches(pod: p, liveness: live))
            let specific = HomeStatusFilter.allCases.contains {
                $0 != .all && $0.matches(pod: p, liveness: live)
            }
            XCTAssertTrue(specific, "pod \(p.status) fell through every specific chip")
        }
    }

    // ─── AppsOwnerFilter ───────────────────────────────────────────────────

    private func app(creator: String, slug: String = "notes") -> AppSummary {
        AppSummary(serviceId: "\(creator)--\(slug)", creator: creator, slug: slug,
                   urlLabel: slug, summary: nil, url: "https://\(slug).flagship.services",
                   status: "running", version: "1", installedAt: 0)
    }

    func test_ownerFilter_all_matchesEverything() {
        XCTAssertTrue(AppsOwnerFilter.all.matches(app: app(creator: "harry"), currentUser: "harry"))
        XCTAssertTrue(AppsOwnerFilter.all.matches(app: app(creator: "bob"), currentUser: "harry"))
    }

    func test_ownerFilter_yours_matchesOwnAuthored() {
        XCTAssertTrue(AppsOwnerFilter.yours.matches(app: app(creator: "harry"), currentUser: "harry"))
        XCTAssertFalse(AppsOwnerFilter.yours.matches(app: app(creator: "bob"), currentUser: "harry"))
    }

    func test_ownerFilter_shared_matchesOtherAuthored() {
        XCTAssertTrue(AppsOwnerFilter.shared.matches(app: app(creator: "bob"), currentUser: "harry"))
        XCTAssertFalse(AppsOwnerFilter.shared.matches(app: app(creator: "harry"), currentUser: "harry"))
    }

    func test_ownerFilter_unknownUser_treatsAllAsYours() {
        // No signed-in user → everything reads as "yours" (and nothing "shared").
        XCTAssertTrue(AppsOwnerFilter.yours.matches(app: app(creator: "bob"), currentUser: ""))
        XCTAssertFalse(AppsOwnerFilter.shared.matches(app: app(creator: "bob"), currentUser: ""))
    }

    // ─── PodStatusStyle (shared by PodCard + Home FSListRow) ───────────────

    func test_podStatusStyle_labels() {
        XCTAssertEqual(PodStatusStyle.label(liveness: .online, status: .online), "Online")
        XCTAssertEqual(PodStatusStyle.label(liveness: .online, status: .offline), "Offline")
        XCTAssertEqual(PodStatusStyle.label(liveness: .waitingForApproval, status: .offline), "Waiting for approval")
        XCTAssertEqual(PodStatusStyle.label(liveness: .comingOnline, status: .pending), "Pending")
        XCTAssertEqual(PodStatusStyle.label(liveness: .comingOnline, status: .unknown), "Coming online…")
        XCTAssertEqual(PodStatusStyle.label(liveness: .dead, status: .unknown), "Never came online")
    }

    func test_podStatusStyle_pillKinds() {
        XCTAssertEqual(PodStatusStyle.pillKind(liveness: .online, status: .online), .online)
        XCTAssertEqual(PodStatusStyle.pillKind(liveness: .dead, status: .unknown), .offline)
        XCTAssertEqual(PodStatusStyle.pillKind(liveness: .waitingForApproval, status: .offline), .provisioning)
        XCTAssertEqual(PodStatusStyle.pillKind(liveness: .online, status: .unknown), .idle)
        XCTAssertEqual(PodStatusStyle.pillKind(liveness: .comingOnline, status: .pending), .pending)
        XCTAssertEqual(PodStatusStyle.pillKind(liveness: .dead, status: .pending), .pending)
    }

    func test_podStatusStyle_accessibilityIds_matchLegacyPodCard() {
        XCTAssertEqual(PodStatusStyle.pillAccessibilityId(liveness: .dead, status: .unknown), "pod-card-never-online")
        XCTAssertEqual(PodStatusStyle.pillAccessibilityId(liveness: .waitingForApproval, status: .offline), "pod-card-waiting-approval")
        XCTAssertEqual(PodStatusStyle.pillAccessibilityId(liveness: .comingOnline, status: .unknown), "pod-card-coming-online")
        XCTAssertEqual(PodStatusStyle.pillAccessibilityId(liveness: .online, status: .online), "pod-card-status")
    }

    // ─── Components instantiate (smoke: bodies build without trapping) ─────

    @MainActor
    func test_components_instantiate() {
        _ = FSChip("All", selected: true) {}
        _ = FSSearchField(text: .constant(""))
        _ = FSProfileCard(name: "harry", subtitle: "Single-device account")
        _ = FSMonogram(name: "harry")
        _ = FSAnnouncementCard(icon: "key.horizontal.fill", title: "t", message: "m", ctaLabel: "go")
        _ = FSSettingsRow(icon: "gear", title: "Row", subtitle: "sub")
        _ = FSSettingsGroup("HEADER", rows: [FSSettingsRow(icon: "gear", title: "Row")])
        _ = FSListRow(leading: .icon("server.rack", color: .teal), title: "box", subtitle: "sub")
        // trailing-only convenience (chevron on the right, no stacked content).
        _ = FSListRow(leading: .icon("server.rack", color: .teal), title: "box", subtitle: "sub") {
            Image(systemName: "chevron.right")
        }
        // below + trailing: status pill stacked under the text, chevron right —
        // the Home server-row shape that keeps a long "Never came online" label
        // off the crushed right margin.
        _ = FSListRow(
            leading: .icon("server.rack", color: .teal),
            title: "box",
            subtitle: "sub",
            below: { FSPill("Never came online", kind: .offline) }
        ) {
            Image(systemName: "chevron.right")
        }
    }
}
