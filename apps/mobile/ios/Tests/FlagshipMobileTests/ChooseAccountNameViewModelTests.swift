import XCTest
import CryptoKit
@testable import FlagshipAPI
@testable import FlagshipCore
@testable import FlagshipUI
@testable import Flagship

/// "Choose your own account name" at sign-up: the account opens under the suggested name, the chosen name is quoted,
/// paid and renamed, the device catches up (grant, profiles, wallet), and only then is it PQ-bound. Anything that
/// fails leaves the suggested name and keeps the payment.
@MainActor
final class ChooseAccountNameViewModelTests: XCTestCase {

    final class FakeClient: AccountNameChangeClient, @unchecked Sendable {
        var quote = NameChangeQuote(available: true, kind: "name-change", units: 10)
        var renameError: Error?
        var irkAnswer: String?
        var irkError: Error?
        var log: [String] = []
        var payments: [NameChangePayment] = []
        var quoteGrants: [NameGrant?] = []
        var renameGrants: [NameGrant?] = []
        var minted: [DeviceCapabilityGrantEnvelope] = []
        var revoked: [(username: String, grantId: String)] = []
        var renameSignature: (bytes: Data, sig: String)?

        func quote(username: String, newUsername: String, grant: NameGrant?) async throws -> NameChangeQuote {
            log.append("quote \(username)->\(newUsername)")
            quoteGrants.append(grant)
            return quote
        }
        func rename(aidPubHex: String, oldUsername: String, newUsername: String, issuedAt: Int64, signatureHex: String,
                    payment: NameChangePayment, grant: NameGrant?) async throws -> NameChangeOutcome {
            log.append("rename \(oldUsername)->\(newUsername)")
            payments.append(payment)
            renameGrants.append(grant)
            renameSignature = (NameChangeEnvelope.canonicalBytes(aidPubHex: aidPubHex, oldUsername: oldUsername, newUsername: newUsername, issuedAt: issuedAt), signatureHex)
            if let renameError { throw renameError }
            return NameChangeOutcome(newUsername: newUsername, oldNameReleased: true)
        }
        func mintDeviceGrant(_ grant: DeviceCapabilityGrantEnvelope, signatureHex: String) async throws {
            log.append("mint \(grant.username)")
            minted.append(grant)
        }
        func revokeDeviceGrant(username: String, grantId: String, reason: String, issuedAt: Int64, signatureHex: String) async throws {
            log.append("revoke \(grantId)")
            revoked.append((username, grantId))
        }
        func accountIrk(username: String) async throws -> String? {
            if let irkError { throw irkError }
            return irkAnswer
        }
    }

    final class FakeWallet: NameChangeWallet {
        var held: [Voucher] = []
        var purchase: NameChangeWalletPurchase = .added
        var buys = 0
        var spent: [(username: String, nullifiers: [String])] = []
        func prepare(username: String, deviceId: String) async {}
        func vouchers(_ n: Int) -> [Voucher]? { held.count >= n ? Array(held.prefix(n)) : nil }
        func buy(units: Int64) async -> NameChangeWalletPurchase {
            buys += 1
            if purchase == .added { held += (0..<Int(units)).map { FakeWallet.voucher($0 + held.count) } }
            return purchase
        }
        func markSpent(username: String, deviceId: String, _ nullifiers: [String]) async {
            spent.append((username, nullifiers))
            held.removeAll { nullifiers.contains(Vouchers.nullifier($0)) }
        }
        static func voucher(_ i: Int) -> Voucher {
            Voucher(k: "k1", p: String(repeating: "0", count: 64), n: String(format: "%064x", i), s: "c2ln")
        }
    }

    final class MemoryStore: PendingAccountRenameStore, @unchecked Sendable {
        var record: PendingAccountRename?
        var saved: [PendingAccountRename.Stage] = []
        func load() -> PendingAccountRename? { record }
        func save(_ r: PendingAccountRename) { record = r; saved.append(r.stage) }
        func clear() { record = nil }
    }

    private var client = FakeClient()
    private var wallet = FakeWallet()
    private var store = MemoryStore()
    private var moves: [(String, String)] = []
    private var keptKeys: [(String, String)] = []
    private var bound: [String] = []
    private var opens = 0
    private let keys = OpenedAccountKeys(
        username: "plucky-avocet", deviceId: String(repeating: "a", count: 32), grantId: "11111111-2222-3333-4444-555555555555",
        scopes: OpenAccountViewModel.foundingScopes, irk: .init(), adminRoot: .init(), deviceKey: .init(),
        umk: Data(repeating: 7, count: 32), accountDisplayName: "Plucky Avocet", deviceDisplayName: "Test iPhone")

