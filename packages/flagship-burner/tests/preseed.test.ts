/**
 * Burner: Debian d-i preseed.cfg generation.
 *
 * The Debian path exists for ONE reason — UEFI firmware that rejects NVRAM
 * boot-entry writes, which Ubuntu's subiquity fatally aborts on but d-i can
 * preseed around by forcing GRUB to the EFI removable-media path. These tests
 * pin that key + the rest of the unattended contract (LUKS/ESP/bios_grub
 * layout, the shared first-boot bootstrap via late_command, Wi-Fi), and assert
 * the embedded recipe round-trips exactly like the Ubuntu generator's does.
 */
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  signAuthCode,
  signInstallBlob,
  verifyAuthCode,
  ed,
  type AuthCode,
  type InstallBlob,
} from "@flagship/protocol";
import { buildDebianPreseed } from "../src/preseed.js";
import { buildAutoinstallUserData, DEFAULT_BOOT_HOST } from "../src/userdata.js";

function makeKeypair(seedByte: number) {
  const sk = new Uint8Array(32).fill(seedByte);
  return { privateKey: sk, publicKey: ed.getPublicKey(sk) };
}
function hx(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}
function unhex(h: string): Uint8Array {
  return Uint8Array.from(Buffer.from(h, "hex"));
}

function signedBlob(): { blob: InstallBlob; blobSignatureHex: string } {
  const irk = makeKeypair(7);
  const delegate = makeKeypair(8);
  const rck = makeKeypair(9);
  const authCode: AuthCode = {
    version: 1,
    serial: "01TESTABCDEF",
    username: "demoalice",
    serverName: "home",
    serverDomain: "home.demoalice.flagship.services",
    delegatedPubKey: delegate.publicKey,
    userPubKey: irk.publicKey,
    issuedAt: Date.now(),
    expiresAt: Date.now() + 6 * 60 * 60_000,
  };
  const authCodeUserSignature = signAuthCode(authCode, irk);
  const blob: InstallBlob = {
    version: 2,
    serverDomain: authCode.serverDomain,
    username: authCode.username,
    serverName: authCode.serverName,
    phoneDelegatedPubKey: delegate.publicKey,
    registrationUrl: "https://flagshipserver.com/api/server/register",
    authCode,
    authCodeUserSignature,
    installerGitRef: "main",
    rckPubKey: rck.publicKey,
  };
  return { blob, blobSignatureHex: hx(signInstallBlob(blob, irk)) };
}

/** Pull the install-blob.json base64 out of the late_command. */
function extractEmbeddedBlob(cfg: string): Record<string, any> {
  const m = cfg.match(/echo '([A-Za-z0-9+/=]+)' \| base64 -d > \/target\/var\/flagship\/install-blob\.json/);
  if (!m) throw new Error("install-blob late_command not found in preseed");
  return JSON.parse(Buffer.from(m[1]!, "base64").toString("utf8"));
}

/** Decode the embedded first-boot bootstrap script out of the late_command. */
function extractBootstrap(cfg: string): string {
  const m = cfg.match(
    /echo '([A-Za-z0-9+/=]+)' \| base64 -d > \/target\/usr\/local\/sbin\/flagship-bootstrap\.sh/,
  );
  if (!m) throw new Error("bootstrap late_command not found in preseed");
  return Buffer.from(m[1]!, "base64").toString("utf8");
}

