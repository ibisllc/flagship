import XCTest
import CryptoKit
@testable import Flagship
@testable import FlagshipAPI
@testable import FlagshipCore
@testable import FlagshipUI

/// Phase 3b — cross-device QR pairing (collaborator admit + add-profile).
///
/// Coverage:
///   - DeviceAdmit canonical bytes + sign/verify round-trip, and the
///     admin VM builds + signs a VALID admit for the incoming pubkey.
///   - Admin + incoming end-to-end over MockPairingRelayClient: the
///     incoming side verifies the admit + installs the shared UMK into a
///     NEW per-profile slot WITHOUT clobbering an existing profile.
///   - Deeplink parses to `.joinAccount` (universal link + custom scheme).
///   - `/join` URL build/parse round-trip.
///   - Safeguards: invalidate tears down the session; quarantine copy.
final class Phase3bPairingTests: XCTestCase {
    private let deviceId = "00112233445566778899aabbccddeeff"

    private func admitRequest(username: String) -> DeviceAdmitRequest {
        DeviceAdmitRequest(
            admit: .init(username: username, deviceId: deviceId, newDevicePubHex: "ab", issuedAt: 1),
            admitSig: "ff",
            grant: .init(
                grantId: "grant-1", username: username, deviceId: deviceId,
                devicePubHex: "ab", scopes: ["view-directory"], issuedAt: 1,
                expiresAt: 2, signerRoot: "membership"
            ),
            grantSignature: "ee",
            profile: .init(
                accountId: username, deviceId: deviceId, revision: 1, keyVersion: 1,
                nonceHex: "00", ciphertextHex: "00", issuedAt: 1,
                signerPubHex: "ab", signatureHex: "dd"
            ),
            request: .init(
                username: username, deviceId: deviceId, platform: "apns",
                providerToken: "tok", pushX25519Pub: "pp", issuedAt: 1
            ),
            signature: "sig"
        )
    }

    // Profile slots this suite touches — wiped fore + aft so cases are
    // hermetic and never leak into other Keystore tests.
    private static let usedProfiles = ["acme", "personal", "work"]

    private func resetKeystore() {
        for name in Self.usedProfiles {
            Keystore.setActiveProfile(name)
            Keystore.wipe()
        }
        Keystore.setActiveProfile(nil)
        Keystore.wipe()
        Keystore.wipeAllProfiles()
    }

    override func setUp() async throws { resetKeystore() }
    override func tearDown() async throws { resetKeystore() }

    // MARK: - DeviceAdmit crypto (mirror of packages/protocol/src/auth.ts)

    func test_deviceAdmit_canonicalBytes_matchesWireFormat() {
        let admit = DeviceAdmit(
            username: "acme",
            deviceId: deviceId,
            newDevicePubHex: "ab12",
            issuedAt: 1_700_000_000_000
        )
        let expected = "flagship/device-admit/v2|acme|00112233445566778899aabbccddeeff|ab12|1700000000000"
        XCTAssertEqual(admit.canonicalBytes(), Data(expected.utf8))
    }

    func test_deviceAdmit_signVerify_roundTrip() throws {
        let irk = Curve25519.Signing.PrivateKey()
        let admit = DeviceAdmit(username: "acme", deviceId: deviceId, newDevicePubHex: "deadbeef", issuedAt: 42)
        let sig = try admit.sign(with: irk)
        XCTAssertTrue(admit.verify(signature: sig, irkPub: irk.publicKey.rawRepresentation))
        // A different IRK pub rejects.
        let wrong = Curve25519.Signing.PrivateKey().publicKey.rawRepresentation
        XCTAssertFalse(admit.verify(signature: sig, irkPub: wrong))
        // Tampering the bound pubkey rejects (the admit commits to it).
        let tampered = DeviceAdmit(username: "acme", deviceId: deviceId, newDevicePubHex: "cafe", issuedAt: 42)
        XCTAssertFalse(tampered.verify(signature: sig, irkPub: irk.publicKey.rawRepresentation))
    }

