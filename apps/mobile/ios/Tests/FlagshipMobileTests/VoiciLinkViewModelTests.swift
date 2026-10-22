import XCTest
import CryptoKit
@testable import FlagshipAPI
@testable import FlagshipCore
@testable import FlagshipUI

/// The pure state function mirrors `apps/web/tests/webappLinkField.test.ts`.
final class VoiciLinkMessageTests: XCTestCase {
    private func link(
        name: String? = nil, held: Int = 0, limit: Int = 5, changesLeft: Int = 3, nextChangeAt: Int64? = nil
    ) -> VoiciLinkState {
        VoiciLinkState(name: name, held: held, limit: limit, changesLeft: changesLeft, nextChangeAt: nextChangeAt, releasesAt: nil)
    }

    private func msg(
        typed: String = "halloween", current: String = "k3j9a2", link: VoiciLinkState? = nil,
        check: VoiciNameCheck? = nil, admin: Bool = true
    ) -> VoiciLinkMessage {
        VoiciLinkViewModel.message(
            typed: typed, current: current, link: link ?? self.link(), check: check, admin: admin, now: 0,
            formatDate: { "on \($0)" }
        )
    }

    func test_isReadOnlyForADeviceThatIsNotAnAdmin() {
        let m = msg(admin: false)
        XCTAssertEqual(m.text, "Only an admin device can change this")
        XCTAssertFalse(m.canSave)
    }

    func test_saysNothingWhileTheFieldStillShowsTheCurrentLink() {
        let m = msg(typed: "k3j9a2")
        XCTAssertEqual(m.text, "")
        XCTAssertFalse(m.canSave)
    }

    func test_checksTheGrammarBeforeAskingDotCom() {
        XCTAssertEqual(msg(typed: "ab").text, "At least 4 characters")
        XCTAssertEqual(msg(typed: "a_b_c_d").text, "Letters, numbers and hyphens only")
        XCTAssertEqual(msg(typed: String(repeating: "x", count: 41)).text, "At most 40 characters")
    }

    func test_offersSaveOnlyForAnAvailableName() {
        XCTAssertEqual(msg(check: VoiciNameCheck(status: "available")).tone, .ok)
        XCTAssertTrue(msg(check: VoiciNameCheck(status: "available")).canSave)
        let taken = msg(check: VoiciNameCheck(status: "taken"))
        XCTAssertEqual(taken.text, "Taken")
        XCTAssertFalse(taken.canSave)
        XCTAssertEqual(msg(check: VoiciNameCheck(status: "reserved")).text, "Reserved")
        XCTAssertEqual(msg(check: VoiciNameCheck(status: "error")).text, "Couldn't check halloween. Try again.")
    }

    func test_handsADibsNameToTheDomainProof() {
        let m = msg(check: VoiciNameCheck(status: "dibs", domain: "halloween.com"))
        XCTAssertEqual(m.text, "Reserved for the owner of halloween.com")
        XCTAssertEqual(m.action, .dibs)
    }

    func test_offersToFreeOneUpWhenEveryNameIsInUse_butNotForAReplace() {
        let full = msg(link: link(held: 5))
        XCTAssertEqual(full.text, "All 5 names in use")
        XCTAssertEqual(full.action, .freeUp)
        XCTAssertTrue(msg(link: link(name: "mine-now", held: 5), check: VoiciNameCheck(status: "available")).canSave)
    }

    func test_showsTheNextChangeWhenTheServiceHasUsedItsChanges() {
        let m = msg(link: link(changesLeft: 0, nextChangeAt: 1_800_000_000_000))
        XCTAssertEqual(m.text, "Next change on 1800000000000")
        XCTAssertFalse(m.canSave)
    }

