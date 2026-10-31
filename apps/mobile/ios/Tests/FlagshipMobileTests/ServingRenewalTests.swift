import XCTest
import CryptoKit
@testable import Flagship
@testable import FlagshipAPI
@testable import FlagshipCore
@testable import FlagshipUI

/// Renewal on use and the dead-man editor (serving-wiring.md section 4), against the mock `.com`
/// and box: what is signed, with which key, and where it goes.
@MainActor
final class ServingRenewalTests: XCTestCase {
    private let user = "alice"
    private let boxA = String(repeating: "6e", count: 32)
    private let boxB = String(repeating: "7f", count: 32)
    private let scope = String(repeating: "1b", count: 32)
    private let device = String(repeating: "8a", count: 32)
    private let now: Int64 = 1_800_000_000_000

    private let admin = Curve25519.Signing.PrivateKey()
    private let renewalPriv = P256.Signing.PrivateKey()
    private var delegations: [String: SignedServingRecord<RenewalKeyDelegation>] = [:]
    private var defaults: UserDefaults!

    override func setUp() async throws {
        defaults = UserDefaults(suiteName: "serving-\(UUID().uuidString)")
        delegations = [:]
    }

    private var renewalSigner: RenewalKey.Signer {
        let k = renewalPriv
        return RenewalKey.Signer(publicKeyHex: ServingAuthority.compressedHex(k.publicKey)) { try k.signature(for: $0).rawRepresentation }
    }

    private func policy(_ box: String, _ grace: ServingGrace, _ lapse: ServingOnLapse = .stopApps, gen: Int64 = 1) -> SignedServingRecord<ServingPolicy> {
        let p = ServingPolicy(account: user, box: box, regGen: 1, policyGen: gen, grace: grace, onLapse: lapse, scopeSha256: scope, issuedAt: now - 1000)
        return SignedServingRecord(record: p, signature: try! ServingAuthority.signEd25519(p.canonicalBytes(), key: admin))
    }

    private func renewer(mailbox: MockSecretMailboxClient, box: MockScreensClient?, silentRoot: Bool) -> ServingRenewer {
        ServingRenewer(
            username: user, mailbox: mailbox,
            box: box.map { b in { _ in b } },
            renewalKey: { [renewalSigner] in renewalSigner },
            silentAdminRoot: { [admin] in silentRoot ? admin : nil },
            deviceKeyPub: { [device] in device },
            delegation: { [unowned self] u in self.delegations[u] },
            recordDelegation: { [unowned self] d in self.delegations[d.record.account] = d },
            state: ServingStateStore(defaults: defaults),
            now: { [now] in now })
    }

    func testOpeningSignsOneLeasePerFiniteServerWithTheDelegatedKey() async throws {
        let mailbox = MockSecretMailboxClient()
        mailbox.serving = [
            AccountServingEntry(serverDomain: "home.alice.flagship.services", boxPub: boxA, regGen: 1, policy: policy(boxA, .sevenDays)),
            AccountServingEntry(serverDomain: "cabin.alice.flagship.services", boxPub: boxB, regGen: 1, policy: policy(boxB, .indefinite)),
        ]
        let box = MockScreensClient()
        let r = renewer(mailbox: mailbox, box: box, silentRoot: true)
        let n = await r.renew()
        XCTAssertEqual(n, 1, "nothing is signed under an indefinite policy")
        // First open with the admin root at hand: the renewal key is delegated once.
        XCTAssertEqual(mailbox.renewalDelegations.count, 1)
        let d = try XCTUnwrap(mailbox.renewalDelegations.first?.body)
        XCTAssertEqual(d.delegation.renewalPub, renewalSigner.publicKeyHex)
        XCTAssertEqual(d.delegation.deviceId, device)
        XCTAssertTrue(ServingAuthority.verifyEd25519(try d.delegation.canonicalBytes(), signatureHex: d.signature,
                                                     publicKeyHex: HexUtil.encode(admin.publicKey.rawRepresentation)))
        XCTAssertEqual(mailbox.servingLeasePosts.count, 1, "one call to .com")
        let item = try XCTUnwrap(mailbox.servingLeasePosts.first?.body.leases.first)
        XCTAssertEqual(item.lease.box, boxA)
        XCTAssertEqual(item.lease.notAfter, now + 7 * 86_400_000)
        XCTAssertEqual(item.delegationPub, renewalSigner.publicKeyHex)
        XCTAssertTrue(ServingAuthority.verifyLeaseP256(item.lease, signatureHex: item.signature, renewalPubHex: renewalSigner.publicKeyHex))
        XCTAssertEqual(box.servingPosts.first?.leases?.first?.delegationPub, renewalSigner.publicKeyHex)
        XCTAssertEqual(box.servingPosts.first?.delegations?.first?.record.renewalPub, renewalSigner.publicKeyHex)

        // Next open: no admin root needed and no second delegation.
        let again = renewer(mailbox: mailbox, box: nil, silentRoot: false)
        let count = await again.renew()
        XCTAssertEqual(count, 1)
        XCTAssertEqual(mailbox.renewalDelegations.count, 1)
        XCTAssertEqual(mailbox.servingLeasePosts.count, 2)
    }

