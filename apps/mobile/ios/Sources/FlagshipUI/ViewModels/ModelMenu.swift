import Foundation
import Observation
import CryptoKit
import Flagship
import FlagshipAPI

/// The build chat's model menu (docs/ai-inference-costs.md §15). Two sources:
/// Flagship Inference's catalog from `.com`, or the models the owner's own key
/// can use, which the box asks the provider for. MIRRORS the webapp and
/// Android model menus.
public enum ModelMenuText {
    /// "1×", "3.5×".
    public static func multiplier(_ m: Double) -> String {
        "\(decimal(m))×"
    }

    /// One decimal at most, ".0" dropped.
    static func decimal(_ v: Double) -> String {
        let r = (v * 10).rounded() / 10
        if r == r.rounded() { return String(Int(r)) }
        return String(format: "%.1f", r)
    }

    /// A Flagship model's short name for the header: "Low 1×".
    public static func short(_ m: InferenceModel) -> String {
        "\(m.tier) \(multiplier(m.multiplier))"
    }

    /// An effort level in the provider's words, capitalised ("xhigh" → "Extra high").
    public static func effort(_ e: String) -> String {
        switch e.lowercased() {
        case "xhigh": return "Extra high"
        default: return e.prefix(1).uppercased() + e.dropFirst().lowercased()
        }
    }

    /// The muted line under a Flagship Inference reply: "used 2.8 credits",
    /// "used 1 credit".
    public static func creditsUsed(_ credits: Double) -> String {
        let n = decimal(credits)
        return "used \(n) credit\(n == "1" ? "" : "s")"
    }

    public static let flagshipInference = "Flagship Inference"
    public static let thinkHarder = "Think harder"
    public static let capabilitiesUnknown = "capabilities unknown"
    public static let keyRefused = "The key was refused"
    public static let boxPicks = "Your server picks the model."
    public static let summarised = "Earlier conversation summarised"
}

/// What the owner picked: the wire `model` and `effort`.
public struct ModelChoice: Codable, Equatable, Sendable {
    public var model: String?
    public var effort: String?
    public init(model: String?, effort: String?) { self.model = model; self.effort = effort }
}

/// The default model per AI key (Settings), used to start a chat. Keyed by the
/// saved key's id (`SavedKeyStore.flagshipInferenceId` for Flagship
/// Inference). Holds no secret.
@MainActor
public enum DefaultModelStore {
    private static let key = "flagship.ai.defaultModel.v1"
    static var defaults: UserDefaults = .standard

    public static func choice(for keyId: String?) -> ModelChoice? {
        guard let keyId, let data = defaults.data(forKey: key),
              let all = try? JSONDecoder().decode([String: ModelChoice].self, from: data) else { return nil }
        return all[keyId]
    }

    public static func set(_ choice: ModelChoice?, for keyId: String) {
        var all = (defaults.data(forKey: key)).flatMap { try? JSONDecoder().decode([String: ModelChoice].self, from: $0) } ?? [:]
        all[keyId] = choice
        if let data = try? JSONEncoder().encode(all) { defaults.set(data, forKey: key) }
    }

    /// The store id for a credential: Flagship Inference, or the saved key it came from.
    public static func keyId(for credential: LlmProviderCredential?) -> String? {
        guard let credential else { return nil }
        if credential.isFreeAi || credential.provider == "flagship" { return SavedKeyStore.flagshipInferenceId }
        return SavedKeyStore().entry(for: credential)?.id
    }

    public static func clear() { defaults.removeObject(forKey: key) }
}

/// Model menus already read this app session: the catalog for 5 minutes, an
/// own key's answer per credential until the app quits.
@MainActor
public enum ModelMenuCache {
    private static var catalog: (InferenceCatalogResponse, Date)?
    private static var own: [String: AiModelsResponse] = [:]

    public static func catalog(_ load: () async throws -> InferenceCatalogResponse) async -> InferenceCatalogResponse? {
        if let (c, at) = catalog, Date().timeIntervalSince(at) < 300 { return c }
        guard let c = try? await load() else { return catalog?.0 }
        catalog = (c, Date())
        return c
    }