    func test_turnsEachRefusalIntoOneShortLine() {
        func line(_ code: String, limit: Int? = nil) -> String {
            VoiciLinkViewModel.refusalMessage(VoiciNameError(status: 409, code: code, limit: limit), typed: "x")
        }
        XCTAssertEqual(line("taken"), "Taken")
        XCTAssertEqual(line("rate-limited"), "Too many changes today")
        XCTAssertEqual(line("name-limit", limit: 25), "All 25 names in use")
        XCTAssertEqual(
            VoiciLinkViewModel.refusalMessage(VoiciNameError(status: 429), typed: "x"),
            "Too many changes today"
        )
        XCTAssertEqual(line("something-new"), "Couldn't save. Try again.")
    }
}

@MainActor
final class VoiciLinkViewModelTests: XCTestCase {
    private let key = Curve25519.Signing.PrivateKey()

    private func vm(
        _ client: MockVoiciNameClient, name: String? = nil, held: Int = 0, admin: Bool = true
    ) -> VoiciLinkViewModel {
        VoiciLinkViewModel(
            client: client, username: "Fresh-Poppy", serviceId: "fresh-poppy--party",
            link: VoiciLinkState(name: name, held: held, limit: 5, changesLeft: 3),
            shortCode: "k3j9a2", admin: admin, signer: { [key] _ in key }, now: { 1_000 }, debounceNanos: 60_000_000_000
        )
    }

    func test_theFieldStartsOnTheRandomCodeUntilACustomNameIsLive() {
        let client = MockVoiciNameClient()
        XCTAssertEqual(vm(client).typed, "k3j9a2")
        XCTAssertEqual(vm(client, name: "halloween").typed, "halloween")
        XCTAssertEqual(vm(client).shortUrl, "https://voi.ci/k3j9a2")
    }

    func test_aCheckRunsOnlyForANameThatCouldBeSaved() async {
        let client = MockVoiciNameClient()
        let model = vm(client)
        model.edit("ab")
        await model.runCheck()
        XCTAssertTrue(client.checks.isEmpty)
        model.edit("Halloween")
        XCTAssertEqual(model.typed, "halloween")
        await model.runCheck()
        XCTAssertEqual(client.checks, ["halloween"])
        XCTAssertTrue(model.message.canSave)
    }

    func test_saveSignsASetOrderAndShowsTheNewName() async throws {
        let client = MockVoiciNameClient()
        client.scriptedSaveResult = VoiciLinkState(name: "halloween", held: 1, limit: 5, changesLeft: 2)
        let model = vm(client)
        var changed: VoiciLinkState?
        model.onChanged = { changed = $0 }
        model.edit("halloween")
        await model.runCheck()
        await model.requestSave()

        let body = try XCTUnwrap(client.saves.first)
        XCTAssertEqual(body.order.op, "set")
        XCTAssertEqual(body.order.user, "fresh-poppy")
        XCTAssertEqual(body.order.name, "halloween")
        let order = VoiciNameOrder(
            user: body.order.user, serviceId: body.order.serviceId, name: body.order.name, op: .set,
            issuedAt: body.order.issuedAt, nonce: body.order.nonce
        )
        XCTAssertTrue(order.verify(signatureHex: body.signature, publicKey: key.publicKey))
        XCTAssertEqual(model.link.name, "halloween")
        XCTAssertEqual(changed?.name, "halloween")
        XCTAssertNil(model.pendingChange)
    }

    func test_replacingOrClearingALiveNameAsksFirst() async throws {
        let client = MockVoiciNameClient()
        let model = vm(client, name: "halloween", held: 1)
        await model.requestUseDefault()
        XCTAssertTrue(client.saves.isEmpty)
        XCTAssertEqual(model.pendingChange?.replacing, "halloween")
        model.cancelPending()
        XCTAssertTrue(client.saves.isEmpty)

        await model.requestUseDefault()
        let pending = try XCTUnwrap(model.pendingChange)
        await model.confirmPending(pending)
        XCTAssertEqual(client.saves.first?.order.op, "clear")
        XCTAssertEqual(client.saves.first?.order.name, "")
        XCTAssertNil(model.link.name)
        XCTAssertEqual(model.typed, "k3j9a2")
    }