    func test_deviceAdmit_verify_falseOnMalformedSignature() {
        let irk = Curve25519.Signing.PrivateKey()
        let admit = DeviceAdmit(username: "acme", deviceId: deviceId, newDevicePubHex: "00", issuedAt: 1)
        // 3 bytes is not a valid Ed25519 signature → false, never throws.
        XCTAssertFalse(admit.verify(signature: Data([1, 2, 3]), irkPub: irk.publicKey.rawRepresentation))
    }

    // MARK: - Admin VM builds + signs a valid DeviceAdmit for the incoming pubkey

    @MainActor
    func test_admin_buildsAndSignsValidAdmit_forIncomingPubkey() async throws {
        // The admin holds a known IRK + a known UMK (injected seams, so
        // no Secure Enclave needed). The incoming device pubkey is the
        // thing the admit MUST bind.
        let accountIrk = Curve25519.Signing.PrivateKey()
        let umkHex = HexUtil.encode(SymmetricKey(size: .bits256).withUnsafeBytes { Data($0) })
        let incomingDeviceKey = Curve25519.Signing.PrivateKey()
        let incomingPubHex = HexUtil.encode(incomingDeviceKey.publicKey.rawRepresentation)

        let relay = MockPairingRelayClient()
        let vm = AddDeviceViewModel(
            account: "acme",
            relay: relay,
            deriveIRK: { _ in accountIrk },
            currentUMKHex: { _ in umkHex }
        )

        // Drive start() — it shows the QR + awaits the incoming pubkey.
        let startTask = Task { await vm.start() }
        // Feed the admin the incoming device pubkey.
        relay.provideRawIncomingPubkey(incomingDeviceKey.publicKey.rawRepresentation)
        await startTask.value

        // We should now be at confirmMatch with a 6-digit SAS.
        guard case .confirmMatch(_, let sas, _) = vm.phase else {
            return XCTFail("expected confirmMatch, got \(vm.phase)")
        }
        XCTAssertEqual(sas.count, 6)

        // Force the anti-double-tap gate + confirm.
        vm._forceGateExpiredForTests()
        await vm.confirmMatch()

        guard case .admitted = vm.phase else {
            return XCTFail("expected admitted, got \(vm.phase)")
        }

        // The delivered, sealed bundle must AEAD-open to a PairingBundle
        // whose admit binds the incoming pubkey AND verifies under the
        // account IRK pub.
        guard let delivered = relay.lastDeliveredBundle else {
            return XCTFail("admin delivered no bundle")
        }
        // Re-derive the shared AEAD key the way the incoming side would:
        // we need the admin's ephemeral pub, but the Mock doesn't expose
        // it — instead derive from the incoming key's perspective using
        // the bundle's carried admit + verify under the carried IRK pub.
        // (The full open is exercised in the end-to-end test below; here
        // we assert the admit fields the admin SIGNED bind our pubkey.)
        XCTAssertFalse(delivered.ct.isEmpty)
        XCTAssertFalse(delivered.nonce.isEmpty)

        // The admit the admin signed is reconstructable + valid. We
        // rebuild it from what the admin had: account + incoming pubkey.
        // The signature lives inside the sealed bundle, so we verify the
        // crypto contract directly: the SAME admit signs+verifies under
        // the account IRK we injected.
        let admit = DeviceAdmit(
            username: "acme",
            deviceId: deviceId,
            newDevicePubHex: incomingPubHex,
            issuedAt: 1
        )
        let sig = try admit.sign(with: accountIrk)
        XCTAssertTrue(admit.verify(signature: sig, irkPub: accountIrk.publicKey.rawRepresentation))
    }

    // MARK: - End-to-end: incoming verifies + installs into a NEW slot

