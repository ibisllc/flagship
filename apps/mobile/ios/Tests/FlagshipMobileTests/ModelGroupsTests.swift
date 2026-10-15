import XCTest
@testable import Flagship
@testable import FlagshipUI
@testable import FlagshipAPI

/// The build chat's grouped model menu, the rules for which key a message
/// carries, the context notice, the composer and the build list.
/// MIRRORS the webapp `lib/modelGroups.js` tests.
@MainActor
final class ModelGroupsTests: XCTestCase {

    private let work = SavedKeyStore.Entry(id: "k1", provider: "openai", label: "Work", apiKey: "sk-work-123456789")
    private let home = SavedKeyStore.Entry(id: "k2", provider: "anthropic", label: "Home", apiKey: "sk-ant-123456789")
    private let router = SavedKeyStore.Entry(id: "k3", provider: "openrouter", label: "Router", apiKey: "sk-or-123456789")
    private let work2 = SavedKeyStore.Entry(id: "k4", provider: "openai", label: "Side", apiKey: "sk-side-123456789")

    override func setUp() {
        super.setUp()
        DefaultModelStore.defaults = UserDefaults(suiteName: "model-groups-\(UUID().uuidString)")!
        FreeAiSessions.defaults = UserDefaults(suiteName: "model-groups-free-\(UUID().uuidString)")!
    }

    // MARK: groups

    func test_specs_flagshipFirstThenSavedKeysInOrder() {
        let specs = ModelGroups.specs(entries: [work, home], includeFlagship: true)
        XCTAssertEqual(specs.map(\.id), [ModelGroups.flagshipId, "k1", "k2"])
        XCTAssertEqual(specs[0].title, "Flagship Inference")
        XCTAssertEqual(specs[1].title, "openai · Work")
        XCTAssertEqual(ModelGroups.specs(entries: [work], includeFlagship: false).map(\.id), ["k1"])
    }

    func test_groupForProvider() {
        let specs = ModelGroups.specs(entries: [router, work, work2, home], includeFlagship: true)
        XCTAssertEqual(ModelGroups.groupId(forProvider: "flagship", in: specs), ModelGroups.flagshipId)
        XCTAssertEqual(ModelGroups.groupId(forProvider: "openai", in: specs), "k1", "the first key of that provider")
        XCTAssertEqual(ModelGroups.groupId(forProvider: "anthropic", in: specs), "k2")
        XCTAssertEqual(ModelGroups.groupId(forProvider: "openrouter", in: specs), "k3")
        XCTAssertNil(ModelGroups.groupId(forProvider: "google", in: specs), "no saved key of it here")
        XCTAssertNil(ModelGroups.groupId(forProvider: nil, in: specs))
        let noFlagship = ModelGroups.specs(entries: [router], includeFlagship: false)
        XCTAssertNil(ModelGroups.groupId(forProvider: "flagship", in: noFlagship))
        XCTAssertEqual(ModelGroups.groupId(forProvider: "openai", in: noFlagship), "k3",
                       "an OpenRouter key goes to the box as OpenAI-compatible")
    }

    func test_groupForCredential() {
        let specs = ModelGroups.specs(entries: [work, home], includeFlagship: true)
        XCTAssertEqual(ModelGroups.groupId(forCredential: home.credential, in: specs), "k2")
        let pass = LlmProviderCredential(provider: "flagship", apiKey: "v1.x", source: "promo")
        XCTAssertEqual(ModelGroups.groupId(forCredential: pass, in: specs), ModelGroups.flagshipId)
        XCTAssertNil(ModelGroups.groupId(forCredential: nil, in: specs))
    }

    // MARK: context notice