    func test_aRefusalReplacesTheLiveMessageUntilTheNextEdit() async {
        let client = MockVoiciNameClient()
        client.saveError = VoiciNameError(status: 409, code: "taken")
        let model = vm(client)
        model.edit("halloween")
        await model.runCheck()
        await model.requestSave()
        XCTAssertEqual(model.message.text, "Taken")
        XCTAssertEqual(model.link.name, nil)
        model.edit("halloween2")
        XCTAssertEqual(model.message.text, "")
    }

    func test_aNonAdminDeviceCannotEditOrSave() async {
        let client = MockVoiciNameClient()
        let model = vm(client, admin: false)
        model.edit("halloween")
        XCTAssertEqual(model.typed, "k3j9a2")
        XCTAssertFalse(model.isEditable)
        await model.requestSave()
        XCTAssertTrue(client.saves.isEmpty)
    }

    func test_freeingOneUpClearsAnotherServicesNameAndFreesASlot() async throws {
        let client = MockVoiciNameClient()
        client.scriptedNames = [VoiciNameListed(serviceId: "fresh-poppy--other", name: "other-party")]
        let model = vm(client, held: 5)
        await model.openFreeUp()
        XCTAssertTrue(model.showsFreeUp)
        let row = try XCTUnwrap(model.freeUpNames?.first)
        await model.requestUseDefault(listed: row)
        let pending = try XCTUnwrap(model.pendingChange)
        XCTAssertEqual(pending.replacing, "other-party")
        await model.confirmPending(pending)
        XCTAssertEqual(client.saves.first?.order.serviceId, "fresh-poppy--other")
        XCTAssertEqual(model.link.held, 4)
        XCTAssertEqual(model.typed, "k3j9a2")
        XCTAssertFalse(model.showsFreeUp)
    }

    func test_ownItHandsTheTypedNameToTheDomainProofAndComesBackReadyToSave() async {
        let client = MockVoiciNameClient()
        client.scriptedChecks["halloween"] = VoiciNameCheck(status: "dibs", domain: "halloween.com")
        let model = vm(client)
        model.edit("halloween")
        await model.runCheck()
        XCTAssertEqual(model.message.action, .dibs)
        model.ownIt()
        XCTAssertEqual(model.dibsName, "halloween")

        client.scriptedChecks["halloween"] = VoiciNameCheck(status: "available")
        await model.dibsFinished()
        XCTAssertNil(model.dibsName)
        XCTAssertTrue(model.message.canSave)
    }
}

@MainActor
final class NameDibsLinkKindTests: XCTestCase {
    private let key = Curve25519.Signing.PrivateKey()

    func test_aLinkProofSendsKindUnsigned_andAnAccountProofLeavesItOut() async throws {
        let client = MockNameDibsClient()
        client.scriptedWindow = DibsWindow(configured: true, open: true, start: 0, end: 9_000)
        let link = NameDibsViewModel(
            client: client, username: "fresh-poppy", kind: .link, presetName: "halloween-party",
            signer: { [key] _ in key }, now: { 1_000 }
        )
        XCTAssertEqual(link.presetName, "halloweenparty")
        await link.load()
        await link.start(name: "halloweenparty")
        await link.check()
        XCTAssertEqual(client.initiates.first?.kind, "link")
        XCTAssertEqual(client.verifies.first?.kind, "link")
        let sent = try JSONSerialization.jsonObject(with: JSONEncoder().encode(client.initiates[0])) as? [String: Any]
        XCTAssertEqual(sent?["kind"] as? String, "link")

        let account = NameDibsViewModel(client: client, username: "fresh-poppy", signer: { [key] _ in key }, now: { 1_000 })
        await account.load()
        await account.start(name: "acme")
        XCTAssertNil(client.initiates.last?.kind)
        let plain = try JSONSerialization.jsonObject(with: JSONEncoder().encode(client.initiates[1])) as? [String: Any]
        XCTAssertNil(plain?["kind"])
    }
}
