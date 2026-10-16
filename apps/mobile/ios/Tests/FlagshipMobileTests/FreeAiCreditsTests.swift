import XCTest
import CryptoKit
@testable import Flagship
@testable import FlagshipUI
@testable import FlagshipAPI

/// Free AI credits: the copy, the `.com` error mapping, the key step's
/// on-by-default choice, the Settings card and the reply re-mint.
@MainActor
final class FreeAiCreditsTests: XCTestCase {

    private var store: SavedKeyStore!
    private var server: MockFlagshipServerClient!
    private let key = Curve25519.Signing.PrivateKey()

    override func setUp() {
        super.setUp()
        store = SavedKeyStore()
        store.clear()
        server = MockFlagshipServerClient()
        server.simulatedLatency = 0
        FreeAiSessions.defaults = UserDefaults(suiteName: "FreeAiCreditsTests")!
        FreeAiSessions.clear()
    }

    override func tearDown() {
        store.clear()
        FreeAiSessions.clear()
        super.tearDown()
    }

    private func service(user: String? = "harry") -> FreeAiCreditsService {
        let k = key
        return FreeAiCreditsService(client: server, username: { user },
                                    sign: { try k.signature(for: $0) }, now: { 1_700_000_000_000 })
    }

    // MARK: copy

    func test_creditsLine() {
        let us = Locale(identifier: "en_US")
        XCTAssertEqual(FreeAiCopy.credits(0, locale: us), "0")
        XCTAssertEqual(FreeAiCopy.credits(1_840, locale: us), "1,840")
        XCTAssertEqual(FreeAiCopy.credits(1_234_567, locale: Locale(identifier: "de_DE")), "1.234.567")
        XCTAssertEqual(FreeAiCopy.credits(-5, locale: us), "0")
        let c = server.freeAiCredits
        XCTAssertEqual(FreeAiCopy.balance(c, locale: us), "1,840 free credits left · 500 added each week")
        XCTAssertEqual(FreeAiCopy.balance(c, locale: Locale(identifier: "de_DE")),
                       "1.840 free credits left · 500 added each week")
        // An older .com sends only tokens: 1 credit = 1,000 weighted tokens.
        let tokensOnly = FreeAiCredits(usedTokens: 660_000, allowanceTokens: 2_500_000, remainingTokens: 1_840_999,
                                       week: c.week, starter: c.starter)
        XCTAssertEqual(FreeAiCopy.balance(tokensOnly, locale: us), "1,840 free credits left · 500 added each week")
        let old = FreeAiCredits(usedTokens: 180_000, allowanceTokens: 1_000_000, remainingTokens: 820_000)
        XCTAssertEqual(FreeAiCopy.balance(old, locale: us), "820 free credits left", "an older .com: totals only")
    }

    func test_copySaysFlagshipInference() {
        XCTAssertEqual(FreeAiCopy.title, "Flagship Inference")
        XCTAssertEqual(FreeAiCopy.useButton, "Use Flagship Inference →")
        XCTAssertEqual(FreeAiCopy.unavailable, "Flagship Inference isn't available right now. You can add your own AI key.")
        for m in [FreeAiCopy.usedUp, FreeAiCopy.busyToday, FreeAiCopy.noServer, FreeAiCopy.unavailable,
                  FreeAiCopy.tooLong, FreeAiCopy.couldNotMint] {
            XCTAssertTrue(m.contains("Flagship Inference"), m)
            XCTAssertFalse(m.lowercased().contains("free ai"), m)
            XCTAssertFalse(m.lowercased().contains("token"), m)
        }
    }