    func test_mayDropContext_mirrorsTheBoxThreshold() {
        // 200k: 16k kept for the reply, 75% of the rest = 138,000.
        XCTAssertFalse(ModelGroups.mayDropContext(conversationTokens: 138_000, contextTokens: 200_000))
        XCTAssertTrue(ModelGroups.mayDropContext(conversationTokens: 138_001, contextTokens: 200_000))
        // 32k: a quarter (8k) kept, 75% of 24k = 18,000.
        XCTAssertFalse(ModelGroups.mayDropContext(conversationTokens: 18_000, contextTokens: 32_000))
        XCTAssertTrue(ModelGroups.mayDropContext(conversationTokens: 18_001, contextTokens: 32_000))
        XCTAssertFalse(ModelGroups.mayDropContext(conversationTokens: nil, contextTokens: 32_000))
        XCTAssertFalse(ModelGroups.mayDropContext(conversationTokens: 50_000, contextTokens: nil))
    }

    func test_contextNotice_onlyForAnotherModelThatWouldDropContext() {
        XCTAssertEqual(ModelGroups.contextNotice(chosenModel: "small", sessionModel: "big", contextTokens: 32_000,
                                                 conversationTokens: 20_000),
                       "Older messages will be summarised to fit this model.")
        XCTAssertNil(ModelGroups.contextNotice(chosenModel: "big", sessionModel: "big", contextTokens: 32_000,
                                               conversationTokens: 20_000), "same model: nothing changes")
        XCTAssertNil(ModelGroups.contextNotice(chosenModel: "small", sessionModel: "big", contextTokens: 32_000,
                                               conversationTokens: 10_000), "fits")
        XCTAssertNil(ModelGroups.contextNotice(chosenModel: "small", sessionModel: "big", contextTokens: nil,
                                               conversationTokens: 20_000), "context unknown")
        XCTAssertNil(ModelGroups.contextNotice(chosenModel: nil, sessionModel: "big", contextTokens: 32_000,
                                               conversationTokens: 20_000))
    }

    // MARK: which key a message carries

    func test_credentialRules() {
        let flagship = ModelGroups.flagshipSpec
        let own = ModelGroups.Spec(id: "k1", title: "t", entry: work)
        XCTAssertEqual(ModelGroups.credential(for: flagship, picked: false, needsCredential: false), .mintFlagship,
                       "Flagship Inference always sends a fresh pass")
        XCTAssertEqual(ModelGroups.credential(for: own, picked: false, needsCredential: false), .keep,
                       "the box keeps the key it holds")
        XCTAssertEqual(ModelGroups.credential(for: own, picked: true, needsCredential: false), .send(work.credential))
        XCTAssertEqual(ModelGroups.credential(for: own, picked: false, needsCredential: true), .send(work.credential))
        XCTAssertEqual(ModelGroups.credential(for: own, picked: false, needsCredential: false, starting: true),
                       .send(work.credential))
        XCTAssertEqual(ModelGroups.credential(for: nil, picked: true, needsCredential: true), .keep)
        guard case .send(let c) = ModelGroups.credential(for: ModelGroups.Spec(id: "k3", title: "t", entry: router),
                                                          picked: true, needsCredential: false) else {
            return XCTFail("a picked key is sent")
        }
        XCTAssertEqual(c.provider, "openai", "OpenRouter goes as OpenAI-compatible")
        XCTAssertEqual(c.apiKey, router.apiKey)
    }

    func test_resolveChoice_mintsAndStopsWhenItMust() async throws {
        let pass = LlmProviderCredential(provider: "flagship", apiKey: "tok", source: "promo")
        let ok: @MainActor () async throws -> LlmProviderCredential = { pass }
        let down: @MainActor () async throws -> LlmProviderCredential = { throw FreeAiError.unavailable(message: "x") }
        let r1 = try await VibeCodeReplyCredential.resolve(choice: .mintFlagship, switchingProvider: false, freeAi: ok)
        XCTAssertEqual(r1, pass)
        let kept = try await VibeCodeReplyCredential.resolve(choice: .mintFlagship, switchingProvider: false, freeAi: down)
        XCTAssertNil(kept, "unavailable for now: the box keeps the pass it holds")
        do {
            _ = try await VibeCodeReplyCredential.resolve(choice: .mintFlagship, switchingProvider: true, freeAi: down)
            XCTFail("switching to Flagship Inference without a pass must stop")
        } catch {}
        do {
            _ = try await VibeCodeReplyCredential.resolve(
                choice: .mintFlagship, switchingProvider: false,
                freeAi: { throw FreeAiError.usedUp(message: FreeAiCopy.usedUp, credits: nil) })
            XCTFail("used up must surface")
        } catch {
            XCTAssertEqual(ScreensClientError.userFacing(error), FreeAiCopy.usedUp)
        }
        let none = try await VibeCodeReplyCredential.resolve(choice: .keep, switchingProvider: false, freeAi: ok)
        XCTAssertNil(none)
        let sent = try await VibeCodeReplyCredential.resolve(choice: .send(work.credential), switchingProvider: true, freeAi: ok)
        XCTAssertEqual(sent, work.credential)
    }

