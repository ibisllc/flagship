import XCTest
@testable import FlagshipBurnerCore

/// Pure-function coverage for the native remaster + user-data engine. The
/// xorriso round-trip and the raw disk write are exercised on real hardware
/// (they need a device); these lock the string transforms.
final class EngineTests: XCTestCase {
    let grub = """
    set timeout=30
    menuentry "Try or Install Ubuntu Server" {
    \tset gfxpayload=keep
    \tlinux\t/casper/vmlinuz quiet ---
    \tinitrd\t/casper/initrd
    }
    menuentry "Test memory" {
    \tlinux16 /boot/memtest86+.bin
    }
    """

    func testGrubInsertsAutoinstall() {
        let out = Remaster.editGrubCfg(grub)
        XCTAssertTrue(out.contains("/casper/vmlinuz autoinstall ds=nocloud\\;s=/cdrom/nocloud/ quiet ---"),
                      "expected autoinstall cmdline after vmlinuz, got:\n\(out)")
    }

    func testGrubShortensTimeout() {
        let out = Remaster.editGrubCfg(grub)
        XCTAssertTrue(out.contains("set timeout=1"))
        XCTAssertFalse(out.contains("set timeout=30"))
    }

    func testGrubLeavesMemtestAlone() {
        XCTAssertTrue(Remaster.editGrubCfg(grub).contains("linux16 /boot/memtest86+.bin"))
    }

    func testGrubIdempotent() {
        let once = Remaster.editGrubCfg(grub)
        let twice = Remaster.editGrubCfg(once)
        XCTAssertEqual(once, twice)
        XCTAssertEqual(twice.components(separatedBy: "autoinstall").count - 1, 1)
    }

    func testGrubAddsTimeoutWhenMissing() {
        let noTimeout = "menuentry \"x\" {\n\tlinux /casper/vmlinuz ---\n}\n"
        XCTAssertTrue(Remaster.editGrubCfg(noTimeout).hasPrefix("set timeout=1\n"))
    }

    func testUserDataEmbedsRecipeAndBootstrap() throws {
        let recipe = Data(#"{"version":2,"serverDomain":"home.x.flagship.services"}"#.utf8)
        let yaml = try UserData.autoinstallYAML(recipeJSON: recipe, installerGitRef: "main")
        XCTAssertTrue(yaml.hasPrefix("#cloud-config"))
        XCTAssertTrue(yaml.contains("autoinstall:"))
        // The recipe is embedded base64 verbatim.
        XCTAssertTrue(yaml.contains(recipe.base64EncodedString()))
        XCTAssertTrue(yaml.contains("/var/flagship/install-blob.json"))
    }

    func testUserDataRejectsUnsafeRef() {
        let recipe = Data("{}".utf8)
        XCTAssertThrowsError(try UserData.autoinstallYAML(recipeJSON: recipe, installerGitRef: "main; rm -rf /")) { e in
            guard case .unsafeGitRef = (e as? UserDataError) else { return XCTFail("expected unsafeGitRef") }
        }
    }

    func testUserDataDefaultsBlankRefToMain() throws {
        let yaml = try UserData.autoinstallYAML(recipeJSON: Data("{}".utf8), installerGitRef: "   ")
        // The bootstrap is embedded base64 — decode it to inspect GIT_REF.
        let re = try NSRegularExpression(pattern: #"echo "([A-Za-z0-9+/=]+)" \| base64 -d > /usr/local/sbin/flagship-bootstrap\.sh"#)
        let m = re.firstMatch(in: yaml, range: NSRange(yaml.startIndex..., in: yaml))!
        let b64 = String(yaml[Range(m.range(at: 1), in: yaml)!])
        let bootstrap = String(data: Data(base64Encoded: b64)!, encoding: .utf8)!
        XCTAssertTrue(bootstrap.contains("GIT_REF=\"main\""), bootstrap)
    }

    func testBootstrapInjectsRefAndRepo() {
        let s = UserData.bootstrapScript(ref: "v1.2.3", repoURL: "https://example.com/x.git")
        XCTAssertTrue(s.contains("GIT_REF=\"v1.2.3\""))
        XCTAssertTrue(s.contains("https://example.com/x.git"))
        // Bash line-continuations survive as literal backslashes.
        XCTAssertTrue(s.contains("/opt/flagship || \\\n"))
    }

    /// The bootstrap must set up AND enable the daemon (parity with the fixed
    /// demo cloud-init), not just register and stop. These mirror the TS
    /// assertions in packages/flagship-burner/tests/userdata.test.ts.
    func testBootstrapSetsUpAndEnablesDaemon() {
        let s = UserData.bootstrapScript(ref: "main", repoURL: UserData.defaultRepoURL)
        // daemon.env with the two REQUIRED daemon inputs (0600).
        XCTAssertTrue(s.contains("cat > /etc/flagship/daemon.env"))
        XCTAssertTrue(s.contains("FLAGSHIP_SUBDOMAIN=$SERVER_DOMAIN"))
        XCTAssertTrue(s.contains("FLAGSHIP_IDENTITY_PRIV_HEX=$SERVER_IDENTITY_PRIV_HEX"))
        XCTAssertTrue(s.contains("chmod 600 /etc/flagship/daemon.env"))
        // Self-signed entitlement bundle (box identity key signs; no user IRK).
        XCTAssertTrue(s.contains("install-helper.ts mint-entitlements"))
        XCTAssertTrue(s.contains("--irk-priv \"$SERVER_IDENTITY_PRIV_HEX\""))
        XCTAssertTrue(s.contains("--pod-pub \"$SERVER_IDENTITY_PUB_HEX\""))
        XCTAssertTrue(s.contains("--out /var/flagship/entitlements.json"))
        XCTAssertTrue(s.contains("INTERIM SELF-SIGN"))
        XCTAssertTrue(s.contains("FOLLOW-UP REQUIRED"))
        // flagship-daemon unit with the FIXED ExecStart (npm run, not npx).
        XCTAssertTrue(s.contains("cat > /etc/systemd/system/flagship-daemon.service"))
        XCTAssertTrue(s.contains("ExecStart=/usr/bin/npm run start --workspace=@flagship/server-daemon"))
        XCTAssertTrue(s.contains("EnvironmentFile=/etc/flagship/daemon.env"))
        XCTAssertFalse(s.contains("npx npm run start"))
        // Register + daemon deferred to first-boot units; enable, never start.
        XCTAssertTrue(s.contains("cat > /etc/systemd/system/flagship-first-boot-register.service"))
        XCTAssertTrue(s.contains("Type=oneshot"))
        XCTAssertTrue(s.contains("ConditionPathExists=!/var/flagship/registered.flag"))
        XCTAssertTrue(s.contains("systemctl enable flagship-daemon.service flagship-first-boot-register.service"))
        XCTAssertFalse(s.contains("systemctl start flagship-daemon.service"))
        XCTAssertFalse(s.contains("systemctl start flagship-first-boot-register.service"))
    }
}