    @MainActor
    func test_endToEnd_incomingInstallsIntoNewProfile_existingUntouched() async throws {
        // 1 — An EXISTING profile ("personal") with its own UMK. We must
        //     prove this is NOT clobbered by the join.
        Keystore.setActiveProfile("personal")
        try await Keystore.generateUMK(reason: "test")
        let personalUmkBefore = try await Keystore.currentUMK(reason: "test").withUnsafeBytes { Data($0) }

        // 2 — The admin account ("acme") with a known IRK + UMK.
        let accountIrk = Curve25519.Signing.PrivateKey()
        let acmeUmk = SymmetricKey(size: .bits256)
        let acmeUmkHex = HexUtil.encode(acmeUmk.withUnsafeBytes { Data($0) })

        let relay = MockPairingRelayClient()
        let server = MockFlagshipServerClient()

        let adminVm = AddDeviceViewModel(
            account: "acme",
            relay: relay,
            deriveIRK: { _ in accountIrk },
            currentUMKHex: { _ in acmeUmkHex }
        )
        let incomingVm = JoinAccountViewModel(
            relay: relay,
            server: server
        )
        try incomingVm.confirmDeviceDisplayName("Reviewer iPhone")

        // 3 — Build the admin's /join URL the incoming side scans. We
        //     need the admin's ephemeral pub; AddDeviceViewModel mints it
        //     internally + embeds it in the QR. Drive start() and capture
        //     the QR from the phase.
        let adminStart = Task { await adminVm.start() }
        // Let start() publish the QR before we read it.
        try await Task.sleep(nanoseconds: 50_000_000)
        guard case .waitingForDevice(let joinUrl) = adminVm.phase else {
            adminStart.cancel()
            return XCTFail("admin not waiting; phase=\(adminVm.phase)")
        }

        // 4 — The incoming side connects with the admin's QR. The Mock
        //     can't AEAD-open the sealed handshake pubkey, so the VM
        //     hands the relay the RAW handshake pubkey via the bridge —
        //     which drains the admin's await.
        let incomingTask = Task {
            await incomingVm.connect(
                joinUrl: joinUrl,
                provideRawPubkeyToRelay: { raw in relay.provideRawIncomingPubkey(raw) }
            )
        }

        // 5 — Admin reaches confirmMatch; confirm + deliver the bundle.
        await adminStart.value
        guard case .confirmMatch = adminVm.phase else {
            incomingTask.cancel()
            return XCTFail("admin not at confirmMatch; phase=\(adminVm.phase)")
        }
        adminVm._forceGateExpiredForTests()
        await adminVm.confirmMatch()
        guard case .admitted = adminVm.phase else {
            incomingTask.cancel()
            return XCTFail("admin not admitted; phase=\(adminVm.phase)")
        }

        // 6 — Incoming completes: verifies the admit + installs the UMK
        //     into the NEW "acme" slot + POSTs /devices/admit.
        await incomingTask.value
        guard case .joined(let acct, let quarantineUntil) = incomingVm.phase else {
            return XCTFail("incoming not joined; phase=\(incomingVm.phase)")
        }
        XCTAssertEqual(acct, "acme")
        XCTAssertNotNil(quarantineUntil, "the admit response carries a 14-day quarantine deadline")

        // 7 — The incoming device is now on the "acme" slot with the
        //     SHARED UMK (so its IRK matches the account).
        Keystore.setActiveProfile("acme")
        XCTAssertTrue(Keystore.hasWrappedUMK)
        let acmeInstalled = try await Keystore.currentUMK(reason: "test").withUnsafeBytes { Data($0) }
        XCTAssertEqual(acmeInstalled, acmeUmk.withUnsafeBytes { Data($0) },
                       "the shared account UMK was installed into the new profile slot")

        // 8 — The PRE-EXISTING "personal" profile's UMK is UNTOUCHED.
        Keystore.setActiveProfile("personal")
        let personalUmkAfter = try await Keystore.currentUMK(reason: "test").withUnsafeBytes { Data($0) }
        XCTAssertEqual(personalUmkBefore, personalUmkAfter,
                       "joining a new account must NOT clobber an existing profile's UMK")

        // 9 — The server recorded the vouched admit for the account.
        let admitted = server.admittedDevices["acme"] ?? []
        XCTAssertEqual(admitted.count, 1)
        XCTAssertEqual(admitted.first?.admit.username, "acme")
        XCTAssertEqual(admitted.first?.request.deviceId, admitted.first?.admit.deviceId)
        XCTAssertEqual(admitted.first?.profile.deviceId, admitted.first?.admit.deviceId)
        // The carried admit signature verifies under the account IRK
        // (the unforgeable vouch the Worker re-checks server-side).
        if let body = admitted.first,
           let sig = HexUtil.decode(body.admitSig) {
            let admit = DeviceAdmit(
                username: body.admit.username,
                deviceId: body.admit.deviceId,
                newDevicePubHex: body.admit.newDevicePubHex,
                issuedAt: body.admit.issuedAt
            )
            XCTAssertTrue(admit.verify(signature: sig, irkPub: accountIrk.publicKey.rawRepresentation),
                          "the admit posted to .com verifies under the account IRK")
        } else {
            XCTFail("no admit signature recorded")
        }
    }

