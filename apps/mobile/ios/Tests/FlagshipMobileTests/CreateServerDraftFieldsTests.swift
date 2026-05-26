import XCTest
@testable import FlagshipCore
@testable import FlagshipUI
@testable import Flagship
@testable import FlagshipAPI

/// P0a parity gap (audit 2026-05-26): the iOS create-server flow was
/// missing the webapp's two draft-only fields — backup-policy and
/// LLM-preferences. These are NOT signed into the InstallBlob (verified
/// against `Sources/Flagship/InstallBlob.swift` — `canonicalBytes` carries
/// neither field), so they live as separate published view-model state +
/// per-device UserDefaults under `CreateServerDraftStore`.
///
/// Asserted invariants:
///   - Defaults match the webapp's `buildDraft.js` defaults (backup-policy
///     "phone-only", llm-preferences empty).
///   - Picker writes propagate to UserDefaults (round-trip).
///   - Textarea writes propagate to UserDefaults (round-trip).
///   - Hydration restores the last-typed values on next VM construction.
///   - The values DO NOT leak into `InstallBlob.canonicalBytes()`.
@MainActor
final class CreateServerDraftFieldsTests: XCTestCase {

    private func freshDefaults() -> UserDefaults {
        let suite = "flagship.createserverdraft.tests.\(UUID().uuidString)"
        let d = UserDefaults(suiteName: suite)!
        d.removePersistentDomain(forName: suite)
        return d
    }

    private func makeVM(defaults: UserDefaults? = nil) -> (CreateServerViewModel, UserDefaults) {
        let d = defaults ?? freshDefaults()
        let store = CreateServerDraftStore(defaults: d)
        let vm = CreateServerViewModel(
            username: "harry",
            server: MockFlagshipServerClient(),
            relay: MockQrRelayClient(),
            draftStore: store
        )
        return (vm, d)
    }

    // MARK: - Defaults match the webapp

    func test_defaultBackupPolicyIsPhoneOnly() {
        let (vm, _) = makeVM()
        XCTAssertEqual(vm.backupPolicy, .phoneOnly)
    }

    func test_defaultLlmPreferencesIsEmpty() {
        let (vm, _) = makeVM()
        XCTAssertEqual(vm.llmPreferences, "")
    }

    func test_backupPolicyVocabularyMatchesWebapp() {
        // Mirrors the webapp's `("none" | "phone-only" | "peer")` from
        // apps/web/public/webapp/lib/buildDraft.js.
        XCTAssertEqual(CreateServerDraftStore.BackupPolicy.none.rawValue, "none")
        XCTAssertEqual(CreateServerDraftStore.BackupPolicy.phoneOnly.rawValue, "phone-only")
        XCTAssertEqual(CreateServerDraftStore.BackupPolicy.peer.rawValue, "peer")
    }

    // MARK: - Picker writes propagate to UserDefaults

    func test_backupPolicyPickerWritePropagates() {
        let (vm, d) = makeVM()
        vm.backupPolicy = .peer
        XCTAssertEqual(d.string(forKey: "flagship.createServerDraft.backupPolicy"), "peer")
        vm.backupPolicy = .none
        XCTAssertEqual(d.string(forKey: "flagship.createServerDraft.backupPolicy"), "none")
    }

    func test_llmPreferencesWritePropagates() {
        let (vm, d) = makeVM()
        vm.llmPreferences = "OpenAI gpt-4o for chat"
        XCTAssertEqual(
            d.string(forKey: "flagship.createServerDraft.llmPreferences"),
            "OpenAI gpt-4o for chat"
        )
    }

    func test_emptyLlmPreferencesClearsTheKey() {
        let (vm, d) = makeVM()
        vm.llmPreferences = "foo"
        XCTAssertEqual(d.string(forKey: "flagship.createServerDraft.llmPreferences"), "foo")
        vm.llmPreferences = ""
        // Empty string ⇒ key cleared, not written as "".
        XCTAssertNil(d.string(forKey: "flagship.createServerDraft.llmPreferences"))
    }

    // MARK: - Persistence round-trip across VM construction

    func test_persistsAcrossViewModelConstruction() {
        let d = freshDefaults()
        do {
            let (vm, _) = makeVM(defaults: d)
            vm.backupPolicy = .peer
            vm.llmPreferences = "local llama3"
        }
        // New VM same defaults — should hydrate the prior values.
        let (vm2, _) = makeVM(defaults: d)
        XCTAssertEqual(vm2.backupPolicy, .peer)
        XCTAssertEqual(vm2.llmPreferences, "local llama3")
    }

    // MARK: - InstallBlob has NO trace of these fields

    func test_draftFieldsAreNotInCanonicalInstallBlob() throws {
        let (vm, _) = makeVM()
        vm.backupPolicy = .peer
        vm.llmPreferences = "SECRET-LLM-NOTE-12345"
        // Construct a representative InstallBlob and assert its canonical
        // bytes don't carry either field. Re-asserts the audit finding
        // structurally (so a future protocol change can't quietly fold them
        // into the wire without flipping this test red).
        let auth = AuthCode(
            serial: "01ABCDE",
            username: "harry",
            serverName: "home",
            serverDomain: "home.harry.flagship.services",
            delegatedPubKey: Data(repeating: 0x11, count: 32),
            userPubKey: Data(repeating: 0x22, count: 32),
            issuedAt: 1_000,
            expiresAt: 1_000 + 6 * 60 * 60_000
        )
        let blob = InstallBlob(
            serverDomain: "home.harry.flagship.services",
            username: "harry",
            serverName: "home",
            phoneDelegatedPubKey: Data(repeating: 0x33, count: 32),
            authCode: auth,
            authCodeUserSignature: Data(repeating: 0x44, count: 64),
            rckPubKey: Data(repeating: 0x55, count: 32)
        )
        let canonical = String(data: blob.canonicalBytes(), encoding: .utf8)!
        XCTAssertFalse(canonical.contains("peer"))
        XCTAssertFalse(canonical.contains("phone-only"))
        XCTAssertFalse(canonical.contains("SECRET-LLM-NOTE-12345"))
        XCTAssertFalse(canonical.contains("backupPolicy"))
        XCTAssertFalse(canonical.contains("llmPreferences"))
    }

    // MARK: - Successful delivery resets the draft

    func test_resetClearsBothFields() {
        let (vm, d) = makeVM()
        vm.backupPolicy = .peer
        vm.llmPreferences = "transient"
        CreateServerDraftStore(defaults: d).reset()
        // A freshly-constructed VM should now see defaults again.
        let (vm2, _) = makeVM(defaults: d)
        XCTAssertEqual(vm2.backupPolicy, .phoneOnly)
        XCTAssertEqual(vm2.llmPreferences, "")
    }
}
