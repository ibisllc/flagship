import XCTest
import UIKit
import ImageIO
import UniformTypeIdentifiers
@testable import Flagship
@testable import FlagshipUI
@testable import FlagshipAPI

/// The build chat's model menu and attachments: the copy, the wire, the
/// vision switch and the limits (the model-menu contract).
@MainActor
final class ModelMenuTests: XCTestCase {

    private let catalog = InferenceCatalogResponse.mock
    private func own(listed: Bool = true, reason: String? = nil, defaultModel: String? = "gpt-5.4-mini") -> AiModelsResponse {
        AiModelsResponse(provider: "openai", kind: "own", listed: listed, models: listed ? ModelOption.mockOwn : [],
                         defaultModel: defaultModel, reason: reason)
    }

    // MARK: copy

    func test_creditsUsed() {
        XCTAssertEqual(ModelMenuText.creditsUsed(2.8), "used 2.8 credits")
        XCTAssertEqual(ModelMenuText.creditsUsed(1), "used 1 credit")
        XCTAssertEqual(ModelMenuText.creditsUsed(1.04), "used 1 credit", "one decimal at most")
        XCTAssertEqual(ModelMenuText.creditsUsed(3.0), "used 3 credits", ".0 dropped")
        XCTAssertEqual(ModelMenuText.creditsUsed(12.345), "used 12.3 credits")
        XCTAssertEqual(ModelMenuText.creditsUsed(0.25), "used 0.3 credits")
    }

    func test_effortLabels() {
        XCTAssertEqual(ModelMenuText.effort("low"), "Low")
        XCTAssertEqual(ModelMenuText.effort("medium"), "Medium")
        XCTAssertEqual(ModelMenuText.effort("xhigh"), "Extra high")
        XCTAssertEqual(ModelMenuText.effort("max"), "Max")
        XCTAssertEqual(ModelMenuText.effort("minimal"), "Minimal")
        XCTAssertEqual(ModelMenuText.effort("none"), "None")
    }

    func test_shortNames() {
        XCTAssertEqual(ModelMenuText.multiplier(1), "1×")
        XCTAssertEqual(ModelMenuText.multiplier(3.5), "3.5×")
        XCTAssertEqual(ModelMenuText.short(catalog.models[0]), "Low 1×")
        XCTAssertEqual(ModelMenuText.short(catalog.models[2]), "Medium multimodal 2×")
    }

    // MARK: Flagship Inference

    /// A catalog whose Low model lists effort levels (Medium lists none).
    private var catalogWithEfforts: InferenceCatalogResponse {
        var models = catalog.models
        let low = models[0]
        models[0] = InferenceModel(id: low.id, tier: low.tier, model: low.model, multiplier: low.multiplier,
                                   label: low.label, descriptor: low.descriptor, contextTokens: low.contextTokens,
                                   modalities: low.modalities, reasoning: true,
                                   efforts: ["low", "medium", "high"], defaultEffort: "medium", default: true)
        return InferenceCatalogResponse(models: models, defaultModel: "low")
    }

    func test_flagship_noEffortUnlessTheCatalogListsOne() {
        let m = ModelMenuModel(source: .flagship(catalog))
        XCTAssertEqual(m.shortName, "Low 1×")
        XCTAssertEqual(m.wireModel, "low")
        XCTAssertTrue(catalog.models[0].reasoning)
        XCTAssertNil(m.efforts, "a model that reasons but lists no efforts gets no control")
        XCTAssertNil(m.wireEffort, "no effort is assumed for Flagship Inference")
        m.select("high")
        XCTAssertNil(m.efforts)
        XCTAssertNil(m.wireEffort)
    }