    func test_statusDecodesCreditFields() throws {
        let body = Data(#"{"available":true,"credits":{"usedTokens":0,"allowanceTokens":2500000,"remainingTokens":2500000,"remainingCredits":2500,"weeklyCredits":500,"tokensPerCredit":1000}}"#.utf8)
        let s = try JSONDecoder().decode(FreeAiStatusResponse.self, from: body)
        XCTAssertEqual(s.credits?.creditsLeft, 2_500)
        XCTAssertEqual(s.credits?.creditsPerWeek, 500)
    }

    func test_statusDecodes_newAndOldShapes() throws {
        let new = Data(#"{"available":true,"ended":false,"reason":"busy-today","message":"m","credits":{"week":{"used":160000,"allowance":500000,"remaining":340000,"resetsAt":1792022400000},"starter":{"used":800000,"allowance":2000000,"remaining":1200000},"usedTokens":960000,"allowanceTokens":2500000,"remainingTokens":1540000}}"#.utf8)
        let s = try JSONDecoder().decode(FreeAiStatusResponse.self, from: new)
        XCTAssertEqual(s.reason, "busy-today")
        XCTAssertEqual(s.ended, false)
        XCTAssertEqual(s.credits?.week?.remaining, 340_000)
        XCTAssertEqual(s.credits?.week?.resetsAt, 1_792_022_400_000)
        XCTAssertEqual(s.credits?.starter?.remaining, 1_200_000)
        let old = Data(#"{"available":true,"credits":{"usedTokens":0,"allowanceTokens":1000000,"remainingTokens":1000000}}"#.utf8)
        let o = try JSONDecoder().decode(FreeAiStatusResponse.self, from: old)
        XCTAssertNil(o.ended)
        XCTAssertNil(o.reason)
        XCTAssertNil(o.credits?.week)
        XCTAssertEqual(FreeAiDisplay.of(o), .usable(o.credits!))
    }

    func test_display_states() {
        let c = server.freeAiCredits
        let ok = FreeAiStatusResponse(available: true, credits: c, ended: false)
        XCTAssertEqual(FreeAiDisplay.of(ok), .usable(c))
        XCTAssertEqual(FreeAiDisplay.of(nil), .hidden)
        XCTAssertEqual(FreeAiDisplay.of(FreeAiStatusResponse(available: false, credits: c, ended: true)), .hidden)
        XCTAssertEqual(FreeAiDisplay.of(FreeAiStatusResponse(available: false, credits: nil)),
                       .blocked(message: FreeAiCopy.unavailable, offerOwnKey: true))
        XCTAssertEqual(FreeAiDisplay.of(FreeAiStatusResponse(available: true, credits: c, reason: "busy-today")),
                       .blocked(message: FreeAiCopy.busyToday, offerOwnKey: true))
        XCTAssertEqual(FreeAiDisplay.of(FreeAiStatusResponse(available: true, credits: c, reason: "no-server")),
                       .blocked(message: FreeAiCopy.noServer, offerOwnKey: false))
        let spent = FreeAiCredits(usedTokens: 10, allowanceTokens: 10, remainingTokens: 0)
        XCTAssertEqual(FreeAiDisplay.of(FreeAiStatusResponse(available: true, credits: spent)),
                       .blocked(message: FreeAiCopy.usedUp, offerOwnKey: true))
    }

    func test_copyNeverSellsAnything() {
        let all = [FreeAiCopy.title, FreeAiCopy.providerTitle, FreeAiCopy.providerSubtitle, FreeAiCopy.tooLong, FreeAiCopy.note, FreeAiCopy.usedUp, FreeAiCopy.busyToday,
                   FreeAiCopy.noServer, FreeAiCopy.ended, FreeAiCopy.unavailable,
                   FreeAiCopy.addOwnKey].joined(separator: " ").lowercased()
        for word in ["buy", "upgrade", "purchase", "subscribe", "pay"] {
            XCTAssertFalse(all.contains(word), word)
        }
    }

    func test_errorMapping() {
        let used = Data(#"{"error":"You've used this week's Flagship Inference credits. More arrive on Monday, or add your own AI key to keep building.","code":"free-ai-used-up","credits":{"usedTokens":5,"allowanceTokens":5,"remainingTokens":0}}"#.utf8)
        guard case .usedUp(let m, let c)? = FreeAiError.from(status: 429, body: used) else {
            return XCTFail("429 is used up")
        }
        XCTAssertEqual(m, FreeAiCopy.usedUp)
        XCTAssertEqual(c?.remainingTokens, 0)
        XCTAssertEqual(FreeAiError.from(status: 503, body: Data()), .unavailable(message: FreeAiCopy.unavailable))
        XCTAssertNil(FreeAiError.from(status: 403, body: Data(#"{"error":"invalid signature"}"#.utf8)))
        XCTAssertEqual(ScreensClientError.userFacing(FreeAiError.usedUp(message: "x", credits: nil)), "x")
    }

    func test_errorMapping_byCode() {
        func body(_ code: String) -> Data { Data(#"{"error":"from .com","code":"\#(code)"}"#.utf8) }
        XCTAssertEqual(FreeAiError.from(status: 429, body: body("free-ai-busy-today")), .busyToday(message: "from .com"))
        XCTAssertEqual(FreeAiError.from(status: 403, body: body("free-ai-no-server")), .noServer(message: "from .com"))
        XCTAssertEqual(FreeAiError.from(status: 410, body: body("free-ai-ended")), .ended(message: "from .com"))
        XCTAssertEqual(FreeAiError.from(status: 410, body: Data()), .ended(message: FreeAiCopy.ended))
        XCTAssertEqual(FreeAiError.from(status: 503, body: body("free-ai-unavailable")), .unavailable(message: "from .com"))
        XCTAssertEqual(FreeAiError.from(status: 400, body: body("free-ai-too-long")), .tooLong(message: "from .com"))
        XCTAssertEqual(FreeAiError.from(status: 400, body: Data(#"{"code":"free-ai-too-long"}"#.utf8)),
                       .tooLong(message: FreeAiCopy.tooLong))
        XCTAssertTrue(FreeAiError.tooLong(message: "").opensAddKey)
        XCTAssertFalse(FreeAiError.unavailable(message: "").opensAddKey)
        for e in [FreeAiError.usedUp(message: "", credits: nil), .busyToday(message: ""), .noServer(message: ""),
                  .ended(message: "")] {
            XCTAssertTrue(e.opensAddKey, "\(e)")
        }
    }

    func test_credentialSourceRidesTheWire() throws {
        let c = LlmProviderCredential(provider: "flagship", apiKey: "t", baseUrl: "https://i.example", relay: true,
                                      source: "promo")
        let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(c)) as? [String: Any])
        XCTAssertEqual(obj["source"] as? String, "promo")
        XCTAssertTrue(c.isFreeAi)
        let byok = try XCTUnwrap(JSONSerialization.jsonObject(
            with: JSONEncoder().encode(LlmProviderCredential(provider: "openai", apiKey: "k"))) as? [String: Any])
        XCTAssertNil(byok["source"], "a saved key sends no source")
    }

    // MARK: service

    func test_mintSignsForTheBox() async throws {
        let r = try await service().mint(serverFqdn: "home.harry.flagship.services")
        XCTAssertEqual(r.credential.source, "promo")
        XCTAssertEqual(r.model, "flagship-free")
        let sent = try XCTUnwrap(server.freeAiTokenRequests.last)
        XCTAssertEqual(sent.request.serverFqdn, "home.harry.flagship.services")
        XCTAssertEqual(sent.request.provider, "flagship")
        XCTAssertEqual(sent.request.desiredDailyInputTokenCap, 0)
        let sig = try XCTUnwrap(Data(hexString: sent.signature))
        XCTAssertTrue(key.publicKey.isValidSignature(sig, for: sent.request.canonicalBytes()))
        _ = try await service().status()
        XCTAssertEqual(server.freeAiStatusRequests.last?.request.serverFqdn, "")
    }

    func test_noUsernameIsUnavailable() async {
        do {
            _ = try await service(user: nil).status()
            XCTFail("needs an account")
        } catch {
            XCTAssertEqual(error as? FreeAiError, .unavailable(message: FreeAiCopy.unavailable))
        }
    }

    // MARK: key step

    func test_keyStep_noSavedKey_choosesFreeAiByDefault() async {
        let vm = BuildKeyViewModel(store: store, freeAiService: service())
        vm.reload()
        XCTAssertFalse(vm.showingForm, "the add form waits while free AI is checked")
        let auto = await vm.loadFreeAi()
        XCTAssertTrue(auto)
        XCTAssertFalse(vm.showingForm)
        let cred = await vm.useFreeAi(serverFqdn: "home.harry.flagship.services")
        XCTAssertEqual(cred?.source, "promo")
        XCTAssertEqual(vm.chosenModel, "flagship-free")
    }

    func test_keyStep_withSavedKey_offersButDoesNotAutoChoose() async throws {
        _ = try store.add(provider: "anthropic", label: "A", apiKey: "sk-anthropic-1111aaaa")
        let vm = BuildKeyViewModel(store: store, freeAiService: service())
        vm.reload()
        let auto = await vm.loadFreeAi()
        XCTAssertFalse(auto)
        guard case .usable(let c) = vm.freeAi else { return XCTFail("row offered") }
        XCTAssertEqual(c.remainingTokens, 1_840_000)
        _ = vm.credential(for: try XCTUnwrap(vm.saved.first))
        XCTAssertNil(vm.chosenModel, "a saved key carries no free-AI model")
    }

    func test_keyStep_usedUp_opensTheAddKeyForm() async {
        server.freeAiCredits = FreeAiCredits(usedTokens: 1_000_000, allowanceTokens: 1_000_000, remainingTokens: 0)
        let vm = BuildKeyViewModel(store: store, freeAiService: service())
        vm.reload()
        let auto = await vm.loadFreeAi()
        XCTAssertFalse(auto)
        XCTAssertEqual(vm.freeAi, .disabled(message: FreeAiCopy.usedUp, offerOwnKey: true))
        XCTAssertTrue(vm.showingForm)
        let cred = await vm.useFreeAi(serverFqdn: "home.harry.flagship.services")
        XCTAssertNil(cred)
        XCTAssertEqual(vm.errorMessage, FreeAiCopy.usedUp)
        XCTAssertTrue(vm.showingForm)
    }

    func test_keyStep_unavailable_fallsBackToTheForm() async {
        server.freeAiAvailable = false
        let vm = BuildKeyViewModel(store: store, freeAiService: service())
        vm.reload()
        _ = await vm.loadFreeAi()
        XCTAssertEqual(vm.freeAi, .disabled(message: FreeAiCopy.unavailable, offerOwnKey: true))
        XCTAssertTrue(vm.showingForm)
    }

    func test_keyStep_blockedReasons_neverAutoChoose_andOpenTheForm() async {
        for reason in ["busy-today", "no-server"] {
            server.freeAiReason = reason
            let vm = BuildKeyViewModel(store: store, freeAiService: service())
            vm.reload()
            let auto = await vm.loadFreeAi()
            XCTAssertFalse(auto, reason)
            XCTAssertTrue(vm.showingForm, reason)
            let cred = await vm.useFreeAi(serverFqdn: "home.harry.flagship.services")
            XCTAssertNil(cred)
            XCTAssertEqual(vm.errorMessage, reason == "busy-today" ? FreeAiCopy.busyToday : FreeAiCopy.noServer)
        }
    }

    func test_keyStep_ended_keepsTheRowDisabled_andNeverAutoChooses() async {
        server.freeAiEnded = true
        let vm = BuildKeyViewModel(store: store, freeAiService: service())
        vm.reload()
        let auto = await vm.loadFreeAi()
        XCTAssertFalse(auto)
        XCTAssertEqual(vm.freeAi, .disabled(message: FreeAiCopy.ended, offerOwnKey: true))
        XCTAssertTrue(vm.showingForm)
        _ = await vm.useFreeAi(serverFqdn: "home.harry.flagship.services")
        XCTAssertEqual(vm.freeAi, .disabled(message: FreeAiCopy.ended, offerOwnKey: true),
                       "a refused mint after the end keeps the row, disabled")
        XCTAssertEqual(vm.errorMessage, FreeAiCopy.ended)
    }

    func test_keyStep_withoutService_keepsTheOldBehaviour() async {
        let vm = BuildKeyViewModel(store: store)
        vm.reload()
        XCTAssertTrue(vm.showingForm)
        let auto = await vm.loadFreeAi()
        XCTAssertFalse(auto)
        XCTAssertEqual(vm.freeAi, .disabled(message: FreeAiCopy.unavailable, offerOwnKey: true),
                       "Flagship Inference is always listed, disabled when this client can't use it")
    }

    // MARK: settings card

    func test_card_states() async {
        let card = FreeAiCreditsCardModel(service: service())
        await card.load()
        XCTAssertEqual(card.state, .usable(server.freeAiCredits))

        server.freeAiReason = "busy-today"
        await card.load()
        XCTAssertEqual(card.state, .disabled(message: FreeAiCopy.busyToday, offerOwnKey: true))

        server.freeAiReason = "no-server"
        await card.load()
        XCTAssertEqual(card.state, .disabled(message: FreeAiCopy.noServer, offerOwnKey: false))
        server.freeAiReason = nil

        server.freeAiCredits = FreeAiCredits(usedTokens: 10, allowanceTokens: 10, remainingTokens: 0)
        await card.load()
        XCTAssertEqual(card.state, .disabled(message: FreeAiCopy.usedUp, offerOwnKey: true))

        server.freeAiEnded = true
        await card.load()
        XCTAssertEqual(card.state, .disabled(message: FreeAiCopy.ended, offerOwnKey: true),
                       "an ended promotion keeps the entry, disabled")
        server.freeAiEnded = false

        server.freeAiAvailable = false
        await card.load()
        XCTAssertEqual(card.state, .disabled(message: FreeAiCopy.unavailable, offerOwnKey: true))

        server.shouldFail = true
        await card.load()
        XCTAssertEqual(card.state, .disabled(message: FreeAiCopy.unavailable, offerOwnKey: true),
                       "a failed fetch keeps the entry, disabled")

        let none = FreeAiCreditsCardModel(service: nil)
        await none.load()
        XCTAssertEqual(none.state, .disabled(message: FreeAiCopy.unavailable, offerOwnKey: true))
    }

    // MARK: Flagship Inference entry

    func test_flagshipInference_copyIsExact() {
        XCTAssertEqual(FreeAiCopy.providerTitle, "Flagship Inference")
        XCTAssertEqual(FreeAiCopy.providerSubtitle, "We use third-party providers and anonymize your requests.")
        XCTAssertEqual(FreeAiCopy.tooLong,
                       "This build is too big for Flagship Inference. Try a smaller change, or use your own AI key.")
        XCTAssertTrue(FreeAiCopy.builtInAccessibility.contains("can't be removed"))
    }

    func test_flagshipInference_entryStates() {
        let c = FreeAiCredits(usedTokens: 1, allowanceTokens: 10, remainingTokens: 9)
        let spent = FreeAiCredits(usedTokens: 10, allowanceTokens: 10, remainingTokens: 0)
        XCTAssertEqual(FreeAiEntryState.of(nil as FreeAiStatusResponse?),
                       .disabled(message: FreeAiCopy.unavailable, offerOwnKey: true))
        XCTAssertEqual(FreeAiEntryState.of(FreeAiStatusResponse(available: false, credits: c, ended: true)),
                       .disabled(message: FreeAiCopy.ended, offerOwnKey: true))
        XCTAssertEqual(FreeAiEntryState.of(FreeAiStatusResponse(available: true, credits: c)), .usable(c))
        XCTAssertEqual(FreeAiEntryState.of(FreeAiStatusResponse(available: true, credits: spent)),
                       .disabled(message: FreeAiCopy.usedUp, offerOwnKey: true))
        XCTAssertEqual(FreeAiEntryState.of(FreeAiStatusResponse(available: true, credits: c, reason: "busy-today")),
                       .disabled(message: FreeAiCopy.busyToday, offerOwnKey: true))
        XCTAssertEqual(FreeAiEntryState.of(FreeAiStatusResponse(available: true, credits: c, reason: "no-server")),
                       .disabled(message: FreeAiCopy.noServer, offerOwnKey: false))
        XCTAssertEqual(FreeAiEntryState.of(FreeAiError.ended(message: "x")),
                       .disabled(message: FreeAiCopy.ended, offerOwnKey: true))
        XCTAssertTrue(FreeAiEntryState.usable(c).isUsable)
        XCTAssertFalse(FreeAiEntryState.loading.isUsable)
    }

    func test_flagshipInference_isASelectableDefault() throws {
        let a = try store.add(provider: "anthropic", label: "A", apiKey: "sk-anthropic-1111aaaa")
        XCTAssertFalse(store.isFlagshipInferenceActive)
        try store.setActive(id: SavedKeyStore.flagshipInferenceId)
        XCTAssertTrue(store.isFlagshipInferenceActive)
        XCTAssertNil(store.active(), "builds fall back to free AI, not a saved key")
        let b = try store.add(provider: "openai", label: "B", apiKey: "sk-openai-2222bbbb")
        XCTAssertTrue(store.isFlagshipInferenceActive, "adding a key doesn't steal the default")
        try store.remove(id: a.id)
        XCTAssertTrue(store.isFlagshipInferenceActive)
        XCTAssertEqual(store.list().map(\.id), [b.id])
        try store.setActive(id: b.id)
        XCTAssertFalse(store.isFlagshipInferenceActive)
        XCTAssertEqual(store.active()?.id, b.id)
    }

    func test_flagshipInference_settingsCanMakeItDefault_butNeverDeleteIt() throws {
        _ = try store.add(provider: "anthropic", label: "A", apiKey: "sk-anthropic-1111aaaa")
        let vm = AiKeysViewModel(store: store)
        vm.reload()
        XCTAssertFalse(vm.flagshipInferenceIsDefault)
        vm.makeFlagshipInferenceDefault()
        XCTAssertTrue(vm.flagshipInferenceIsDefault)
        vm.delete(id: SavedKeyStore.flagshipInferenceId)
        XCTAssertTrue(vm.flagshipInferenceIsDefault)
        XCTAssertEqual(vm.entries.count, 1)
    }

    func test_keyStep_choosingFlagshipInference_marksItLastUsed() async throws {
        _ = try store.add(provider: "anthropic", label: "A", apiKey: "sk-anthropic-1111aaaa")
        let vm = BuildKeyViewModel(store: store, freeAiService: service())
        vm.reload()
        _ = await vm.loadFreeAi()
        XCTAssertFalse(vm.flagshipInferenceIsDefault)
        let cred = await vm.useFreeAi(serverFqdn: "home.harry.flagship.services")
        XCTAssertEqual(cred?.source, "promo")
        XCTAssertTrue(vm.flagshipInferenceIsDefault)
        XCTAssertNil(vm.active)
        XCTAssertEqual(vm.orderedEntries.count, 1, "saved keys stay listed below")
        _ = vm.credential(for: try XCTUnwrap(vm.saved.first))
        vm.reload()
        XCTAssertFalse(vm.flagshipInferenceIsDefault)
    }

    // MARK: reply credential

    func test_reply_freeAiSession_remintsEverySend() async throws {
        FreeAiSessions.mark("s1")
        var mints = 0
        let fresh: @MainActor () async throws -> LlmProviderCredential = {
            mints += 1
            return LlmProviderCredential(provider: "flagship", apiKey: "tok-\(mints)", relay: true, source: "promo")
        }
        let saved = LlmProviderCredential(provider: "openai", apiKey: "sk-saved")
        let a = try await VibeCodeReplyCredential.resolve(sessionId: "s1", boxNeedsKey: false,
                                                          saved: { saved }, freeAi: fresh)
        let b = try await VibeCodeReplyCredential.resolve(sessionId: "s1", boxNeedsKey: true,
                                                          saved: { saved }, freeAi: fresh)
        XCTAssertEqual(a?.apiKey, "tok-1")
        XCTAssertEqual(b?.apiKey, "tok-2")
    }

    func test_reply_freeAiSession_usedUpStopsTheSend() async {
        FreeAiSessions.mark("s1")
        do {
            _ = try await VibeCodeReplyCredential.resolve(
                sessionId: "s1", boxNeedsKey: false, saved: { nil },
                freeAi: { throw FreeAiError.usedUp(message: FreeAiCopy.usedUp, credits: nil) })
            XCTFail("used up must surface")
        } catch {
            XCTAssertEqual(ScreensClientError.userFacing(error), FreeAiCopy.usedUp)
        }
    }

    func test_reply_freeAiSession_busyOrEndedStopsTheSend() async {
        FreeAiSessions.mark("s1")
        for e in [FreeAiError.busyToday(message: FreeAiCopy.busyToday), .ended(message: FreeAiCopy.ended)] {
            do {
                _ = try await VibeCodeReplyCredential.resolve(
                    sessionId: "s1", boxNeedsKey: false, saved: { nil }, freeAi: { throw e })
                XCTFail("\(e) must surface")
            } catch {
                XCTAssertEqual(ScreensClientError.userFacing(error), e.message)
            }
        }
    }

    func test_reply_freeAiUnavailable_letsTheBoxKeepItsToken() async throws {
        FreeAiSessions.mark("s1")
        let r = try await VibeCodeReplyCredential.resolve(
            sessionId: "s1", boxNeedsKey: false, saved: { nil },
            freeAi: { throw FreeAiError.unavailable(message: "x") })
        XCTAssertNil(r)
    }

    func test_reply_ownKeySession_unchanged() async throws {
        let saved = LlmProviderCredential(provider: "openai", apiKey: "sk-saved")
        let fresh: @MainActor () async throws -> LlmProviderCredential = {
            XCTFail("an own-key session never mints"); throw FreeAiError.unavailable(message: "")
        }
        let none = try await VibeCodeReplyCredential.resolve(sessionId: "s2", boxNeedsKey: false,
                                                             saved: { saved }, freeAi: fresh)
        XCTAssertNil(none)
        let needed = try await VibeCodeReplyCredential.resolve(sessionId: "s2", boxNeedsKey: true,
                                                               saved: { saved }, freeAi: fresh)
        XCTAssertEqual(needed?.apiKey, "sk-saved")
    }

    func test_reply_boxNeedsKey_noSavedKey_usesFreeAiAndRemembers() async throws {
        let r = try await VibeCodeReplyCredential.resolve(
            sessionId: "s3", boxNeedsKey: true, saved: { nil },
            freeAi: { LlmProviderCredential(provider: "flagship", apiKey: "tok", source: "promo") })
        XCTAssertEqual(r?.apiKey, "tok")
        XCTAssertTrue(FreeAiSessions.isFreeAi("s3"))
    }

    func test_selection_freeAiCarriesItsModel() {
        let c = LlmProviderCredential(provider: "flagship", apiKey: "t", source: "promo")
        let s = VibeCodeCredentialSelection.compatible(with: c, freeAiModel: "flagship-free")
        XCTAssertEqual(s.credential, c)
        XCTAssertEqual(s.model, "flagship-free")
    }

    /// The env-var answer resumes the AI, so it carries the key and the model
    /// choice as any message does (a Flagship pass would otherwise run out).
    func test_envVarAnswer_carriesTheKeyAndTheModel() throws {
        let c = LlmProviderCredential(provider: "flagship", apiKey: "t", source: "promo")
        let ack = VibeCodeSessionScreen.envVarAck("set", credential: c, model: "glm-5.3-flash", effort: "low")
        XCTAssertEqual(ack.envVarStatus, "set")
        XCTAssertNil(ack.text)
        XCTAssertEqual(ack.credential, c)
        XCTAssertEqual(ack.model, "glm-5.3-flash")
        XCTAssertEqual(ack.effort, "low")
        let noModel = VibeCodeSessionScreen.envVarAck("declined", credential: nil, model: nil, effort: "low")
        XCTAssertNil(noModel.effort, "no effort without a model")
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(ack)) as? [String: Any])
        XCTAssertEqual(json["model"] as? String, "glm-5.3-flash")
    }
}

private extension Data {
    init?(hexString: String) {
        guard hexString.count % 2 == 0 else { return nil }
        var out = Data()
        var i = hexString.startIndex
        while i < hexString.endIndex {
            let j = hexString.index(i, offsetBy: 2)
            guard let b = UInt8(hexString[i..<j], radix: 16) else { return nil }
            out.append(b)
            i = j
        }
        self = out
    }
}
