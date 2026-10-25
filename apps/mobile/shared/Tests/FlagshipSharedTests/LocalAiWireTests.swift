import XCTest
@testable import FlagshipAPI
@testable import FlagshipCore

/// The Local AI screen's wire (packages/server-daemon/src/localAi/http.ts) decodes as the box sends
/// it, and the mock box answers like the real one (same rows, refusals and sentences).
final class LocalAiWireTests: XCTestCase {
    /// A `GET /api/screens/local-ai` body in the shape `localAiView` writes (nulls and extra fields included).
    static let liveJSON = """
    {"available":true,"reason":null,"privacy":"this-server","cost":"none",
     "settings":{"useGpu":true,"serveModel":null},
     "hardware":{"cpus":4,"memoryMiB":7900,"diskFreeBytes":52000000000,"gpuService":true,
       "gpus":[{"id":"0","model":"RTX 4090","vendor":"nvidia","memoryMiB":24564,"state":"in-use",
         "holders":[{"appId":"flagship-local-ai","appName":"Local AI","allocationId":"localai-0123456789abcdef","state":"running"}]}]},
     "budget":{"usedBytes":491400032,"budgetBytes":68719476736},
     "models":[{"id":"qwen2.5-0.5b-q4","name":"Qwen2.5 0.5B","descriptor":"Tiny; runs on any server","parameters":"0.5B",
       "quantization":"Q4_K_M","sizeBytes":491400032,"license":{"id":"apache-2.0","url":"https://x"},"contextTokens":32768,
       "tools":true,"purpose":"chat","trainable":false,"state":"installed","progress":null,"reason":null,
       "memoryNeededMiB":923,"fits":true,"speed":{"tokensPerSecond":31.2,"measured":true,"on":"gpu"}},
      {"id":"stories-15m","name":"TinyStories 15M","descriptor":"d","parameters":"15M","quantization":"F32","sizeBytes":98357920,
       "license":{"id":"mit","url":"https://y"},"contextTokens":256,"tools":false,"purpose":"test","trainable":true,
       "state":"downloading","progress":{"state":"downloading","receivedBytes":10,"totalBytes":98357920},"reason":null,
       "memoryNeededMiB":368,"fits":true,"speed":{"tokensPerSecond":122,"measured":false,"on":"cpu"}}],
     "service":{"state":"running","jobId":"0123456789abcdef","modelId":"qwen2.5-0.5b-q4","device":"gpu",
       "gpu":{"allocationId":"localai-0123456789abcdef","deviceIds":["0"]},"queuePosition":null,"startedAt":1,"lastUsedAt":2,"inFlight":0,"reason":null},
     "jobs":[{"id":"0123456789abcdef","kind":"inference","appId":null,"appName":null,"modelId":"qwen2.5-0.5b-q4","state":"running",
       "device":"gpu","gpu":{"deviceIds":["0"]},"queuePosition":null,"createdAt":1,"startedAt":1,"endedAt":null,"reason":null,
       "epochs":null,"epochsDone":null,"checkpoints":null,"cost":"none"},
      {"id":"fedcba9876543210","kind":"training","appId":"alice--notes","appName":"Notes","modelId":"stories-15m","state":"queued",
       "device":null,"gpu":null,"queuePosition":2,"createdAt":3,"startedAt":null,"endedAt":null,"reason":null,
       "epochs":3,"epochsDone":0,"checkpoints":0,"cost":"none"}],
     "apps":[{"serviceId":"alice--notes","name":"Notes",
       "grant":{"serverDomain":"home.alice.flagship.services","serviceId":"alice--notes","requestsPerDay":500,"tokensPerDay":200000,"maxTokensPerRequest":1024,"issuedAt":9},
       "usage":{"day":"2026-10-24","requests":3,"tokens":900}}],
     "datasets":[{"serviceId":"alice--notes","name":"Notes","hasSampleData":true}],
     "trainableModels":[{"id":"stories-15m","name":"TinyStories 15M","installed":false,"memoryNeededMiB":934}]}
    """