    func test_flagship_effortsFromTheCatalog() {
        let m = ModelMenuModel(source: .flagship(catalogWithEfforts))
        XCTAssertEqual(m.efforts, ["low", "medium", "high"])
        XCTAssertEqual(m.wireEffort, "medium", "starts on the catalog's defaultEffort")
        m.setEffort("high")
        XCTAssertEqual(m.wireEffort, "high")
        m.select("medium")
        XCTAssertNil(m.efforts, "Medium lists none")
        XCTAssertNil(m.wireEffort)
        m.select("low")
        XCTAssertEqual(m.wireEffort, "medium", "picking a model resets to its default")
        m.setEffort("low")
        m.pick("low")
        XCTAssertEqual(m.wireEffort, "medium", "picking the same model again resets too")
    }

    func test_flagship_resumesTheSessionsModel() {
        let m = ModelMenuModel(source: .flagship(catalog), initial: ModelChoice(model: "medium", effort: "high"))
        XCTAssertEqual(m.wireModel, "medium")
        XCTAssertNil(m.wireEffort, "an effort the model doesn't list is dropped")
        let withEfforts = ModelMenuModel(source: .flagship(catalogWithEfforts), initial: ModelChoice(model: "low", effort: "high"))
        XCTAssertEqual(withEfforts.wireEffort, "high", "the session's effort is kept when the model lists it")
        let stale = ModelMenuModel(source: .flagship(catalog), initial: ModelChoice(model: "flagship-free", effort: nil))
        XCTAssertEqual(stale.wireModel, "low", "an id the catalog lacks falls back to its default")
    }

    func test_flagship_catalogUnavailable() {
        let m = ModelMenuModel(source: .flagship(nil))
        XCTAssertEqual(m.shortName, "Flagship Inference")
        XCTAssertNil(m.wireModel, "no model sent; the box uses the default")
        XCTAssertNil(m.efforts)
        XCTAssertEqual(m.visionDecision(hasImage: true), .send)
    }

    func test_flagship_visionSwitch() {
        let m = ModelMenuModel(source: .flagship(catalog), initial: ModelChoice(model: "medium", effort: nil))
        XCTAssertEqual(m.visionDecision(hasImage: false), .send)
        XCTAssertEqual(m.visionDecision(hasImage: true),
                       .offerSwitch(to: "medium-vision", message: "I'll have to switch to GLM-5.3-Flash (2×) for this."))
        m.select("high")
        XCTAssertEqual(m.visionDecision(hasImage: true),
                       .cannot(message: "MiniMax-M3 can't see images. Remove them or pick another model."))
        m.select("low")
        XCTAssertEqual(m.visionDecision(hasImage: true), .send, "Low sees images")
    }

    // MARK: own key

    func test_own_listedEffortAndUnknown() {
        let m = ModelMenuModel(source: .own(own()))
        XCTAssertEqual(m.shortName, "GPT-5.4 Mini")
        XCTAssertEqual(m.wireModel, "gpt-5.4-mini")
        XCTAssertEqual(m.efforts, ["none", "low", "medium", "high", "xhigh"])
        XCTAssertEqual(m.wireEffort, "medium", "preselects defaultEffort")
        m.setEffort("xhigh")
        XCTAssertEqual(m.wireEffort, "xhigh")
        m.select("brand-new")
        XCTAssertNil(m.efforts, "unknown model: no effort control")
        XCTAssertNil(m.wireEffort)
        XCTAssertNil(m.contextTokens, "unknown model: context unknown")
        XCTAssertEqual(m.visionDecision(hasImage: true), .send, "vision unknown: no alert")
    }

    func test_own_visionSwitch() {
        let m = ModelMenuModel(source: .own(own()), initial: ModelChoice(model: "qwen3-coder", effort: nil))
        XCTAssertEqual(m.visionDecision(hasImage: true),
                       .offerSwitch(to: "gpt-5.4-mini", message: "I'll have to switch to GPT-5.4 Mini for this."))
        let lone = AiModelsResponse(provider: "openai", kind: "own", listed: true, models: [
            ModelOption(id: "coder", label: "Coder", vision: false, tools: true, known: true),
        ])
        XCTAssertEqual(ModelMenuModel(source: .own(lone)).visionDecision(hasImage: true),
                       .cannot(message: "Coder can't see images. Remove them or pick another model."))
    }