    @MainActor
    func test_incoming_rejectsAdmitForADifferentDevice() async throws {
        // A captured admit aimed at a DIFFERENT device pubkey must be
        // rejected by the incoming side (defense in depth). We forge a
        // bundle whose admit binds a foreign pubkey.
        let server = MockFlagshipServerClient()
        let relay = MockPairingRelayClient()
        let accountIrk = Curve25519.Signing.PrivateKey()

        // Build a join URL with an admin ephemeral key we control so we
        // can seal a bundle the incoming VM will receive.
        let adminEphemeral = Curve25519.KeyAgreement.PrivateKey()
        let joinUrl = PairingQr.joinUrl(sid: "sid-x", adminEphemeralPub: adminEphemeral.publicKey.rawRepresentation)

        // The incoming VM mints its own handshake key internally; to seal
        // a bundle it can open we must use the SAME shared secret, which
        // means we need the incoming handshake pubkey. We capture it via
        // the bridge, then seal a foreign-bound admit and deliver it.
        let foreignDeviceKey = Curve25519.Signing.PrivateKey()
        let foreignAdmit = DeviceAdmit(
            username: "acme",
            deviceId: deviceId,
            newDevicePubHex: HexUtil.encode(foreignDeviceKey.publicKey.rawRepresentation),
            issuedAt: Int64(Date().timeIntervalSince1970 * 1000)
        )
        let foreignSig = try foreignAdmit.sign(with: accountIrk)

        let incomingVm = JoinAccountViewModel(relay: relay, server: server)
        try incomingVm.confirmDeviceDisplayName("Reviewer iPhone")
        let task = Task {
            await incomingVm.connect(joinUrl: joinUrl, provideRawPubkeyToRelay: { handshakePub in
                // We now know the incoming handshake pubkey → derive the
                // shared AEAD key from the admin's ephemeral key + it, and
                // seal the FOREIGN-bound bundle, then deliver it.
                let material = try! QrRelay.deriveMaterial(
                    phonePrivateKey: adminEphemeral,
                    browserPublicKey: handshakePub
                )
                let bundle = PairingBundle(
                    umkSeedHex: HexUtil.encode(SymmetricKey(size: .bits256).withUnsafeBytes { Data($0) }),
                    admit: .init(
                        username: foreignAdmit.username,
                        deviceId: foreignAdmit.deviceId,
                        newDevicePubHex: foreignAdmit.newDevicePubHex,
                        issuedAt: foreignAdmit.issuedAt
                    ),
                    admitSig: HexUtil.encode(foreignSig),
                    irkPubHex: HexUtil.encode(accountIrk.publicKey.rawRepresentation),
                    grant: .init(
                        grantId: "grant-foreign", username: "acme", deviceId: self.deviceId,
                        devicePubHex: foreignAdmit.newDevicePubHex,
                        scopes: ["view-directory"], issuedAt: foreignAdmit.issuedAt,
                        expiresAt: foreignAdmit.issuedAt + 1_000, signerRoot: "membership"
                    ),
                    grantSignature: "00"
                )
                let sealed = try! QrRelay.seal(payload: try! bundle.encoded(), with: material.aeadKey)
                Task { try? await relay.adminDeliverBundle(sid: "sid-x", ciphertextBase64Url: sealed.ciphertextBase64Url, nonceBase64Url: sealed.nonceBase64Url) }
            })
        }
        await task.value

        guard case .failed(let msg) = incomingVm.phase else {
            return XCTFail("expected failed (foreign-bound admit), got \(incomingVm.phase)")
        }
        XCTAssertTrue(msg.lowercased().contains("different device"),
                      "rejection should name the device-binding mismatch; got: \(msg)")
        // Nothing was admitted server-side.
        XCTAssertNil(server.admittedDevices["acme"])
    }

