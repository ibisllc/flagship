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
        XCTAssertTrue(b.contains("if [ \"$BOOT_UNLOCK_MODE\" = \"approve\" ]; then"))
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
        XCTAssertTrue(b.contains("if [ \"$BOOT_UNLOCK_MODE\" = \"approve\" ]; then"))
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
            hash, "a269d668fe30c30226b7c9825247d6e63b3020e0a0e524d939e248d83b739656",
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
        XCTAssertTrue(wifi.contains("After=network.target"))
        XCTAssertTrue(wifi.contains("systemctl restart systemd-networkd"))
        XCTAssertTrue(wifi.contains("dhclient -1"))
        // The SAFETY-NET unit specifically must NOT wait on network-online (that
        // would defeat the offline backstop). Scope the check to that unit body
        // — the daemon/register units legitimately use network-online.target.
        if let unitStart = wifi.range(of: "flagship-wifi-safetynet.service <<")?.upperBound,
           let unitEnd = wifi.range(of: "WIFIUNIT", range: unitStart..<wifi.endIndex)?.lowerBound {
            let unit = String(wifi[unitStart..<unitEnd])
            XCTAssertFalse(unit.contains("network-online.target"))
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
    func testDebianPreseedCryptoStorage() throws {
        let cfg = try UserData.debianPreseed(recipeJSON: sampleRecipe(), installerGitRef: "main")
        XCTAssertTrue(cfg.contains("d-i partman-auto/method string crypto"))
        XCTAssertTrue(cfg.contains("method{ crypto }"))
        XCTAssertTrue(cfg.contains("vg_name{ flagship }"))
        XCTAssertTrue(cfg.contains("in_vg{ flagship } lv_name{ root }"))
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
}

/// Minimal mirror of RecipeLoader's private DTO, used only to assert that
/// bootUnlockMode is parsed (presence-preserving) from the recipe JSON.
private struct ParseableRecipe: Decodable {
    let bootUnlockMode: String?
}
