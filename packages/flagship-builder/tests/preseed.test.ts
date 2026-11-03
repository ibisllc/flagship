/**
 * Builder: Debian d-i preseed.cfg generation.
 *
 * The Debian path exists for ONE reason — UEFI firmware that rejects NVRAM
 * boot-entry writes, which d-i can preseed around by forcing GRUB to the EFI
 * removable-media path. These tests
 * pin that key + the rest of the unattended contract (LUKS/ESP/bios_grub
 * layout, the shared first-boot bootstrap via late_command, Wi-Fi), and assert
 * the embedded recipe round-trips.
 */
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync, chmodSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  signAuthCode,
  signInstallBlob,
  verifyAuthCode,
  ed,
  type AuthCode,
  type InstallBlob,
} from "@flagship/protocol";
import { assertPreseedCommandsFit, buildDebianPreseed, PRESEED_COMMAND_MAX_BYTES, replacePreseedBootstrap } from "../src/preseed.js";
import { DEFAULT_BOOT_HOST } from "../src/userdata.js";

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
    installerGitRef: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    rckPubKey: rck.publicKey,
  };
  return { blob, blobSignatureHex: hx(signInstallBlob(blob, irk)) };
}

/** Pull the install-blob.json base64 out of the late_command. */
function extractEmbeddedBlob(cfg: string): Record<string, any> {
  const m = cfg.match(/^d-i flagship\/install-blob string ([A-Za-z0-9+/=]+)$/m);
  if (!m) throw new Error("install-blob late_command not found in preseed");
  return JSON.parse(Buffer.from(m[1]!, "base64").toString("utf8"));
}

/** Decode the embedded first-boot bootstrap script out of the late_command. */
function extractBootstrap(cfg: string): string {
  const m = cfg.match(/^d-i flagship\/bootstrap string ([A-Za-z0-9+/=]+)$/m);
  if (!m) throw new Error("bootstrap late_command not found in preseed");
  return Buffer.from(m[1]!, "base64").toString("utf8");
}

describe("buildDebianPreseed — embedded recipe ", () => {
  it("is a d-i preseed (not cloud-config)", () => {
    const { blob, blobSignatureHex } = signedBlob();
    const cfg = buildDebianPreseed({ blob, blobSignatureHex });
    expect(cfg.startsWith("# Flagship Studio — debian-installer preseed")).toBe(true);
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
    // two NVRAM-skip mechanisms).
    expect(c).toContain("grub-efi-amd64 grub2/force_efi_extra_removable boolean true");
    // And don't try to write NVRAM at all (firmware that rejects it aborts).
    expect(c).toContain("d-i grub-installer/update-nvram boolean false");
  });

  it("installs GRUB only for Debian (no other-OS NVRAM probing)", () => {
    const c = cfg();
    expect(c).toContain("d-i grub-installer/only_debian boolean true");
    expect(c).toContain("d-i grub-installer/with_other_os boolean false");
  });

  it("installs GRUB to the same resolved fixed disk as partman, not the USB installer", () => {
    const c = cfg();
    const resolve = c.indexOf("for _d in $(list-devices disk)");
    const partman = c.indexOf('debconf-set partman-auto/disk "$DISK"');
    const grub = c.indexOf('debconf-set grub-installer/bootdev "$DISK"');
    const wipe = c.indexOf("dmsetup remove_all");

    expect(resolve).toBeGreaterThanOrEqual(0);
    expect(resolve).toBeLessThan(partman);
    expect(partman).toBeLessThan(grub);
    expect(grub).toBeLessThan(wipe);
  });
});