    static func credentialKey(_ c: LlmProviderCredential) -> String {
        let raw = "\(c.provider)|\(c.baseUrl ?? "")|\(c.apiKey)"
        return SHA256.hash(data: Data(raw.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    /// The models a key can use; a failed call becomes a free-text field.
    public static func models(for credential: LlmProviderCredential,
                              _ load: (AiModelsRequest) async throws -> AiModelsResponse) async -> AiModelsResponse {
        let k = credentialKey(credential)
        if let hit = own[k] { return hit }
        do {
            let r = try await load(AiModelsRequest(credential: credential))
            own[k] = r
            return r
        } catch {
            return AiModelsResponse(provider: credential.provider, kind: "own", listed: false, models: [],
                                    reason: "failed")
        }
    }

    public static func clear() { catalog = nil; own = [:] }
}

/// The menu's state: what's offered and what's chosen.
@MainActor
@Observable
public final class ModelMenuModel {
    public enum Source: Equatable {
        case idle
        case loading
        /// Flagship Inference; nil catalog ⇒ only "Flagship Inference", no model sent.
        case flagship(InferenceCatalogResponse?)
        case own(AiModelsResponse)
    }

    public private(set) var source: Source = .idle
    /// Catalog id (Flagship) or the provider's model id (own key, listed).
    public private(set) var selectedId: String?
    /// Own-key effort.
    public private(set) var effort: String?
    /// Flagship Inference "Think harder".
    public var thinkHarder = false { didSet { if oldValue != thinkHarder { changed() } } }
    /// The model typed when the key's list couldn't be read.
    public var customModel = "" { didSet { if oldValue != customModel { changed() } } }

    @ObservationIgnored private var loader: (() async -> Source)?
    @ObservationIgnored private var initial: ModelChoice?
    /// Called on every owner change (Settings saves the default with it).
    @ObservationIgnored public var onChange: ((ModelChoice) -> Void)?

    public init(initial: ModelChoice? = nil, loader: (() async -> Source)? = nil) {
        self.initial = initial
        self.loader = loader
        if let initial {
            selectedId = initial.model
            effort = initial.effort
            thinkHarder = initial.effort != nil
        }
    }

    /// A menu that's already loaded (tests, previews).
    public convenience init(source: Source, initial: ModelChoice? = nil) {
        self.init(initial: initial)
        apply(source)
    }

    public func setLoader(_ loader: @escaping () async -> Source, initial: ModelChoice?) {
        self.loader = loader
        self.initial = initial
        if source == .idle, let initial {
            selectedId = initial.model
            effort = initial.effort
            withoutChange { thinkHarder = initial.effort != nil }
        }
    }

    public var hasLoader: Bool { loader != nil }
    /// The menu has something to offer (a loader, or a source already set).
    public var isActive: Bool { loader != nil || source != .idle }

    /// Read the menu once (the answer is cached per key for the app session).
    public func ensureLoaded() async {
        guard source == .idle, let loader else { return }
        source = .loading
        apply(await loader())
    }

    @ObservationIgnored private var muted = false
    private func withoutChange(_ f: () -> Void) { muted = true; f(); muted = false }
    private func changed() { if !muted { onChange?(choice) } }

    func apply(_ s: Source) {
        withoutChange {
            source = s
            switch s {
            case .flagship(let catalog?):
                if selectedId == nil || !catalog.models.contains(where: { $0.id == selectedId }) {
                    selectedId = catalog.defaultModel
                }
                if catalogModel?.reasoning != true { thinkHarder = false }
            case .own(let r) where r.listed == true:
                let models = r.models ?? []
                if selectedId == nil || !models.contains(where: { $0.id == selectedId }) {
                    selectedId = models.first(where: { $0.id == r.defaultModel })?.id ?? models.first?.id
                    effort = nil
                }
                if let o = ownOption {
                    if let e = effort, o.efforts?.contains(e) != true { effort = nil }
                    if effort == nil { effort = o.defaultEffort }
                } else {
                    effort = nil
                }
            case .own(let r):
                if customModel.isEmpty { customModel = selectedId ?? r.defaultModel ?? "" }
            default:
                break
            }
        }
    }

    // MARK: Derived

    public var isFlagship: Bool { if case .flagship = source { return true }; return false }

    public var catalog: InferenceCatalogResponse? {
        if case .flagship(let c) = source { return c }
        return nil
    }

    public var catalogModel: InferenceModel? {
        guard let c = catalog else { return nil }
        return c.models.first { $0.id == selectedId } ?? c.models.first { $0.id == c.defaultModel }
    }

    public var ownResponse: AiModelsResponse? {
        if case .own(let r) = source { return r }
        return nil
    }

    public var ownListed: Bool { ownResponse?.listed == true }

    public var ownOptions: [ModelOption] { ownResponse?.models ?? [] }

    public var ownOption: ModelOption? {
        guard ownListed else { return nil }
        return ownOptions.first { $0.id == selectedId }
    }

    /// The header's short name ("Low 1×", "GPT-5.4 Mini").
    public var shortName: String {
        switch source {
        case .idle, .loading:
            return "Model"
        case .flagship:
            return catalogModel.map(ModelMenuText.short) ?? ModelMenuText.flagshipInference
        case .own:
            if let o = ownOption { return o.label }
            let typed = customModel.trimmingCharacters(in: .whitespaces)
            return typed.isEmpty ? (selectedId ?? "Model") : typed
        }
    }

    /// Show "Think harder" (a Flagship model that reasons).
    public var offersThinkHarder: Bool { catalogModel?.reasoning == true }

    /// The own-key effort levels to offer, nil ⇒ no control.
    public var efforts: [String]? {
        guard let e = ownOption?.efforts, !e.isEmpty else { return nil }
        return e
    }

    /// The wire `model`; nil ⇒ let the box pick.
    public var wireModel: String? {
        switch source {
        case .flagship: return catalogModel?.id
        case .own:
            if ownListed { return ownOption?.id }
            let typed = customModel.trimmingCharacters(in: .whitespacesAndNewlines)
            return typed.isEmpty ? nil : typed
        case .idle, .loading: return initial?.model
        }
    }

    /// The wire `effort`; nil ⇒ the provider's default.
    public var wireEffort: String? {
        switch source {
        case .flagship: return offersThinkHarder && thinkHarder ? "high" : nil
        case .own: return efforts == nil ? nil : effort
        case .idle, .loading: return initial?.effort
        }
    }

    public var choice: ModelChoice { ModelChoice(model: wireModel, effort: wireEffort) }

    // MARK: Changes

    public func select(_ id: String) {
        guard id != selectedId else { return }
        selectedId = id
        if isFlagship {
            if !offersThinkHarder { withoutChange { thinkHarder = false } }
        } else {
            effort = ownOption?.defaultEffort
        }
        changed()
    }

    public func setEffort(_ e: String?) {
        guard e != effort else { return }
        effort = e
        changed()
    }

    // MARK: Images

    /// What sending images needs with the current model.
    public func visionDecision(hasImage: Bool) -> VisionDecision {
        guard hasImage else { return .send }
        switch source {
        case .flagship(let c?):
            guard let m = catalogModel else { return .send }
            return VisionDecision.flagship(model: m, catalog: c)
        case .own:
            guard let o = ownOption else { return .send }
            return VisionDecision.own(option: o, options: ownOptions)
        default:
            return .send
        }
    }
}

/// Sending an image to a model that can't see it.
public enum VisionDecision: Equatable, Sendable {
    case send
    /// Offer to switch (Switch / Cancel).
    case offerSwitch(to: String, message: String)
    /// No model to switch to (OK).
    case cannot(message: String)

    public static func flagship(model m: InferenceModel, catalog: InferenceCatalogResponse) -> VisionDecision {
        if m.seesImages { return .send }
        if let altId = m.visionAlternative, let alt = catalog.models.first(where: { $0.id == altId }) {
            return .offerSwitch(to: alt.id,
                                message: "I'll have to switch to \(alt.model) (\(ModelMenuText.multiplier(alt.multiplier))) for this.")
        }
        return .cannot(message: "\(m.model) can't see images. Remove them or pick another model.")
    }

    public static func own(option o: ModelOption, options: [ModelOption]) -> VisionDecision {
        guard o.vision == false else { return .send }
        if let altId = o.visionAlternative, let alt = options.first(where: { $0.id == altId }) {
            return .offerSwitch(to: alt.id, message: "I'll have to switch to \(alt.label) for this.")
        }
        return .cannot(message: "\(o.label) can't see images. Remove them or pick another model.")
    }

    public var message: String? {
        switch self {
        case .send: return nil
        case .offerSwitch(_, let m), .cannot(let m): return m
        }
    }
}