    // MARK: the grouped menu

    private func ownModels(_ c: LlmProviderCredential) async -> AiModelsResponse {
        if c.provider == "anthropic" {
            return AiModelsResponse(provider: "anthropic", kind: "own", listed: false, models: [], reason: "no-list")
        }
        return AiModelsResponse(provider: c.provider, kind: "own", listed: true, models: ModelOption.mockOwn,
                                defaultModel: "gpt-5.4-mini")
    }

    private func configured(provider: String?, model: String?, effort: String? = nil, entries: [SavedKeyStore.Entry]? = nil,
                            freeAi: Bool = false, usable: Bool? = nil) -> GroupedModelMenu {
        let m = GroupedModelMenu()
        var check: (@MainActor () async -> Bool)?
        if let usable { check = { usable } }
        m.configure(entries: entries ?? [work, home], provider: provider, freeAiSession: freeAi,
                    fallbackCredential: nil, initial: ModelChoice(model: model, effort: effort),
                    flagshipCatalog: { InferenceCatalogResponse.mock },
                    ownModels: { [unowned self] in await self.ownModels($0) },
                    flagshipUsable: check)
        let saved = [work, home, router, work2]
        m.keyLookup = { id in saved.first { $0.id == id } }
        return m
    }

    func test_reopenedChat_preselectsTheBoxsGroupAndModel() async {
        let m = configured(provider: "openai", model: "qwen3-coder")
        XCTAssertEqual(m.groups.map(\.id), ["k1", "k2"], "Flagship Inference only when usable or in use")
        XCTAssertEqual(m.selectedGroupId, "k1")
        XCTAssertFalse(m.picked)
        await m.loadCurrent()
        XCTAssertEqual(m.wireModel, "qwen3-coder")
        XCTAssertEqual(m.shortName, "Qwen3 Coder · Work", "an own key's name follows the model")
        XCTAssertNil(m.efforts, "Qwen3 Coder lists no efforts")
        XCTAssertEqual(m.credentialChoice(needsCredential: false), .keep,
                       "don't send a key just because of the inference")
        XCTAssertEqual(m.credentialChoice(needsCredential: true), .send(work.credential))
    }

    func test_flagshipChat_isFirstAndAlwaysMints() async {
        let m = configured(provider: "flagship", model: "medium")
        XCTAssertEqual(m.groups.map(\.id), [ModelGroups.flagshipId, "k1", "k2"])
        await m.loadCurrent()
        XCTAssertEqual(m.shortName, "Medium 1×", "no key name for Flagship Inference")
        XCTAssertNil(m.efforts, "the catalog lists none: no effort control")
        XCTAssertNil(m.wireEffort)
        XCTAssertEqual(m.credentialChoice(needsCredential: false), .mintFlagship)
    }

    func test_olderBox_usesTheRememberedFreeAiChat() {
        let m = configured(provider: nil, model: nil, freeAi: true)
        XCTAssertEqual(m.selectedGroupId, ModelGroups.flagshipId)
    }