    private func makeVM(grant: NameGrant? = nil, now: Int64 = 1_800_000_000_000) -> ChooseAccountNameViewModel {
        let server = MockFlagshipServerClient()
        server.simulatedLatency = 0
        return ChooseAccountNameViewModel(
            suggested: "plucky-avocet",
            grant: grant,
            openAccount: { [unowned self] in
                opens += 1
                bound.append("(opened)")
                return keys
            },
            client: client, server: server, wallet: wallet, store: store,
            local: .init(moveSlot: { [unowned self] in moves.append(($0, $1)) },
                         keepDeviceKey: { [unowned self] old, new, _, _ in keptKeys.append((old, new)) }),
            bindPq: { [unowned self] _, name in bound.append(name) },
            now: { now })
    }

    // MARK: success

    func test_payWithVouchers_buysRenamesCatchesUpThenBinds() async {
        let vm = makeVM()
        vm.name = "Harry"
        await vm.pay()

        XCTAssertEqual(vm.phase, .done(name: "harry"))
        XCTAssertEqual(vm.completedName, "harry")
        XCTAssertEqual(opens, 1)
        XCTAssertEqual(wallet.buys, 1)
        guard case .vouchers(let vs)? = client.payments.first else { return XCTFail("paid with vouchers") }
        XCTAssertEqual(vs.count, 10)
        XCTAssertEqual(client.log, ["quote plucky-avocet->harry", "rename plucky-avocet->harry", "mint harry", "revoke \(keys.grantId)"])
        // The rename is signed by the admin root over the name-change bytes.
        let sig = try! XCTUnwrap(client.renameSignature)
        XCTAssertTrue(keys.adminRoot.publicKey.isValidSignature(HexUtil.decode(sig.sig)!, for: sig.bytes))
        // The new grant: same device and key, the founding scopes, under the new name; signed by the admin root.
        let g = try! XCTUnwrap(client.minted.first)
        XCTAssertEqual(g.username, "harry")
        XCTAssertEqual(g.deviceId, keys.deviceId)
        XCTAssertEqual(g.devicePubKeyHex, HexUtil.encode(keys.deviceKey.publicKey.rawRepresentation))
        XCTAssertEqual(g.scopes, OpenAccountViewModel.foundingScopes)
        XCTAssertEqual(client.revoked.first?.username, "harry")
        // Local state moved, then the spent vouchers left the wallet under the new name.
        XCTAssertEqual(moves.first?.0, "plucky-avocet"); XCTAssertEqual(moves.first?.1, "harry")
        XCTAssertEqual(keptKeys.count, 1)
        XCTAssertEqual(wallet.spent.first?.username, "harry")
        XCTAssertEqual(wallet.spent.first?.nullifiers, vs.map(Vouchers.nullifier))
        XCTAssertEqual(store.saved, [.renaming, .renamed, .movedLocally, .grantSwapped, .profilesDone])
        XCTAssertNil(store.record, "the pending record goes once the device caught up")
        // PQ binding only after the rename, and as the new name.
        XCTAssertEqual(bound, ["(opened)", "harry"])
    }

    func test_useCode_paysWithTheCode_noPurchase() async {
        let vm = makeVM()
        vm.name = "harry"
        vm.showsCode = true
        vm.code = " FRIEND-CODE "
        await vm.useCode()

        XCTAssertEqual(vm.phase, .done(name: "harry"))
        XCTAssertEqual(client.payments, [.code("FRIEND-CODE")])
        XCTAssertEqual(wallet.buys, 0)
        XCTAssertTrue(wallet.spent.isEmpty)
        XCTAssertEqual(bound.last, "harry")
    }

    func test_vouchersAlreadyInTheWallet_areUsedWithoutBuying() async {
        wallet.held = (0..<10).map(FakeWallet.voucher)
        let vm = makeVM()
        vm.name = "harry"
        await vm.pay()
        XCTAssertEqual(wallet.buys, 0)
        XCTAssertEqual(vm.completedName, "harry")
    }

    // MARK: refusals

    func test_takenName_staysOnScreen_accountExists_nothingPaid() async {
        client.quote = NameChangeQuote(available: false, code: "taken")
        let vm = makeVM()
        vm.name = "harry"
        await vm.pay()
        XCTAssertEqual(vm.message, "Taken or too similar to an existing name")
        XCTAssertEqual(vm.phase, .editing)
        XCTAssertNotNil(vm.opened, "the account exists under the suggested name")
        XCTAssertEqual(wallet.buys, 0)
        XCTAssertTrue(client.payments.isEmpty)
        XCTAssertEqual(bound, ["(opened)"], "no PQ binding while the name is still being chosen")
        // Trying another name doesn't open the account again.
        client.quote = NameChangeQuote(available: true, kind: "name-change", units: 10)
        vm.name = "harry2"
        await vm.pay()
        XCTAssertEqual(opens, 1)
        XCTAssertEqual(vm.completedName, "harry2")
    }

