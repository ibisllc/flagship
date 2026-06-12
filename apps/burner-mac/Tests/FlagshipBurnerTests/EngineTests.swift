import XCTest
import CryptoKit
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

    // MARK: - encryptRoot is the locked DEFAULT; false is the debug escape

    /// Default (encryptRoot omitted) MUST equal the explicit `true` path and
    /// carry the LUKS storage block + unlock hook. encryptRoot:false is the
    /// internal debug escape that reproduces the proven unencrypted path.
    func testEncryptRootDefaultsLocked() throws {
        let recipe = Data(#"{"version":2,"serverDomain":"home.x.flagship.services"}"#.utf8)
        let dflt = try UserData.autoinstallYAML(recipeJSON: recipe, installerGitRef: "main")
        let explicit = try UserData.autoinstallYAML(recipeJSON: recipe, installerGitRef: "main", encryptRoot: true)
        XCTAssertEqual(dflt, explicit, "default must equal explicit encryptRoot:true byte-for-byte")
        XCTAssertTrue(dflt.contains("storage:"))
        XCTAssertTrue(dflt.contains("dm_crypt"))
        let enc = UserData.bootstrapScript(ref: "main", repoURL: UserData.defaultRepoURL)
        XCTAssertTrue(enc.contains("encryptRoot ON"))
        XCTAssertTrue(enc.contains("/boot/flagship-unseal"))
        // The debug escape (encryptRoot:false) reproduces the plaintext path.
        let plainYaml = try UserData.autoinstallYAML(recipeJSON: recipe, installerGitRef: "main", encryptRoot: false)
        XCTAssertFalse(plainYaml.contains("storage:"))
        XCTAssertFalse(plainYaml.contains("dm_crypt"))
        let plain = UserData.bootstrapScript(ref: "main", repoURL: UserData.defaultRepoURL, encryptRoot: false)
        XCTAssertFalse(plain.contains("encryptRoot ON"))
        XCTAssertFalse(plain.contains("/boot/flagship-unseal"))
        XCTAssertFalse(plain.contains("unlock_via_relay"))
        XCTAssertFalse(plain.contains("unlock_via_box_lease"))
        XCTAssertFalse(plain.contains("update-initramfs"))
        XCTAssertFalse(plain.contains("luksAddKey"))
        XCTAssertFalse(plain.contains("/boot/flagship-boot-unlock-mode"))
        XCTAssertTrue(plain.hasSuffix("echo \"[flagship-bootstrap] done\"\n"))
    }

    /// The encrypted bootstrap is EXACTLY the plain bootstrap with the LUKS
    /// block spliced before the final installed.flag — proves the shared body
    /// is reused verbatim (the cross-language byte-identity guarantee).
    func testEncryptedBootstrapIsPlainPlusLuks() {
        let plain = UserData.bootstrapScript(ref: "main", repoURL: UserData.defaultRepoURL, encryptRoot: false)
        let enc = UserData.bootstrapScript(ref: "main", repoURL: UserData.defaultRepoURL, encryptRoot: true)
        let tail = "date > /var/flagship/installed.flag\necho \"[flagship-bootstrap] done\"\n"
        XCTAssertTrue(plain.hasSuffix(tail))
        XCTAssertTrue(enc.hasSuffix(tail))
        // Stripping the LUKS block from enc must reproduce the plain script.
        let withoutTail = String(enc.dropLast(tail.count))
        XCTAssertTrue(withoutTail.contains(UserData.luksBootstrapBlock()))
        let recombined = withoutTail.replacingOccurrences(of: UserData.luksBootstrapBlock(), with: "") + tail
        XCTAssertEqual(recombined, plain)
    }

    /// EXPERIMENTAL LUKS path: storage layout + helper bake + initramfs hook.
    /// Mirrors the TS encryptRoot:true assertions in userdata.test.ts.
    func testEncryptRootEmitsLuksStorageAndHook() throws {
        let recipe = Data(#"{"version":2}"#.utf8)
        let yaml = try UserData.autoinstallYAML(recipeJSON: recipe, installerGitRef: "main", encryptRoot: true)
        // curtin custom storage with a LUKS-encrypted root + unencrypted /boot.
        XCTAssertTrue(yaml.contains("storage:"))
        XCTAssertTrue(yaml.contains("type: dm_crypt"))
        XCTAssertTrue(yaml.contains("dm_name: flagship_root"))
        XCTAssertTrue(yaml.contains("label: FLAGSHIP_BOOT"))
        XCTAssertTrue(yaml.contains("label: FLAGSHIP_ROOT"))
        XCTAssertTrue(yaml.contains("path: /boot"))
        XCTAssertTrue(yaml.contains("EXPERIMENTAL"))
        // UEFI Secure Boot: the ESP carries grub_device (curtin installs the
        // SIGNED shim+grub chain), the DISK must NOT (that installs unsigned BIOS
        // grub-pc → "Secure Boot Violation: invalid signature").
        XCTAssertTrue(yaml.contains("flag: bios_grub"))
        XCTAssertTrue(yaml.contains("flag: boot, grub_device: true"))
        XCTAssertTrue(yaml.contains("fstype: fat32"))
        XCTAssertTrue(yaml.contains("path: /boot/efi"))
        XCTAssertTrue(yaml.contains("wipe: superblock-recursive, grub_device: false"))
        // Broken-NVRAM firmware: skip the EFI NVRAM write (else the install
        // aborts) + a late-command installs grub to the removable fallback path.
        XCTAssertTrue(yaml.contains("grub:\n      update_nvram: false"))
        XCTAssertTrue(yaml.contains("$D/BOOT/BOOTX64.EFI"))
        XCTAssertTrue(yaml.contains("shimx64.efi"))
        // Second mechanism (subiquity may ignore storage.grub.update_nvram):
        // the debconf preseed so grub-install passes --no-nvram.
        XCTAssertTrue(yaml.contains("debconf-selections: |"))
        XCTAssertTrue(yaml.contains("grub2/update_nvram boolean false"))

        let b = UserData.bootstrapScript(ref: "main", repoURL: UserData.defaultRepoURL, encryptRoot: true)
        // Helper baked to /boot — build-at-install from cloned source.
        XCTAssertTrue(b.contains("apt-get install -y --no-install-recommends golang-go"))
        XCTAssertTrue(b.contains("/opt/flagship/installer/unseal-helper"))
        XCTAssertTrue(b.contains("-o /boot/flagship-unseal"))
        XCTAssertTrue(b.contains("chmod 755 /boot/flagship-unseal"))
        XCTAssertTrue(b.contains("CGO_ENABLED=0 GOOS=linux GOARCH=amd64"))
        // Re-key to a random key + seal for phone + upload (install.sh pattern).
        XCTAssertTrue(b.contains("head -c 64 /dev/urandom > \"$LUKS_KEY\""))
        XCTAssertTrue(b.contains("cryptsetup luksAddKey"))
        XCTAssertTrue(b.contains("cryptsetup luksRemoveKey"))
        XCTAssertTrue(b.contains("install-helper.ts seal-for-bak"))
        XCTAssertTrue(b.contains("install-helper.ts sign-sealed-key"))
        XCTAssertTrue(b.contains("/sealed-luks-key"))
        XCTAssertTrue(b.contains("shred -u \"$LUKS_KEY\""))
        // Initramfs hook lifting the relay + box-lease verbatim (plaintext RETIRED).
        XCTAssertTrue(b.contains("/etc/initramfs-tools/hooks/flagship-unlock"))
        XCTAssertTrue(b.contains("/etc/initramfs-tools/scripts/local-top/flagship-unlock"))
        XCTAssertTrue(b.contains("unlock_via_relay()"))
        XCTAssertTrue(b.contains("unlock_via_box_lease()"))
        XCTAssertTrue(b.contains("flagship/secret-request/v1|"))
        XCTAssertFalse(b.contains("flagship/consume-unlock-key/v1|"))
        XCTAssertFalse(b.contains("unlock_via_plaintext_consume"))
        XCTAssertTrue(b.contains("if ! unlock_via_box_lease; then"))
        XCTAssertTrue(b.contains("copy_exec /usr/bin/openssl"))
        XCTAssertTrue(b.contains("copy_exec /usr/bin/curl"))
        XCTAssertTrue(b.contains("copy_exec /usr/bin/xxd"))
        XCTAssertTrue(b.contains("copy_exec /bin/sed"))
        XCTAssertTrue(b.contains("copy_exec /sbin/cryptsetup"))
        XCTAssertTrue(b.contains("copy_exec /boot/flagship-unseal /bin/flagship-unseal"))
        XCTAssertTrue(b.contains("/dev/disk/by-label/FLAGSHIP_ROOT"))
        XCTAssertTrue(b.contains("cryptsetup luksOpen --key-file - \"$ROOT_PART\" flagship_root"))
        XCTAssertTrue(b.contains("update-initramfs -u"))
    }

    /// Recently-reconciled-with-the-TS-canonical chunks the Swift port was
    /// missing (it had been checkpointed at a WIP state). Pins so the drift
    /// cannot silently reappear. Mirrors the TS assertions in userdata.test.ts.
    func testBootstrapCarriesReconciledChunks() {
        // (1) NodeSource install has the npm fallback: a WARN on a failed
        //     setup_20.x, an explicit distro-npm install if npm is still absent,
        //     and a FATAL guard so a build can't proceed without npm.
        let plain = UserData.bootstrapScript(ref: "main", repoURL: UserData.defaultRepoURL, encryptRoot: false)
        XCTAssertTrue(plain.contains("curl -fsSL https://deb.nodesource.com/setup_20.x | bash - || echo \"[flagship-bootstrap] WARN: NodeSource setup failed; falling back to distro nodejs+npm\""))
        XCTAssertTrue(plain.contains("if ! command -v npm >/dev/null 2>&1; then"))
        XCTAssertTrue(plain.contains("apt-get install -y --no-install-recommends npm"))
        XCTAssertTrue(plain.contains("command -v npm >/dev/null 2>&1 || { echo \"[flagship-bootstrap] FATAL: npm unavailable; cannot build daemon\"; exit 1; }"))

        // (2) report_phase() provisioning-status reporting: the function POSTs
        //     {"phase":…} to <control-plane>/api/order/$AUTH_CODE_SERIAL/status,
        //     and the bootstrap start fires the "downloading" phase (the
        //     flagship git-clone/apt/node fetch — AFTER the base OS install, so
        //     it follows "installing" on the wire). (registering + sealing fire
        //     on the encrypted path — asserted below.)
        XCTAssertTrue(plain.contains("CONTROL_PLANE_BASE=\"$(echo \"$REGISTRATION_URL\" | sed 's|/api/server/register$||')\""))
        XCTAssertTrue(plain.contains("report_phase() {"))
        XCTAssertTrue(plain.contains("\"$CONTROL_PLANE_BASE/api/order/$AUTH_CODE_SERIAL/status\" >/dev/null 2>&1 || true"))
        XCTAssertTrue(plain.contains("report_phase downloading"))
        // Error trap → terminal `error` phase on a non-zero exit; disarmed on a
        // clean exit. The deferred-register wrapper fires `registering` on the
        // plain path and stashes AUTH_CODE_SERIAL for it. Byte-identical to
        // userdata.test.ts.
        XCTAssertTrue(plain.contains("trap flagship_on_error EXIT"))
        XCTAssertTrue(plain.contains("report_phase error \"bootstrap exited $_rc\""))
        XCTAssertTrue(plain.contains("trap - EXIT"))
        XCTAssertTrue(plain.contains("report_phase registering"))
        XCTAssertTrue(plain.contains("AUTH_CODE_SERIAL=$AUTH_CODE_SERIAL"))

        // (3) register-before-seal ordering on the encrypted path: registration
        //     runs in-target BEFORE the destructive re-key/seal (the sealed-key
        //     upload 404s otherwise), writes registered.flag, and the phase
        //     reports fire registering→sealing.
        let enc = UserData.bootstrapScript(ref: "main", repoURL: UserData.defaultRepoURL, encryptRoot: true)
        XCTAssertTrue(enc.contains("report_phase registering"))
        XCTAssertTrue(enc.contains("echo \"[flagship-bootstrap] registering server with .com (prereq for sealed-key upload)\""))
        XCTAssertTrue(enc.contains("date > /var/flagship/registered.flag"))
        XCTAssertTrue(enc.contains("report_phase sealing"))
        // The register POST must come BEFORE the luksAddKey re-key.
        let registerIdx = enc.range(of: "registering server with .com")
        let rekeyIdx = enc.range(of: "cryptsetup luksAddKey")
        XCTAssertNotNil(registerIdx)
        XCTAssertNotNil(rekeyIdx)
        if let r = registerIdx, let k = rekeyIdx {
            XCTAssertTrue(r.lowerBound < k.lowerBound, "registration must precede the destructive LUKS re-key")
        }

        // (4) the boot-host bake: the dedicated boot worker is written to
        //     /boot/flagship-boot-host and the initramfs hook copies it through.
        XCTAssertTrue(enc.contains("echo \"https://boot.flagshipserver.com\" > /boot/flagship-boot-host"))
        XCTAssertTrue(enc.contains("cp /boot/flagship-boot-host \"${DESTDIR}/boot/flagship-boot-host\" 2>/dev/null || true"))

        // An explicit bootHost override threads into the bake.
        let custom = UserData.bootstrapScript(ref: "main", repoURL: UserData.defaultRepoURL, encryptRoot: true, bootHost: "https://boot.example.com")
        XCTAssertTrue(custom.contains("echo \"https://boot.example.com\" > /boot/flagship-boot-host"))
    }

    // MARK: - Two-tier boot-unlock policy (docs §7a.1) — mirrors the TS tests

    /// Default (bootUnlockMode omitted) bakes "auto", emits unlock_via_box_lease
    /// + the auto dispatch, and the retired plaintext-consume path is GONE.
    func testBootUnlockModeAutoDefault() {
        let b = UserData.bootstrapScript(ref: "main", repoURL: UserData.defaultRepoURL)
        XCTAssertTrue(b.contains("echo \"auto\" > /boot/flagship-boot-unlock-mode"))
        XCTAssertFalse(b.contains("echo \"approve\" > /boot/flagship-boot-unlock-mode"))
        XCTAssertTrue(b.contains("unlock_via_box_lease()"))
        XCTAssertTrue(b.contains("/api/boot/lease/"))
        XCTAssertTrue(b.contains("\"sealedKey\":\""))
        XCTAssertTrue(b.contains("--identity-priv-hex \"$SEED_HEX\" --sealed-hex \"$SEALED_KEY\""))
        XCTAssertTrue(b.contains("if [ \"$EFFECTIVE_MODE\" = \"approve\" ]; then"))
        XCTAssertTrue(b.contains("if ! unlock_via_box_lease; then"))
        XCTAssertTrue(b.contains("BOOT_UNLOCK_MODE=\"$(cat /boot/flagship-boot-unlock-mode 2>/dev/null || echo auto)\""))
        XCTAssertFalse(b.contains("unlock_via_plaintext_consume"))
        XCTAssertFalse(b.contains("flagship/consume-unlock-key/v1|"))
    }

    /// Explicit "auto" === the absent default, byte-for-byte.
    func testBootUnlockModeAutoEqualsDefault() {
        let dflt = UserData.bootstrapScript(ref: "main", repoURL: UserData.defaultRepoURL)
        let explicit = UserData.bootstrapScript(ref: "main", repoURL: UserData.defaultRepoURL, bootUnlockMode: "auto")
        XCTAssertEqual(explicit, dflt)
    }

    /// bootUnlockMode:"approve" bakes "approve", keeps the relay-first dispatch,
    /// and never reintroduces the plaintext-consume fallback.
    func testBootUnlockModeApprove() throws {
        let b = UserData.bootstrapScript(ref: "main", repoURL: UserData.defaultRepoURL, bootUnlockMode: "approve")
        XCTAssertTrue(b.contains("echo \"approve\" > /boot/flagship-boot-unlock-mode"))
        XCTAssertFalse(b.contains("echo \"auto\" > /boot/flagship-boot-unlock-mode"))
        XCTAssertTrue(b.contains("if [ \"$EFFECTIVE_MODE\" = \"approve\" ]; then"))
        XCTAssertTrue(b.contains("unlock_via_relay"))
        XCTAssertFalse(b.contains("unlock_via_plaintext_consume"))
        XCTAssertFalse(b.contains("flagship/consume-unlock-key/v1|"))

        // The whole YAML differs from auto ONLY in the baked mode literal.
        let recipe = Data(#"{"version":2}"#.utf8)
        let autoYaml = try UserData.autoinstallYAML(recipeJSON: recipe, installerGitRef: "main")
        let approveYaml = try UserData.autoinstallYAML(recipeJSON: recipe, installerGitRef: "main", bootUnlockMode: "approve")
        XCTAssertNotEqual(approveYaml, autoYaml)
    }

    /// A recipe with bootUnlockMode:"approve" parses, verifies (the mode is in
    /// the canonical bytes), and surfaces the effective mode the box bakes.
    func testRecipeBootUnlockModeRoundTrips() throws {
        // Absent ⇒ effective "auto".
        let r0 = #"{"version":2,"serverDomain":"d","username":"u","serverName":"s","phoneDelegatedPubKey":"00","registrationUrl":"https://x","authCode":{"serial":"01","userPubKey":"00","issuedAt":0,"expiresAt":1},"authCodeUserSignature":"00","installerGitRef":"main","rckPubKey":"00","blobSignatureHex":"00"}"#
        let dto0 = try JSONDecoder().decode(ParseableRecipe.self, from: Data(r0.utf8))
        XCTAssertNil(dto0.bootUnlockMode)

        // Present "approve" decodes.
        let r1 = #"{"version":2,"serverDomain":"d","username":"u","serverName":"s","phoneDelegatedPubKey":"00","registrationUrl":"https://x","authCode":{"serial":"01","userPubKey":"00","issuedAt":0,"expiresAt":1},"authCodeUserSignature":"00","installerGitRef":"main","rckPubKey":"00","blobSignatureHex":"00","bootUnlockMode":"approve"}"#
        let dto1 = try JSONDecoder().decode(ParseableRecipe.self, from: Data(r1.utf8))
        XCTAssertEqual(dto1.bootUnlockMode, "approve")
    }

    // MARK: - optional Wi-Fi (burn-time local input; not in the signed recipe)

    /// No Wi-Fi (the default) must be byte-identical to before — no `network:`
    /// block, no wpasupplicant. Mirrors the TS userdata.test.ts assertions.
    func testWifiAbsentIsByteIdentical() throws {
        let recipe = Data(#"{"version":2,"serverDomain":"home.x.flagship.services"}"#.utf8)
        let none = try UserData.autoinstallYAML(recipeJSON: recipe, installerGitRef: "main")
        let empty = try UserData.autoinstallYAML(recipeJSON: recipe, installerGitRef: "main", wifiSSID: "")
        let blank = try UserData.autoinstallYAML(recipeJSON: recipe, installerGitRef: "main", wifiSSID: "   ")
        XCTAssertEqual(empty, none)
        XCTAssertEqual(blank, none, "whitespace-only SSID is treated as absent")
        XCTAssertFalse(none.contains("network:"))
        XCTAssertFalse(none.contains("wpasupplicant"))
    }

    /// An SSID emits: the wired-only `network:` fallback (networkd allows
    /// ethernet match, NOT wifi match), the wpasupplicant package, an
    /// early-command (live installer) AND a /target late-command. Crucially the
    /// YAML carries NO `wifis:`/`wl*` — the Wi-Fi is configured at runtime by the
    /// base64'd script, keyed by the detected interface name.
    func testWifiEmitsEthernetFallbackAndCommands() throws {
        let recipe = Data(#"{"version":2}"#.utf8)
        let yaml = try UserData.autoinstallYAML(recipeJSON: recipe, installerGitRef: "main",
                                                wifiSSID: "HomeNet", wifiPassword: "s3cret")
        XCTAssertTrue(yaml.contains("  network:\n    version: 2"))
        XCTAssertTrue(yaml.contains("match: {name: \"en*\"}"))
        XCTAssertTrue(yaml.contains("    - wpasupplicant\n"))
        XCTAssertTrue(yaml.contains("  early-commands:"))
        XCTAssertTrue(yaml.contains("bash /tmp/flagship-wifi.sh\""))      // live
        XCTAssertTrue(yaml.contains("bash /tmp/flagship-wifi.sh /target\"")) // target
        // The networkd-rejected wifi `match:` glob must NOT appear in the YAML.
        XCTAssertFalse(yaml.contains("wifis:"))
        XCTAssertFalse(yaml.contains("wl*"))
        // The SSID/password live ONLY inside the base64 script, never in plaintext.
        XCTAssertFalse(yaml.contains("HomeNet"))
        XCTAssertFalse(yaml.contains("s3cret"))
        // network: precedes early-commands: precedes identity: (under autoinstall:).
        let net = yaml.range(of: "network:")!.lowerBound
        let early = yaml.range(of: "early-commands:")!.lowerBound
        let ident = yaml.range(of: "identity:")!.lowerBound
        XCTAssertTrue(net < early && early < ident)
    }

    /// The runtime Wi-Fi script must be BYTE-IDENTICAL to the TS twin
    /// (userdata.ts wifiSetupScript) — the base64 only matches across the two
    /// burners if the script does. This pins the same sha256 both suites assert,
    /// the same cross-language lockstep guarantee the InstallBlob golden vector
    /// gives. If this fails, the Swift + TS scripts drifted (check indentation).
    func testWifiSetupScriptIsByteIdenticalToTs() {
        let script = UserData.wifiSetupScript(ssid: "Flagship Test AP", password: "test-only-not-real")
        let hash = SHA256.hash(data: Data(script.utf8)).map { String(format: "%02x", $0) }.joined()
        XCTAssertEqual(
            hash, "f215b57a79ae7f12cd6b372dd7631842a8f6dafbdc1beca7b6f3588535c770b9",
            "Swift wifiSetupScript drifted from the TS twin. Script:\n\(script)")
    }

    /// The runtime Wi-Fi script branches at runtime on the target's network
    /// stack: Ubuntu (netplan present) keeps the netplan file; Debian (else)
    /// writes systemd-networkd + wpa_supplicant, neutralizes d-i's ifupdown wpa
    /// stanza, and enables the units via .wants symlinks. Mirrors the TS tests.
    func testWifiSetupScriptIsDistroCorrect() {
        let s = UserData.wifiSetupScript(ssid: "HomeNet", password: "s3cret")
        XCTAssertTrue(s.contains(#"if [ -d "${ROOT}/etc/netplan" ]; then"#))
        // Ubuntu netplan branch unchanged.
        XCTAssertTrue(s.contains(#"cat > "${ROOT}/etc/netplan/99-flagship-wifi.yaml""#))
        XCTAssertTrue(s.contains("  wifis:"))
        // Debian networkd + wpa_supplicant branch.
        XCTAssertTrue(s.contains(#"cat > "${ROOT}/etc/systemd/network/10-flagship-wifi.network""#))
        XCTAssertTrue(s.contains("DHCP=yes"))
        XCTAssertTrue(s.contains(#"cat > "${ROOT}/etc/wpa_supplicant/wpa_supplicant-${IF}.conf""#))
        XCTAssertTrue(s.contains(#"ssid="HomeNet""#))
        XCTAssertTrue(s.contains(#"psk="s3cret""#))
        XCTAssertTrue(s.contains(#"chmod 600 "${ROOT}/etc/wpa_supplicant/wpa_supplicant-${IF}.conf""#))
        // ifupdown stanza neutralized; units enabled via symlinks.
        XCTAssertTrue(s.contains(#"IFACES_FILE="${ROOT}/etc/network/interfaces""#))
        XCTAssertTrue(s.contains("neutralized ifupdown wireless stanza"))
        XCTAssertTrue(s.contains(#"multi-user.target.wants/wpa_supplicant@${IF}.service""#))
        XCTAssertTrue(s.contains("ln -sf /lib/systemd/system/systemd-networkd.service"))
    }

    /// The first-boot Wi-Fi safety-net block must be BYTE-IDENTICAL to the TS
    /// twin (userdata.ts buildWifiSafetyNetBlock). Same cross-language lockstep
    /// guarantee as wifiSetupScript. If this fails the two ports drifted.
    func testWifiSafetyNetBlockIsByteIdenticalToTs() {
        let block = UserData.wifiSafetyNetBlock(ssid: "Flagship Test AP", password: "test-only-not-real")
        let hash = SHA256.hash(data: Data(block.utf8)).map { String(format: "%02x", $0) }.joined()
        XCTAssertEqual(
            hash, "f7c3c21f0d6f669a887ac88fd906f0aa443790a6c408a9441c7e18402781141f",
            "Swift wifiSafetyNetBlock drifted from the TS twin. Block:\n\(block)")
    }

    /// The safety-net is gated on the SSID: absent ⇒ "" (wired bootstrap stays
    /// byte-identical), present ⇒ the oneshot unit + base64 creds + route-gated,
    /// idempotent, retrying backstop that never waits on network-online.target.
    func testWifiSafetyNetGatingAndShape() {
        XCTAssertEqual(UserData.wifiSafetyNetBlock(ssid: "", password: "x"), "")
        XCTAssertEqual(UserData.wifiSafetyNetBlock(ssid: "   ", password: "x"), "")
        // Wired bootstrap carries no safety-net + no wpasupplicant apt addition.
        let wired = UserData.bootstrapScript(ref: "main", repoURL: UserData.defaultRepoURL, encryptRoot: false)
        XCTAssertFalse(wired.contains("flagship-wifi-safetynet"))
        XCTAssertFalse(wired.contains("wpasupplicant"))
        // Wi-Fi bootstrap carries the unit, the base64 creds (never plaintext),
        // wpasupplicant, the route gate, and the DHCP retries.
        let wifi = UserData.bootstrapScript(ref: "main", repoURL: UserData.defaultRepoURL, encryptRoot: false,
                                            wifiSSID: "HomeNet", wifiPassword: "s3cret")
        XCTAssertTrue(wifi.contains("/usr/local/sbin/flagship-wifi-safetynet.sh"))
        XCTAssertTrue(wifi.contains("systemctl enable flagship-wifi-safetynet.service"))
        XCTAssertTrue(wifi.contains("FLAGSHIP_WIFI_SSID_B64="))
        XCTAssertTrue(wifi.contains("chmod 600 /etc/flagship/wifi.env"))
        XCTAssertFalse(wifi.contains("HomeNet"))   // base64, never plaintext
        XCTAssertFalse(wifi.contains("s3cret"))
        XCTAssertTrue(wifi.contains("wpasupplicant"))
        XCTAssertTrue(wifi.contains("has_route() { ip route show default 2>/dev/null | grep -q .; }"))
        XCTAssertTrue(wifi.contains("Before=flagship-first-boot-register.service flagship-daemon.service"))
        XCTAssertTrue(wifi.contains("systemctl restart systemd-networkd"))
        XCTAssertTrue(wifi.contains("dhclient -1"))
        // The SAFETY-NET unit must carry NO network ordering at all: not
        // network-online.target (defeats the offline backstop) and not
        // network.target either (can be delayed on a Wi-Fi-only box — the
        // chicken-and-egg this unit exists to break). Scope to the unit body —
        // the daemon/register units legitimately use network-online.target.
        if let unitStart = wifi.range(of: "flagship-wifi-safetynet.service <<")?.upperBound,
           let unitEnd = wifi.range(of: "WIFIUNIT", range: unitStart..<wifi.endIndex)?.lowerBound {
            let unit = String(wifi[unitStart..<unitEnd])
            XCTAssertFalse(unit.contains("network-online.target"))
            XCTAssertFalse(unit.contains("After="))
            XCTAssertFalse(unit.contains("Wants=network"))
        } else {
            XCTFail("safety-net unit body not found")
        }
    }

    /// END-TO-END: the safety-net must reach the GENERATED YAML/preseed, not just
    /// the bootstrapScript helper — i.e. the generators thread the Wi-Fi creds
    /// into the bootstrap. (Guards against a missed wiring at the call site.)
    func testWifiSafetyNetReachesGeneratedArtifacts() throws {
        let recipe = sampleRecipe()
        // Ubuntu autoinstall — decode the embedded bootstrap, assert safety-net.
        let yaml = try UserData.autoinstallYAML(recipeJSON: recipe, installerGitRef: "main",
                                                wifiSSID: "HomeNet", wifiPassword: "s3cret")
        let reY = try NSRegularExpression(pattern: #"echo "([A-Za-z0-9+/=]+)" \| base64 -d > /usr/local/sbin/flagship-bootstrap\.sh"#)
        let mY = reY.firstMatch(in: yaml, range: NSRange(yaml.startIndex..., in: yaml))!
        let by = String(data: Data(base64Encoded: String(yaml[Range(mY.range(at: 1), in: yaml)!]))!, encoding: .utf8)!
        XCTAssertTrue(by.contains("flagship-wifi-safetynet.service"), "Ubuntu YAML must embed the safety-net")
        // Debian preseed — same end-to-end check.
        let cfg = try UserData.debianPreseed(recipeJSON: recipe, installerGitRef: "main",
                                             wifiSSID: "HomeNet", wifiPassword: "s3cret")
        let reD = try NSRegularExpression(pattern: #"echo '([A-Za-z0-9+/=]+)' \| base64 -d > /target/usr/local/sbin/flagship-bootstrap\.sh"#)
        let mD = reD.firstMatch(in: cfg, range: NSRange(cfg.startIndex..., in: cfg))!
        let bd = String(data: Data(base64Encoded: String(cfg[Range(mD.range(at: 1), in: cfg)!]))!, encoding: .utf8)!
        XCTAssertTrue(bd.contains("flagship-wifi-safetynet.service"), "Debian preseed must embed the safety-net")
        // A wired Ubuntu burn must NOT carry it (byte-identity preserved).
        let wiredYaml = try UserData.autoinstallYAML(recipeJSON: recipe, installerGitRef: "main")
        let mW = reY.firstMatch(in: wiredYaml, range: NSRange(wiredYaml.startIndex..., in: wiredYaml))!
        let bw = String(data: Data(base64Encoded: String(wiredYaml[Range(mW.range(at: 1), in: wiredYaml)!]))!, encoding: .utf8)!
        XCTAssertFalse(bw.contains("flagship-wifi-safetynet"))
    }

    // MARK: - BRING-UP SAFETY NET + initramfs Wi-Fi (phone-gated unlock in early boot)

    /// CHANGE 1: the encrypted bootstrap KEEPS the burn-time passphrase slot as a
    /// bring-up recovery net — the luksRemoveKey is guarded off (`if false`), never
    /// run, so a box whose phone/Wi-Fi auto-unlock doesn't engage can still be
    /// unlocked by hand. Mirrors the TS userdata.test.ts assertion.
    func testEncryptedBootstrapKeepsBurnPassphraseRecoverySlot() {
        let b = UserData.bootstrapScript(ref: "main", repoURL: UserData.defaultRepoURL, encryptRoot: true)
        XCTAssertTrue(b.contains("cryptsetup luksAddKey"))
        XCTAssertTrue(b.contains("cryptsetup luksRemoveKey")) // present but guarded
        let removeRange = b.range(of: "cryptsetup luksRemoveKey")!
        let guardRange = b.range(of: "if false; then",
                                 options: .backwards,
                                 range: b.startIndex..<removeRange.lowerBound)
        XCTAssertNotNil(guardRange, "luksRemoveKey must be guarded by `if false; then`")
        XCTAssertTrue(b.contains("BRING-UP SAFETY NET"))
        XCTAssertTrue(b.contains("recovery slot"))
    }

    /// CHANGE 2: the initramfs Wi-Fi hook + premount are emitted ONLY on the
    /// encrypted Wi-Fi path; absent on wired and on the plain (unencrypted) path.
    func testInitramfsWifiGating() {
        let wired = UserData.bootstrapScript(ref: "main", repoURL: UserData.defaultRepoURL, encryptRoot: true)
        XCTAssertFalse(wired.contains("init-premount/flagship-wifi"))
        XCTAssertFalse(wired.contains("/etc/initramfs-tools/hooks/flagship-wifi"))
        // Plain path even with creds: no LUKS prompt to unlock past ⇒ no block.
        let plain = UserData.bootstrapScript(ref: "main", repoURL: UserData.defaultRepoURL,
                                             encryptRoot: false, wifiSSID: "HomeNet", wifiPassword: "s3cret")
        XCTAssertFalse(plain.contains("init-premount/flagship-wifi"))
        // Helper returns "" with no SSID.
        XCTAssertEqual(UserData.initramfsWifiBlock(ssid: "", password: "x"), "")
        XCTAssertEqual(UserData.initramfsWifiBlock(ssid: "   ", password: "x"), "")
    }

    /// The build-time hook stages this box's driver + firmware + the premount's
    /// tools, VALIDATED step by step with a build-time diagnostic log on /boot.
    func testInitramfsWifiHookStagesDriverFirmwareWpa() {
        let b = UserData.bootstrapScript(ref: "main", repoURL: UserData.defaultRepoURL,
                                         encryptRoot: true, wifiSSID: "HomeNet", wifiPassword: "s3cret")
        XCTAssertTrue(b.contains("cat > /etc/initramfs-tools/hooks/flagship-wifi"))
        XCTAssertTrue(b.contains("WLIF=$(ls /sys/class/net 2>/dev/null | grep -E '^wl' | head -1)"))
        XCTAssertTrue(b.contains(#"DRV=$(basename "$(readlink -f "/sys/class/net/$WLIF/device/driver" 2>/dev/null)" 2>/dev/null)"#))
        XCTAssertTrue(b.contains(#"if [ -n "$WLIF" ]; then"#))
        XCTAssertTrue(b.contains(#"if [ -n "$DRV" ]; then"#))
        XCTAssertTrue(b.contains(#"manual_add_modules "$DRV""#))
        // Firmware for the driver AND its dependencies, accepting the Debian 13
        // compressed variants (.xz/.zst) with the variant filename preserved.
        XCTAssertTrue(b.contains(#"modprobe --show-depends "$DRV""#))
        XCTAssertTrue(b.contains(#"for fw in $(modinfo -F firmware "$_m" 2>/dev/null); do stage_fw "$fw"; done"#))
        XCTAssertTrue(b.contains(#"for _v in "" .xz .zst; do"#))
        XCTAssertTrue(b.contains("for r in regulatory.db regulatory.db.p7s"))
        // cfg80211/mac80211 explicit; bounded no-detection fallback.
        XCTAssertTrue(b.contains("manual_add_modules cfg80211"))
        XCTAssertTrue(b.contains("manual_add_modules mac80211"))
        XCTAssertTrue(b.contains("copy_modules_dir kernel/drivers/net/wireless"))
        // Every premount tool staged: wpa_supplicant + wpa_cli + ip (both paths).
        XCTAssertTrue(b.contains("copy_exec /sbin/wpa_supplicant"))
        XCTAssertTrue(b.contains("copy_exec /usr/sbin/wpa_supplicant /sbin/wpa_supplicant"))
        XCTAssertTrue(b.contains("copy_exec /sbin/wpa_cli /sbin/wpa_cli"))
        XCTAssertTrue(b.contains("copy_exec /usr/sbin/wpa_cli /sbin/wpa_cli"))
        XCTAssertTrue(b.contains("copy_exec /sbin/ip /sbin/ip"))
        XCTAssertTrue(b.contains("copy_exec /bin/ip /sbin/ip"))
        // The stage-by-stage build log on /boot, best-effort, never aborts.
        XCTAssertTrue(b.contains("BLOG=/boot/flagship-wifi-build.log"))
        XCTAssertTrue(b.contains(#"blog() { echo "flagship-wifi-hook: $*" >> "$BLOG" 2>/dev/null || true; }"#))
        XCTAssertTrue(b.contains(#"blog "interface detected: $WLIF""#))
        XCTAssertTrue(b.contains(#"blog "NO wl* interface visible at build time""#))
        XCTAssertTrue(b.contains(#"blog "driver UNRESOLVED — falling back to the whole wireless module class""#))
        XCTAssertTrue(b.contains(#"blog "hook done""#))
        XCTAssertTrue(b.range(of: #"apt-get install .*wpasupplicant"#, options: .regularExpression) != nil)
    }

    /// The boot-time premount brings Wi-Fi up (modprobe + wpa_supplicant + bounded
    /// DHCP). The premount is written via an UNQUOTED heredoc, so the bootstrap
    /// text carries the shell vars escaped (`\$DRV`).
    func testInitramfsWifiPremountBringsNetworkUp() {
        let b = UserData.bootstrapScript(ref: "main", repoURL: UserData.defaultRepoURL,
                                         encryptRoot: true, wifiSSID: "HomeNet", wifiPassword: "s3cret")
        XCTAssertTrue(b.contains("cat > /etc/initramfs-tools/scripts/init-premount/flagship-wifi"))
        XCTAssertTrue(b.contains(#"modprobe "\$DRV""#))
        XCTAssertTrue(b.contains(#"ip link set "\$IF" up"#))
        XCTAssertTrue(b.contains("wpa_supplicant -B -i"))
        XCTAssertTrue(b.contains("/run/flagship-wpa.conf"))
        XCTAssertTrue(b.contains(#"ipconfig -t 20 "\$IF""#))
        XCTAssertTrue(b.contains(#"udhcpc -i "\$IF" -n -q -t 5"#))
        // Interface wait raised to ~30s; "premount start" logs FIRST (before the
        // boot-fs mount) and the mount result is logged either way, so an empty
        // persistent log can only mean the premount never ran.
        XCTAssertTrue(b.contains("no wl* interface in 30s — falling through"))
        XCTAssertTrue(b.contains(#"log_stage "premount start (ssid baked)""#))
        XCTAssertTrue(b.contains("while [ ! -e /dev/disk/by-label/FLAGSHIP_BOOT ]; do"))
        XCTAssertTrue(b.contains(#"log_stage "boot fs mounted (persistent log live)""#))
        XCTAssertTrue(b.contains(#"log_stage "boot fs mount FAILED — log stays in /run (survives pivot)""#))
        let startLog = b.range(of: #"log_stage "premount start (ssid baked)""#)!
        let mountAt = b.range(of: "mount /dev/disk/by-label/FLAGSHIP_BOOT", range: startLog.lowerBound ..< b.endIndex)!
        XCTAssertTrue(startLog.lowerBound < mountAt.lowerBound)
        XCTAssertTrue(b.contains("falling through"))
        // Creds embedded single-quote-escaped (NOT base64; initramfs /bin/sh).
        XCTAssertTrue(b.contains("WIFI_SSID='HomeNet'"))
        XCTAssertTrue(b.contains("WIFI_PSK='s3cret'"))
        let evil = UserData.initramfsWifiBlock(ssid: "Net's AP", password: "p'w")
        XCTAssertTrue(evil.contains("WIFI_SSID='Net'\\''s AP'"))
        XCTAssertTrue(evil.contains("WIFI_PSK='p'\\''w'"))
    }

    /// The Wi-Fi premount (init-premount) precedes the unlock relay (local-top),
    /// and is emitted before update-initramfs rebuilds the initrd.
    func testInitramfsWifiOrderedBeforeUnlock() {
        let b = UserData.bootstrapScript(ref: "main", repoURL: UserData.defaultRepoURL,
                                         encryptRoot: true, wifiSSID: "HomeNet", wifiPassword: "s3cret")
        let wifiAt = b.range(of: "init-premount/flagship-wifi")!.lowerBound
        XCTAssertTrue(b.contains("scripts/local-top/flagship-unlock"))
        let updateAt = b.range(of: "update-initramfs -u")!.lowerBound
        XCTAssertTrue(wifiAt < updateAt)
    }

    /// The initramfs Wi-Fi block must be BYTE-IDENTICAL to the TS twin
    /// (userdata.ts buildInitramfsWifiBlock). Same cross-language lockstep
    /// guarantee as wifiSetupScript/wifiSafetyNetBlock. If this fails they drifted.
    func testInitramfsWifiBlockIsByteIdenticalToTs() {
        let block = UserData.initramfsWifiBlock(ssid: "Flagship Test AP", password: "test-only-not-real")
        let hash = SHA256.hash(data: Data(block.utf8)).map { String(format: "%02x", $0) }.joined()
        XCTAssertEqual(
            hash, "5a0ad7e25ec0e8bd6b44082797d4dba6838ce025f11947b7cd2d5d69732cb444",
            "Swift initramfsWifiBlock drifted from the TS twin. Block:\n\(block)")
    }

    // MARK: - #27 root-cause fixes (2026-06-09 live hardware session)

    /// The encrypted WIRED bootstrap must be BYTE-IDENTICAL to the TS twin —
    /// userdata.test.ts pins this SAME sha256. The unlock hook/premount (which
    /// the net-ensure/resolv-ensure fix changed on every LUKS burn, wired or
    /// Wi-Fi) had no cross-language pin before.
    func testEncryptedWiredBootstrapIsByteIdenticalToTs() {
        let b = UserData.bootstrapScript(ref: "main", repoURL: UserData.defaultRepoURL, encryptRoot: true)
        let hash = SHA256.hash(data: Data(b.utf8)).map { String(format: "%02x", $0) }.joined()
        XCTAssertEqual(
            hash, "16ec057330f90971a5d6e9bc36b89bd7fed4fe2050dca45bd920138583a75176",
            "Swift encrypted wired bootstrap drifted from the TS twin.")
    }

    /// The encrypted DEBIAN bootstrap must be BYTE-IDENTICAL to the TS twin —
    /// userdata.test.ts pins this SAME sha256. The Debian premount must open the
    /// LUKS container under the CRYPTTAB target name (read from
    /// /cryptroot/crypttab, e.g. sda4_crypt) so Debian's local-top/cryptroot —
    /// which runs after us and skips an already-active target — recognizes the
    /// unlock. Opening as flagship_root hung every phone-approved boot at
    /// "Please unlock disk sda4_crypt:" (metal, 2026-06-12).
    func testEncryptedDebianBootstrapIsByteIdenticalToTs() {
        let b = UserData.bootstrapScript(ref: "main", repoURL: UserData.defaultRepoURL,
                                         encryptRoot: true, family: "debian")
        XCTAssertTrue(b.contains(#"[ -n "$CRYPT_NAME" ] || CRYPT_NAME=flagship_root"#))
        XCTAssertTrue(b.contains(#"cryptsetup luksOpen --key-file - "$ROOT_LUKS_PART" "$CRYPT_NAME""#))
        let hash = SHA256.hash(data: Data(b.utf8)).map { String(format: "%02x", $0) }.joined()
        XCTAssertEqual(
            hash, "384951096900d413e93fcb44ddbeb54d0796d8c6557febe75ed0fd788a34826b",
            "Swift encrypted Debian bootstrap drifted from the TS twin.")
    }

    /// FIX 1+2: the build hook stages the driver's whole module dir (op-modes
    /// like iwlmvm are REVERSE deps, request_module'd at runtime, invisible to
    /// manual_add_modules) and the boot premount belt-and-braces-loads the
    /// op-mode + writes /etc/resolv.conf after DHCP (klibc ipconfig records DNS
    /// in /run/net-<if>.conf but nothing writes resolv.conf in the initramfs).
    func testInitramfsWifiOpModeAndDnsFixes() {
        let b = UserData.bootstrapScript(ref: "main", repoURL: UserData.defaultRepoURL,
                                         encryptRoot: true, wifiSSID: "HomeNet", wifiPassword: "s3cret")
        XCTAssertTrue(b.contains(#"d=$(modinfo -n "$DRV" 2>/dev/null)"#))
        XCTAssertTrue(b.contains(#"sub="kernel/${d#*/kernel/}""#))
        XCTAssertTrue(b.contains(#"if copy_modules_dir "$sub" 2>/dev/null; then blog "module dir staged: $sub"; else blog "module dir STAGING FAILED: $sub"; fi"#))
        XCTAssertTrue(b.contains(#"if [ "\$DRV" = iwlwifi ]; then"#))
        XCTAssertTrue(b.contains(#"modprobe "\$m" 2>/dev/null && log_stage "op-mode loaded: \$m" && break"#))
        XCTAssertTrue(b.contains(#"[ -f "/run/net-\$IF.conf" ] && . "/run/net-\$IF.conf""#))
        XCTAssertTrue(b.contains(#"echo "nameserver \$_d" >> /etc/resolv.conf"#))
        XCTAssertTrue(b.contains(#"log_stage "dns configured:\$_dns""#))
        XCTAssertTrue(b.contains(#"log_stage "dns fallback: public resolvers""#))
    }

    /// FIX 3: the unlock premount self-ensures net (wired path: link-up + DHCP
    /// the first carrier interface, route-checked first so Wi-Fi skips) + DNS
    /// (both paths), and the unlock hook stages `ip`. Present on every LUKS
    /// burn; the Wi-Fi-only blocks stay absent on wired.
    func testUnlockPremountNetAndResolvEnsure() {
        let b = UserData.bootstrapScript(ref: "main", repoURL: UserData.defaultRepoURL, encryptRoot: true)
        XCTAssertTrue(b.contains("copy_exec /sbin/ip /sbin/ip 2>/dev/null || copy_exec /bin/ip /sbin/ip"))
        XCTAssertTrue(b.contains("if ! ip route 2>/dev/null | grep -q '^default'; then"))
        XCTAssertTrue(b.contains("echo \"flagship: no default route — bringing up interfaces for DHCP\""))
        XCTAssertTrue(b.contains(#"if [ "$(cat "/sys/class/net/$IFW/carrier" 2>/dev/null || echo 0)" != "1" ]; then continue; fi"#))
        XCTAssertTrue(b.contains(#"ipconfig -t 20 "$IFW" 2>/dev/null || true"#))
        XCTAssertTrue(b.contains(#"udhcpc -i "$IFW" -n -q -t 5 2>/dev/null || true"#))
        XCTAssertTrue(b.contains("if [ ! -s /etc/resolv.conf ]; then"))
        XCTAssertTrue(b.contains("for _nc in /run/net-*.conf; do"))
        XCTAssertTrue(b.contains("echo \"flagship: dns fallback: public resolvers\""))
        let ensureAt = b.range(of: "net-ensure")!.lowerBound
        let dispatchAt = b.range(of: "echo \"flagship: boot-unlock mode = $EFFECTIVE_MODE")!.lowerBound
        XCTAssertTrue(ensureAt < dispatchAt)
        XCTAssertFalse(b.contains("init-premount/flagship-wifi"))
        XCTAssertFalse(b.contains("flagship-wifi-safetynet"))
        // The no-LUKS path stays untouched — no unlock script at all.
        let plain = UserData.bootstrapScript(ref: "main", repoURL: UserData.defaultRepoURL, encryptRoot: false)
        XCTAssertFalse(plain.contains("net-ensure"))
        XCTAssertFalse(plain.contains("resolv.conf"))
    }

    /// FIX 4: the full-OS safety-net persists the initramfs /run log (it
    /// survives the pivot) and, before giving up on "no wireless interface",
    /// reloads every loaded refcount-0 wireless driver (the loaded-but-
    /// interface-less case: the op-mode module never loaded).
    func testSafetyNetPersistsLogAndSelfHeals() {
        let b = UserData.bootstrapScript(ref: "main", repoURL: UserData.defaultRepoURL,
                                         encryptRoot: false, wifiSSID: "HomeNet", wifiPassword: "s3cret")
        XCTAssertTrue(b.contains("cp /run/flagship-wifi.log /var/log/flagship-wifi-initramfs.log 2>/dev/null || true"))
        XCTAssertTrue(b.contains("echo \"[safety-net] no wireless interface — reloading idle wireless modules\""))
        XCTAssertTrue(b.contains(#"modinfo -n "$m" 2>/dev/null | grep -q /drivers/net/wireless/ || continue"#))
        XCTAssertTrue(b.contains(#"[ "$(cat "/sys/module/$m/refcnt" 2>/dev/null || echo 1)" = "0" ] || continue"#))
        XCTAssertTrue(b.contains(#"modprobe -r "$m" 2>/dev/null || true"#))
        let reload = b.range(of: "reloading idle wireless modules")!.lowerBound
        let giveUp = b.range(of: "[safety-net] no wireless interface; giving up")!.lowerBound
        XCTAssertTrue(reload < giveUp)
    }

    // MARK: - Debian (debian-installer / d-i) preseed

    private func sampleRecipe() -> Data {
        Data(#"{"version":2,"serverDomain":"home.x.flagship.services","phoneDelegatedPubKey":"00"}"#.utf8)
    }

    /// Pull the install-blob.json base64 out of the preseed late_command.
    private func preseedEmbeddedBlobB64(_ cfg: String) throws -> String {
        let re = try NSRegularExpression(
            pattern: #"echo '([A-Za-z0-9+/=]+)' \| base64 -d > /target/var/flagship/install-blob\.json"#)
        let m = re.firstMatch(in: cfg, range: NSRange(cfg.startIndex..., in: cfg))!
        return String(cfg[Range(m.range(at: 1), in: cfg)!])
    }

    /// Decode the embedded bootstrap out of the preseed late_command.
    private func preseedBootstrap(_ cfg: String) throws -> String {
        let re = try NSRegularExpression(
            pattern: #"echo '([A-Za-z0-9+/=]+)' \| base64 -d > /target/usr/local/sbin/flagship-bootstrap\.sh"#)
        let m = re.firstMatch(in: cfg, range: NSRange(cfg.startIndex..., in: cfg))!
        let b64 = String(cfg[Range(m.range(at: 1), in: cfg)!])
        return String(data: Data(base64Encoded: b64)!, encoding: .utf8)!
    }

    func testDebianPreseedIsADiPreseedNotCloudConfig() throws {
        let cfg = try UserData.debianPreseed(recipeJSON: sampleRecipe(), installerGitRef: "main")
        XCTAssertTrue(cfg.hasPrefix("# Flagship Burner — debian-installer preseed"))
        XCTAssertTrue(cfg.contains("d-i debian-installer/locale string"))
        XCTAssertFalse(cfg.contains("#cloud-config"))
        XCTAssertFalse(cfg.contains("autoinstall:"))
    }

    /// THE NVRAM/removable-path fix — the entire reason the Debian path exists.
    func testDebianPreseedForcesEfiRemovablePath() throws {
        let cfg = try UserData.debianPreseed(recipeJSON: sampleRecipe(), installerGitRef: "main")
        // Both owner keys (d-i question + grub-efi-amd64 package question).
        XCTAssertTrue(cfg.contains("d-i grub-installer/force-efi-extra-removable boolean true"))
        XCTAssertTrue(cfg.contains("grub-efi-amd64 grub2/force_efi_extra_removable boolean true"))
        XCTAssertTrue(cfg.contains("d-i grub-installer/update-nvram boolean false"))
        XCTAssertTrue(cfg.contains("d-i grub-installer/only_debian boolean true"))
    }

    /// LVM-on-LUKS storage: ESP + bios_grub + unencrypted /boot + encrypted root.
    /// Under `partman-auto/method crypto`, partman BUILDS the encrypted LVM itself
    /// from a PLAIN recipe — the root is just `$lvmok{ }` + `method{ format }`.
    /// Hand-declaring the LVM (`method{ crypto }`/`vg_name`/`in_vg`/`lv_name`) makes
    /// partman abort with "No physical volume defined in volume group". Mirrors
    /// preseed.test.ts.
    func testDebianPreseedCryptoStorage() throws {
        let cfg = try UserData.debianPreseed(recipeJSON: sampleRecipe(), installerGitRef: "main")
        XCTAssertTrue(cfg.contains("d-i partman-auto/method string crypto"))
        XCTAssertFalse(cfg.contains("method{ lvm }"))
        XCTAssertFalse(cfg.contains("method{ crypto }"))
        XCTAssertFalse(cfg.contains("vg_name{"))
        XCTAssertFalse(cfg.contains("in_vg{"))
        XCTAssertFalse(cfg.contains("lv_name{"))
        XCTAssertTrue(cfg.contains("$lvmok{ }"))
        XCTAssertTrue(cfg.contains("d-i partman-auto-lvm/new_vg_name string flagship"))
        XCTAssertTrue(cfg.contains("method{ biosgrub }"))
        XCTAssertTrue(cfg.contains("method{ efi } format{ }"))
        XCTAssertTrue(cfg.contains("label{ FLAGSHIP_BOOT }"))
        XCTAssertTrue(cfg.contains("label{ FLAGSHIP_ROOT }"))
        XCTAssertTrue(cfg.contains("mountpoint{ /boot }"))
        XCTAssertTrue(cfg.contains("mountpoint{ / }"))
        // burn-time passphrase the bootstrap re-keys away.
        XCTAssertTrue(cfg.contains("d-i partman-crypto/passphrase password flagship-burn-time-luks-rekey-me-immediately"))
        XCTAssertTrue(cfg.contains("d-i partman-crypto/weak_passphrase boolean true"))
        // destructive steps unattended.
        XCTAssertTrue(cfg.contains("d-i partman/confirm boolean true"))
        XCTAssertTrue(cfg.contains("d-i partman-crypto/confirm boolean true"))
    }

    /// encryptRoot:false is the debug escape — plain regular layout, no crypto,
    /// but STILL the removable-path GRUB fix.
    func testDebianPreseedPlainEscape() throws {
        let cfg = try UserData.debianPreseed(recipeJSON: sampleRecipe(), installerGitRef: "main", encryptRoot: false)
        XCTAssertTrue(cfg.contains("d-i partman-auto/method string regular"))
        XCTAssertFalse(cfg.contains("method{ crypto }"))
        XCTAssertFalse(cfg.contains("partman-crypto/passphrase"))
        XCTAssertTrue(cfg.contains("method{ efi } format{ }"))
        XCTAssertTrue(cfg.contains("label{ FLAGSHIP_ROOT }"))
        XCTAssertTrue(cfg.contains("d-i grub-installer/force-efi-extra-removable boolean true"))
    }

    /// The bootstrap runs from preseed/late_command in the target, and is the
    /// SAME daemon setup as Ubuntu.
    func testDebianPreseedRunsSharedBootstrap() throws {
        let cfg = try UserData.debianPreseed(recipeJSON: sampleRecipe(), installerGitRef: "main")
        XCTAssertTrue(cfg.contains("d-i preseed/late_command string"))
        XCTAssertTrue(cfg.contains("in-target /usr/local/sbin/flagship-bootstrap.sh"))
        XCTAssertTrue(cfg.contains("/target/var/flagship/install-blob.json"))
        let b = try preseedBootstrap(cfg)
        XCTAssertTrue(b.contains("cat > /etc/flagship/daemon.env"))
        XCTAssertTrue(b.contains("install-helper.ts mint-entitlements"))
        XCTAssertTrue(b.contains("ExecStart=/usr/bin/npm run start --workspace=@flagship/server-daemon"))
        XCTAssertTrue(b.contains("https://deb.nodesource.com/setup_20.x"))
    }

    /// The plain bootstrap is byte-identical across Ubuntu + Debian (only the
    /// LUKS unlock differs) — prove it via the debug-escape (unencrypted) path.
    func testDebianPlainBootstrapEqualsUbuntu() {
        let deb = UserData.bootstrapScript(ref: "main", repoURL: UserData.defaultRepoURL, encryptRoot: false, family: "debian")
        let ubuntu = UserData.bootstrapScript(ref: "main", repoURL: UserData.defaultRepoURL, encryptRoot: false, family: "ubuntu")
        XCTAssertEqual(deb, ubuntu)
    }

    /// The encrypted Debian bootstrap adds LVM-aware initramfs unlock bits.
    func testDebianEncryptedBootstrapIsLvmAware() {
        let b = UserData.bootstrapScript(ref: "main", repoURL: UserData.defaultRepoURL, encryptRoot: true, family: "debian")
        XCTAssertTrue(b.contains("encryptRoot ON"))
        XCTAssertTrue(b.contains("unlock_via_relay()"))
        XCTAssertTrue(b.contains("unlock_via_box_lease()"))
        XCTAssertTrue(b.contains("copy_exec /sbin/lvm /sbin/lvm"))
        XCTAssertTrue(b.contains("vgchange -ay"))
        XCTAssertTrue(b.contains("blkid -t TYPE=crypto_LUKS -o device | head -n1"))
        XCTAssertFalse(b.contains("unlock_via_plaintext_consume"))
        // Ubuntu's encrypted bootstrap must NOT carry the LVM bits.
        let u = UserData.bootstrapScript(ref: "main", repoURL: UserData.defaultRepoURL, encryptRoot: true, family: "ubuntu")
        XCTAssertFalse(u.contains("copy_exec /sbin/lvm /sbin/lvm"))
        XCTAssertFalse(u.contains("vgchange -ay"))
    }

    /// Wi-Fi: install-time netcfg + the runtime-detected netplan; the embedded
    /// runtime script is BYTE-IDENTICAL to the Ubuntu/TS twin (same sha256 pin).
    func testDebianPreseedWifi() throws {
        let none = try UserData.debianPreseed(recipeJSON: sampleRecipe(), installerGitRef: "main")
        XCTAssertFalse(none.contains("netcfg/wireless_essid"))
        XCTAssertFalse(none.contains("wpasupplicant"))

        let cfg = try UserData.debianPreseed(recipeJSON: sampleRecipe(), installerGitRef: "main",
                                             wifiSSID: "HomeNet", wifiPassword: "s3cret")
        XCTAssertTrue(cfg.contains("d-i netcfg/wireless_essid string HomeNet"))
        XCTAssertTrue(cfg.contains("d-i netcfg/wireless_security_type select wpa"))
        XCTAssertTrue(cfg.contains("d-i netcfg/wireless_wpa string s3cret"))
        XCTAssertTrue(cfg.contains("wpasupplicant"))
        XCTAssertTrue(cfg.contains("/target/tmp/flagship-wifi.sh"))

        // The embedded runtime script matches the cross-language pin.
        let pinned = try UserData.debianPreseed(recipeJSON: sampleRecipe(), installerGitRef: "main",
                                                wifiSSID: "Flagship Test AP", wifiPassword: "test-only-not-real")
        let re = try NSRegularExpression(
            pattern: #"echo '([A-Za-z0-9+/=]+)' \| base64 -d > /target/tmp/flagship-wifi\.sh"#)
        let m = re.firstMatch(in: pinned, range: NSRange(pinned.startIndex..., in: pinned))!
        let b64 = String(pinned[Range(m.range(at: 1), in: pinned)!])
        let script = String(data: Data(base64Encoded: b64)!, encoding: .utf8)!
        let hash = SHA256.hash(data: Data(script.utf8)).map { String(format: "%02x", $0) }.joined()
        XCTAssertEqual(hash, "f215b57a79ae7f12cd6b372dd7631842a8f6dafbdc1beca7b6f3588535c770b9")
    }

    func testDebianPreseedRejectsUnsafeRef() {
        XCTAssertThrowsError(try UserData.debianPreseed(recipeJSON: sampleRecipe(), installerGitRef: "main; rm -rf /")) { e in
            guard case .unsafeGitRef = (e as? UserDataError) else { return XCTFail("expected unsafeGitRef") }
        }
    }

    // MARK: - Phone-home beacons (earliest progress to the phone)

    /// A recipe with the serial + domain the TS twin's beacon test uses, so the
    /// expected beacon literals below are byte-identical across both suites.
    private func beaconRecipe() -> Data {
        Data(#"{"version":2,"serverDomain":"home.demoalice.flagship.services","phoneDelegatedPubKey":"00","authCode":{"serial":"01TESTABCDEF"}}"#.utf8)
    }

    // The EXACT beacon command strings — byte-identical to preseed.test.ts.
    // Each d-i rung POSTs a canonical ProvisionStatusPhase to the single
    // order-status channel (POST /api/order/<serial>/status). No `detail`
    // on the beacon (serverDomain is authoritative from registration).
    private static let earlyBeacon =
        #"( echo '{"phase":"booting"}' > /tmp/flagship-beacon.json; "#
        + "wget -q -O- --post-file=/tmp/flagship-beacon.json --timeout=15 "
        + "https://flagshipserver.com/api/order/01TESTABCDEF/status ) || true"
    private static let lateBeacon =
        #"( echo '{"phase":"downloading"}' > /tmp/flagship-beacon.json; "#
        + "wget -q -O- --post-file=/tmp/flagship-beacon.json --timeout=15 "
        + "https://flagshipserver.com/api/order/01TESTABCDEF/status ) || true"
    // Beacon C — fired from partman/early_command (network up by partman), before
    // the unconditional disk wipe. Byte-identical to preseed.test.ts.
    private static let partitionBeacon =
        #"( echo '{"phase":"partitioning"}' > /tmp/flagship-beacon.json; "#
        + "wget -q -O- --post-file=/tmp/flagship-beacon.json --timeout=15 "
        + "https://flagshipserver.com/api/order/01TESTABCDEF/status ) || true"
    // Beacon D — fired at the END of late_command, AFTER the bootstrap SUCCEEDS,
    // BEFORE poweroff. NOT success: the box has not registered yet. Byte-identical
    // to preseed.test.ts.
    private static let installedBeacon =
        #"( echo '{"phase":"installed"}' > /tmp/flagship-beacon.json; "#
        + "wget -q -O- --post-file=/tmp/flagship-beacon.json --timeout=15 "
        + "https://flagshipserver.com/api/order/01TESTABCDEF/status ) || true"

    func testDebianPreseedEarlyBeacon() throws {
        let cfg = try UserData.debianPreseed(recipeJSON: beaconRecipe(), installerGitRef: "main")
        // Beacon A POSTs d-i-started before partman (earliest hook).
        XCTAssertTrue(cfg.contains("d-i preseed/early_command string \(Self.earlyBeacon)"))
        let early = cfg.range(of: "preseed/early_command")!
        let partman = cfg.range(of: "partman/early_command")!
        XCTAssertTrue(early.lowerBound < partman.lowerBound, "the beacon must fire before the partman early_command")
    }

    func testDebianPreseedLateBeacon() throws {
        let cfg = try UserData.debianPreseed(recipeJSON: beaconRecipe(), installerGitRef: "main")
        // Beacon B POSTs the downloading phase FIRST in late_command, before blob-decode.
        XCTAssertTrue(cfg.contains("d-i preseed/late_command string \(Self.lateBeacon); mkdir -p /target/var/flagship;"))
    }

    func testDebianPreseedPartitionBeaconAndWipe() throws {
        // The unconditional disk-wipe + the 'partitioning' beacon must hold in
        // BOTH storage variants; the literals match preseed.test.ts.
        for encryptRoot in [true, false] {
            let cfg = try UserData.debianPreseed(recipeJSON: beaconRecipe(), installerGitRef: "main", encryptRoot: encryptRoot)
            // The wipe runs from partman/early_command after DISK is resolved.
            XCTAssertTrue(cfg.contains("d-i partman/early_command string"))
            XCTAssertTrue(cfg.contains(#"DISK=$(list-devices disk | head -n1); debconf-set partman-auto/disk "$DISK""#))
            XCTAssertTrue(cfg.contains("dmsetup remove_all 2>/dev/null || true"))
            XCTAssertTrue(cfg.contains(#"dd if=/dev/zero of="$DISK" bs=1M count=16 2>/dev/null || true"#))
            XCTAssertTrue(cfg.contains(#"SZ=$(blockdev --getsz "$DISK" 2>/dev/null || echo 0)"#))
            XCTAssertTrue(cfg.contains(#"dd if=/dev/zero of="$DISK" bs=512 seek=$((SZ-8192)) count=8192 2>/dev/null || true"#))
            XCTAssertTrue(cfg.contains(#"blockdev --rereadpt "$DISK" 2>/dev/null || true"#))
            // The 'partitioning' beacon fires BEFORE the wipe.
            XCTAssertTrue(cfg.contains("\(Self.partitionBeacon); \\"))
            let beacon = cfg.range(of: #""phase":"partitioning""#)!
            let wipe = cfg.range(of: "dmsetup remove_all")!
            XCTAssertTrue(beacon.lowerBound < wipe.lowerBound, "beacon must precede the wipe")
        }
    }

    // Beacon E — the `installing` base-installer.d dropper, written by
    // partman/early_command (base-installer runs it right after partitioning,
    // filling the silent debootstrap/apt window). Byte-identical to preseed.test.ts.
    private static let installingDrop =
        "( mkdir -p /usr/lib/base-installer.d; "
        + #"{ echo '#!/bin/sh'; echo "( echo '{\"phase\":\"installing\"}' > /tmp/flagship-beacon.json; "#
        + "wget -q -O- --post-file=/tmp/flagship-beacon.json --timeout=15 "
        + #"https://flagshipserver.com/api/order/01TESTABCDEF/status ) || true &"; echo 'exit 0'; } "#
        + "> /usr/lib/base-installer.d/05flagship-beacon; "
        + "chmod +x /usr/lib/base-installer.d/05flagship-beacon ) || true"

    func testDebianPreseedInstallingDropper() throws {
        // Both storage variants drop it; ordering inside the early_command is
        // partitioning beacon → wipe → dropper; the dropped script is
        // backgrounded + exit 0 so it can never block or fail base-installer.
        for encryptRoot in [true, false] {
            let cfg = try UserData.debianPreseed(recipeJSON: beaconRecipe(), installerGitRef: "main", encryptRoot: encryptRoot)
            XCTAssertTrue(cfg.contains(Self.installingDrop), "encryptRoot=\(encryptRoot)")
            let part = cfg.range(of: #""phase":"partitioning""#)!
            let wipe = cfg.range(of: "dmsetup remove_all")!
            let drop = cfg.range(of: "/usr/lib/base-installer.d")!
            XCTAssertTrue(part.lowerBound < wipe.lowerBound)
            XCTAssertTrue(wipe.lowerBound < drop.lowerBound)
            XCTAssertTrue(cfg.contains(#"|| true &"; echo 'exit 0';"#))
        }
    }

    func testDebianPreseedInstalledBeaconOnSuccessOnly() throws {
        let cfg = try UserData.debianPreseed(recipeJSON: beaconRecipe(), installerGitRef: "main")
        // Success path: bootstrap `&&` the installed beacon, THEN `||` the
        // failure (dev late-log) branch. Byte-identical to preseed.test.ts.
        XCTAssertTrue(cfg.contains(
            "( in-target /usr/local/sbin/flagship-bootstrap.sh > /target/var/log/flagship-bootstrap.log 2>&1 ) && "
            + "\(Self.installedBeacon) || "
        ))
        // The `installed` beacon comes AFTER the bootstrap run and BEFORE the
        // failure branch's dev late-log POST (success-only; never on failure).
        let installed = cfg.range(of: #""phase":"installed""#)!
        let bootstrapRun = cfg.range(of: "flagship-bootstrap.log 2>&1 ) &&")!
        let lateLog = cfg.range(of: "/api/dev/late-log/")!
        XCTAssertTrue(bootstrapRun.lowerBound < installed.lowerBound)
        XCTAssertTrue(installed.lowerBound < lateLog.lowerBound)
    }

    func testDebianPreseedOverwriteConfirmFlags() throws {
        // Both variants authorize partman to steamroll existing LVM/crypto.
        for encryptRoot in [true, false] {
            let cfg = try UserData.debianPreseed(recipeJSON: beaconRecipe(), installerGitRef: "main", encryptRoot: encryptRoot)
            for k in [
                "d-i partman-lvm/confirm boolean true",
                "d-i partman-lvm/confirm_nooverwrite boolean true",
                "d-i partman-crypto/confirm boolean true",
                "d-i partman-crypto/confirm_nooverwrite boolean true",
                "d-i partman/confirm_nooverwrite boolean true",
            ] {
                XCTAssertTrue(cfg.contains(k), "encryptRoot=\(encryptRoot): missing \(k)")
            }
        }
    }

    func testDebianPreseedBeaconsBestEffort() throws {
        let cfg = try UserData.debianPreseed(recipeJSON: beaconRecipe(), installerGitRef: "main")
        // busybox wget --post-file= (no curl in mini.iso d-i), both wrapped || true.
        XCTAssertTrue(cfg.contains("wget -q -O- --post-file=/tmp/flagship-beacon.json --timeout=15"))
        let occurrences = cfg.components(separatedBy: ") || true").count - 1
        XCTAssertGreaterThanOrEqual(occurrences, 2)
        // Serial inlined in the URL on the canonical order-status channel (no
        // runtime blob parse, no detail field on the d-i beacon).
        XCTAssertTrue(cfg.contains("/api/order/01TESTABCDEF/status"))
    }

    func testDebianPreseedBeaconSanitizesInjection() {
        // Dangerous chars in the serial/domain are stripped to the safe subset.
        XCTAssertEqual(UserData.beaconSafe("evil\"; rm -rf / #"), "evilrm-rf")
        XCTAssertEqual(UserData.beaconSafe("abc$(touch x)def"), "abctouchxdef")
    }

    // MARK: - Debian remaster transforms (mirror remasterIso.ts)

    func testEditGrubCfgForPreseed() {
        let grub = """
        set timeout=10
        menuentry "Install" {
        \tlinux\t/install.amd/vmlinuz vga=788 --- quiet
        \tinitrd\t/install.amd/initrd.gz
        }
        menuentry "Graphical install" {
        \tlinux\t/install.amd/gtk/vmlinuz vga=788 --- quiet
        \tinitrd\t/install.amd/gtk/initrd.gz
        }
        """
        let out = Remaster.editGrubCfgForPreseed(grub)
        XCTAssertTrue(out.contains("/install.amd/vmlinuz \(Remaster.debianPreseedCmdline) vga=788"))
        XCTAssertTrue(out.contains("/install.amd/gtk/vmlinuz \(Remaster.debianPreseedCmdline) vga=788"))
        XCTAssertTrue(out.contains("preseed/file=/cdrom/preseed.cfg"))
        XCTAssertTrue(out.contains("set timeout=1"))
        XCTAssertFalse(out.contains("set timeout=10"))
        // idempotent
        XCTAssertEqual(Remaster.editGrubCfgForPreseed(out), out)
    }

    func testEditIsolinuxCfgForPreseed() {
        let txt = """
        prompt 1
        timeout 600
        label install
        \tkernel /install.amd/vmlinuz
        \tappend vga=788 initrd=/install.amd/initrd.gz --- quiet
        """
        let out = Remaster.editIsolinuxCfgForPreseed(txt)
        XCTAssertTrue(out.contains("initrd=/install.amd/initrd.gz \(Remaster.debianPreseedCmdline)"))
        XCTAssertTrue(out.range(of: "(?m)^\\s*timeout\\s+1", options: .regularExpression) != nil)
        XCTAssertFalse(out.contains("timeout 600"))
        XCTAssertTrue(out.range(of: "(?m)^\\s*prompt\\s+0", options: .regularExpression) != nil)
        XCTAssertEqual(Remaster.editIsolinuxCfgForPreseed(out), out)
    }

    func testClassifyIsoText() {
        XCTAssertEqual(Remaster.classifyIsoText("Debian 13.5.0 amd64 1"), "debian")
        XCTAssertEqual(Remaster.classifyIsoText("/install.amd\n/boot\n/EFI"), "debian")
        XCTAssertEqual(Remaster.classifyIsoText("Ubuntu-Server 22.04.5 LTS amd64"), "ubuntu")
        XCTAssertEqual(Remaster.classifyIsoText("/casper\n/boot"), "ubuntu")
        XCTAssertEqual(Remaster.classifyIsoText("ubuntu based on debian\n/casper"), "ubuntu")
        XCTAssertEqual(Remaster.classifyIsoText("Some Custom Linux 1.0"), "ubuntu")
        XCTAssertEqual(Remaster.classifyIsoText(""), "ubuntu")
    }

    /// The script detects the interface at runtime (networkd needs the real
    /// name), writes a name-keyed netplan via a placeholder + sed, and escapes
    /// the SSID/password for the YAML scalar inside the quoted heredoc.
    func testWifiSetupScriptContentAndEscaping() {
        let s = UserData.wifiSetupScript(ssid: "My \"Net\" \\x", password: "p\"a\\ss")
        XCTAssertTrue(s.contains("for d in /sys/class/net/*/wireless; do"))
        XCTAssertTrue(s.contains("<<'FLAGSHIP_WIFI_EOF'"))
        XCTAssertTrue(s.contains("    __IFACE__:"))
        XCTAssertTrue(s.contains("sed -i \"s/__IFACE__/${IF}/\""))
        XCTAssertTrue(s.contains("99-flagship-wifi.yaml"))
        // YAML-scalar escaping of the SSID + password.
        XCTAssertTrue(s.contains("\"My \\\"Net\\\" \\\\x\":"))
        XCTAssertTrue(s.contains("password: \"p\\\"a\\\\ss\""))
    }

    /// Regression: the .com/website hand out the recipe as an envelope
    /// { blob:{…}, blobSignature }. The box bootstrap reads serverDomain/
    /// username/phoneDelegatedPubKey at the TOP LEVEL of install-blob.json, so
    /// the burner must write the FLATTENED blob — not the raw envelope (which
    /// nests everything under .blob, making every top-level read null and the
    /// LUKS re-key abort). This guards the fix.
    func testEnvelopeRecipeIsFlattenedIntoInstallBlob() throws {
        let envelope = Data(#"{"blob":{"version":2,"serverDomain":"home.x.flagship.services","username":"x","serverName":"home","phoneDelegatedPubKey":"aa","registrationUrl":"https://flagshipserver.com/api/server/register","authCode":{"version":1,"serial":"AAAA1111BBBB","userPubKey":"bb","issuedAt":0,"expiresAt":0}},"blobSignature":"cc"}"#.utf8)
        let preseed = try UserData.debianPreseed(recipeJSON: envelope, installerGitRef: "main")

        // Extract the base64 that gets decoded into install-blob.json.
        let tail = "' | base64 -d > /target/var/flagship/install-blob.json"
        guard let tailRange = preseed.range(of: tail),
              let echoRange = preseed.range(of: "echo '", options: .backwards,
                                            range: preseed.startIndex..<tailRange.lowerBound)
        else { return XCTFail("install-blob.json write not found in preseed") }
        let b64 = String(preseed[echoRange.upperBound..<tailRange.lowerBound])
        guard let decoded = Data(base64Encoded: b64),
              let obj = try JSONSerialization.jsonObject(with: decoded) as? [String: Any]
        else { return XCTFail("install-blob.json base64 did not decode to JSON") }

        // Flattened: top-level fields present, the envelope wrapper gone.
        XCTAssertEqual(obj["serverDomain"] as? String, "home.x.flagship.services")
        XCTAssertEqual(obj["username"] as? String, "x")
        XCTAssertEqual(obj["phoneDelegatedPubKey"] as? String, "aa")
        XCTAssertEqual((obj["authCode"] as? [String: Any])?["serial"] as? String, "AAAA1111BBBB")
        XCTAssertNil(obj["blob"], "install-blob.json must be the flat blob, not the envelope")
    }
}

/// Minimal mirror of RecipeLoader's private DTO, used only to assert that
/// bootUnlockMode is parsed (presence-preserving) from the recipe JSON.
private struct ParseableRecipe: Decodable {
    let bootUnlockMode: String?
}