    func test_own_unlistedFreeText() {
        let m = ModelMenuModel(source: .own(own(listed: false, reason: "rejected", defaultModel: "gpt-5")))
        XCTAssertEqual(m.customModel, "gpt-5", "prefilled with defaultModel")
        XCTAssertEqual(m.wireModel, "gpt-5")
        m.customModel = "  my-model "
        XCTAssertEqual(m.wireModel, "my-model")
        XCTAssertEqual(m.shortName, "my-model")
        m.customModel = ""
        XCTAssertNil(m.wireModel)
        XCTAssertNil(m.wireEffort)
    }

    func test_onChangeFiresOnlyForOwnerChanges() async {
        var seen: [ModelChoice] = []
        let withEfforts = catalogWithEfforts
        let m = ModelMenuModel(initial: nil) { .flagship(withEfforts) }
        m.onChange = { seen.append($0) }
        await m.ensureLoaded()
        XCTAssertTrue(seen.isEmpty, "loading isn't a change")
        m.select("medium")
        m.select("low")
        m.setEffort("high")
        XCTAssertEqual(seen, [ModelChoice(model: "medium", effort: nil), ModelChoice(model: "low", effort: "medium"),
                              ModelChoice(model: "low", effort: "high")])
    }

    func test_defaultModelStore() {
        DefaultModelStore.defaults = UserDefaults(suiteName: "model-menu-\(UUID().uuidString)")!
        XCTAssertNil(DefaultModelStore.choice(for: "k1"))
        DefaultModelStore.set(ModelChoice(model: "medium", effort: "high"), for: "k1")
        DefaultModelStore.set(ModelChoice(model: "gpt-5", effort: nil), for: "k2")
        XCTAssertEqual(DefaultModelStore.choice(for: "k1"), ModelChoice(model: "medium", effort: "high"))
        XCTAssertEqual(DefaultModelStore.choice(for: "k2")?.model, "gpt-5")
        let free = LlmProviderCredential(provider: "flagship", apiKey: "v1.x", source: "promo")
        XCTAssertEqual(DefaultModelStore.keyId(for: free), SavedKeyStore.flagshipInferenceId)
    }

    // MARK: wire