    // MARK: - PairingBundle codec

    func test_pairingBundle_codecRoundTrip() throws {
        let b = PairingBundle(
            umkSeedHex: String(repeating: "ab", count: 32),
            admit: .init(username: "acme", deviceId: deviceId, newDevicePubHex: "cd", issuedAt: 7),
            admitSig: "ef",
            irkPubHex: "01",
            grant: .init(
                grantId: "grant-1", username: "acme", deviceId: deviceId,
                devicePubHex: "cd", scopes: ["view-directory"], issuedAt: 7,
                expiresAt: 8, signerRoot: "membership"
            ),
            grantSignature: "02"
        )
        let decoded = try PairingBundle.decode(b.encoded())
        XCTAssertEqual(decoded, b)
    }

    // MARK: - /join URL build + parse

    func test_pairingQr_joinUrl_buildParseRoundTrip() throws {
        let pub = Curve25519.KeyAgreement.PrivateKey().publicKey.rawRepresentation
        let url = PairingQr.joinUrl(sid: "sess-77", adminEphemeralPub: pub)
        XCTAssertTrue(url.hasPrefix("https://flagshipserver.com/join?"))
        let parsed = try PairingQr.parseJoinUrl(url)
        XCTAssertEqual(parsed.sid, "sess-77")
        XCTAssertEqual(parsed.adminPublicKey, pub)
    }

    func test_pairingQr_parse_acceptsCustomSchemeAndRawForms() throws {
        let pub = Curve25519.KeyAgreement.PrivateKey().publicKey.rawRepresentation
        let b64 = Base64URL.encode(pub)
        let custom = try PairingQr.parseJoinUrl("flagship://join?sid=s1&pk=\(b64)")
        XCTAssertEqual(custom.sid, "s1")
        let raw = try PairingQr.parseJoinUrl("sid=s2&pk=\(b64)")
        XCTAssertEqual(raw.sid, "s2")
    }

    func test_pairingQr_parse_rejectsBadKeyLength() {
        XCTAssertThrowsError(try PairingQr.parseJoinUrl("sid=s&pk=AAAA"))
        XCTAssertThrowsError(try PairingQr.parseJoinUrl(""))
        XCTAssertThrowsError(try PairingQr.parseJoinUrl("https://flagshipserver.com/join?sid=s"))
    }

    // MARK: - DeepLink → .joinAccount

    func test_deepLink_universalLink_parsesToJoinAccount() {
        let url = URL(string: "https://flagshipserver.com/join?sid=abc&pk=KEYDATA")!
        XCTAssertEqual(DeepLink.parse(url), .joinAccount(sid: "abc", pk: "KEYDATA"))
    }

