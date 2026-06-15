import Foundation
import Observation
import Flagship
import FlagshipAPI

/// Backs the reusable AI-key step (`BuildKeyScreen`). Recalls the saved keys
/// from the device-local `SavedKeyStore` as masked slugs, pre-selects the
/// active one for a one-tap Confirm, and runs the "use a different key" form
/// (with an optional "Save on this device" toggle). The credential it yields
/// is in-memory only — handed to the caller's `onChosen`; the raw key never
/// touches flagshipserver.com.
///
/// Mirrors the canonical webapp `views/build-key.js`.
@MainActor
@Observable
public final class BuildKeyViewModel {
    /// The saved keys, most-recently-loaded.
    public private(set) var saved: [SavedKeyStore.Entry] = []
    /// The active (pre-selected for Confirm) entry, if any.
    public private(set) var active: SavedKeyStore.Entry?

    /// True ⇒ the "use a different key" form is showing.
    public var showingForm = false

    // Form fields.
    public var formProvider: String = "anthropic"
    public var formApiKey: String = ""
    public var formBaseUrl: String = ""
    public var formLabel: String = ""
    /// "Save on this device" — when on, the new key is persisted to the
    /// SavedKeyStore (so it shows in Settings + recall next time); when off
    /// it's used in-memory only for this one build.
    public var saveOnDevice = true

    public private(set) var errorMessage: String?

    /// Providers offered in the form picker. Same set as the webapp.
    public let providers = ["anthropic", "openai", "google", "openrouter", "ollama"]

    private let store: SavedKeyStore

    public init(store: SavedKeyStore = SavedKeyStore()) {
        self.store = store
    }

    /// Reload the saved keys + active pointer. Call on appear.
    public func reload() {
        saved = store.list()
        active = store.active()
    }

    public func slug(for e: SavedKeyStore.Entry) -> String { store.slug(for: e) }

    /// Non-active saved entries (rendered as one-tap recall rows beneath the
    /// pre-selected Confirm card).
    public var otherEntries: [SavedKeyStore.Entry] {
        guard let active else { return saved }
        return saved.filter { $0.id != active.id }
    }

    /// Recall a saved entry → its in-memory credential. Promotes it to active
    /// so a later visit pre-selects the same key.
    public func credential(for e: SavedKeyStore.Entry) -> LlmProviderCredential {
        try? store.setActive(id: e.id)
        return e.credential
    }

    /// Build the credential from the "use a different key" form. When
    /// `saveOnDevice` is set, persist it first (so it surfaces in Settings +
    /// recall). Returns nil + sets `errorMessage` on a bad form.
    public func credentialFromForm() -> LlmProviderCredential? {
        errorMessage = nil
        let key = formApiKey.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !key.isEmpty else {
            errorMessage = "Enter an API key."
            return nil
        }
        let base = formBaseUrl.trimmingCharacters(in: .whitespacesAndNewlines)
        let label = formLabel.trimmingCharacters(in: .whitespacesAndNewlines)
        if saveOnDevice {
            do {
                _ = try store.add(
                    provider: formProvider,
                    label: label.isEmpty ? formProvider : label,
                    apiKey: key,
                    baseUrl: base.isEmpty ? nil : base
                )
                reload()
            } catch {
                errorMessage = error.localizedDescription
                return nil
            }
        }
        return LlmProviderCredential(
            provider: formProvider,
            apiKey: key,
            baseUrl: base.isEmpty ? nil : base
        )
    }

    public func resetForm() {
        formProvider = "anthropic"
        formApiKey = ""
        formBaseUrl = ""
        formLabel = ""
        saveOnDevice = true
        errorMessage = nil
    }
}
