import Foundation

// AI model menus and chat attachments.
// MIRRORS packages/protocol/src/aiModels.ts (InferenceModel,
// InferenceCatalogResponse, ModelOption), packages/server-daemon/src/llm/
// modelCatalog.ts (AiModelsResponse) and the VibeCodeAttachment shape in
// packages/server-daemon/src/screens/types.ts.

/// One Flagship Inference model, as `.com` serves it.
public struct InferenceModel: Codable, Equatable, Sendable, Identifiable {
    /// Catalog id the box sends as `model` ("low", "medium", …).
    public let id: String
    /// Tier label ("Low", "Medium multimodal", …).
    public let tier: String
    /// The real model's name ("Qwen3.6-35B-A3B").
    public let model: String
    /// Credits per 1,000 weighted tokens, relative to the base model.
    public let multiplier: Double
    /// "Low 1× (Qwen3.6-35B-A3B)": what a menu shows.
    public let label: String
    public let descriptor: String
    public let contextTokens: Int
    /// "text", "image".
    public let modalities: [String]
    /// "Think harder" is offered.
    public let reasoning: Bool
    public let `default`: Bool?
    /// For a text-only model: the catalog id to switch to for an image.
    public let visionAlternative: String?
    public let upstream: [String: String]?

    public init(id: String, tier: String, model: String, multiplier: Double, label: String,
                descriptor: String, contextTokens: Int, modalities: [String], reasoning: Bool,
                default isDefault: Bool? = nil, visionAlternative: String? = nil,
                upstream: [String: String]? = nil) {
        self.id = id; self.tier = tier; self.model = model; self.multiplier = multiplier
        self.label = label; self.descriptor = descriptor; self.contextTokens = contextTokens
        self.modalities = modalities; self.reasoning = reasoning; self.default = isDefault
        self.visionAlternative = visionAlternative; self.upstream = upstream
    }

    public var seesImages: Bool { modalities.contains("image") }
}

/// `GET https://flagshipserver.com/api/inference/models`.
public struct InferenceCatalogResponse: Codable, Equatable, Sendable {
    public let models: [InferenceModel]
    public let defaultModel: String
    /// 1 credit = this many weighted tokens.
    public let creditTokens: Double
    public let inputWeight: Double
    public let outputWeight: Double

    public init(models: [InferenceModel], defaultModel: String, creditTokens: Double = 1000,
                inputWeight: Double = 1, outputWeight: Double = 4) {
        self.models = models; self.defaultModel = defaultModel; self.creditTokens = creditTokens
        self.inputWeight = inputWeight; self.outputWeight = outputWeight
    }
}

/// A row of an own-key model menu, as the box answers it.
public struct ModelOption: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let label: String
    public let contextTokens: Int?
    /// Takes images. Nil: unknown.
    public let vision: Bool?
    /// Takes tool calls. Nil: unknown.
    public let tools: Bool?
    /// Effort levels in the provider's own words; absent: no control.
    public let efforts: [String]?
    public let defaultEffort: String?
    /// False: not in the capability table ("capabilities unknown").
    public let known: Bool
    /// For a text-only model: the option to switch to for an image.
    public let visionAlternative: String?

    public init(id: String, label: String, contextTokens: Int? = nil, vision: Bool?, tools: Bool?,
                efforts: [String]? = nil, defaultEffort: String? = nil, known: Bool,
                visionAlternative: String? = nil) {
        self.id = id; self.label = label; self.contextTokens = contextTokens; self.vision = vision
        self.tools = tools; self.efforts = efforts; self.defaultEffort = defaultEffort
        self.known = known; self.visionAlternative = visionAlternative
    }
}

/// `POST /api/screens/ai/models` answer: the TS union
/// `{kind:"flagship", catalog}` | `{kind:"own", listed, models, defaultModel?, reason?}`.
public struct AiModelsResponse: Codable, Equatable, Sendable {
    public let provider: String
    /// "flagship" | "own".
    public let kind: String
    public let catalog: InferenceCatalogResponse?
    /// False: no list could be read; offer a free-text model field.
    public let listed: Bool?
    public let models: [ModelOption]?
    public let defaultModel: String?
    /// "no-list" | "rejected" | "failed".
    public let reason: String?