describe("buildDebianPreseed — embedded recipe (same contract as Ubuntu)", () => {
  it("is a d-i preseed (not cloud-config)", () => {
    const { blob, blobSignatureHex } = signedBlob();
    const cfg = buildDebianPreseed({ blob, blobSignatureHex });
    expect(cfg.startsWith("# Flagship Burner — debian-installer preseed")).toBe(true);
    expect(cfg).toContain("d-i debian-installer/locale string");
    expect(cfg).not.toContain("#cloud-config");
    expect(cfg).not.toContain("autoinstall:");
  });

  it("embeds an auth-code with every field canonicalAuthCode needs", () => {
    const { blob, blobSignatureHex } = signedBlob();
    const e = extractEmbeddedBlob(buildDebianPreseed({ blob, blobSignatureHex }));
    for (const f of [
      "version", "serial", "username", "serverName", "serverDomain",
      "delegatedPubKey", "userPubKey", "issuedAt", "expiresAt",
    ]) {
      expect(e.authCode[f], `authCode.${f} must be embedded`).toBeDefined();
    }
  });

  it("embedded auth-code signature verifies — exactly the .com register check", () => {
    const { blob, blobSignatureHex } = signedBlob();
    const e = extractEmbeddedBlob(buildDebianPreseed({ blob, blobSignatureHex }));
    const reconstructed: AuthCode = {
      version: e.authCode.version,
      serial: e.authCode.serial,
      username: e.authCode.username,
      serverName: e.authCode.serverName,
      serverDomain: e.authCode.serverDomain,
      delegatedPubKey: unhex(e.authCode.delegatedPubKey),
      userPubKey: unhex(e.authCode.userPubKey),
      issuedAt: e.authCode.issuedAt,
      expiresAt: e.authCode.expiresAt,
    };
    expect(
      verifyAuthCode(reconstructed, unhex(e.authCodeUserSignature), unhex(e.authCode.userPubKey)),
    ).toBe(true);
  });

  it("embeds blobSignatureHex so the daemon can forward the blob signature", () => {
    const { blob, blobSignatureHex } = signedBlob();
    expect(extractEmbeddedBlob(buildDebianPreseed({ blob, blobSignatureHex })).blobSignatureHex)
      .toBe(blobSignatureHex);
  });

  it("the embedded blob is byte-identical to the Ubuntu generator's (same recipe)", () => {
    // Both generators embed installBlobToJson(blob, sig) — the daemon must read
    // the SAME bytes whichever installer ran.
    const { blob, blobSignatureHex } = signedBlob();
    const deb = extractEmbeddedBlob(buildDebianPreseed({ blob, blobSignatureHex }));
    // Ubuntu embeds via `echo "<b64>" | base64 -d > /var/flagship/install-blob.json`
    const yaml = buildAutoinstallUserData({ blob, blobSignatureHex });
    const m = yaml.match(/echo "([A-Za-z0-9+/=]+)" \| base64 -d > \/var\/flagship\/install-blob\.json/);
    const ubuntu = JSON.parse(Buffer.from(m![1]!, "base64").toString("utf8"));
    expect(deb).toEqual(ubuntu);
  });
});

describe("buildDebianPreseed — THE NVRAM/removable-path fix (the whole point)", () => {
  function cfg(): string {
    const { blob, blobSignatureHex } = signedBlob();
    return buildDebianPreseed({ blob, blobSignatureHex });
  }

  it("forces GRUB to the EFI removable-media path via BOTH owner keys", () => {
    const c = cfg();
    // The d-i grub-installer question…
    expect(c).toContain("d-i grub-installer/force-efi-extra-removable boolean true");
    // …AND the underlying grub-efi-amd64 package question (belt + suspenders,
    // same intent as the Ubuntu path setting two NVRAM-skip mechanisms).
    expect(c).toContain("grub-efi-amd64 grub2/force_efi_extra_removable boolean true");
    // And don't try to write NVRAM at all (firmware that rejects it aborts).
    expect(c).toContain("d-i grub-installer/update-nvram boolean false");
  });

  it("installs GRUB only for Debian (no other-OS NVRAM probing)", () => {
    const c = cfg();
    expect(c).toContain("d-i grub-installer/only_debian boolean true");
    expect(c).toContain("d-i grub-installer/with_other_os boolean false");
  });
});

