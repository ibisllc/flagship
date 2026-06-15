import Foundation
import Observation
import Flagship

/// Backs Settings → AI keys. Views saved keys as masked slugs, adds a new
/// one, and deletes. No full key is ever shown — only the typed input holds
/// plaintext, and the list renders `SavedKeyStore.slug` (provider · label ·
/// ••••last4).
///
/// Mirrors the webapp Settings providers manager (`views/settings.js`
/// `renderProviders`).
@MainActor
@Observable
public final class AiKeysViewModel {
    public private(set) var entries: [SavedKeyStore.Entry] = []
    public private(set) var activeId: String?

    /// True ⇒ the add form is showing.
    public var showingForm = false
    public var formProvider: String = "anthropic"
    public var formApiKey: String = ""
    public var formBaseUrl: String = ""
    public var formLabel: String = ""
    public private(set) var errorMessage: String?

    public let providers = ["anthropic", "openai", "google", "openrouter", "ollama"]

    private let store: SavedKeyStore

    public init(store: SavedKeyStore = SavedKeyStore()) {
        self.store = store
    }

    public func reload() {
        let s = store.load()
        entries = s.entries
        activeId = s.activeId
    }

    public func slug(for e: SavedKeyStore.Entry) -> String { store.slug(for: e) }

    /// Add the key from the form. Returns true on success (and resets +
    /// hides the form); sets `errorMessage` on failure.
    @discardableResult
    public func addFromForm() -> Bool {
        errorMessage = nil
        let key = formApiKey.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !key.isEmpty else {
            errorMessage = "Enter an API key."
            return false
        }
        let label = formLabel.trimmingCharacters(in: .whitespacesAndNewlines)
        let base = formBaseUrl.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            _ = try store.add(
                provider: formProvider,
                label: label.isEmpty ? formProvider : label,
                apiKey: key,
                baseUrl: base.isEmpty ? nil : base
            )
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
        resetForm()
        showingForm = false
        reload()
        return true
    }

    public func delete(id: String) {
        try? store.remove(id: id)
        reload()
    }

    public func setActive(id: String) {
        try? store.setActive(id: id)
        reload()
    }

    public func resetForm() {
        formProvider = "anthropic"
        formApiKey = ""
        formBaseUrl = ""
        formLabel = ""
        errorMessage = nil
    }
}
