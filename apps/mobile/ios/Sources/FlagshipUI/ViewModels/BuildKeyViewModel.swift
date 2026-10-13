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
    /// "Send through the Flagship relay": on by default for every new key.
    public var formRelay = true
    /// "Save on this device" — when on, the new key is persisted to the
    /// SavedKeyStore (so it shows in Settings + recall next time); when off
    /// it's used in-memory only for this one build.
    public var saveOnDevice = true

    public private(set) var errorMessage: String?

    /// Providers offered in the form picker. Same set as the webapp.
    public let providers = ["anthropic", "openai", "google", "openrouter", "ollama"]

    private let store: SavedKeyStore

    // MARK: Free AI credits

    public enum FreeAiRow: Equatable {
        /// Not asked yet, no free AI on this client, or the promotion has
        /// ended: no row.
        case none
        case loading
        case available(FreeAiCredits)
        /// Can't be used now (used up, busy today, no running server,
        /// unavailable): the message, no Use button.
        case blocked(String)
    }

    /// The "Free AI credits" row at the top of the step.
    public private(set) var freeAi: FreeAiRow = .none
    /// A mint is in flight (the row's button shows progress).
    public private(set) var freeAiBusy = false
    /// The model the box should ask for with the chosen credential: set when
    /// free AI is chosen, nil for a saved key.
    public private(set) var chosenModel: String?
    /// Wired by the screen (it needs the environment's `.com` client).
    public var freeAiService: FreeAiCreditsService?

    public init(store: SavedKeyStore = SavedKeyStore(), freeAiService: FreeAiCreditsService? = nil) {
        self.store = store
        self.freeAiService = freeAiService
    }

    /// Reload the saved keys + active pointer. Call on appear.
    public func reload() {
        saved = store.list()
        active = store.active()
        if saved.isEmpty && !freeAiOffered { showingForm = true }
    }

    private var freeAiChecked = false

    private var freeAiOffered: Bool {
        switch freeAi {
        case .loading, .available: return true
        case .none: return freeAiService != nil && !freeAiChecked
        default: return false
        }
    }

    /// Ask `.com` for the free-AI balance. Returns true when the step should
    /// use free AI straight away: on by default for an owner with no saved
    /// key and credits left.
    @discardableResult
    public func loadFreeAi() async -> Bool {
        guard let service = freeAiService else {
            freeAi = .none
            freeAiChecked = true
            if saved.isEmpty { showingForm = true }
            return false
        }
        freeAi = .loading
        do {
            freeAi = Self.row(for: try await service.status())
        } catch let e as FreeAiError {
            if case .ended = e { freeAi = .none } else { freeAi = .blocked(e.message) }
        } catch {
            freeAi = .none
        }
        freeAiChecked = true
        if saved.isEmpty {
            if case .available = freeAi { showingForm = false; return true }
            showingForm = true
        }
        return false
    }

    /// The row for a status read. MIRRORS the webapp `freeAiRowState`.
    static func row(for s: FreeAiStatusResponse) -> FreeAiRow {
        switch FreeAiDisplay.of(s) {
        case .hidden: return .none
        case .usable(let c): return .available(c)
        case .blocked(let m, _): return .blocked(m)
        }
    }

    /// Use free AI for the box `serverFqdn`: mint a fresh credential. Nil +
    /// `errorMessage` when refused; every refusal but "unavailable" opens the
    /// add-key form.
    public func useFreeAi(serverFqdn: String) async -> LlmProviderCredential? {
        guard let service = freeAiService, !freeAiBusy else { return nil }
        freeAiBusy = true
        defer { freeAiBusy = false }
        errorMessage = nil
        do {
            let r = try await service.mint(serverFqdn: serverFqdn)
            chosenModel = r.model
            if let c = r.credits { freeAi = .available(c) }
            return r.credential
        } catch let e as FreeAiError {
            if case .ended = e { freeAi = .none } else { freeAi = .blocked(e.message) }
            errorMessage = e.message
            if e.opensAddKey || saved.isEmpty { resetFormKeepingError(); showingForm = true }
        } catch {
            errorMessage = "Couldn't get free AI credits. Try again, or add your own AI key."
        }
        return nil
    }

    private func resetFormKeepingError() {
        let e = errorMessage
        resetForm()
        errorMessage = e
    }

    /// The saved keys, the last-used one first.
    public var orderedEntries: [SavedKeyStore.Entry] {
        guard let active else { return saved }
        return [active] + saved.filter { $0.id != active.id }
    }

    /// Save the form's key to the list and close the form. Choosing a key is a
    /// separate step, so adding one never moves the build on.
    @discardableResult
    public func addFromForm() -> Bool {
        errorMessage = nil
        let key = formApiKey.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !key.isEmpty else {
            errorMessage = "Enter an API key."
            return false
        }
        let base = formBaseUrl.trimmingCharacters(in: .whitespacesAndNewlines)
        let label = formLabel.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            let added = try store.add(
                provider: formProvider,
                label: label.isEmpty ? formProvider : label,
                apiKey: key,
                baseUrl: base.isEmpty ? nil : base,
                relay: formRelay
            )
            try? store.setActive(id: added.id)
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
        resetForm()
        showingForm = false
        reload()
        return true
    }

    /// Remove a saved key from this phone (the caller has confirmed it).
    public func delete(_ e: SavedKeyStore.Entry) {
        try? store.remove(id: e.id)
        reload()
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
        chosenModel = nil
        try? store.setActive(id: e.id)
        return e.credential
    }

    /// Build the credential from the "use a different key" form. When
    /// `saveOnDevice` is set, persist it first (so it surfaces in Settings +
    /// recall). Returns nil + sets `errorMessage` on a bad form.
    public func credentialFromForm() -> LlmProviderCredential? {
        errorMessage = nil
        chosenModel = nil
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
                    baseUrl: base.isEmpty ? nil : base,
                    relay: formRelay
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
            baseUrl: base.isEmpty ? nil : base,
            relay: formRelay
        )
    }

    /// Turn the Flagship relay on or off for a saved key.
    public func setRelay(_ e: SavedKeyStore.Entry, on: Bool) {
        try? store.setRelay(id: e.id, relay: on)
        reload()
    }

    public func resetForm() {
        formProvider = "anthropic"
        formApiKey = ""
        formBaseUrl = ""
        formLabel = ""
        formRelay = true
        saveOnDevice = true
        errorMessage = nil
    }
}