describe("buildDebianPreseed — storage (LVM-on-LUKS; ESP + bios_grub + /boot)", () => {
  function cfg(opts: { encryptRoot?: boolean } = {}): string {
    const { blob, blobSignatureHex } = signedBlob();
    return buildDebianPreseed({ blob, blobSignatureHex, ...opts });
  }

  it("default (locked) is the encrypted LVM-on-LUKS layout", () => {
    const c = cfg();
    // partman-crypto's only reliably-preseedable encrypted mode.
    expect(c).toContain("d-i partman-auto/method string crypto");
    // Under method=crypto, partman BUILDS the encrypted LVM itself from a plain
    // recipe. Hand-declaring the LVM (method{ lvm }/vg_name/in_vg/lv_name) made
    // partman abort "No physical volume defined in volume group" (validated in a
    // QEMU d-i run). So the recipe must NOT contain those — root is just an ext4
    // partition marked $lvmok{ }; the VG name comes from new_vg_name.
    expect(c).not.toContain("method{ lvm }");
    expect(c).not.toContain("method{ crypto }");
    expect(c).not.toContain("vg_name{");
    expect(c).not.toContain("in_vg{");
    expect(c).not.toContain("lv_name{");
    expect(c).toContain("$lvmok{ }");
    expect(c).toContain("d-i partman-auto-lvm/new_vg_name string flagship");
    // The burn-time passphrase the bootstrap re-keys away (preseeded so the
    // install is unattended; weak-passphrase warning suppressed).
    expect(c).toContain("d-i partman-crypto/passphrase password flagship-burn-time-luks-rekey-me-immediately");
    expect(c).toContain("d-i partman-crypto/passphrase-again password flagship-burn-time-luks-rekey-me-immediately");
    expect(c).toContain("d-i partman-crypto/weak_passphrase boolean true");
  });

  it("GPT layout: 1M bios_grub + a FAT32 ESP at /boot/efi + ext4 /boot, all labelled like Ubuntu", () => {
    const c = cfg();
    // reserved bios_grub (future BIOS variant) — matches the Ubuntu curtin intent.
    expect(c).toContain("method{ biosgrub }");
    expect(c).toContain("$iflabel{ gpt }");
    // The canonical d-i ESP stanza.
    expect(c).toContain("method{ efi } format{ }");
    // Unencrypted /boot, labelled FLAGSHIP_BOOT, mounted /boot (mirrors Ubuntu).
    expect(c).toContain("label{ FLAGSHIP_BOOT }");
    expect(c).toContain("mountpoint{ /boot }");
    // Encrypted root, labelled FLAGSHIP_ROOT, mounted / (the bootstrap +
    // initramfs hook key off these labels, shared with the Ubuntu path).
    expect(c).toContain("label{ FLAGSHIP_ROOT }");
    expect(c).toContain("mountpoint{ / }");
  });

  it("makes every destructive partman step unattended", () => {
    const c = cfg();
    for (const k of [
      "d-i partman-partitioning/confirm_write_new_label boolean true",
      "d-i partman/confirm boolean true",
      "d-i partman/confirm_nooverwrite boolean true",
      "d-i partman-lvm/confirm boolean true",
      "d-i partman-crypto/confirm boolean true",
    ]) {
      expect(c, k).toContain(k);
    }
  });

  it("encryptRoot:false is the debug escape — plain regular layout, NO crypto", () => {
    const c = cfg({ encryptRoot: false });
    expect(c).toContain("d-i partman-auto/method string regular");
    expect(c).not.toContain("method{ crypto }");
    expect(c).not.toContain("partman-crypto/passphrase");
    expect(c).not.toContain("vg_name{ flagship }");
    // …but STILL an ESP + /boot + labelled root (so the removable-path GRUB and
    // the daemon setup are exercised against a known-good non-LUKS baseline).
    expect(c).toContain("method{ efi } format{ }");
    expect(c).toContain("label{ FLAGSHIP_ROOT }");
    // The NVRAM/removable fix is independent of LUKS — present either way.
    expect(c).toContain("d-i grub-installer/force-efi-extra-removable boolean true");
  });
});