    func test_pickingAnotherGroup_sendsItsKeyOnce() async {
        let m = configured(provider: "anthropic", model: "claude-x")
        XCTAssertEqual(m.selectedGroupId, "k2")
        await m.loadAll()
        m.pick(groupId: "k1", modelId: "gpt-5.4-mini")
        XCTAssertTrue(m.picked)
        XCTAssertEqual(m.wireModel, "gpt-5.4-mini")
        XCTAssertEqual(m.efforts, ["none", "low", "medium", "high", "xhigh"])
        XCTAssertEqual(m.wireEffort, "medium", "effort starts on the model's default")
        XCTAssertEqual(m.credentialChoice(needsCredential: false), .send(work.credential))
        XCTAssertEqual(m.credentialChoice(needsCredential: false, switching: false), .keep,
                       "an env-var answer keeps the box's key")
        m.didSend()
        XCTAssertFalse(m.picked)
        XCTAssertEqual(m.boxGroupId, "k1")
        XCTAssertEqual(m.credentialChoice(needsCredential: false), .keep, "the box holds it now")
    }

    func test_deletedKey_isNotSent() async throws {
        let m = configured(provider: "anthropic", model: "claude-x")
        await m.loadAll()
        m.pick(groupId: "k1", modelId: "gpt-5.4-mini")
        m.keyLookup = { _ in nil }
        XCTAssertEqual(m.credentialChoice(needsCredential: false), .keyGone)
        do {
            _ = try await VibeCodeReplyCredential.resolve(choice: .keyGone, switchingProvider: true, freeAi: nil)
            XCTFail("a deleted key stops the send")
        } catch {
            XCTAssertEqual(error.localizedDescription,
                           "That AI key isn't saved on this phone any more. Pick another model.")
        }
    }

    func test_nothingChosen_and_noGroups() {
        let m = configured(provider: nil, model: nil, entries: [])
        XCTAssertTrue(m.groups.isEmpty)
        XCTAssertTrue(m.isActive, "the menu still shows, to say how to add a key")
        XCTAssertEqual(m.shortName, "Choose a model")
        XCTAssertEqual(ModelGroups.noGroups, "Add an AI key in Settings to pick a model.")
    }

    func test_unlistedKey_offersATypedModel() async throws {
        let m = configured(provider: "openai", model: "gpt-5.4-mini")
        await m.loadAll()
        let anthropic = try XCTUnwrap(m.group("k2"))
        XCTAssertEqual(anthropic.menu.ownListed, false)
        anthropic.menu.customModel = "claude-sonnet"
        m.selectGroup("k2")
        XCTAssertEqual(m.wireModel, "claude-sonnet")
        XCTAssertEqual(m.shortName, "claude-sonnet · Home")
        XCTAssertTrue(m.picked)
    }

    func test_flagshipAddedWhenUsable() async {
        let m = configured(provider: "openai", model: "gpt-5.4-mini", usable: true)
        XCTAssertEqual(m.groups.count, 2)
        await m.loadAll()
        XCTAssertEqual(m.groups.map(\.id), [ModelGroups.flagshipId, "k1", "k2"])
        let off = configured(provider: "openai", model: "gpt-5.4-mini", usable: false)
        await off.loadAll()
        XCTAssertEqual(off.groups.map(\.id), ["k1", "k2"])
    }

    func test_providerWithoutAKeyHere_showsTheChatsModel() {
        let m = configured(provider: "google", model: "gemini-x")
        XCTAssertNil(m.selectedGroupId)
        XCTAssertEqual(m.shortName, "gemini-x")
        XCTAssertNil(m.wireModel, "nothing changes until the owner picks")
        XCTAssertEqual(m.credentialChoice(needsCredential: true), .keep)
    }

    func test_contextNoticeFromTheMenu() async {
        let m = configured(provider: "openai", model: "gpt-5.4-mini")
        await m.loadCurrent()
        let state = VibeCodeSessionPublicState(id: "s", appId: nil, status: "ready-to-deploy", messages: [],
                                               pendingRequest: nil, model: "gpt-5.4-mini", canContinue: true,
                                               conversationTokens: 200_000)
        XCTAssertNil(m.contextNotice(for: state), "same model")
        m.pick(groupId: "k1", modelId: "qwen3-coder")
        XCTAssertEqual(m.contextNotice(for: state), ModelMenuText.contextNotice,
                       "262k context: 200k is past 75% of what's left")
        m.pick(groupId: "k1", modelId: "brand-new")
        XCTAssertNil(m.contextNotice(for: state), "unknown context: no notice")
    }