    func test_dibsHeld_namesTheDomainAndDate() async {
        client.quote = NameChangeQuote(available: false, code: "dibs-held", heldUntil: 1_800_000_000_000)
        let vm = makeVM()
        vm.name = "acme"
        await vm.pay()
        let msg = try! XCTUnwrap(vm.message)
        XCTAssertTrue(msg.hasPrefix("This name is held for the owner of acme.com until "), msg)
        XCTAssertTrue(msg.contains("2027"), msg)
    }

    func test_badCode_saysSo_andKeepsTheSuggestedName() async {
        client.renameError = NameChangeRefusal(status: 402, code: "code-invalid")
        let vm = makeVM()
        vm.name = "harry"
        vm.code = "nope"
        await vm.useCode()
        XCTAssertEqual(vm.message, "That voucher code isn't valid for an account name.")
        XCTAssertNil(vm.completedName)
        XCTAssertNil(store.record)
        XCTAssertTrue(moves.isEmpty)

        client.renameError = NameChangeRefusal(status: 402, code: "code-used")
        await vm.useCode()
        XCTAssertEqual(vm.message, "That voucher code was already used.")
    }

    func test_renameRefusedAfterVouchers_keepsSuggestedName_andTheVouchers() async {
        client.renameError = NameChangeRefusal(status: 409, code: "rename-failed")
        let vm = makeVM()
        vm.name = "harry"
        await vm.pay()
        XCTAssertEqual(vm.message, "The name change didn't go through. Your account keeps the name plucky-avocet, and your $10 stays in your account as vouchers.")
        XCTAssertEqual(wallet.held.count, 10, "the vouchers stay in the wallet")
        XCTAssertTrue(wallet.spent.isEmpty)
        XCTAssertNil(store.record)
        XCTAssertTrue(moves.isEmpty)
        XCTAssertEqual(bound, ["(opened)"])
        // Keep the suggested name: onboarding goes on as it, PQ-bound then.
        vm.keepSuggested()
        XCTAssertEqual(vm.completedName, "plucky-avocet")
        XCTAssertEqual(bound.last, "plucky-avocet")
    }

    func test_renameRefusedWithCode_saysTheCodeStillWorks() async {
        client.renameError = NameChangeRefusal(status: 409, code: "cooldown")
        let vm = makeVM()
        vm.name = "harry"
        vm.code = "abc"
        await vm.useCode()
        XCTAssertEqual(vm.message, "The name change didn't go through. Your account keeps the name plucky-avocet, and your voucher code still works.")
    }

    func test_voucherSpent_dropsTheListedVouchers() async {
        let spent = Vouchers.nullifier(FakeWallet.voucher(0))
        client.renameError = NameChangeRefusal(status: 409, code: "voucher-spent", spent: [spent])
        let vm = makeVM()
        vm.name = "harry"
        await vm.pay()
        XCTAssertEqual(wallet.spent.first?.username, "plucky-avocet")
        XCTAssertEqual(wallet.spent.first?.nullifiers, [spent])
        XCTAssertEqual(wallet.held.count, 9)
    }

    func test_paymentCancelled_orFailed_keepsTheSuggestedName() async {
        wallet.purchase = .cancelled
        let vm = makeVM()
        vm.name = "harry"
        await vm.pay()
        XCTAssertEqual(vm.message, "Payment cancelled. Your account keeps the name plucky-avocet.")
        XCTAssertTrue(client.payments.isEmpty)
        wallet.purchase = .failed
        await vm.pay()
        XCTAssertEqual(vm.message, "The payment didn't go through. Your account keeps the name plucky-avocet.")
        XCTAssertNil(vm.completedName)
    }

    func test_localFormatProblem_blocksPaying() {
        let vm = makeVM()
        vm.name = "-bad"
        XCTAssertEqual(vm.nameProblem, "No hyphen at the start or end, or two in a row")
        XCTAssertFalse(vm.canPay)
        vm.name = "ok-name"
        XCTAssertNil(vm.nameProblem)
        XCTAssertTrue(vm.canPay)
    }

    // MARK: no answer to the rename