describe("buildDebianPreseed — first-boot bootstrap (reused verbatim from Ubuntu)", () => {
  function bootstrap(opts: { encryptRoot?: boolean } = {}): string {
    const { blob, blobSignatureHex } = signedBlob();
    return extractBootstrap(buildDebianPreseed({ blob, blobSignatureHex, ...opts }));
  }

  it("runs the bootstrap from preseed/late_command in the target", () => {
    const { blob, blobSignatureHex } = signedBlob();
    const c = buildDebianPreseed({ blob, blobSignatureHex });
    expect(c).toContain("d-i preseed/late_command string");
    // d-i in-target == curtin in-target; the bootstrap runs inside /target.
    expect(c).toContain("in-target /usr/local/sbin/flagship-bootstrap.sh");
    expect(c).toContain("/target/var/flagship/install-blob.json");
    expect(c).toContain("/target/usr/local/sbin/flagship-bootstrap.sh");
  });

  it("is the SAME daemon setup as Ubuntu (env, self-signed entitlements, units)", () => {
    const b = bootstrap();
    expect(b).toContain("cat > /etc/flagship/daemon.env");
    expect(b).toContain("FLAGSHIP_SUBDOMAIN=$SERVER_DOMAIN");
    expect(b).toContain("install-helper.ts mint-entitlements");
    expect(b).toContain("INTERIM SELF-SIGN");
    expect(b).toContain("ExecStart=/usr/bin/npm run start --workspace=@flagship/server-daemon");
    expect(b).toContain("systemctl enable flagship-daemon.service flagship-first-boot-register.service");
    // Node 20 from NodeSource — reused verbatim, the whole reason we don't rely
    // on Debian's archived nodejs.
    expect(b).toContain("https://deb.nodesource.com/setup_20.x");
  });

  it("the bootstrap is byte-identical to the Ubuntu generator's EXCEPT the LUKS unlock", () => {
    // The plain (unencrypted) bootstrap is shared verbatim — prove it by
    // comparing the debug-escape path to the Ubuntu debug-escape path.
    const { blob, blobSignatureHex } = signedBlob();
    const debPlain = extractBootstrap(buildDebianPreseed({ blob, blobSignatureHex, encryptRoot: false }));
    const ubuntuYaml = buildAutoinstallUserData({ blob, blobSignatureHex, encryptRoot: false });
    const m = ubuntuYaml.match(/echo "([A-Za-z0-9+/=]+)" \| base64 -d > \/usr\/local\/sbin\/flagship-bootstrap\.sh/);
    const ubuntuPlain = Buffer.from(m![1]!, "base64").toString("utf8");
    expect(debPlain).toBe(ubuntuPlain);
  });

  it("the encrypted bootstrap re-keys + seals + adds an LVM-aware initramfs unlock", () => {
    const b = bootstrap();
    // Re-key + seal + upload (install.sh pattern) — shared with Ubuntu.
    expect(b).toContain("encryptRoot ON");
    expect(b).toContain('head -c 64 /dev/urandom > "$LUKS_KEY"');
    expect(b).toContain("install-helper.ts seal-for-bak");
    expect(b).toContain("/sealed-luks-key");
    // The relay/box-lease functions are lifted verbatim (boot worker contract).
    expect(b).toContain("unlock_via_relay()");
    expect(b).toContain("unlock_via_box_lease()");
    expect(b).toContain("flagship/boot-auth/v1|box|");
    expect(b).toContain('REQ_PATH="/api/boot/request"');
    // LVM-on-LUKS specifics (Debian only): stage lvm, vgchange after luksOpen,
    // discover the raw LUKS partition by TYPE (label is inside the container).
    expect(b).toContain("copy_exec /sbin/lvm /sbin/lvm");
    expect(b).toContain("vgchange -ay");
    expect(b).toContain('blkid -t TYPE=crypto_LUKS -o device | head -n1');
    // The retired plaintext-consume path stays retired.
    expect(b).not.toContain("unlock_via_plaintext_consume");
    expect(b).not.toContain("flagship/consume-unlock-key/v1|");
  });

  it("bakes the boot host + boot-unlock mode, override-capable (same as Ubuntu)", () => {
    const b = bootstrap();
    expect(b).toContain('echo "https://boot.flagshipserver.com" > /boot/flagship-boot-host');
    expect(b).toContain('echo "auto" > /boot/flagship-boot-unlock-mode');
    expect(DEFAULT_BOOT_HOST).toBe("https://boot.flagshipserver.com");
  });

  it("approve mode bakes approve + relay-only dispatch", () => {
    const { blob, blobSignatureHex } = signedBlob();
    const b = extractBootstrap(
      buildDebianPreseed({ blob: { ...blob, bootUnlockMode: "approve" }, blobSignatureHex }),
    );
    expect(b).toContain('echo "approve" > /boot/flagship-boot-unlock-mode');
    expect(b).toContain('if [ "$BOOT_UNLOCK_MODE" = "approve" ]; then');
  });
});

