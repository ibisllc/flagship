import XCTest
@testable import FlagshipBurnerCore

final class VMConfigTests: XCTestCase {

    // MARK: - Fixtures

    private func makeRecipe(bootUnlockMode: String? = nil,
                            diskEncryption: String? = nil) -> Recipe {
        let ac = RecipeAuthCode(version: 1,
                                serial: "01VMTEST",
                                username: "harry",
                                serverName: "home",
                                serverDomain: "home.harry.flagship.services",
                                delegatedPubKeyHex: String(repeating: "13", count: 32),
                                userPubKeyHex: String(repeating: "ea", count: 32),
                                issuedAt: 1_899_996_400_000,
                                expiresAt: 1_900_000_000_000)
        return Recipe(version: 2,
                      serverDomain: "home.harry.flagship.services",
                      username: "harry",
                      serverName: "home",
                      phoneDelegatedPubKeyHex: String(repeating: "13", count: 32),
                      registrationUrl: "https://flagship.services/api/server/register",
                      authCode: ac,
                      authCodeUserSignatureHex: String(repeating: "00", count: 64),
                      installerGitRef: "main",
                      rckPubKeyHex: String(repeating: "fd", count: 32),
                      blobSignatureHex: String(repeating: "f1", count: 64),
                      bootUnlockMode: bootUnlockMode,
                      diskEncryption: diskEncryption)
    }

    private func json(_ obj: [String: Any]) -> Data {
        try! JSONSerialization.data(withJSONObject: obj)
    }

    private let host16 = HostResources(cpuCount: 8, memoryBytes: 16 * VMResourcePlan.gib)

    // MARK: - Determinism + shape

    func testPlanIsDeterministic() {
        let recipe = makeRecipe()
        let raw = json(["version": 2])
        let a = VMConfig.plan(recipe: recipe, recipeJSON: raw, host: host16)
        let b = VMConfig.plan(recipe: recipe, recipeJSON: raw, host: host16)
        XCTAssertEqual(a, b)
    }

    func testPlanCarriesTheServerIdentityAndResources() {
        let cfg = VMConfig.plan(recipe: makeRecipe(), recipeJSON: json([:]), host: host16)
        XCTAssertEqual(cfg.name, "home.harry.flagship.services")
        XCTAssertEqual(cfg.serverDomain, "home.harry.flagship.services")
        XCTAssertEqual(cfg.username, "harry")
        XCTAssertEqual(cfg.serverName, "home")
        XCTAssertEqual(cfg.cpuCount, VMResourcePlan.vmCPUCount(host: host16))
        XCTAssertEqual(cfg.memoryBytes, VMResourcePlan.vmMemoryBytes(host: host16))
        XCTAssertEqual(cfg.mainDiskSizeBytes, VMResourcePlan.defaultMainDiskSizeBytes)
        XCTAssertEqual(cfg.networkMode, .nat)
    }

    // MARK: - Serial console ⇔ debug grant (the hard guardrail)

    func testProductionRecipeGetsNoSerialConsole() {
        let cfg = VMConfig.plan(recipe: makeRecipe(), recipeJSON: json(["version": 2]), host: host16)
        XCTAssertFalse(cfg.serialConsoleEnabled)
    }

    func testDebugGrantSiblingEnablesTheSerialConsole() {
        let raw = json(["version": 2, "debugGrant": "{\"grant\":{},\"signatureHex\":\"ab\"}"])
        let cfg = VMConfig.plan(recipe: makeRecipe(), recipeJSON: raw, host: host16)
        XCTAssertTrue(cfg.serialConsoleEnabled)
    }

    func testDebugGrantInsideTheEnvelopeShapeEnablesTheConsole() {
        // The sibling rides at the TOP level of the issued envelope, beside
        // `blob`/`blobSignature` — exactly where the canonical engine reads it.
        let raw = json(["blob": ["version": 2], "blobSignature": "f1",
                        "debugGrant": ["grant": ["issuedAt": 1], "signatureHex": "ab"]])
        let cfg = VMConfig.plan(recipe: makeRecipe(), recipeJSON: raw, host: host16)
        XCTAssertTrue(cfg.serialConsoleEnabled)
    }

    func testEmptyDebugGrantStringDoesNotEnableTheConsole() {
        // Mirrors the engine's asStr: an empty string is "absent".
        let raw = json(["version": 2, "debugGrant": ""])
        let cfg = VMConfig.plan(recipe: makeRecipe(), recipeJSON: raw, host: host16)
        XCTAssertFalse(cfg.serialConsoleEnabled)
    }

    // MARK: - Unlock policy from the signed blob

    func testEncryptedGuestAwaitsPhoneUnlockAtBoot() {
        // Absent diskEncryption ⇒ LUKS ⇒ boots into the sealed state.
        let cfg = VMConfig.plan(recipe: makeRecipe(), recipeJSON: json([:]), host: host16)
        XCTAssertTrue(cfg.diskEncrypted)
        XCTAssertTrue(cfg.awaitsPhoneUnlockAtBoot)
        XCTAssertEqual(cfg.bootUnlockMode, "auto")
    }

    func testApproveModeIsCarriedThrough() {
        let cfg = VMConfig.plan(recipe: makeRecipe(bootUnlockMode: "approve"),
                                recipeJSON: json([:]), host: host16)
        XCTAssertEqual(cfg.bootUnlockMode, "approve")
        XCTAssertTrue(cfg.awaitsPhoneUnlockAtBoot)
    }

    func testUnencryptedGuestBootsStraightThrough() {
        let cfg = VMConfig.plan(recipe: makeRecipe(diskEncryption: "none"),
                                recipeJSON: json([:]), host: host16)
        XCTAssertFalse(cfg.diskEncrypted)
        XCTAssertFalse(cfg.awaitsPhoneUnlockAtBoot)
    }

    // MARK: - Codable round-trip (persisted in config.json)

    func testCodableRoundTrip() throws {
        let raw = json(["debugGrant": "x"])
        let cfg = VMConfig.plan(recipe: makeRecipe(bootUnlockMode: "approve"),
                                recipeJSON: raw, host: host16)
        let data = try VMInventoryStore.encoder().encode(cfg)
        let back = try VMInventoryStore.decoder().decode(VMConfig.self, from: data)
        XCTAssertEqual(back, cfg)
    }
}