    // MARK: composer

    func test_composerPlaceholders() {
        XCTAssertEqual(VibeCodeComposer.placeholder(status: "ready-to-deploy", canContinue: true), "Ask for a change…")
        XCTAssertEqual(VibeCodeComposer.placeholder(status: "failed", canContinue: true), "Tell the AI what to try next…")
        XCTAssertNil(VibeCodeComposer.placeholder(status: "failed", canContinue: false), "an older box takes none")
        XCTAssertNil(VibeCodeComposer.placeholder(status: "deployed", canContinue: false))
    }

    // MARK: build list

    func test_buildList_labelsAndActions() {
        XCTAssertEqual(BuildJournalScreen.sessionLabel("failed"), "Failed")
        XCTAssertEqual(BuildJournalScreen.sessionLabel("cancelled"), "Cancelled")
        XCTAssertEqual(BuildJournalScreen.sessionLabel("ready-to-deploy"), "Ready to deploy")
        for s in ["awaiting-tool-response", "ready-to-deploy", "failed"] {
            XCTAssertEqual(BuildJournalScreen.sessionAction(s), "Continue", s)
        }
        for s in ["streaming", "deploying"] { XCTAssertEqual(BuildJournalScreen.sessionAction(s), "Resume", s) }
        for s in ["deployed", "cancelled"] { XCTAssertEqual(BuildJournalScreen.sessionAction(s), "Open", s) }
    }

    func test_buildList_newestActivityFirst() async {
        let screens = MockScreensClient()
        screens.simulatedLatency = 0
        screens.vibeCodeSessionsFixture = [
            VibeCodeSessionMeta(sessionId: "old-but-touched", startedAt: 1, status: "failed", updatedAt: 500),
            VibeCodeSessionMeta(sessionId: "deployed", startedAt: 300, status: "deployed"),
            VibeCodeSessionMeta(sessionId: "cancelled", startedAt: 100, status: "cancelled", updatedAt: 150),
            VibeCodeSessionMeta(sessionId: "ready", startedAt: 200, status: "ready-to-deploy", updatedAt: 400),
        ]
        let vm = BuildJournalViewModel(client: screens)
        await vm.loadList()
        XCTAssertEqual(vm.liveSessions.map(\.sessionId), ["old-but-touched", "ready", "deployed", "cancelled"],
                       "every chat shows, newest activity first")
    }

    // MARK: mock matches the box

    func test_mockReplyRefusesLikeTheBox() async throws {
        let screens = MockScreensClient()
        screens.simulatedLatency = 0
        screens.vibeCodeSessionStateFixture = VibeCodeSessionPublicState(
            id: "s", appId: nil, status: "deployed", messages: [], pendingRequest: nil, canContinue: false)
        do {
            _ = try await screens.vibeCodeSessionReply(sessionId: "s", VibeCodeReplyRequest(text: "more"))
            XCTFail("a deployed chat takes no message")
        } catch {
            XCTAssertEqual(ScreensClientError.boxReason(error),
                           "This app is deployed. To change it, open the app and choose Change this app.")
        }
        screens.vibeCodeSessionStateFixture = VibeCodeSessionPublicState(
            id: "s", appId: nil, status: "failed", messages: [], pendingRequest: nil, canContinue: true)
        do {
            _ = try await screens.vibeCodeSessionReply(sessionId: "s", VibeCodeReplyRequest(text: "  "))
            XCTFail("a continuation needs text")
        } catch {
            XCTAssertEqual(ScreensClientError.boxReason(error), "text required")
        }
        let ok = try await screens.vibeCodeSessionReply(
            sessionId: "s", VibeCodeReplyRequest(text: "try a smaller image", credential: work.credential,
                                                 model: "gpt-5.4-mini", effort: nil))
        XCTAssertTrue(ok.ok)
        XCTAssertEqual(screens.vibeCodeReplies.last?.credential?.provider, "openai")
    }
}