describe("buildDebianPreseed — optional Wi-Fi (burn-time local input)", () => {
  function cfg(opts: { wifiSSID?: string; wifiPassword?: string }): string {
    const { blob, blobSignatureHex } = signedBlob();
    return buildDebianPreseed({ blob, blobSignatureHex, ...opts });
  }

  it("absent Wi-Fi === byte-identical to no Wi-Fi (no netcfg wireless, no wpasupplicant)", () => {
    const { blob, blobSignatureHex } = signedBlob();
    const none = buildDebianPreseed({ blob, blobSignatureHex });
    const empty = buildDebianPreseed({ blob, blobSignatureHex, wifiSSID: "" });
    const ws = buildDebianPreseed({ blob, blobSignatureHex, wifiSSID: "   " });
    expect(empty).toBe(none);
    expect(ws).toBe(none);
    expect(none).not.toContain("netcfg/wireless_essid");
    expect(none).not.toContain("wpasupplicant");
  });

  it("an SSID drives BOTH install-time netcfg AND the runtime-detected netplan", () => {
    const c = cfg({ wifiSSID: "HomeNet", wifiPassword: "s3cret" });
    // Install-time: d-i netcfg keys wireless by ESSID (unlike networkd).
    expect(c).toContain("d-i netcfg/wireless_essid string HomeNet");
    expect(c).toContain("d-i netcfg/wireless_security_type select wpa");
    expect(c).toContain("d-i netcfg/wireless_wpa string s3cret");
    // Installed system gets wpasupplicant + the runtime script (late_command).
    expect(c).toContain("wpasupplicant");
    expect(c).toContain("/target/tmp/flagship-wifi.sh");
  });

  /** Decode the base64 Wi-Fi script out of the late_command. */
  function extractWifiScript(c: string): string {
    const m = c.match(/echo '([A-Za-z0-9+/=]+)' \| base64 -d > \/target\/tmp\/flagship-wifi\.sh/);
    if (!m) throw new Error("wifi setup command not found in preseed");
    return Buffer.from(m[1]!, "base64").toString("utf8");
  }

  it("the runtime Wi-Fi script is BYTE-IDENTICAL to the Ubuntu/Swift twin (same sha256 pin)", () => {
    // The Ubuntu generator + the Swift burner pin this SAME hash. The installed
    // system must get the identical name-keyed netplan whichever installer ran.
    const c = cfg({ wifiSSID: "Flagship Test AP", wifiPassword: "test-only-not-real" });
    const s = extractWifiScript(c);
    expect(createHash("sha256").update(s).digest("hex")).toBe(
      "f215b57a79ae7f12cd6b372dd7631842a8f6dafbdc1beca7b6f3588535c770b9",
    );
  });

  it("runs the Wi-Fi script CHROOTED with no ROOT arg (in-target /==target; avoids /target/target)", () => {
    const c = cfg({ wifiSSID: "HomeNet", wifiPassword: "s3cret" });
    // It writes the script under /target then runs it IN the chroot with no arg,
    // so the script's ROOT is "" — its / already IS the target. Passing /target
    // would double up to /target/target (the bug this guards against).
    expect(c).toContain("in-target bash /tmp/flagship-wifi.sh;");
    expect(c).not.toContain("in-target bash /tmp/flagship-wifi.sh /target");
  });

  it("the Debian bootstrap carries the SAME first-boot Wi-Fi safety-net as Ubuntu", () => {
    const { blob, blobSignatureHex } = signedBlob();
    const b = extractBootstrap(
      buildDebianPreseed({ blob, blobSignatureHex, wifiSSID: "HomeNet", wifiPassword: "s3cret" }),
    );
    expect(b).toContain("/usr/local/sbin/flagship-wifi-safetynet.sh");
    expect(b).toContain("systemctl enable flagship-wifi-safetynet.service");
    expect(b).toContain("FLAGSHIP_WIFI_SSID_B64=");
    expect(b).not.toContain("HomeNet"); // creds are base64, never plaintext
    // and wpasupplicant is on the bootstrap apt line on the Wi-Fi path.
    expect(b).toMatch(/apt-get install .*wpasupplicant/);
  });

  it("a wired Debian bootstrap is unchanged — no safety-net, no wpasupplicant apt addition", () => {
    const { blob, blobSignatureHex } = signedBlob();
    const b = extractBootstrap(buildDebianPreseed({ blob, blobSignatureHex }));
    expect(b).not.toContain("flagship-wifi-safetynet");
    expect(b).not.toMatch(/apt-get install .*wpasupplicant/);
  });
});

describe("buildDebianPreseed — input validation (parity with the Ubuntu generator)", () => {
  it("rejects an unsafe git ref", () => {
    const { blob, blobSignatureHex } = signedBlob();
    expect(() =>
      buildDebianPreseed({ blob, blobSignatureHex, installerGitRef: "main; rm -rf /" }),
    ).toThrow(/unsafe git ref/);
  });
  it("rejects a non-https boot host", () => {
    const { blob, blobSignatureHex } = signedBlob();
    expect(() =>
      buildDebianPreseed({ blob, blobSignatureHex, bootHost: "http://insecure.example" }),
    ).toThrow(/bootHost must be https/);
  });
});