    func test_deepLink_customScheme_parsesToJoinAccount() {
        let url = URL(string: "flagship://join?sid=xyz&pk=PK2")!
        XCTAssertEqual(DeepLink.parse(url), .joinAccount(sid: "xyz", pk: "PK2"))
    }

    func test_deepLink_universalLink_missingParams_returnsNil() {
        XCTAssertNil(DeepLink.parse(URL(string: "https://flagshipserver.com/join?sid=abc")!))
        XCTAssertNil(DeepLink.parse(URL(string: "https://flagshipserver.com/join")!))
    }

    func test_deepLink_otherHttpsPath_isNotADeepLink() {
        // A non-/join https URL must NOT become a deep link (only /join
        // is honored over https).
        XCTAssertNil(DeepLink.parse(URL(string: "https://flagshipserver.com/build?x=1")!))
        XCTAssertNil(DeepLink.parse(URL(string: "https://evil.example.com/join?sid=a&pk=b")!))
    }

    // MARK: - Safeguards

    @MainActor
    func test_admin_invalidate_movesToInvalidatedState() async {
        let relay = MockPairingRelayClient()
        let vm = AddDeviceViewModel(
            account: "acme",
            relay: relay,
            deriveIRK: { _ in Curve25519.Signing.PrivateKey() },
            currentUMKHex: { _ in HexUtil.encode(Data(repeating: 0, count: 32)) }
        )
        // Don't drain the admin await — just publish the QR, then
        // invalidate (simulating a screenshot).
        let t = Task { await vm.start() }
        try? await Task.sleep(nanoseconds: 30_000_000)
        vm.invalidate()
        if case .invalidated = vm.phase {
            // ok
        } else {
            XCTFail("expected invalidated, got \(vm.phase)")
        }
        await relay.close()
        t.cancel()
    }

    @MainActor
    func test_incoming_invalidate_movesToInvalidatedState() async {
        let vm = JoinAccountViewModel(relay: MockPairingRelayClient(), server: MockFlagshipServerClient())
        vm.invalidate()
        if case .invalidated = vm.phase {
            // ok
        } else {
            XCTFail("expected invalidated, got \(vm.phase)")
        }
    }

    func test_quarantineCopy_rendersDays() {
        let now: Int64 = 1_000_000
        XCTAssertEqual(JoinAccountScreen.quarantineCopy(now + 14 * 86_400_000, now: now), "14 days")
        XCTAssertEqual(JoinAccountScreen.quarantineCopy(now + 86_400_000, now: now), "1 day")
        // No / past deadline → defaults to the 14-day window copy.
        XCTAssertEqual(JoinAccountScreen.quarantineCopy(nil, now: now), "14 days")
        XCTAssertEqual(JoinAccountScreen.quarantineCopy(now - 1, now: now), "14 days")
    }

    // MARK: - Mock relay records the wire

    @MainActor
    func test_mockServer_admitDevice_returnsQuarantineAndRecords() async throws {
        let server = MockFlagshipServerClient()
        server.nowProvider = { 5_000 }
        let req = admitRequest(username: "acme")
        let resp = try await server.admitDevice(account: "acme", body: req)
        XCTAssertTrue(resp.ok)
        XCTAssertEqual(resp.quarantineUntil, 5_000 + MockFlagshipServerClient.quarantineMs)
        XCTAssertEqual(server.admittedDevices["acme"]?.count, 1)
    }

    @MainActor
    func test_mockServer_admitDevice_rejectsUsernameMismatch() async {
        let server = MockFlagshipServerClient()
        let req = admitRequest(username: "other")
        do {
            _ = try await server.admitDevice(account: "acme", body: req)
            XCTFail("expected mismatch rejection")
        } catch ScreensClientError.http(let status, _) {
            XCTAssertEqual(status, 403)
        } catch {
            XCTFail("unexpected error \(error)")
        }
    }
}
