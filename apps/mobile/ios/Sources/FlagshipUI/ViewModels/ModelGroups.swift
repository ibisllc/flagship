import Foundation
import Observation
import Flagship
import FlagshipAPI

/// The build chat's model menu, grouped by provider: Flagship Inference first
/// (when the owner can use it, or the chat already does), then every AI key
/// saved on this device, each with its own models. Picking a model from
/// another group switches the chat's provider: that group's key rides the
/// next message and the box replaces the chat's key with it.
/// MIRRORS the webapp `lib/modelGroups.js` and Android `core/AiModelMenu.kt`.
public enum ModelGroups {
    public static let flagshipId = SavedKeyStore.flagshipInferenceId

    /// A group before its models load: Flagship Inference (`entry == nil`) or a saved key.
    public struct Spec: Equatable, Sendable {
        public let id: String
        public let title: String
        public let entry: SavedKeyStore.Entry?
        public init(id: String, title: String, entry: SavedKeyStore.Entry?) {
            self.id = id; self.title = title; self.entry = entry
        }
        public var isFlagship: Bool { entry == nil }
    }

    /// A saved key's group title.
    public static func keyTitle(_ e: SavedKeyStore.Entry) -> String { "\(e.provider) · \(e.label)" }

    public static let chooseModel = String(localized: "Choose a model")
    public static let loadingModels = String(localized: "Loading models…")
    public static let catalogUnreadable = String(localized: "The models couldn't be listed right now.")
    public static let noGroups = String(localized: "Add an AI key in Settings to pick a model.")
    public static let keyGoneMessage = String(localized: "That AI key isn't saved on this phone any more. Pick another model.")

    /// The picked key was deleted from this device since the menu was built.
    public struct KeyGone: LocalizedError, Equatable {
        public init() {}
        public var errorDescription: String? { ModelGroups.keyGoneMessage }
    }

    public static let flagshipSpec = Spec(id: flagshipId, title: ModelMenuText.flagshipInference, entry: nil)

    /// The groups in menu order.
    public static func specs(entries: [SavedKeyStore.Entry], includeFlagship: Bool) -> [Spec] {
        var out: [Spec] = includeFlagship ? [flagshipSpec] : []
        for e in entries where e.provider != "flagship" {
            out.append(Spec(id: e.id, title: keyTitle(e), entry: e))
        }
        return out
    }

    /// The credential a saved key goes to the box as (an OpenRouter key goes
    /// as an OpenAI-compatible one).
    static func wireCredential(_ e: SavedKeyStore.Entry) -> LlmProviderCredential {
        VibeCodeCredentialSelection.compatible(with: e.credential).credential ?? e.credential
    }

    /// For a reopened chat: the group of the provider the box says it uses
    /// (Flagship Inference, else the first saved key of that provider).
    public static func groupId(forProvider provider: String?, in specs: [Spec]) -> String? {
        guard let provider, !provider.isEmpty else { return nil }
        if provider == "flagship" { return specs.first(where: \.isFlagship)?.id }
        return specs.first { $0.entry?.provider == provider }?.id
            ?? specs.first { $0.entry.map { wireCredential($0).provider } == provider }?.id
    }

    /// The group a credential came from.
    public static func groupId(forCredential c: LlmProviderCredential?, in specs: [Spec]) -> String? {
        guard let c else { return nil }
        if c.isFreeAi || c.provider == "flagship" { return specs.first(where: \.isFlagship)?.id }
        return specs.first { $0.entry?.apiKey == c.apiKey }?.id
    }

    /// Switching to a model with this context may drop older messages: the
    /// conversation is past the box's compaction threshold for it (75% of
    /// what is left after the reply's room, as `contextCompaction.ts`).
    public static func mayDropContext(conversationTokens: Int?, contextTokens: Int?) -> Bool {
        guard let t = conversationTokens, t > 0, let ctx = contextTokens, ctx > 0 else { return false }
        let budget = Double(ctx - min(16_000, ctx / 4))
        return Double(t) > budget * 0.75
    }

    /// The one-line notice under the menu, or nil.
    public static func contextNotice(chosenModel: String?, sessionModel: String?, contextTokens: Int?,
                                     conversationTokens: Int?) -> String? {
        guard let chosenModel, chosenModel != sessionModel else { return nil }
        return mayDropContext(conversationTokens: conversationTokens, contextTokens: contextTokens)
            ? ModelMenuText.contextNotice : nil
    }

    /// What the next message carries for the key.
    public enum CredentialChoice: Equatable, Sendable {
        /// Nothing: the box keeps the key it holds.
        case keep
        /// A fresh Flagship Inference pass.
        case mintFlagship
        case send(LlmProviderCredential)
        /// The key to send is no longer saved on this device.
        case keyGone
    }