    func test_lostAnswer_butTheNameIsOurs_finishes() async {
        client.renameError = URLError(.networkConnectionLost)
        client.irkAnswer = HexUtil.encode(keys.irk.publicKey.rawRepresentation)
        let vm = makeVM()
        vm.name = "harry"
        await vm.pay()
        XCTAssertEqual(vm.completedName, "harry")
        XCTAssertNil(store.record)
    }

    func test_lostAnswer_andUnreachable_keepsTheRecordForLater() async {
        client.renameError = URLError(.networkConnectionLost)
        client.irkError = URLError(.notConnectedToInternet)
        let vm = makeVM()
        vm.name = "harry"
        await vm.pay()
        XCTAssertNil(vm.completedName)
        XCTAssertEqual(store.record?.stage, .renaming)
        XCTAssertTrue(AccountRenameResume.isRenaming("plucky-avocet", store: store))
        XCTAssertTrue(AccountRenameResume.isRenaming("harry", store: store))
    }

    // MARK: resume after a restart

    func test_resume_renameLanded_restoresAsTheNewName() async {
        store.record = PendingAccountRename(oldName: "plucky-avocet", newName: "harry", deviceId: keys.deviceId, oldGrantId: keys.grantId,
                                            irkPubHex: "ab", accountDisplayName: "Harry", deviceDisplayName: "iPhone")
        client.irkAnswer = "ab"
        let resume = AccountRenameResume(store: store)
        var moved: [(String, String)] = []
        let name = await resume.atLaunch(slot: "plucky-avocet", client: client, moveSlot: { moved.append(($0, $1)) })
        XCTAssertEqual(name, "harry")
        XCTAssertEqual(moved.first?.1, "harry")
        XCTAssertTrue(resume.needsFinish)
        XCTAssertEqual(store.record?.stage, .renamed)
    }

    func test_resume_renameNeverLanded_dropsTheRecord() async {
        store.record = PendingAccountRename(oldName: "plucky-avocet", newName: "harry", deviceId: keys.deviceId, oldGrantId: keys.grantId,
                                            irkPubHex: "ab", accountDisplayName: "Harry", deviceDisplayName: "iPhone")
        client.irkAnswer = nil
        let resume = AccountRenameResume(store: store)
        let name = await resume.atLaunch(slot: "plucky-avocet", client: client, moveSlot: { _, _ in XCTFail("no move") })
        XCTAssertEqual(name, "plucky-avocet")
        XCTAssertNil(store.record)
        XCTAssertFalse(resume.needsFinish)
    }

    func test_resume_unreachable_keepsOldNameAndRecord() async {
        store.record = PendingAccountRename(oldName: "plucky-avocet", newName: "harry", deviceId: keys.deviceId, oldGrantId: keys.grantId,
                                            irkPubHex: "ab", accountDisplayName: "Harry", deviceDisplayName: "iPhone")
        client.irkError = URLError(.notConnectedToInternet)
        let resume = AccountRenameResume(store: store)
        let name = await resume.atLaunch(slot: "plucky-avocet", client: client, moveSlot: { _, _ in XCTFail("no move") })
        XCTAssertEqual(name, "plucky-avocet")
        XCTAssertNotNil(store.record)
    }

    func test_finisher_resumesFromItsStage() async throws {
        let rec = PendingAccountRename(oldName: "plucky-avocet", newName: "harry", deviceId: keys.deviceId, oldGrantId: keys.grantId,
                                       irkPubHex: "ab", stage: .grantSwapped, accountDisplayName: "Harry", deviceDisplayName: "iPhone")
        store.record = rec
        let server = MockFlagshipServerClient()
        server.simulatedLatency = 0
        let f = AccountRenameFinisher(client: client, server: server, store: store, wallet: wallet,
                                      local: .init(moveSlot: { _, _ in XCTFail("already moved") }, keepDeviceKey: { _, _, _, _ in XCTFail("already kept") }))
        try await f.finish(rec, keys: AccountRenameKeys(irk: keys.irk, adminRoot: keys.adminRoot, deviceKey: keys.deviceKey, umk: keys.umk))
        XCTAssertTrue(client.minted.isEmpty, "the grant was already swapped")
        XCTAssertNil(store.record)
    }

    func test_accountGone_ignoresANameUnderRename() {
        let registry = AccountGoneRegistry()
        registry.setOwnNames(["plucky-avocet"])
        let s = store
        s.record = PendingAccountRename(oldName: "plucky-avocet", newName: "harry", deviceId: "d", oldGrantId: "g",
                                        irkPubHex: "ab", accountDisplayName: "", deviceDisplayName: "")
        registry.setRenameGuard { AccountRenameResume.isRenaming($0, store: s) }
        let url = URL(string: "https://flagshipserver.com/api/accounts/plucky-avocet/pods")!
        XCTAssertFalse(registry.note(url: url, status: 404, body: AccountGoneRegistry.body()))
        XCTAssertFalse(registry.isGone)
        s.record = nil
        XCTAssertTrue(registry.note(url: url, status: 404, body: AccountGoneRegistry.body()))
    }

