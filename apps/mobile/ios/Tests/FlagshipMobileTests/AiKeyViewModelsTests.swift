import XCTest
@testable import Flagship
@testable import FlagshipUI
@testable import FlagshipAPI

/// View-model state for the AI-key step (BuildKeyViewModel) and the Settings
/// manager (AiKeysViewModel). Both ride the device-local SavedKeyStore; its
/// in-memory fallback is cleared in setUp so cases are isolated.
@MainActor
final class AiKeyViewModelsTests: XCTestCase {

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

    // MARK: - BuildKeyViewModel

    func test_buildKey_reload_surfacesSavedAndActive() throws {
        let a = try store.add(provider: "anthropic", label: "A", apiKey: "sk-anthropic-1111aaaa")
        _ = try store.add(provider: "openai", label: "B", apiKey: "sk-openai-2222bbbb")
        let vm = BuildKeyViewModel(store: store)
        vm.reload()
        XCTAssertEqual(vm.saved.count, 2)
        XCTAssertEqual(vm.active?.id, a.id)
        XCTAssertEqual(vm.otherEntries.count, 1)
        XCTAssertFalse(vm.otherEntries.contains { $0.id == a.id })
    }

    func test_buildKey_credentialForEntry_promotesToActive() throws {
        _ = try store.add(provider: "anthropic", label: "A", apiKey: "sk-anthropic-1111aaaa")
        let b = try store.add(provider: "openai", label: "B", apiKey: "sk-openai-2222bbbb")
        let vm = BuildKeyViewModel(store: store)
        vm.reload()
        let cred = vm.credential(for: b)
        XCTAssertEqual(cred.provider, "openai")
        XCTAssertEqual(cred.apiKey, "sk-openai-2222bbbb")
        XCTAssertEqual(store.active()?.id, b.id, "recall promotes the chosen key to active")
    }

    func test_buildKey_formWithSave_persistsAndYieldsCredential() {
        let vm = BuildKeyViewModel(store: store)
        vm.formProvider = "google"
        vm.formApiKey = "key-google-6666ffff"
        vm.formLabel = "Personal"
        vm.saveOnDevice = true
        let cred = vm.credentialFromForm()
        XCTAssertEqual(cred?.provider, "google")
        XCTAssertEqual(cred?.apiKey, "key-google-6666ffff")
        XCTAssertEqual(store.list().count, 1, "save-on-device persists to the store")
        XCTAssertEqual(store.list().first?.label, "Personal")
    }

    func test_buildKey_formWithoutSave_doesNotPersist() {
        let vm = BuildKeyViewModel(store: store)
        vm.formProvider = "anthropic"
        vm.formApiKey = "sk-anthropic-7777gggg"
        vm.saveOnDevice = false
        let cred = vm.credentialFromForm()
        XCTAssertEqual(cred?.apiKey, "sk-anthropic-7777gggg")
        XCTAssertTrue(store.list().isEmpty, "in-memory only when save-on-device is off")
    }

    func test_buildKey_formBlankKey_setsErrorAndYieldsNil() {
        let vm = BuildKeyViewModel(store: store)
        vm.formApiKey = "   "
        XCTAssertNil(vm.credentialFromForm())
        XCTAssertNotNil(vm.errorMessage)
    }

    // MARK: - AiKeysViewModel

    func test_aiKeys_addFromForm_appendsAndHidesForm() {
        let vm = AiKeysViewModel(store: store)
        vm.showingForm = true
        vm.formProvider = "openai"
        vm.formApiKey = "sk-openai-8888hhhh"
        vm.formLabel = "Work"
        XCTAssertTrue(vm.addFromForm())
        XCTAssertEqual(vm.entries.count, 1)
        XCTAssertEqual(vm.entries.first?.label, "Work")
        XCTAssertFalse(vm.showingForm)
    }

    func test_aiKeys_addBlankKey_failsAndKeepsForm() {
        let vm = AiKeysViewModel(store: store)
        vm.showingForm = true
        vm.formApiKey = ""
        XCTAssertFalse(vm.addFromForm())
        XCTAssertNotNil(vm.errorMessage)
        XCTAssertTrue(vm.entries.isEmpty)
    }

    func test_aiKeys_delete_removesEntry() throws {
        let a = try store.add(provider: "anthropic", label: "A", apiKey: "sk-anthropic-1111aaaa")
        let vm = AiKeysViewModel(store: store)
        vm.reload()
        XCTAssertEqual(vm.entries.count, 1)
        vm.delete(id: a.id)
        XCTAssertTrue(vm.entries.isEmpty)
    }

    func test_aiKeys_setActive_marksDefault() throws {
        _ = try store.add(provider: "anthropic", label: "A", apiKey: "sk-anthropic-1111aaaa")
        let b = try store.add(provider: "openai", label: "B", apiKey: "sk-openai-2222bbbb")
        let vm = AiKeysViewModel(store: store)
        vm.reload()
        vm.setActive(id: b.id)
        XCTAssertEqual(vm.activeId, b.id)
    }
}