    private func json(_ v: some Encodable) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(v)) as? [String: Any])
    }

    func test_reply_sendsModelAndNullEffort() throws {
        let off = try json(VibeCodeReplyRequest(text: "hi", model: "low", effort: nil))
        XCTAssertEqual(off["model"] as? String, "low")
        XCTAssertTrue(off.keys.contains("effort"), "effort: null = provider default")
        XCTAssertTrue(off["effort"] is NSNull)
        XCTAssertNil(off["attachments"])
        let on = try json(VibeCodeReplyRequest(text: "hi", model: "low", effort: "high"))
        XCTAssertEqual(on["effort"] as? String, "high")
        let envOnly = try json(VibeCodeReplyRequest(text: nil, envVarStatus: "set"))
        XCTAssertFalse(envOnly.keys.contains("effort"), "no model ⇒ no effort key")
        XCTAssertFalse(envOnly.keys.contains("model"))
    }

    func test_start_sendsModelEffortAttachments() throws {
        let a = VibeCodeAttachment.data(name: "plants.csv", mediaType: "text/csv", text: "name\nfern\n")
        let body = try json(VibeCodeStartRequest(prompt: "p", model: "medium", effort: "high", attachments: [a]))
        XCTAssertEqual(body["model"] as? String, "medium")
        XCTAssertEqual(body["effort"] as? String, "high")
        let att = try XCTUnwrap((body["attachments"] as? [[String: Any]])?.first)
        XCTAssertEqual(att["kind"] as? String, "data")
        XCTAssertEqual(att["mediaType"] as? String, "text/csv")
        XCTAssertEqual(att["name"] as? String, "plants.csv")
        XCTAssertEqual(att["text"] as? String, "name\nfern\n")
        XCTAssertNil(att["dataBase64"])
        let bare = try json(VibeCodeStartRequest(prompt: "p", model: nil, attachments: []))
        XCTAssertNil(bare["attachments"], "no empty array on the wire")
        XCTAssertNil(bare["effort"])
    }

    func test_decodesBothModelAnswers() throws {
        let flagship = """
        {"provider":"flagship","kind":"flagship","catalog":{"models":[{"id":"low","tier":"Low","model":"Qwen3.6-35B-A3B",
        "multiplier":1,"label":"Low 1× (Qwen3.6-35B-A3B)","descriptor":"Quick.","contextTokens":262144,
        "modalities":["text","image"],"reasoning":true,"default":true,"upstream":{"deepinfra":"x"}}],
        "defaultModel":"low","creditTokens":1000,"inputWeight":1,"outputWeight":4}}
        """
        let f = try JSONDecoder().decode(AiModelsResponse.self, from: Data(flagship.utf8))
        XCTAssertEqual(f.catalog?.models.first?.label, "Low 1× (Qwen3.6-35B-A3B)")
        let ownJson = """
        {"provider":"openai","kind":"own","listed":true,"defaultModel":"gpt-5","models":[
        {"id":"gpt-5.4-mini","label":"GPT-5.4 Mini","contextTokens":400000,"vision":true,"tools":true,
         "efforts":["none","low"],"defaultEffort":"low","known":true},
        {"id":"brand-new","label":"brand-new","vision":null,"tools":null,"known":false}]}
        """
        let o = try JSONDecoder().decode(AiModelsResponse.self, from: Data(ownJson.utf8))
        XCTAssertEqual(o.models?.count, 2)
        XCTAssertNil(o.models?[1].vision)
        XCTAssertEqual(o.models?[1].known, false)
        let state = """
        {"id":"s","appId":null,"status":"awaiting-tool-response","model":"medium","effort":"high","summarised":true,
         "messages":[{"role":"assistant","text":"ok","timestamp":1,"credits":2.8},
                     {"role":"user","text":"see","timestamp":2,"attachments":[{"kind":"image","mediaType":"image/png","dataBase64":"AA==","name":"a.png"}]}]}
        """
        let s = try JSONDecoder().decode(VibeCodeSessionPublicState.self, from: Data(state.utf8))
        XCTAssertEqual(s.model, "medium")
        XCTAssertEqual(s.summarised, true)
        XCTAssertEqual(s.messages[0].credits, 2.8)
        XCTAssertEqual(s.messages[1].attachments?.first?.name, "a.png")
        let lines = VibeTranscript.lines(s.messages).lines
        XCTAssertEqual(lines[0].credits, 2.8)
        XCTAssertEqual(lines[1].attachments?.count, 1)
        XCTAssertNil(s.canContinue, "an older box omits the new fields")
        XCTAssertNil(s.provider)
        XCTAssertNil(s.conversationTokens)
        XCTAssertNil(f.catalog?.models.first?.efforts)
    }

    func test_decodesContinueProviderAndEfforts() throws {
        let state = """
        {"id":"s","appId":"u--plants","status":"failed","messages":[],"failureReason":"build failed",
         "needsCredential":true,"model":"gpt-5.4-mini","provider":"openai","canContinue":true,"conversationTokens":42000}
        """
        let s = try JSONDecoder().decode(VibeCodeSessionPublicState.self, from: Data(state.utf8))
        XCTAssertEqual(s.canContinue, true)
        XCTAssertEqual(s.provider, "openai")
        XCTAssertEqual(s.conversationTokens, 42_000)
        XCTAssertEqual(s.needsCredential, true)
        let catalogJson = """
        {"models":[{"id":"low","tier":"Low","model":"Q","multiplier":1,"label":"Low 1× (Q)","descriptor":"d",
          "contextTokens":262144,"modalities":["text"],"reasoning":true,"efforts":["low","high"],"defaultEffort":"low"}],
         "defaultModel":"low","creditTokens":1000,"inputWeight":1,"outputWeight":4}
        """
        let c = try JSONDecoder().decode(InferenceCatalogResponse.self, from: Data(catalogJson.utf8))
        XCTAssertEqual(c.models[0].efforts, ["low", "high"])
        XCTAssertEqual(c.models[0].defaultEffort, "low")
        let sessions = """
        {"sessions":[{"sessionId":"a","startedAt":1,"status":"failed","updatedAt":9},{"sessionId":"b","startedAt":5,"status":"deployed"}]}
        """
        let list = try JSONDecoder().decode(VibeCodeSessionsResponse.self, from: Data(sessions.utf8))
        XCTAssertEqual(list.sessions[0].lastActivity, 9)
        XCTAssertEqual(list.sessions[1].lastActivity, 5, "no updatedAt: startedAt")
    }

    func test_mockClientsAnswerTheMenus() async throws {
        let screens = MockScreensClient()
        screens.simulatedLatency = 0
        ModelMenuCache.clear()
        let cred = LlmProviderCredential(provider: "openai", apiKey: "sk-test")
        let r1 = await ModelMenuCache.models(for: cred) { try await screens.aiModels($0) }
        let r2 = await ModelMenuCache.models(for: cred) { try await screens.aiModels($0) }
        XCTAssertEqual(r1, r2)
        XCTAssertEqual(screens.aiModelsCalls, 1, "cached per credential")
        struct Boom: Error {}
        let failed = await ModelMenuCache.models(for: LlmProviderCredential(provider: "openai", apiKey: "other")) { _ in
            throw Boom()
        }
        XCTAssertEqual(failed.listed, false, "a failed call becomes a free-text field")
        ModelMenuCache.clear()
    }

    // MARK: attachments

    private let png = Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A] + [UInt8](repeating: 0, count: 16))

    func test_attachmentKinds() {
        XCTAssertEqual(ChatAttachmentRules.kind(forFileName: "shot.PNG"), .image)
        XCTAssertEqual(ChatAttachmentRules.kind(forFileName: "notes.md"), .text)
        XCTAssertEqual(ChatAttachmentRules.kind(forFileName: "server.ts"), .text)
        XCTAssertEqual(ChatAttachmentRules.kind(forFileName: "Dockerfile"), .text)
        XCTAssertEqual(ChatAttachmentRules.kind(forFileName: "plants.csv"), .data)
        XCTAssertEqual(ChatAttachmentRules.kind(forFileName: "seed.json"), .data)
        XCTAssertEqual(ChatAttachmentRules.kind(forFileName: "spec.pdf"), .document)
        XCTAssertNil(ChatAttachmentRules.kind(forFileName: "movie.mov"))
        XCTAssertNil(ChatAttachmentRules.kind(forFileName: "archive.zip"))
    }

    func test_attachmentWireShapes() throws {
        guard case .success(let img) = ChatAttachmentRules.attachment(name: "a.png", data: png) else { return XCTFail() }
        XCTAssertEqual(img.kind, "image")
        XCTAssertEqual(img.mediaType, "image/png")
        guard case .success(let csv) = ChatAttachmentRules.attachment(name: "p.csv", data: Data("a,b\n".utf8)) else { return XCTFail() }
        XCTAssertEqual(csv, .data(name: "p.csv", mediaType: "text/csv", text: "a,b\n"))
        guard case .success(let js) = ChatAttachmentRules.attachment(name: "s.json", data: Data("{}".utf8)) else { return XCTFail() }
        XCTAssertEqual(js.mediaType, "application/json")
        guard case .success(let pdf) = ChatAttachmentRules.attachment(name: "s.pdf", data: Data("%PDF-1.7".utf8)) else { return XCTFail() }
        XCTAssertEqual(pdf.kind, "document")
        XCTAssertEqual(pdf.mediaType, "application/pdf")
        XCTAssertEqual(pdf.dataBase64, Data("%PDF-1.7".utf8).base64EncodedString())
        XCTAssertEqual(ChatAttachmentRules.attachment(name: "fake.pdf", data: Data("hello".utf8)),
                       .failure(.unsupported(name: "fake.pdf")))
        XCTAssertEqual(ChatAttachmentRules.attachment(name: "b.txt", data: Data([0xFF, 0xFE, 0xFD])),
                       .failure(.notText(name: "b.txt")))
    }

    func test_attachmentLimits() {
        let text = Data(repeating: 0x61, count: 256 * 1024 + 1)
        XCTAssertEqual(ChatAttachmentRules.attachment(name: "big.txt", data: text),
                       .failure(.tooBig(name: "big.txt", kind: .text)))
        XCTAssertEqual(ChatAttachmentRules.Refusal.tooBig(name: "big.txt", kind: .text).message,
                       "big.txt is over the 256 KB limit for text files.")
        XCTAssertEqual(ChatAttachmentRules.Refusal.tooBig(name: "a.png", kind: .image).message,
                       "a.png is over the 4 MB limit for images.")
        XCTAssertEqual(ChatAttachmentRules.Refusal.tooBig(name: "d.csv", kind: .data).message,
                       "d.csv is over the 2 MB limit for CSV and JSON files.")
        XCTAssertEqual(ChatAttachmentRules.Refusal.tooBig(name: "s.pdf", kind: .document).message,
                       "s.pdf is over the 10 MB limit for PDFs.")
        let csv = Data(repeating: 0x61, count: 2 * 1024 * 1024)
        if case .failure = ChatAttachmentRules.attachment(name: "ok.csv", data: csv) { XCTFail("2 MB exactly fits") }
    }

    func test_stager() {
        let s = ChatAttachmentStager()
        s.add(ChatAttachmentRules.attachment(name: "a.png", data: png))
        s.add(ChatAttachmentRules.attachment(name: "d.csv", data: Data("x".utf8)))
        XCTAssertTrue(s.hasImage)
        XCTAssertTrue(s.hasData)
        s.add(ChatAttachmentRules.attachment(name: "x.zip", data: Data()))
        XCTAssertEqual(s.staged.count, 2, "a refused file isn't attached")
        XCTAssertEqual(s.error, "x.zip can't be attached. Attach an image, a text file, a CSV or JSON file, or a PDF.")
        for i in 0..<5 { s.add(.success(.text(name: "\(i).txt", text: "t"))) }
        XCTAssertEqual(s.staged.count, 6)
        XCTAssertEqual(s.error, "You can attach up to 6 files to a message.")
        s.remove(s.staged[0].id)
        XCTAssertFalse(s.hasImage)
        XCTAssertNil(s.error)
        XCTAssertEqual(s.wire.count, 5)
        s.clear()
        XCTAssertTrue(s.isEmpty)
    }

    func test_photoIsReencodedWhenNotAcceptedAsIs() throws {
        let img = UIGraphicsImageRenderer(size: CGSize(width: 40, height: 30)).image { ctx in
            UIColor.red.setFill(); ctx.fill(CGRect(x: 0, y: 0, width: 40, height: 30))
        }
        guard case .success(let kept) = ChatAttachmentRules.photo(data: try XCTUnwrap(img.pngData()), index: 1)
        else { return XCTFail() }
        XCTAssertEqual(kept.name, "photo-1.png", "a png under the limit is kept as is")
        // A TIFF stands in for HEIC: decodable, but not a type the box takes.
        let tiff = NSMutableData()
        let dest = try XCTUnwrap(CGImageDestinationCreateWithData(tiff, UTType.tiff.identifier as CFString, 1, nil))
        CGImageDestinationAddImage(dest, try XCTUnwrap(img.cgImage), nil)
        XCTAssertTrue(CGImageDestinationFinalize(dest))
        guard case .success(let jpeg) = ChatAttachmentRules.photo(data: tiff as Data, index: 2) else { return XCTFail() }
        XCTAssertEqual(jpeg.name, "photo-2.jpg")
        XCTAssertEqual(jpeg.mediaType, "image/jpeg")
        XCTAssertEqual(ChatAttachmentRules.photo(data: Data("nope".utf8), index: 3), .failure(.unreadable(name: "photo-3.jpg")))
    }
}