    /// Flagship Inference always mints a fresh pass. An own key goes when the
    /// owner picked it here (`picked`), when the box holds no key
    /// (`needsCredential`), or on the chat's first message (`starting`).
    public static func credential(for spec: Spec?, picked: Bool, needsCredential: Bool,
                                  starting: Bool = false) -> CredentialChoice {
        guard let spec else { return .keep }
        guard let entry = spec.entry else { return .mintFlagship }
        guard picked || needsCredential || starting else { return .keep }
        return .send(wireCredential(entry))
    }

    /// The trigger: the model's short name, then the key's name for an own key.
    public static func triggerText(modelName: String, spec: Spec?) -> String {
        guard let e = spec?.entry else { return modelName }
        return "\(modelName) · \(e.label)"
    }
}

/// One group of the menu: its spec and its own single-provider menu.
public struct ModelMenuGroup: Identifiable {
    public let spec: ModelGroups.Spec
    public let menu: ModelMenuModel
    public init(spec: ModelGroups.Spec, menu: ModelMenuModel) { self.spec = spec; self.menu = menu }
    public var id: String { spec.id }
    public var title: String { spec.title }
}

/// The build chat's menu: which group is chosen, and which one the box uses.
@MainActor
@Observable
public final class GroupedModelMenu {
    public private(set) var groups: [ModelMenuGroup] = []
    public private(set) var selectedGroupId: String?
    /// The group whose key the box holds now (nil: none of this device's).
    public private(set) var boxGroupId: String?
    /// What the chat uses, shown while no group is chosen.
    @ObservationIgnored private var initial: ModelChoice?
    @ObservationIgnored private var flagshipCatalog: (@MainActor () async -> InferenceCatalogResponse?)?
    @ObservationIgnored private var ownModels: (@MainActor (LlmProviderCredential) async -> AiModelsResponse)?
    @ObservationIgnored private var flagshipUsable: (@MainActor () async -> Bool)?
    @ObservationIgnored private var checkedFlagship = false
    @ObservationIgnored public private(set) var isConfigured = false

    public init() {}

    /// Groups already loaded (tests, previews).
    public init(groups: [ModelMenuGroup], selected: String?, box: String? = nil) {
        self.groups = groups
        selectedGroupId = selected
        boxGroupId = box ?? selected
        isConfigured = true
    }

    /// Build the groups for a chat. `provider` is what the box says the chat
    /// uses; an older box doesn't say, so a free-AI chat (this device
    /// remembers) or the saved key it was started with stands in.
    public func configure(
        entries: [SavedKeyStore.Entry],
        provider: String?,
        freeAiSession: Bool,
        fallbackCredential: LlmProviderCredential?,
        initial: ModelChoice,
        flagshipCatalog: (@MainActor () async -> InferenceCatalogResponse?)?,
        ownModels: @escaping @MainActor (LlmProviderCredential) async -> AiModelsResponse,
        flagshipUsable: (@MainActor () async -> Bool)?
    ) {
        guard !isConfigured else { return }
        isConfigured = true
        self.initial = initial
        self.flagshipCatalog = flagshipCatalog
        self.ownModels = ownModels
        self.flagshipUsable = flagshipUsable
        let usesFlagship = provider == "flagship" || (provider == nil && freeAiSession)
        let specs = ModelGroups.specs(entries: entries, includeFlagship: usesFlagship)
        let box: String?
        if let provider, !provider.isEmpty {
            box = ModelGroups.groupId(forProvider: provider, in: specs)
        } else if usesFlagship {
            box = ModelGroups.flagshipId
        } else {
            box = ModelGroups.groupId(forCredential: fallbackCredential, in: specs)
        }
        groups = specs.map { makeGroup($0, initial: $0.id == box ? initial : DefaultModelStore.choice(for: $0.id)) }
        boxGroupId = box
        selectedGroupId = box
    }

    private func makeGroup(_ spec: ModelGroups.Spec, initial: ModelChoice?) -> ModelMenuGroup {
        let loader: () async -> ModelMenuModel.Source
        if let entry = spec.entry {
            let cred = ModelGroups.wireCredential(entry)
            loader = { @MainActor [weak self] in
                guard let load = self?.ownModels else {
                    return .own(AiModelsResponse(provider: cred.provider, kind: "own", listed: false, models: [],
                                                 reason: "failed"))
                }
                let r = await load(cred)
                return r.kind == "flagship" ? .flagship(r.catalog) : .own(r)
            }
        } else {
            loader = { @MainActor [weak self] in .flagship(await self?.flagshipCatalog?()) }
        }
        return ModelMenuGroup(spec: spec, menu: ModelMenuModel(initial: initial, loader: loader))
    }