    func testWithoutADelegationOrASilentAdminRootNothingIsSignedAndNothingPrompts() async {
        let mailbox = MockSecretMailboxClient()
        mailbox.serving = [AccountServingEntry(serverDomain: "home.alice.flagship.services", boxPub: boxA, regGen: 1, policy: policy(boxA, .thirtyDays))]
        let n = await renewer(mailbox: mailbox, box: nil, silentRoot: false).renew()
        XCTAssertEqual(n, 0)
        XCTAssertTrue(mailbox.servingLeasePosts.isEmpty)
        XCTAssertTrue(mailbox.renewalDelegations.isEmpty)
    }

    func testTheStateStoreLearnsALockingDeadline() async {
        let mailbox = MockSecretMailboxClient()
        mailbox.serving = [AccountServingEntry(serverDomain: "home.alice.flagship.services", boxPub: boxA, regGen: 1,
                                               policy: policy(boxA, .sevenDays, .lockServer))]
        await renewer(mailbox: mailbox, box: nil, silentRoot: true).renew()
        let s = ServingStateStore(defaults: defaults)
        XCTAssertTrue(s.locks("home.alice.flagship.services"))
        XCTAssertEqual(s.until("home.alice.flagship.services"), now + 7 * 86_400_000)
    }

    private func editor(mailbox: MockSecretMailboxClient, box: MockScreensClient, current: ServingView) -> ServingPolicyEditor {
        ServingPolicyEditor(current: current, username: user, serverDomain: "home.alice.flagship.services", boxPub: boxA,
                            adminRoot: admin, mailbox: mailbox, box: box,
                            renewer: renewer(mailbox: mailbox, box: box, silentRoot: false),
                            state: ServingStateStore(defaults: defaults), now: { [now] in now })
    }

    func testTheEditorSignsTheNextGenerationAndAFirstLease() async throws {
        let mailbox = MockSecretMailboxClient(), box = MockScreensClient()
        let ed = editor(mailbox: mailbox, box: box, current: ServingView(grace: "indefinite", onLapse: "stop-apps", until: nil, policyGen: 3, regGen: 2, scopeSha256: scope))
        XCTAssertFalse(ed.canLock)
        ed.setGrace(.thirtyDays)
        ed.onLapse = .lockServer
        XCTAssertTrue(ed.changed)
        let ok = await ed.save()
        XCTAssertTrue(ok)
        let post = try XCTUnwrap(mailbox.servingPolicies.first?.body)
        XCTAssertEqual(post.policy.policyGen, 4)
        XCTAssertEqual(post.policy.regGen, 2)
        XCTAssertEqual(post.policy.grace, "30d")
        XCTAssertEqual(post.policy.onLapse, "lock-server")
        XCTAssertEqual(post.policy.scopeSha256, scope)
        XCTAssertTrue(ServingAuthority.verifyEd25519(try post.policy.canonicalBytes(), signatureHex: post.signature,
                                                     publicKeyHex: HexUtil.encode(admin.publicKey.rawRepresentation)))
        XCTAssertEqual(box.servingPosts.first?.policy?.record, post.policy)
        // The editor delegates the renewal key with the root it holds and signs the first lease with it.
        XCTAssertEqual(mailbox.renewalDelegations.count, 1)
        let lease = try XCTUnwrap(mailbox.servingLeasePosts.first?.body.leases.first)
        XCTAssertEqual(lease.lease.policyGen, 4)
        XCTAssertEqual(lease.lease.notAfter, now + 30 * 86_400_000)
    }

    func testNeverGreysOutLockingAndSignsNoLease() async throws {
        let mailbox = MockSecretMailboxClient(), box = MockScreensClient()
        let ed = editor(mailbox: mailbox, box: box, current: ServingView(grace: "7d", onLapse: "lock-server", until: now + 1, policyGen: 1, regGen: 1, scopeSha256: scope))
        XCTAssertTrue(ed.canLock)
        ed.setGrace(.indefinite)
        XCTAssertFalse(ed.canLock)
        XCTAssertEqual(ed.onLapse, .stopApps)
        let saved = await ed.save()
        XCTAssertTrue(saved)
        XCTAssertEqual(mailbox.servingPolicies.first?.body.policy.grace, "indefinite")
        XCTAssertEqual(mailbox.servingPolicies.first?.body.policy.onLapse, "stop-apps")
        XCTAssertTrue(mailbox.servingLeasePosts.isEmpty)
    }

    func testTheLineReadsAsSectionFive() {
        let until = Int64(Date(timeIntervalSince1970: 1_794_700_800).timeIntervalSince1970 * 1000)
        let stays = String(ServingLineText.line(ServingView(grace: "7d", onLapse: "stop-apps", until: until, policyGen: 1, regGen: 1, scopeSha256: scope), now: Date()).characters)
        XCTAssertTrue(stays.hasPrefix("Stays online until "), stays)
        XCTAssertTrue(stays.contains(" if no admin opens Flagship · 7 days"), stays)
        let locks = String(ServingLineText.line(ServingView(grace: "30d", onLapse: "lock-server", until: until, policyGen: 1, regGen: 1, scopeSha256: scope), now: Date()).characters)
        XCTAssertTrue(locks.hasPrefix("Locks on "), locks)
        XCTAssertTrue(locks.hasSuffix("· 30 days"), locks)
        let never = String(ServingLineText.line(ServingView(grace: "indefinite", onLapse: "stop-apps", until: nil, policyGen: 1, regGen: 1, scopeSha256: scope), now: Date()).characters)
        XCTAssertEqual(never, "No time limit")
    }
}
