import XCTest
@testable import Flagship
@testable import FlagshipAPI

/// Device-local saved AI-key store: add/list/delete, masking, active pointer,
/// persistence, and the credential handoff. On the simulator test bundle the
/// store falls back to its process-local in-memory mirror (no Keychain
/// entitlement), so a fresh `clear()` in setUp keeps tests isolated.
final class SavedKeyStoreTests: XCTestCase {

    private var store: SavedKeyStore!

    override func setUp() {
        super.setUp()
        store = SavedKeyStore()
        store.clear()
    }

    override func tearDown() {
        store.clear()
        super.tearDown()
    }

    // MARK: - Masking

    func test_maskKey_showsFirstAndLastFour() {
        XCTAssertEqual(SavedKeyStore.maskKey("sk-abcdef0123456789"), "sk-a••••6789")
    }

    func test_maskKey_collapsesShortKeys() {
        XCTAssertEqual(SavedKeyStore.maskKey("short"), "••••")
        XCTAssertEqual(SavedKeyStore.maskKey(""), "")
    }

    func test_slug_neverContainsTheMiddleOfTheKey() {
        let e = SavedKeyStore.Entry(
            id: "x", provider: "anthropic", label: "Personal",
            apiKey: "sk-ant-SECRETMIDDLE-1234"
        )
        let slug = SavedKeyStore.slug(for: e)
        XCTAssertTrue(slug.contains("anthropic"))
        XCTAssertTrue(slug.contains("Personal"))
        XCTAssertTrue(slug.hasSuffix("1234"))
        // The secret middle must NOT appear in any list-facing string.
        XCTAssertFalse(slug.contains("SECRETMIDDLE"))
        XCTAssertFalse(slug.contains("sk-ant-SECRETMIDDLE"))
    }

    // MARK: - CRUD

    func test_add_then_list_returnsEntry() throws {
        let e = try store.add(provider: "openai", label: "Work", apiKey: "sk-openai-aaaa1111")
        let list = store.list()
        XCTAssertEqual(list.count, 1)
        XCTAssertEqual(list.first?.id, e.id)
        XCTAssertEqual(list.first?.provider, "openai")
        XCTAssertEqual(list.first?.label, "Work")
        XCTAssertEqual(list.first?.apiKey, "sk-openai-aaaa1111")
    }

    func test_add_blankLabel_fallsBackToProvider() throws {
        let e = try store.add(provider: "google", label: "  ", apiKey: "key-google-bbbb2222")
        XCTAssertEqual(e.label, "google")
    }

    func test_add_blankKey_throws() {
        XCTAssertThrowsError(try store.add(provider: "anthropic", label: "x", apiKey: "   "))
    }

    func test_firstAdded_becomesActive() throws {
        let first = try store.add(provider: "anthropic", label: "A", apiKey: "sk-anthropic-1111aaaa")
        _ = try store.add(provider: "openai", label: "B", apiKey: "sk-openai-2222bbbb")
        XCTAssertEqual(store.active()?.id, first.id)
    }

    func test_setActive_changesActive() throws {
        _ = try store.add(provider: "anthropic", label: "A", apiKey: "sk-anthropic-1111aaaa")
        let second = try store.add(provider: "openai", label: "B", apiKey: "sk-openai-2222bbbb")
        try store.setActive(id: second.id)
        XCTAssertEqual(store.active()?.id, second.id)
    }

    func test_remove_dropsEntry_andReassignsActive() throws {
        let a = try store.add(provider: "anthropic", label: "A", apiKey: "sk-anthropic-1111aaaa")
        let b = try store.add(provider: "openai", label: "B", apiKey: "sk-openai-2222bbbb")
        XCTAssertEqual(store.active()?.id, a.id)
        try store.remove(id: a.id)
        XCTAssertEqual(store.list().count, 1)
        XCTAssertEqual(store.list().first?.id, b.id)
        // Active reassigned to the surviving entry.
        XCTAssertEqual(store.active()?.id, b.id)
    }

    func test_clear_removesEverything() throws {
        _ = try store.add(provider: "anthropic", label: "A", apiKey: "sk-anthropic-1111aaaa")
        _ = try store.add(provider: "openai", label: "B", apiKey: "sk-openai-2222bbbb")
        store.clear()
        XCTAssertTrue(store.list().isEmpty)
        XCTAssertNil(store.active())
    }

    // MARK: - Persistence

    func test_persistsAcrossStoreInstances() throws {
        _ = try store.add(provider: "anthropic", label: "Mine", apiKey: "sk-anthropic-cccc3333", baseUrl: "https://proxy.example")
        // A brand-new store instance reads the same backing store.
        let other = SavedKeyStore()
        let list = other.list()
        XCTAssertEqual(list.count, 1)
        XCTAssertEqual(list.first?.baseUrl, "https://proxy.example")
    }

    // MARK: - Credential handoff

    func test_entryCredential_carriesProviderKeyAndBaseUrl() throws {
        let e = try store.add(provider: "openai", label: "x", apiKey: "sk-openai-dddd4444", baseUrl: "https://api.x")
        let cred = e.credential
        XCTAssertEqual(cred.provider, "openai")
        XCTAssertEqual(cred.apiKey, "sk-openai-dddd4444")
        XCTAssertEqual(cred.baseUrl, "https://api.x")
    }

    func test_add_emptyBaseUrl_storesNil() throws {
        let e = try store.add(provider: "openai", label: "x", apiKey: "sk-openai-eeee5555", baseUrl: "")
        XCTAssertNil(e.baseUrl)
    }
}