    /// Show the menu: once set up for a chat, even with no group (it then
    /// says how to add a key).
    public var isActive: Bool { isConfigured }

    public func group(_ id: String?) -> ModelMenuGroup? { groups.first { $0.id == id } }
    public var currentGroup: ModelMenuGroup? { group(selectedGroupId) }
    public var boxGroup: ModelMenuGroup? { group(boxGroupId) }
    public var current: ModelMenuModel? { currentGroup?.menu }

    /// Read the chosen group's models (when the chat opens).
    public func loadCurrent() async { await current?.ensureLoaded() }

    /// Read every group's models (when the menu opens), adding Flagship
    /// Inference first if the owner can use it.
    public func loadAll() async {
        if !checkedFlagship, !groups.contains(where: { $0.spec.isFlagship }), let flagshipUsable {
            checkedFlagship = true
            if await flagshipUsable(), !groups.contains(where: { $0.spec.isFlagship }) {
                groups.insert(makeGroup(ModelGroups.flagshipSpec,
                                        initial: DefaultModelStore.choice(for: ModelGroups.flagshipId)), at: 0)
            }
        }
        let menus = groups.map(\.menu)
        await withTaskGroup(of: Void.self) { tg in
            for m in menus { tg.addTask { await m.ensureLoaded() } }
        }
    }

    // MARK: Chosen

    /// The trigger's text.
    public var shortName: String {
        guard let g = currentGroup else { return initial?.model ?? ModelGroups.chooseModel }
        return ModelGroups.triggerText(modelName: g.menu.shortName, spec: g.spec)
    }

    public var efforts: [String]? { current?.efforts }
    public var effort: String? { current?.effort }
    public var wireModel: String? { current?.wireModel }
    public var wireEffort: String? { current?.wireEffort }

    /// The owner chose a group here other than the one the box uses.
    public var picked: Bool { selectedGroupId != nil && selectedGroupId != boxGroupId }

    /// Pick a model in a group; its effort goes back to the model's default.
    public func pick(groupId: String, modelId: String) {
        guard let g = group(groupId) else { return }
        selectedGroupId = groupId
        g.menu.pick(modelId)
    }

    /// Choose a group without a listed model (Flagship without a catalog, a typed model id).
    public func selectGroup(_ id: String) {
        guard group(id) != nil else { return }
        selectedGroupId = id
    }

    /// Switch model within the chosen group (the image switch).
    public func select(_ modelId: String) { current?.select(modelId) }

    public func setEffort(_ e: String?) { current?.setEffort(e) }

    public func visionDecision(hasImage: Bool) -> VisionDecision {
        current?.visionDecision(hasImage: hasImage) ?? .send
    }

    /// "Older messages will be summarised…" when the chosen model is new to
    /// the chat and the conversation outgrows it.
    public func contextNotice(for state: VibeCodeSessionPublicState?) -> String? {
        guard let state, let current else { return nil }
        return ModelGroups.contextNotice(chosenModel: current.wireModel, sessionModel: state.model,
                                         contextTokens: current.contextTokens,
                                         conversationTokens: state.conversationTokens)
    }

    /// Finds a saved key by id (the device's store; tests replace it).
    @ObservationIgnored public var keyLookup: (String) -> SavedKeyStore.Entry? = { id in
        SavedKeyStore().list().first { $0.id == id }
    }

    /// The key the next message carries. `switching` false (an env-var
    /// answer, which sends no model) keeps the box's group. Reads the saved
    /// key again, so a relay change since the menu was built applies, and a
    /// key deleted since can't be sent.
    public func credentialChoice(needsCredential: Bool, switching: Bool = true) -> ModelGroups.CredentialChoice {
        guard let g = switching ? currentGroup : boxGroup else { return .keep }
        var spec = g.spec
        let choice: ModelGroups.CredentialChoice
        if let e = spec.entry {
            let fresh = keyLookup(e.id)
            if let fresh { spec = ModelGroups.Spec(id: spec.id, title: spec.title, entry: fresh) }
            choice = ModelGroups.credential(for: spec, picked: switching && picked, needsCredential: needsCredential)
            if case .send = choice, fresh == nil { return .keyGone }
            return choice
        }
        return ModelGroups.credential(for: spec, picked: switching && picked, needsCredential: needsCredential)
    }

    /// A message went through: the box now holds the chosen group's key.
    public func didSend() {
        if selectedGroupId != nil { boxGroupId = selectedGroupId }
    }
}
