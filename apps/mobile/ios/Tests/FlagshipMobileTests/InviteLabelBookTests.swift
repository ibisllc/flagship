import XCTest
@testable import FlagshipCore

/// P6 — InviteLabelBook persistence + opaque-tag minter + share-URL
/// builder. Mirrors the privacy invariant from the canonical webapp
/// label-book + Android `core/InviteLabelBook.kt`.
final class InviteLabelBookTests: XCTestCase {

    func test_putGet_roundTripsAnEntry() {
        let book = InMemoryInviteLabelBook()
        let label = InviteLabel(
            displayName: "John (work)",
            channel: "imessage",
            sentTo: "+1 555 0142",
            notes: "",
            sentAt: 1_700_000_000_000
        )
        book.put(serviceId: "harry-plants", opaqueTagHex: "AABBCCDD11223344", label: label)
        let got = book.get(serviceId: "harry-plants", opaqueTagHex: "aabbccdd11223344")
        XCTAssertEqual(got?.displayName, "John (work)")
        XCTAssertEqual(got?.channel, "imessage")
        XCTAssertEqual(got?.sentTo, "+1 555 0142")
    }

    func test_get_returnsNilForMissingTag() {
        let book = InMemoryInviteLabelBook()
        XCTAssertNil(book.get(serviceId: "harry-plants", opaqueTagHex: "00".repeated(8)))
    }

    func test_get_isPerService() {
        let book = InMemoryInviteLabelBook()
        let label = InviteLabel(
            displayName: "John",
            channel: "other",
            sentTo: "",
            notes: "",
            sentAt: 1
        )
        book.put(serviceId: "harry-plants", opaqueTagHex: "ab".repeated(8), label: label)
        XCTAssertNotNil(book.get(serviceId: "harry-plants", opaqueTagHex: "ab".repeated(8)))
        XCTAssertNil(book.get(serviceId: "harry-wiki", opaqueTagHex: "ab".repeated(8)))
    }

    func test_list_returnsRowsForOneServiceSortedNewestFirst() {
        let book = InMemoryInviteLabelBook()
        let a = InviteLabel(displayName: "A", channel: "other", sentTo: "", notes: "", sentAt: 1)
        let b = InviteLabel(displayName: "B", channel: "other", sentTo: "", notes: "", sentAt: 3)
        let c = InviteLabel(displayName: "C", channel: "other", sentTo: "", notes: "", sentAt: 2)
        book.put(serviceId: "harry-plants", opaqueTagHex: "01".repeated(8), label: a)
        book.put(serviceId: "harry-plants", opaqueTagHex: "02".repeated(8), label: b)
        book.put(serviceId: "harry-plants", opaqueTagHex: "03".repeated(8), label: c)
        book.put(serviceId: "harry-wiki", opaqueTagHex: "04".repeated(8), label: a)
        let rows = book.list(serviceId: "harry-plants")
        XCTAssertEqual(rows.count, 3)
        XCTAssertEqual(rows.map(\.label.displayName), ["B", "C", "A"])
    }

    func test_remove_isIdempotent() {
        let book = InMemoryInviteLabelBook()
        book.put(
            serviceId: "harry-plants",
            opaqueTagHex: "ab".repeated(8),
            label: InviteLabel(displayName: "x", channel: "other", sentTo: "", notes: "", sentAt: 1)
        )
        book.remove(serviceId: "harry-plants", opaqueTagHex: "ab".repeated(8))
        book.remove(serviceId: "harry-plants", opaqueTagHex: "ab".repeated(8))
        XCTAssertNil(book.get(serviceId: "harry-plants", opaqueTagHex: "ab".repeated(8)))
    }

    func test_userDefaultsBacked_roundTripsAcrossInstances() {
        let suite = UserDefaults(suiteName: "fs-invite-labelbook-test-\(UUID().uuidString)")!
        let key = "test-storage"
        let book1 = UserDefaultsInviteLabelBook(defaults: suite, storageKey: key)
        book1.put(
            serviceId: "harry-plants",
            opaqueTagHex: "ab".repeated(8),
            label: InviteLabel(
                displayName: "Persisted",
                channel: "imessage",
                sentTo: "x",
                notes: "n",
                sentAt: 42
            )
        )
        // Open a fresh instance bound to the same suite + key — labels
        // must survive the process boundary.
        let book2 = UserDefaultsInviteLabelBook(defaults: suite, storageKey: key)
        let got = book2.get(serviceId: "harry-plants", opaqueTagHex: "ab".repeated(8))
        XCTAssertEqual(got?.displayName, "Persisted")
        XCTAssertEqual(got?.sentAt, 42)
    }

    // MARK: - InviteUtil

    func test_generateOpaqueTag_returnsLowercase32HexChars() {
        for _ in 0..<32 {
            let tag = InviteUtil.generateOpaqueTag()
            XCTAssertEqual(tag.count, 32)
            XCTAssertTrue(tag.allSatisfy { c in c.isHexDigit && !c.isUppercase })
        }
    }

    func test_buildShareUrl_includesSecretAndServiceIdFragment() {
        let url = InviteUtil.buildShareUrl(
            appUrl: "https://plants.harry.flagship.services/",
            secretHex: "abc123",
            serviceId: "harry-plants"
        )
        XCTAssertEqual(url, "https://plants.harry.flagship.services/invite#k=abc123&a=harry-plants")
    }

    func test_buildShareUrl_stripsTrailingSlash() {
        let url = InviteUtil.buildShareUrl(
            appUrl: "https://x.flagship.services//",
            secretHex: "deadbeef",
            serviceId: "x"
        )
        XCTAssertTrue(url.hasPrefix("https://x.flagship.services/invite#"))
    }
}

private extension String {
    /// Helper used by the tests above to mint repeated-hex strings.
    func repeated(_ count: Int) -> String {
        String(repeating: self, count: count)
    }
}