describe("buildDebianPreseed — storage (LVM-on-LUKS; ESP + bios_grub + /boot)", () => {
  function cfg(opts: { encryptRoot?: boolean; targetDisk?: string } = {}): string {
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
    // No passphrase (and no constant) is written into the preseed.
    expect(c).not.toMatch(/partman-crypto\/passphrase(-again)? password/);
    expect(c).not.toContain("flagship-build-time-luks");
    expect(c).toContain("d-i partman-crypto/weak_passphrase boolean true");
  });

  it("generates the install-time LUKS passphrase INSIDE the installer and feeds partman-crypto", () => {
    const c = cfg();
    const early = c.slice(c.indexOf("d-i partman/early_command"), c.indexOf("d-i partman-lvm/device_remove_lvm"));
    // 48 random alphanumerics from the kernel CSPRNG, length-checked, 0600.
    expect(early).toContain("BURN=$(tr -dc A-Za-z0-9 </dev/urandom | head -c 48)");
    expect(early).toContain('[ "${#BURN}" -eq 48 ] || exit 1');
    expect(early).toContain("( umask 077; printf '%s' \"$BURN\" > /tmp/flagship-luks-burn )");
    expect(early).toContain('debconf-set partman-crypto/passphrase "$BURN"');
    expect(early).toContain('debconf-set partman-crypto/passphrase-again "$BURN"');
    // Marked seen, or partman-crypto still prompts for it.
    expect(early).toContain("d-i partman-crypto/passphrase seen true");
    expect(early).toContain("d-i partman-crypto/passphrase-again seen true");
    expect(early).toContain("debconf-set-selections /tmp/flagship-luks-seen");
    // It is generated before the wipe and the partitioning.
    expect(early.indexOf("BURN=$(")).toBeLessThan(early.indexOf("dmsetup remove_all"));
  });

  it("late_command copies the generated key onto the target BEFORE the bootstrap, then forgets it", () => {
    const c = cfg();
    const late = c.slice(c.indexOf("d-i preseed/late_command"));
    const cp = late.indexOf("cp /tmp/flagship-luks-burn /target/var/flagship/luks-burn.key");
    expect(cp).toBeGreaterThan(0);
    expect(late).toContain("chmod 600 /target/var/flagship/luks-burn.key");
    expect(cp).toBeLessThan(late.indexOf("in-target /usr/local/sbin/flagship-bootstrap.sh"));
    expect(late.indexOf("rm -f /tmp/flagship-luks-burn")).toBeGreaterThan(late.indexOf("flagship-bootstrap.log 2>&1 ) &&"));
  });

  it("the unencrypted layout and a debug image generate no passphrase", () => {
    const { blob, blobSignatureHex } = signedBlob();
    for (const o of [{ encryptRoot: false }, { debugSshAuthorizedKey: "ssh-ed25519 AAAA dev@x" }]) {
      const c = buildDebianPreseed({ blob, blobSignatureHex, ...o });
      expect(c).toContain("d-i partman-auto/method string regular");
      expect(c).not.toContain("flagship-luks-burn");
      expect(c).not.toContain("partman-crypto/passphrase");
    }
  });

  it("GPT layout: 1M bios_grub + a FAT32 ESP at /boot/efi + ext4 /boot, all labelled for boot-stage", () => {
    const c = cfg();
    // reserved bios_grub (future BIOS variant).
    expect(c).toContain("method{ biosgrub }");
    expect(c).toContain("$iflabel{ gpt }");
    // The canonical d-i ESP stanza.
    expect(c).toContain("method{ efi } format{ }");
    // Unencrypted /boot, labelled FLAGSHIP_BOOT, mounted /boot.
    expect(c).toContain("label{ FLAGSHIP_BOOT }");
    expect(c).toContain("mountpoint{ /boot }");
    // Encrypted root, labelled FLAGSHIP_ROOT, mounted / (the bootstrap +
    // initramfs hook key off these labels).
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

  // The unconditional disk-wipe + overwrite-confirm flags that stop a prior
  // install's stale LUKS/LVM/GPT from blocking the auto-partitioner. These must
  // hold in BOTH storage variants; the literals match EngineTests.swift.
  it("partman/early_command unconditionally wipes the target disk (both variants)", () => {
    for (const encryptRoot of [true, false]) {
      const c = cfg({ encryptRoot });
      // The wipe runs from partman/early_command after DISK is resolved.
      expect(c, `encryptRoot=${encryptRoot}`).toContain("d-i partman/early_command string");
      // DISK is chosen by the disk-choice loop (behaviour pinned in "the target disk" below); the
      // first-enumerated pick is gone, not even as a fallback.
      expect(c).toContain("for _d in $(list-devices disk); do");
      expect(c.indexOf("for _d in $(list-devices disk)")).toBeLessThan(c.indexOf('debconf-set partman-auto/disk "$DISK"'));
      expect(c).not.toContain("list-devices disk | head -n1");
      expect(c).toContain('debconf-set partman-auto/disk "$DISK"');
      expect(c).toContain('debconf-set grub-installer/bootdev "$DISK"');
      // dmsetup clears stale mappings; dd zeroes the front GPT; rereadpt re-reads.
      expect(c).toContain("dmsetup remove_all 2>/dev/null || true");
      expect(c).toContain('dd if=/dev/zero of="$DISK" bs=1M count=16 2>/dev/null || true');
      // …and the backup GPT header at the disk tail.
      expect(c).toContain('SZ=$(blockdev --getsz "$DISK" 2>/dev/null || echo 0)');
      expect(c).toContain('dd if=/dev/zero of="$DISK" bs=512 seek=$((SZ-8192)) count=8192 2>/dev/null || true');
      expect(c).toContain('blockdev --rereadpt "$DISK" 2>/dev/null || true');
    }
  });

  it("the partman/early_command beacon fires the 'partitioning' phase before the wipe (both variants)", () => {
    for (const encryptRoot of [true, false]) {
      const c = cfg({ encryptRoot });
      expect(c, `encryptRoot=${encryptRoot}`).toContain('"phase":"partitioning"');
      // Beacon BEFORE the wipe so the phone hears from the box even if the wipe/
      // partition later fails.
      expect(c.indexOf('"phase":"partitioning"')).toBeLessThan(c.indexOf("dmsetup remove_all"));
    }
  });

  it("both variants carry the LVM + crypto overwrite-confirm flags", () => {
    for (const encryptRoot of [true, false]) {
      const c = cfg({ encryptRoot });
      for (const k of [
        "d-i partman-lvm/confirm boolean true",
        "d-i partman-lvm/confirm_nooverwrite boolean true",
        "d-i partman-crypto/confirm boolean true",
        "d-i partman-crypto/confirm_nooverwrite boolean true",
        "d-i partman/confirm_nooverwrite boolean true",
      ]) {
        expect(c, `encryptRoot=${encryptRoot}: ${k}`).toContain(k);
      }
    }
  });
});

describe("buildDebianPreseed — first-boot bootstrap ", () => {
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

  // d-i execs each preseeded command as ONE argument (and logs it through
  // logger); Linux refuses arguments over 128 KiB and d-i then skips the
  // late_command silently and powers off "installed" with a disk nobody can
  // unlock (home.serene-parrot, 2026-11-02: Wi-Fi took it to ~134 KB).
  it("keeps every preseeded command far under d-i's 128 KiB argument limit, Wi-Fi and debug grant included", () => {
    const { blob, blobSignatureHex } = signedBlob();
    const variants = [
      {},
      { wifiSSID: "A".repeat(32), wifiPassword: "p".repeat(63) },
      { encryptRoot: false, wifiSSID: "HomeNet", wifiPassword: "s3cret" },
      { debugSshAuthorizedKey: "ssh-ed25519 AAAA dev@x" },
    ];
    for (const v of variants) {
      const c = buildDebianPreseed({ blob, blobSignatureHex, ...v });
      for (const line of c.replace(/\\\n/g, " ").split("\n")) {
        const m = /^d-i (preseed\/early_command|partman\/early_command|preseed\/late_command) string (.*)$/.exec(line);
        if (m) expect(m[2]!.length, m[1]).toBeLessThan(PRESEED_COMMAND_MAX_BYTES);
      }
      const late = c.slice(c.indexOf("d-i preseed/late_command"));
      expect(late).not.toMatch(/[A-Za-z0-9+/=]{2048}/);
    }
  });

  it("reads the payloads back with debconf-get, checks their length and holds when one is cut", () => {
    const c = buildDebianPreseed({ ...signedBlob(), wifiSSID: "HomeNet", wifiPassword: "s3cret" });
    const late = c.slice(c.indexOf("d-i preseed/late_command"));
    const boot = extractBootstrap(c);
    expect(late).toContain(`debconf-get flagship/bootstrap | base64 -d > /target/usr/local/sbin/flagship-bootstrap.sh && [ "$(wc -c < /target/usr/local/sbin/flagship-bootstrap.sh)" -eq ${Buffer.byteLength(boot)} ]`);
    expect(late).toContain(`[ "$(wc -c < /target/var/flagship/install-blob.json)" -eq ${Buffer.byteLength(JSON.stringify(extractEmbeddedBlob(c)))} ]`);
    expect(late).toContain("debconf-get flagship/wifi-setup | base64 -d > /target/tmp/flagship-wifi.sh");
    // A cut payload writes a FATAL line and lands in the hold, never the poweroff.
    expect(late).toMatch(/FATAL: the install payload did not arrive whole' > \/target\/var\/log\/flagship-bootstrap\.log; false; \}; \} && \( in-target \/usr\/local\/sbin\/flagship-bootstrap\.sh/);
    // The payload answers come before the late_command that reads them.
    expect(c.indexOf("d-i flagship/bootstrap string")).toBeLessThan(c.indexOf("d-i preseed/late_command"));
  });

  it("refuses a preseed whose command would cross the limit", () => {
    const big = "x".repeat(PRESEED_COMMAND_MAX_BYTES + 1);
    expect(() => assertPreseedCommandsFit(`d-i preseed/late_command string ${big}\n`)).toThrow(/late_command/);
    expect(() => assertPreseedCommandsFit(`d-i partman/early_command string a \\\n${big}\n`)).toThrow(/early_command/);
    expect(() => assertPreseedCommandsFit(`d-i flagship/bootstrap string ${big}\n`)).not.toThrow();
  });

  it("replacePreseedBootstrap swaps the payload and its length check together", () => {
    const c = replacePreseedBootstrap(buildDebianPreseed(signedBlob()), "#!/bin/bash\necho hi\n");
    expect(extractBootstrap(c)).toBe("#!/bin/bash\necho hi\n");
    expect(c).toContain(`flagship-bootstrap.sh)" -eq 20 ]`);
  });

  it("sets up the daemon (env, relay-fetched entitlements, units)", () => {
    const b = bootstrap();
    expect(b).toContain("cat > /etc/flagship/daemon.env");
    expect(b).toContain("FLAGSHIP_SUBDOMAIN=$SERVER_DOMAIN");
    expect(b).not.toContain("install-helper.ts mint-entitlements");
    expect(b).toContain("fetch an IRK-signed entitlement from the phone");
    expect(b).toContain("ExecStart=/usr/local/bin/node --disable-warning=ExperimentalWarning packages/server-daemon/dist/index.js");
    expect(b).toContain("systemctl enable flagship-daemon.service flagship-first-boot-register.service");
    // Node ships inside the signed release: no NodeSource repository on the box.
    expect(b).not.toContain("deb.nodesource.com");
  });

  it("the encrypted bootstrap re-keys + seals + adds an LVM-aware initramfs unlock", () => {
    const b = bootstrap();
    // Re-key + seal + upload (install.sh pattern).
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

  it("bakes the boot host + boot-unlock mode, override-capable", () => {
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
    expect(b).toContain('if [ "$EFFECTIVE_MODE" = "auto" ] && unlock_via_box_lease; then');
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
    const m = c.match(/^d-i flagship\/wifi-setup string ([A-Za-z0-9+/=]+)$/m);
    if (!m) throw new Error("wifi setup command not found in preseed");
    return Buffer.from(m[1]!, "base64").toString("utf8");
  }

  it("the runtime Wi-Fi script is BYTE-IDENTICAL across the builders (same sha256 pin)", () => {
    // The Swift builder pins this SAME hash. The installed system must get the
    // identical name-keyed config whichever builder ran.
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

  it("the Debian bootstrap carries the first-boot Wi-Fi safety-net", () => {
    const { blob, blobSignatureHex } = signedBlob();
    const b = extractBootstrap(
      buildDebianPreseed({ blob, blobSignatureHex, wifiSSID: "HomeNet", wifiPassword: "s3cret" }),
    );
    expect(b).toContain("/usr/local/sbin/flagship-wifi-safetynet.sh");
    expect(b).toContain("systemctl enable flagship-wifi-safetynet.service");
    expect(b).toContain("FLAGSHIP_WIFI_SSID_B64=");
    // The SAFETY-NET block keeps creds base64 (never plaintext). Scope the check
    // to that block — the separate initramfs Wi-Fi premount embeds escaped
    // plaintext on purpose (it's on the unencrypted /boot regardless).
    const snStart = b.indexOf("First-boot Wi-Fi safety-net");
    const snEnd = b.indexOf("Wi-Fi safety-net installed + enabled");
    const safetyNet = b.slice(snStart, snEnd);
    expect(safetyNet).not.toContain("HomeNet"); // creds are base64, never plaintext
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

describe("buildDebianPreseed — phone-home beacons (earliest progress to the phone)", () => {
  function cfg(): string {
    const { blob, blobSignatureHex } = signedBlob();
    return buildDebianPreseed({ blob, blobSignatureHex });
  }

  // The EXACT beacon command strings. ONE canonical channel: each posts a
  // ProvisionStatusPhase to POST /api/order/<serial>/status. These literals are
  // byte-identical to the Swift twin's (EngineTests.swift) — keep both in
  // lockstep. The serial sits in the URL; no secrets. busybox wget --post-file=
  // (no curl in mini.iso d-i).
  const EARLY_BEACON =
    `( echo '{"phase":"booting"}' > /tmp/flagship-beacon.json; ` +
    `wget -q -O- --post-file=/tmp/flagship-beacon.json --timeout=15 ` +
    `https://flagshipserver.com/api/order/01TESTABCDEF/status ) || true`;
  const LATE_BEACON =
    `( echo '{"phase":"downloading"}' > /tmp/flagship-beacon.json; ` +
    `wget -q -O- --post-file=/tmp/flagship-beacon.json --timeout=15 ` +
    `https://flagshipserver.com/api/order/01TESTABCDEF/status ) || true`;
  // Beacon C — fired from partman/early_command (network up by partman), before
  // the unconditional disk wipe. Byte-identical to EngineTests.swift.
  const PARTITION_BEACON =
    `( echo '{"phase":"partitioning"}' > /tmp/flagship-beacon.json; ` +
    `wget -q -O- --post-file=/tmp/flagship-beacon.json --timeout=15 ` +
    `https://flagshipserver.com/api/order/01TESTABCDEF/status ) || true`;
  // Beacon D — fired at the END of late_command, AFTER the bootstrap SUCCEEDS,
  // BEFORE poweroff. NOT success: the box has not registered yet. Byte-identical
  // to EngineTests.swift.
  const INSTALLED_BEACON =
    `( echo '{"phase":"installed"}' > /tmp/flagship-beacon.json; ` +
    `wget -q -O- --post-file=/tmp/flagship-beacon.json --timeout=15 ` +
    `https://flagshipserver.com/api/order/01TESTABCDEF/status ) || true`;

  it("Beacon A — early_command POSTs the booting phase before partman (best-effort)", () => {
    const c = cfg();
    expect(c).toContain(`d-i preseed/early_command string ${EARLY_BEACON}`);
    // The earliest hook fires BEFORE the partman disk-selection early_command.
    expect(c.indexOf("preseed/early_command")).toBeLessThan(c.indexOf("partman/early_command"));
  });

  it("Beacon B — late_command POSTs the downloading phase FIRST, before the blob-decode", () => {
    const c = cfg();
    expect(c).toContain(
      `${LATE_BEACON}; mkdir -p /target/var/flagship;`,
    );
    expect(c.indexOf(LATE_BEACON)).toBeLessThan(
      c.indexOf("mkdir -p /target/var/flagship"),
    );
  });

  it("late_command drops the cdrom apt source before the bootstrap's first apt-get", () => {
    const c = cfg();
    const sedAt = c.indexOf("sed -i '/^deb cdrom:/d' /target/etc/apt/sources.list");
    expect(sedAt).toBeGreaterThan(0);
    expect(sedAt).toBeLessThan(c.indexOf("in-target /usr/local/sbin/flagship-bootstrap.sh"));
  });

  it("Beacon C — partman/early_command POSTs the partitioning phase right before the wipe", () => {
    const c = cfg();
    expect(c).toContain(`${PARTITION_BEACON}; \\`);
  });

  function extractInstallerTelemetry(c: string): string {
    const match = c.match(
      /echo '([A-Za-z0-9+/=]+)' \| base64 -d > \/tmp\/flagship-installer-telemetry\.sh/,
    );
    if (!match) throw new Error("base-installer telemetry drop not found");
    return Buffer.from(match[1]!, "base64").toString("utf8");
  }

  function extractInstallerTelemetryLauncher(c: string): string {
    const match = c.match(
      /echo '([A-Za-z0-9+/=]+)' \| base64 -d > \/usr\/lib\/base-installer\.d\/05flagship-beacon/,
    );
    if (!match) throw new Error("base-installer telemetry launcher not found");
    return Buffer.from(match[1]!, "base64").toString("utf8");
  }

  it("Beacon E — partman/early_command drops the base-installer.d 'installing' beacon script (both variants)", () => {
    const { blob, blobSignatureHex } = signedBlob();
    for (const encryptRoot of [true, false]) {
      const c = buildDebianPreseed({ blob, blobSignatureHex, encryptRoot });
      const telemetry = extractInstallerTelemetry(c);
      const launcher = extractInstallerTelemetryLauncher(c);
      expect(telemetry).toContain('"phase":"installing"');
      expect(telemetry).toContain("/api/order/01TESTABCDEF/status");
      // Ordering inside the early_command: partitioning beacon → wipe → dropper.
      const partAt = c.indexOf('"phase":"partitioning"');
      const wipeAt = c.indexOf("dmsetup remove_all");
      const dropAt = c.indexOf("/usr/lib/base-installer.d");
      expect(partAt).toBeGreaterThan(0);
      expect(wipeAt).toBeGreaterThan(partAt);
      expect(dropAt).toBeGreaterThan(wipeAt);
      // A detached launcher owns the backgrounding so d-i cannot reap the
      // watcher when this run-parts hook returns.
      expect(launcher).toContain("setsid /bin/sh /tmp/flagship-installer-telemetry.sh");
      expect(launcher).toContain("trap '' HUP");
      expect(launcher).toContain("echo $! > /tmp/flagship-installer-telemetry.pid");
      expect(launcher).toContain("exit 0");
    }
  });

  it("reports allowlisted d-i stages and a two-minute heartbeat without uploading raw logs", () => {
    const telemetry = extractInstallerTelemetry(cfg());
    for (const detail of [
      "Installing Debian base system",
      "Downloading Debian base packages",
      "Verifying Debian base packages",
      "Extracting the Debian base system",
      "Unpacking the Debian base system",
      "Configuring the Debian base system",
      "Configuring the Debian package source",
      "Installing system packages",
      "Installing the bootloader",
      "Finishing the operating-system install",
    ]) {
      expect(telemetry).toContain(detail);
    }
    expect(telemetry).toContain("-ge 120");
    expect(telemetry).toContain('"detail":"%s (%s min)"');
    expect(telemetry).toContain("grep -q");
    expect(telemetry).not.toContain("--post-file=/var/log/syslog");
    expect(telemetry).not.toContain("/api/dev/late-log/");
  });

  it("stops installer telemetry before advancing to downloading", () => {
    const c = cfg();
    const stopAt = c.indexOf("touch /tmp/flagship-installer-telemetry.done");
    const downloadingAt = c.indexOf('"phase":"downloading"');
    expect(stopAt).toBeGreaterThan(0);
    expect(downloadingAt).toBeGreaterThan(stopAt);
    expect(c).toContain('kill "$(cat /tmp/flagship-installer-telemetry.pid)"');
    expect(c).toContain("telemetry.pid)\" 2>/dev/null || true; fi; sleep 1;");
  });

  it("Beacon D — late_command POSTs 'installed' on the bootstrap SUCCESS path only, before poweroff", () => {
    const c = cfg();
    // The success path: bootstrap `&&` the installed beacon, THEN `||` the
    // failure hold (it prints why on the console and never powers off).
    expect(c).toContain(
      `( in-target /usr/local/sbin/flagship-bootstrap.sh > /target/var/log/flagship-bootstrap.log 2>&1 ) && ` +
        `rm -f /tmp/flagship-luks-burn && ( ${INSTALLED_BEACON} ) || ( grep -E 'FATAL|ERROR'`,
    );
    const failure = c.slice(c.lastIndexOf("|| ( grep -E 'FATAL|ERROR'"));
    expect(failure).toContain("FLAGSHIP INSTALL FAILED");
    expect(failure).toContain("while :; do sleep 3600; done )");
    expect(failure).not.toContain("exit 1");
    // Nothing between the bootstrap and the hold may succeed on its own: the
    // beacon's `|| true` must sit inside a group, or a failed bootstrap falls
    // through `A && B || true || hold` and the install looks finished.
    const chain = c.slice(c.indexOf("flagship-bootstrap.log 2>&1 ) &&"), c.lastIndexOf("|| ( grep -E"));
    expect(chain.replace(/\( echo '\{"phase":"installed"\}'[^)]*\) \|\| true/, "BEACON")).not.toMatch(/\|\| true\s*$/);
    expect(chain).toContain("&& ( ( echo '{\"phase\":\"installed\"}'");
    expect(c.indexOf('"phase":"installed"')).toBeGreaterThan(
      c.indexOf("flagship-bootstrap.log 2>&1 ) &&"),
    );
  });

  it("no installer log is ever posted to the control plane (GA close-out 5)", () => {
    const c = cfg();
    expect(c).not.toContain("/api/dev/");
    expect(c).not.toContain("late-log");
    expect(c).not.toContain("fb-bootstrap-tail");
  });

  it("beacons are best-effort (|| true) and use busybox wget --post-file= (no curl in d-i)", () => {
    const c = cfg();
    expect(c).toContain("wget -q -O- --post-file=/tmp/flagship-beacon.json --timeout=15");
    // both beacons are wrapped so a not-yet-up network never blocks the install
    expect(c.match(/\) \|\| true/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it("posts to the canonical order-status channel; the serial is inlined (no runtime blob parse)", () => {
    const c = cfg();
    expect(c).toContain("/api/order/01TESTABCDEF/status");
    // The only d-i detail is generated by the allowlisted installer watcher;
    // serverDomain remains authoritative from registration, not a beacon.
    expect(extractInstallerTelemetry(c)).toContain('"detail"');
    expect(c).not.toContain('"serverDomain"');
  });

  it("sanitizes the inlined serial to an injection-proof set", () => {
    const { blob, blobSignatureHex } = signedBlob();
    const dirty = {
      ...blob,
      serverDomain: 'evil"; rm -rf / #',
      authCode: { ...blob.authCode, serial: "abc$(touch x)def" },
    };
    const c = buildDebianPreseed({ blob: dirty, blobSignatureHex });
    // The dangerous characters are stripped from the serial; the order-status
    // URL carries only the safe subset, and no domain is inlined into the beacon.
    expect(c).toContain("/api/order/abctouchxdef/status");
    expect(c).not.toContain("rm -rf /");
    expect(c).not.toContain("$(touch");
  });
});

describe("buildDebianPreseed — input validation ", () => {
  it("rejects an unsafe git ref", () => {
    const { blob, blobSignatureHex } = signedBlob();
    expect(() =>
      buildDebianPreseed({ blob, blobSignatureHex, installerGitRef: "main; rm -rf /" }),
    ).toThrow(/exact 40-character commit/);
  });
  it("rejects a non-https boot host", () => {
    const { blob, blobSignatureHex } = signedBlob();
    expect(() =>
      buildDebianPreseed({ blob, blobSignatureHex, bootHost: "http://insecure.example" }),
    ).toThrow(/bootHost must be https/);
  });
});

/**
 * B2 OPEN #9: the installer used to wipe the largest fixed disk without asking. Runs the generated
 * disk choice (the partman/early_command up to `debconf-set`) under /bin/sh against a fake machine:
 * /sys, /proc/mounts and /dev/disk/by-id are moved under a scratch root, list-devices and wget are
 * stubs, and the endless hold after a stop becomes `exit 7` so the test can see it.
 */
describe("buildDebianPreseed — the target disk", () => {
  interface Disk {
    name: string;
    gb: number;
    removable?: boolean;
    ids?: string[];
    /** Holds the installer (what d-i mounted at /cdrom); "part" = its first partition is mounted. */
    installer?: "whole" | "part";
  }
  function preseed(targetDisk?: string): string {
    const { blob, blobSignatureHex } = signedBlob();
    return buildDebianPreseed({ blob, blobSignatureHex, ...(targetDisk !== undefined ? { targetDisk } : {}) });
  }
  function choose(disks: Disk[], targetDisk?: string): { code: number; disk: string | null; console: string; beacon: string | null } {
    const T = realpathSync(mkdtempSync(join(tmpdir(), "flagship-disks-")));
    try {
      for (const d of ["sys/block", "sys/class/block", "sys/devices", "dev/disk/by-id", "proc", "bin", "tmp"]) mkdirSync(join(T, d), { recursive: true });
      let mounts = "";
      for (const d of disks) {
        writeFileSync(join(T, "dev", d.name), "");
        mkdirSync(join(T, "sys/block", d.name));
        writeFileSync(join(T, "sys/block", d.name, "size"), `${Math.round((d.gb * 1e9) / 512)}\n`);
        writeFileSync(join(T, "sys/block", d.name, "removable"), d.removable ? "1\n" : "0\n");
        mkdirSync(join(T, "sys/devices", d.name, `${d.name}1`), { recursive: true });
        writeFileSync(join(T, "sys/devices", d.name, `${d.name}1`, "partition"), "1\n");
        symlinkSync(join(T, "sys/devices", d.name), join(T, "sys/class/block", d.name));
        symlinkSync(join(T, "sys/devices", d.name, `${d.name}1`), join(T, "sys/class/block", `${d.name}1`));
        for (const id of d.ids ?? []) symlinkSync(join(T, "dev", d.name), join(T, "dev/disk/by-id", id));
        if (d.installer) mounts += `/dev/${d.installer === "part" ? `${d.name}1` : d.name} /cdrom iso9660 ro 0 0\n`;
      }
      writeFileSync(join(T, "proc/mounts"), `proc /proc proc rw 0 0\n${mounts}`);
      const stub = (n: string, body: string) => {
        writeFileSync(join(T, "bin", n), `#!/bin/sh\n${body}\n`);
        chmodSync(join(T, "bin", n), 0o755);
      };
      stub("list-devices", `for d in ${disks.map((d) => join(T, "dev", d.name)).join(" ")}; do echo "$d"; done`);
      stub("wget", `cp ${join(T, "tmp/flagship-beacon.json")} ${join(T, "beacon.json")}`);
      const line = preseed(targetDisk).replace(/\\\n/g, " ").split("\n").find((l) => l.startsWith("d-i partman/early_command string "))!;
      let cmd = line.slice("d-i partman/early_command string ".length);
      cmd = cmd.slice(0, cmd.indexOf('debconf-set partman-auto/disk "$DISK"'));
      expect(cmd).toContain("while :; do sleep 3600; done;");
      cmd = cmd
        .replace("while :; do sleep 3600; done;", "exit 7;")
        .split("/sys/").join(`${T}/sys/`)
        .split("/proc/mounts").join(`${T}/proc/mounts`)
        .split("/dev/disk/by-id").join(`${T}/dev/disk/by-id`)
        .split("/tmp/flagship-beacon.json").join(`${T}/tmp/flagship-beacon.json`)
        .split("/dev/console").join(`${T}/console`);
      let code = 0;
      let out = "";
      try {
        out = execFileSync("/bin/sh", ["-c", `${cmd} echo "DISK=$DISK"`], { env: { PATH: `${join(T, "bin")}:/usr/bin:/bin` }, encoding: "utf8", stdio: "pipe" });
      } catch (e) {
        code = (e as { status: number }).status;
      }
      const disk = /DISK=(.*)/.exec(out)?.[1]?.replace(`${T}/dev/`, "") ?? null;
      const beacon = existsSync(join(T, "beacon.json")) ? readFileSync(join(T, "beacon.json"), "utf8") : null;
      const consoleOut = existsSync(join(T, "console")) ? readFileSync(join(T, "console"), "utf8") : "";
      return { code, disk, console: consoleOut, beacon };
    } finally {
      rmSync(T, { recursive: true, force: true });
    }
  }

  it("one fixed disk (Studio's hosted VM, the common box): installs there, the installer medium never counts", () => {
    // The Mac VZHost: USB ISO as sda (not marked removable), the virtio main disk as vda.
    expect(choose([{ name: "sda", gb: 0.8, installer: "whole" }, { name: "vda", gb: 64 }])).toMatchObject({ code: 0, disk: "vda" });
    // A big USB SSD that holds the installer, marked fixed, next to a smaller internal disk.
    expect(choose([{ name: "sda", gb: 1000, installer: "part" }, { name: "nvme0n1", gb: 256 }])).toMatchObject({ code: 0, disk: "nvme0n1" });
    // A removable card reader and eMMC boot areas never count.
    expect(choose([{ name: "mmcblk0", gb: 32 }, { name: "mmcblk0boot0", gb: 0.004 }, { name: "sdc", gb: 64, removable: true }])).toMatchObject({ code: 0, disk: "mmcblk0" });
  });

  it("two fixed disks: stops before erasing anything, on the console and on the install timeline", () => {
    const r = choose([{ name: "sda", gb: 0.8, installer: "whole" }, { name: "nvme0n1", gb: 500, ids: ["nvme-Samsung_SSD_980_S64ANS0T1"] }, { name: "sdb", gb: 2000, ids: ["ata-WDC_WD20_WD-XYZ"] }]);
    expect(r.code).toBe(7);
    expect(r.disk).toBeNull();
    expect(r.console).toContain("FLAGSHIP INSTALL STOPPED: This machine has 2 disks that could be erased (500 GB, 2000 GB). Nothing was erased.");
    expect(r.console).toContain("by-id: nvme-Samsung_SSD_980_S64ANS0T1");
    const beacon = JSON.parse(r.beacon!) as { phase: string; detail: string };
    expect(beacon.phase).toBe("error");
    expect(beacon.detail).toContain("2 disks that could be erased");
    expect(beacon.detail).not.toContain("Samsung");
  });

  it("no disk to install on: stops, and never falls back to the first-enumerated device", () => {
    const r = choose([{ name: "sda", gb: 16, removable: true }, { name: "sdb", gb: 4 }]);
    expect(r.code).toBe(7);
    expect(JSON.parse(r.beacon!).detail).toContain("no fixed disk of 8 GB or more");
  });

  it("a named target disk: exactly that one, by id, serial or size; a name that matches none or several stops", () => {
    const disks: Disk[] = [{ name: "sda", gb: 0.8, installer: "whole" }, { name: "nvme0n1", gb: 500, ids: ["nvme-Samsung_SSD_980_S64ANS0T1"] }, { name: "sdb", gb: 2000, ids: ["ata-WDC_WD20_WD-XYZ"] }];
    expect(choose(disks, "by-id:ata-WDC_WD20_WD-XYZ")).toMatchObject({ code: 0, disk: "sdb" });
    expect(choose(disks, "serial:S64ANS0T1")).toMatchObject({ code: 0, disk: "nvme0n1" });
    expect(choose(disks, `size:${Math.round(500e9 / 512) * 512}`)).toMatchObject({ code: 0, disk: "nvme0n1" });
    const missing = choose(disks, "serial:NOPE");
    expect(missing.code).toBe(7);
    expect(JSON.parse(missing.beacon!).detail).toBe("The disk this installer was made for (serial:NOPE) is not in this machine. Nothing was erased.");
    // The installer medium can't be named.
    expect(choose(disks, `size:${Math.round(0.8e9 / 512) * 512}`).code).toBe(7);
    const twins: Disk[] = [{ name: "sda", gb: 500 }, { name: "sdb", gb: 500 }];
    expect(choose(twins, `size:${Math.round(500e9 / 512) * 512}`).code).toBe(7);
  });

  it("refuses a target disk name it can't carry safely into the installer's shell", () => {
    for (const bad of ["sda", "by-id:a b", "serial:x;reboot", "size:0", "by-id:$(id)", "serial:"]) {
      expect(() => preseed(bad), bad).toThrow(/targetDisk/);
    }
  });
});