    func testTheBoxesViewDecodes() throws {
        let v = try JSONDecoder().decode(LocalAiView.self, from: Data(Self.liveJSON.utf8))
        XCTAssertEqual(v.cost, "none")
        XCTAssertEqual(v.privacy, "this-server")
        XCTAssertEqual(v.hardware.gpus.first?.holders.first?.appName, "Local AI")
        XCTAssertEqual(v.models[1].progress?.receivedBytes, 10)
        XCTAssertTrue(v.models[0].speed.measured)
        XCTAssertEqual(v.jobs[1].queuePosition, 2)
        XCTAssertTrue(v.jobs[1].canCancel)
        XCTAssertEqual(v.apps.first?.grant?.maxTokensPerRequest, 1024)
        XCTAssertNil(v.settings.serveModel)
        let detail = """
        {"job":{"id":"fedcba9876543210","kind":"training","appId":"alice--notes","appName":"Notes","modelId":"stories-15m","state":"completed",
          "device":"cpu","gpu":null,"queuePosition":null,"createdAt":3,"startedAt":4,"endedAt":5,"reason":null,"epochs":2,"epochsDone":2,"checkpoints":2,"cost":"none"},
         "datasetDigest":"\(String(repeating: "a", count: 64))","datasetBytes":4096,
         "checkpoints":[{"epoch":1,"sha256":"\(String(repeating: "b", count: 64))","sizeBytes":98357920,"at":6,"loss":2.5},
                        {"epoch":2,"sha256":"\(String(repeating: "c", count: 64))","sizeBytes":98357920,"at":7,"loss":null}]}
        """
        let d = try JSONDecoder().decode(LocalAiJobDetail.self, from: Data(detail.utf8))
        XCTAssertEqual(d.checkpoints.count, 2)
        XCTAssertNil(d.checkpoints[1].loss)
        XCTAssertTrue(d.job.canDelete)
    }

    func testTheCredentialIsTheLocalProvider() {
        XCTAssertEqual(LocalAi.credential.provider, "flagship-local")
        XCTAssertEqual(LocalAi.credential.relay, false)
    }

    private func mock() -> MockScreensClient {
        let m = MockScreensClient()
        m.simulatedLatency = 0
        return m
    }

    private func boxSentence(_ error: Error) -> String? {
        guard case ScreensClientError.http(_, let body) = error,
              let o = try? JSONSerialization.jsonObject(with: Data(body.utf8)) as? [String: Any] else { return nil }
        return o["error"] as? String
    }

    func testMockDownloadFinishesAndRefusesLikeTheBox() async throws {
        let m = mock()
        try await m.localAiModel(.download, modelId: "stories-15m")
        do {
            try await m.localAiModel(.download, modelId: "stories-15m")
            XCTFail("a second download should be refused")
        } catch { XCTAssertEqual(boxSentence(error), "That model is already downloading.") }
        _ = try await m.localAi()
        _ = try await m.localAi()
        let v = try await m.localAi()
        XCTAssertEqual(v.models.first { $0.id == "stories-15m" }?.state, "installed")
        do {
            try await m.localAiModel(.download, modelId: "nope")
            XCTFail("unknown model")
        } catch { XCTAssertEqual(boxSentence(error), "That model isn't in this server's catalog.") }
    }

    func testMockServiceRefusesWithoutAModelAndNeverFallsBack() async throws {
        let m = mock()
        try await m.localAiModel(.delete, modelId: "qwen2.5-0.5b-q4")
        do {
            _ = try await m.localAiServiceStart(modelId: nil)
            XCTFail("no model")
        } catch { XCTAssertEqual(boxSentence(error), "No model is downloaded on this server yet. Download one under Local AI.") }
        let menu = try await m.aiModels(AiModelsRequest(credential: LocalAi.credential))
        XCTAssertEqual(menu.provider, "flagship-local")
        XCTAssertEqual(menu.models ?? [], [])
    }

    func testMockTrainAndGrantTakeOnlyTheOrdersFields() async throws {
        let m = mock()
        let domain = await m.boxDomain()!
        let order = LocalAiTrainOrder(serverDomain: domain, serviceId: "bright-maple--wiki", jobId: "0123456789abcdef",
                                      baseModel: "stories-260k", epochs: 2, issuedAt: 1)
        var bad = order.body(signatureHex: String(repeating: "0", count: 128))
        var o = bad["order"] as! [String: Any]
        o["dataset"] = "flagship-devfiles-other--app"
        bad["order"] = o
        do {
            _ = try await m.localAiTrain(body: bad)
            XCTFail("an extra field must be refused")
        } catch { XCTAssertEqual(boxSentence(error), "Send {order, signature} with exactly the training order's fields.") }
        do {
            _ = try await m.localAiTrain(body: order.body(signatureHex: String(repeating: "0", count: 128)))
            XCTFail("base model not downloaded")
        } catch { XCTAssertEqual(boxSentence(error), "Download the base model first.") }
        let g = LocalAiAppGrant.allow(serverDomain: domain, serviceId: "bright-maple--wiki", issuedAt: 5)
        try await m.localAiGrant(body: g.body(signatureHex: String(repeating: "0", count: 128)))
        do {
            try await m.localAiGrant(body: g.body(signatureHex: String(repeating: "0", count: 128)))
            XCTFail("not newer")
        } catch { XCTAssertEqual(boxSentence(error), "A newer choice is already in place.") }
        let v = try await m.localAi()
        XCTAssertEqual(v.apps.first?.grant?.requestsPerDay, 500)
    }
}