    // MARK: name-grant links

    func test_grantLink_parses() {
        let link = URL(string: "https://flagshipserver.com/app/choose-name#n=Harry&g=abc123&e=1800000000000&f=1")!
        guard case .nameGrant(let g)? = DeepLink.parse(link) else { return XCTFail("routes to choose-name") }
        XCTAssertEqual(g, NameGrant(name: "harry", code: "abc123", expiresAt: 1_800_000_000_000, free: true))
        guard case .nameGrant(let paid)? = DeepLink.parse(URL(string: "https://flagshipserver.com/app/choose-name#n=harry&g=abc&e=5")!) else {
            return XCTFail("routes")
        }
        XCTAssertFalse(paid.free)
        XCTAssertNil(DeepLink.parse(URL(string: "https://flagshipserver.com/app/choose-name#n=harry&e=5")!), "no code, no grant")
    }

    func test_freeGrant_needsNoPayment() async {
        client.quote = NameChangeQuote(available: true, kind: "name-change", units: 10, paid: true)
        let grant = NameGrant(name: "harry", code: "abc", expiresAt: 1_900_000_000_000, free: true)
        let vm = makeVM(grant: grant)
        XCTAssertEqual(vm.name, "harry")
        XCTAssertTrue(vm.isFreeGrant)
        await vm.continueWithGrant()
        XCTAssertEqual(vm.completedName, "harry")
        XCTAssertEqual(client.payments, [.grant])
        XCTAssertEqual(client.quoteGrants, [grant])
        XCTAssertEqual(client.renameGrants, [grant])
        XCTAssertEqual(wallet.buys, 0)
    }

    func test_expiredGrant_saysSo_beforeOpeningTheAccount() async {
        let vm = makeVM(grant: NameGrant(name: "harry", code: "abc", expiresAt: 1_000, free: true))
        await vm.continueWithGrant()
        XCTAssertEqual(vm.message, "This link has expired. Ask for a new one.")
        XCTAssertEqual(opens, 0)
        client.quote = NameChangeQuote(available: false, code: "grant-used")
        let vm2 = makeVM(grant: NameGrant(name: "harry", code: "abc", expiresAt: 1_900_000_000_000, free: false))
        await vm2.pay()
        XCTAssertEqual(vm2.message, "This link doesn't work any more. Ask for a new one.")
    }

    func test_grantLink_onAnExistingAccount_explains() {
        XCTAssertEqual(NameGrantText.existingAccount, "Open this link when you create your account.")
        XCTAssertEqual(RootShell.tab(for: .nameGrant(NameGrant(name: "a", code: "b", expiresAt: 1, free: false)), selected: .home), .home)
    }

    // MARK: the keystore slot follows the name

    func test_moveProfileSlot_carriesTheSlotAndThePointer() throws {
        let deviceId = String(repeating: "b", count: 32)
        Keystore.setActiveProfile("slot-old")
        defer { Keystore.wipe(); Keystore.setActiveProfile(nil) }
        Keystore.storeAccountDeviceId(deviceId, accountId: "slot-old")
        try KeystoreTestSupport.write(account: "com.flagship.umk.wrapped.slot-old", data: Data([1, 2, 3]), sync: .cloudRoot)
        Keystore.moveProfileSlot(from: "slot-old", to: "slot-new")
        XCTAssertEqual(Keystore.activeProfileId, "slot-new")
        XCTAssertEqual(Keystore.accountDeviceId(accountId: "slot-new"), deviceId)
        XCTAssertNil(Keystore.accountDeviceId(accountId: "slot-old"))
        XCTAssertEqual(KeystoreTestSupport.lastWrittenSyncClass(account: "com.flagship.umk.wrapped.slot-new"), .cloudRoot)
        XCTAssertNil(KeystoreTestSupport.lastWrittenSyncClass(account: "com.flagship.umk.wrapped.slot-old"))
        // Running it again (a crash after the move) changes nothing.
        Keystore.moveProfileSlot(from: "slot-old", to: "slot-new")
        XCTAssertEqual(Keystore.accountDeviceId(accountId: "slot-new"), deviceId)
        KeystoreTestSupport.wipeInMemory(account: "com.flagship.umk.wrapped.slot-new")
    }
}