    public init(provider: String, kind: String, catalog: InferenceCatalogResponse? = nil,
                listed: Bool? = nil, models: [ModelOption]? = nil, defaultModel: String? = nil,
                reason: String? = nil) {
        self.provider = provider; self.kind = kind; self.catalog = catalog; self.listed = listed
        self.models = models; self.defaultModel = defaultModel; self.reason = reason
    }
}

/// One chat attachment on a start/reply turn (≤ 6 per message).
///   image    `{kind:"image", mediaType, dataBase64, name}`  png/jpeg/gif/webp, 4 MB
///   text     `{kind:"text", text, name}`                    256 KB
///   data     `{kind:"data", name, mediaType, text}`         text/csv | application/json, 2 MB
///   document `{kind:"document", name, mediaType, dataBase64}` application/pdf, 10 MB
public struct VibeCodeAttachment: Codable, Equatable, Sendable {
    public let kind: String
    public let name: String?
    public let mediaType: String?
    public let dataBase64: String?
    public let text: String?

    public init(kind: String, name: String?, mediaType: String? = nil, dataBase64: String? = nil,
                text: String? = nil) {
        self.kind = kind; self.name = name; self.mediaType = mediaType
        self.dataBase64 = dataBase64; self.text = text
    }

    public static func image(name: String, mediaType: String, data: Data) -> Self {
        .init(kind: "image", name: name, mediaType: mediaType, dataBase64: data.base64EncodedString())
    }
    public static func text(name: String, text: String) -> Self {
        .init(kind: "text", name: name, text: text)
    }
    public static func data(name: String, mediaType: String, text: String) -> Self {
        .init(kind: "data", name: name, mediaType: mediaType, text: text)
    }
    public static func document(name: String, data: Data) -> Self {
        .init(kind: "document", name: name, mediaType: "application/pdf", dataBase64: data.base64EncodedString())
    }
}

// MARK: - Fixtures (mock clients, previews, tests)

public extension InferenceCatalogResponse {
    /// The production catalog's shape (packages/control-plane/src/inferenceModels.ts).
    static let mock = InferenceCatalogResponse(
        models: [
            InferenceModel(id: "low", tier: "Low", model: "Qwen3.6-35B-A3B", multiplier: 1,
                           label: "Low 1× (Qwen3.6-35B-A3B)",
                           descriptor: "Quick and thrifty. Good for small apps and fixes.",
                           contextTokens: 262_144, modalities: ["text", "image"], reasoning: true,
                           default: true),
            InferenceModel(id: "medium", tier: "Medium", model: "DeepSeek-V4-Flash", multiplier: 1,
                           label: "Medium 1× (DeepSeek-V4-Flash)",
                           descriptor: "Stronger code for bigger apps. Text only.",
                           contextTokens: 1_000_000, modalities: ["text"], reasoning: true,
                           visionAlternative: "medium-vision"),
            InferenceModel(id: "medium-vision", tier: "Medium multimodal", model: "GLM-5.3-Flash", multiplier: 2,
                           label: "Medium multimodal 2× (GLM-5.3-Flash)",
                           descriptor: "Reads screenshots and mockups.",
                           contextTokens: 200_000, modalities: ["text", "image"], reasoning: true),
            InferenceModel(id: "high", tier: "High", model: "MiniMax-M3", multiplier: 3.5,
                           label: "High 3.5× (MiniMax-M3)",
                           descriptor: "The most capable. For hard builds.",
                           contextTokens: 1_000_000, modalities: ["text"], reasoning: false),
        ],
        defaultModel: "low")
}

public extension ModelOption {
    static let mockOwn: [ModelOption] = [
        ModelOption(id: "gpt-5.4-mini", label: "GPT-5.4 Mini", contextTokens: 400_000, vision: true, tools: true,
                    efforts: ["none", "low", "medium", "high", "xhigh"], defaultEffort: "medium", known: true),
        ModelOption(id: "qwen3-coder", label: "Qwen3 Coder", contextTokens: 262_144, vision: false, tools: true,
                    known: true, visionAlternative: "gpt-5.4-mini"),
        ModelOption(id: "brand-new", label: "brand-new", vision: nil, tools: nil, known: false),
    ]
}
