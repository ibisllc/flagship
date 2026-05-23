/**
 * Burner: cloud-init user-data embeds a COMPLETE auth-code.
 *
 * The bootstrap baked into the ISO reads the embedded install-blob back
 * and hands it to `install-helper sign-server-register`, which
 * reconstructs `canonicalAuthCode` to forward the phone's signature to
 * .com. canonicalAuthCode covers version/serverName/serverDomain/
 * delegatedPubKey — so if the serializer drops any of those, .com
 * rejects the registration. These tests pin the full round-trip:
 * embed -> base64-decode -> verifyAuthCode, which is exactly the
 * .com-side check.
 */
import { describe, it, expect } from "vitest";
import {
  signAuthCode,
  signInstallBlob,
  verifyAuthCode,
  ed,
  type AuthCode,
  type InstallBlob,
} from "@flagship/protocol";
import { buildAutoinstallUserData } from "../src/userdata.js";

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

function signedBlob(): { blob: InstallBlob; blobSignatureHex: string; userPub: Uint8Array } {
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
  return { blob, blobSignatureHex: hx(signInstallBlob(blob, irk)), userPub: irk.publicKey };
}

/** Pull the install-blob.json base64 out of the late-command line. */
function extractEmbeddedBlob(yaml: string): Record<string, any> {
  const m = yaml.match(/echo "([A-Za-z0-9+/=]+)" \| base64 -d > \/var\/flagship\/install-blob\.json/);
  if (!m) throw new Error("install-blob late-command not found in user-data");
  return JSON.parse(Buffer.from(m[1]!, "base64").toString("utf8"));
}

/** Decode the embedded first-boot bootstrap script back to its bash text. */
function extractBootstrap(yaml: string): string {
  const m = yaml.match(
    /echo "([A-Za-z0-9+/=]+)" \| base64 -d > \/usr\/local\/sbin\/flagship-bootstrap\.sh/,
  );
  if (!m) throw new Error("bootstrap late-command not found in user-data");
  return Buffer.from(m[1]!, "base64").toString("utf8");
}

describe("buildAutoinstallUserData", () => {
  it("embeds an auth-code with every field canonicalAuthCode needs", () => {
    const { blob, blobSignatureHex } = signedBlob();
    const yaml = buildAutoinstallUserData({ blob, blobSignatureHex });
    const embedded = extractEmbeddedBlob(yaml);
    for (const f of [
      "version",
      "serial",
      "username",
      "serverName",
      "serverDomain",
      "delegatedPubKey",
      "userPubKey",
      "issuedAt",
      "expiresAt",
    ]) {
      expect(embedded.authCode[f], `authCode.${f} must be embedded`).toBeDefined();
    }
  });

  it("embedded auth-code signature verifies — exactly the .com register check", () => {
    const { blob, blobSignatureHex } = signedBlob();
    const yaml = buildAutoinstallUserData({ blob, blobSignatureHex });
    const e = extractEmbeddedBlob(yaml);
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
    const ok = verifyAuthCode(
      reconstructed,
      unhex(e.authCodeUserSignature),
      unhex(e.authCode.userPubKey),
    );
    expect(ok).toBe(true);
  });

  it("embeds blobSignatureHex so the daemon can forward the blob signature", () => {
    const { blob, blobSignatureHex } = signedBlob();
    const yaml = buildAutoinstallUserData({ blob, blobSignatureHex });
    expect(extractEmbeddedBlob(yaml).blobSignatureHex).toBe(blobSignatureHex);
  });
});

describe("bootstrap sets up + enables the daemon (parity with the fixed demo)", () => {
  function bootstrap(): string {
    const { blob, blobSignatureHex } = signedBlob();
    return extractBootstrap(buildAutoinstallUserData({ blob, blobSignatureHex }));
  }

  it("writes /etc/flagship/daemon.env with the two REQUIRED daemon inputs (0600)", () => {
    const b = bootstrap();
    expect(b).toContain("cat > /etc/flagship/daemon.env");
    expect(b).toContain("FLAGSHIP_SUBDOMAIN=$SERVER_DOMAIN");
    expect(b).toContain("FLAGSHIP_IDENTITY_PRIV_HEX=$SERVER_IDENTITY_PRIV_HEX");
    expect(b).toContain("chmod 600 /etc/flagship/daemon.env");
  });

  it("self-signs the entitlement bundle with the box identity key (no user IRK on box)", () => {
    const b = bootstrap();
    expect(b).toContain("install-helper.ts mint-entitlements");
    // The signer (--irk-priv) is the box's OWN identity priv, and --pod-pub
    // is that same identity pubkey — i.e. a self-signed RootEntitlement.
    expect(b).toMatch(/--irk-priv "\$SERVER_IDENTITY_PRIV_HEX"/);
    expect(b).toMatch(/--pod-pub "\$SERVER_IDENTITY_PUB_HEX"/);
    expect(b).toContain("--out /var/flagship/entitlements.json");
    // The interim/self-signed nature + the phone-signed follow-up must be
    // documented in the generated script itself.
    expect(b).toContain("INTERIM SELF-SIGN");
    expect(b).toContain("FOLLOW-UP REQUIRED");
  });

  it("installs the flagship-daemon unit with the FIXED ExecStart (npm run, not npx)", () => {
    const b = bootstrap();
    expect(b).toContain("cat > /etc/systemd/system/flagship-daemon.service");
    expect(b).toContain(
      "ExecStart=/usr/bin/npm run start --workspace=@flagship/server-daemon",
    );
    expect(b).toContain("EnvironmentFile=/etc/flagship/daemon.env");
    expect(b).toContain("WorkingDirectory=/opt/flagship");
    expect(b).toContain("Type=simple");
    expect(b).toContain("Restart=on-failure");
    expect(b).toContain("RestartSec=5");
    expect(b).toContain("WantedBy=multi-user.target");
    // The pre-fix bug used `npx … run start`; that must be gone.
    expect(b).not.toContain("npx npm run start");
    expect(b).not.toMatch(/ExecStart=.*npx .*run start/);
  });

  it("defers register + daemon to first-boot units (chroot can't run systemd)", () => {
    const b = bootstrap();
    // Register moved to a oneshot first-boot unit (NOT inline in the chroot).
    expect(b).toContain("cat > /etc/systemd/system/flagship-first-boot-register.service");
    expect(b).toContain("Type=oneshot");
    expect(b).toContain("ConditionPathExists=!/var/flagship/registered.flag");
    expect(b).toContain("/usr/local/sbin/flagship-first-boot-register.sh");
    // The wrapper still does the real sign + POST, just on first real boot.
    expect(b).toContain("install-helper.ts sign-server-register");
    // ENABLE the units so they fire on first real boot…
    expect(b).toContain(
      "systemctl enable flagship-daemon.service flagship-first-boot-register.service",
    );
    // …and NEVER rely on `systemctl start` (systemd isn't the init in the
    // install chroot). No `systemctl start` of either unit anywhere.
    expect(b).not.toMatch(/systemctl start flagship-daemon\.service/);
    expect(b).not.toMatch(/systemctl start flagship-first-boot-register\.service/);
  });
});

describe("LUKS is the locked DEFAULT — proven unencrypted path is the debug escape", () => {
  function userData(opts: { encryptRoot?: boolean }): string {
    const { blob, blobSignatureHex } = signedBlob();
    return buildAutoinstallUserData({ blob, blobSignatureHex, ...opts });
  }

  it("default (no flag) === explicit encryptRoot:true, byte-for-byte", () => {
    // LUKS is now the default. Omitting the flag must produce the SAME locked
    // box as asking for it explicitly. (Auth-codes carry timestamps, so both
    // are generated from ONE signedBlob().)
    const { blob, blobSignatureHex } = signedBlob();
    const dflt = buildAutoinstallUserData({ blob, blobSignatureHex });
    const explicit = buildAutoinstallUserData({ blob, blobSignatureHex, encryptRoot: true });
    expect(dflt).toBe(explicit);
  });

  it("default path encrypts — curtin LUKS storage block + unlock hook present", () => {
    const yaml = userData({});
    expect(yaml).toContain("storage:");
    expect(yaml).toContain("type: dm_crypt");
    const b = extractBootstrap(yaml);
    expect(b).toContain("encryptRoot ON");
    expect(b).toContain("/boot/flagship-unseal");
  });

  it("encryptRoot:false reproduces the proven unencrypted path (debug escape only)", () => {
    // The escape is intentionally NOT exposed in the CLI/GUI — it exists so a
    // boot failure can be bisected against the known-good plaintext baseline.
    const yaml = userData({ encryptRoot: false });
    expect(yaml).not.toContain("storage:");
    expect(yaml).not.toContain("dm_crypt");
    const b = extractBootstrap(yaml);
    expect(b).not.toContain("encryptRoot ON");
    expect(b).not.toContain("/boot/flagship-unseal");
    expect(b).not.toContain("unlock_via_relay");
    expect(b).not.toContain("unlock_via_box_lease");
    expect(b).not.toContain("update-initramfs");
    expect(b).not.toContain("luksAddKey");
    expect(b).not.toContain("/boot/flagship-boot-unlock-mode");
    // …and it still ends exactly where the proven path ends.
    expect(b.trimEnd().endsWith('echo "[flagship-bootstrap] done"')).toBe(true);
  });
});

describe("two-tier boot-unlock policy (docs §7a.1) — auto default + approve", () => {
  function userData(opts: { bootUnlockMode?: "auto" | "approve" }): string {
    const { blob, blobSignatureHex } = signedBlob();
    const merged = opts.bootUnlockMode
      ? { ...blob, bootUnlockMode: opts.bootUnlockMode }
      : blob;
    return buildAutoinstallUserData({ blob: merged, blobSignatureHex });
  }

  it("default (no bootUnlockMode) bakes \"auto\" to /boot + emits box-lease + the auto dispatch", () => {
    const b = extractBootstrap(userData({}));
    // The mode file is baked exactly "auto".
    expect(b).toContain('echo "auto" > /boot/flagship-boot-unlock-mode');
    expect(b).not.toContain('echo "approve" > /boot/flagship-boot-unlock-mode');
    // box-lease helper present + GETs the box-sealed lease quartet.
    expect(b).toContain("unlock_via_box_lease()");
    expect(b).toContain("/unlock-key/lease-v2");
    // Parses the hex sealedKey + unseals with --sealed-hex.
    expect(b).toContain('"sealedKey":"');
    expect(b).toContain('--identity-priv-hex "$SEED_HEX" --sealed-hex "$SEALED_KEY"');
    // auto dispatch: box-lease first, relay fallback.
    expect(b).toContain('if [ "$BOOT_UNLOCK_MODE" = "approve" ]; then');
    expect(b).toContain("if ! unlock_via_box_lease; then");
    expect(b).toContain("unlock_via_relay");
    // The premount script reads the mode (default auto if the file is absent).
    expect(b).toContain('BOOT_UNLOCK_MODE="$(cat /boot/flagship-boot-unlock-mode 2>/dev/null || echo auto)"');
    // The retired plaintext-consume path is GONE from the dispatch.
    expect(b).not.toContain("unlock_via_plaintext_consume");
    expect(b).not.toContain("flagship/consume-unlock-key/v1|");
  });

  it("explicit auto === default, byte-for-byte (auto is the absent semantics)", () => {
    const { blob, blobSignatureHex } = signedBlob();
    const dflt = buildAutoinstallUserData({ blob, blobSignatureHex });
    const explicit = buildAutoinstallUserData({
      blob: { ...blob, bootUnlockMode: "auto" },
      blobSignatureHex,
    });
    expect(explicit).toBe(dflt);
  });

  it("bootUnlockMode:\"approve\" bakes \"approve\" + relay-only + NO box-lease call + NO plaintext fallback", () => {
    const b = extractBootstrap(userData({ bootUnlockMode: "approve" }));
    // The mode file is baked exactly "approve".
    expect(b).toContain('echo "approve" > /boot/flagship-boot-unlock-mode');
    expect(b).not.toContain('echo "auto" > /boot/flagship-boot-unlock-mode');
    // The relay is the ONLY dispatch in approve mode — no box-lease, no fallback.
    expect(b).toContain('if [ "$BOOT_UNLOCK_MODE" = "approve" ]; then');
    expect(b).toContain("unlock_via_relay");
    // Defense in depth: the dispatch never CALLS the box-lease in approve mode
    // (the function may be defined, but `if ! unlock_via_box_lease; then` —
    // the auto branch — is only reached when mode != approve at runtime).
    // No plaintext-consume anywhere.
    expect(b).not.toContain("unlock_via_plaintext_consume");
    expect(b).not.toContain("flagship/consume-unlock-key/v1|");
  });

  it("approve and auto YAML differ ONLY in the baked mode + nothing else structural", () => {
    const { blob, blobSignatureHex } = signedBlob();
    const autoYaml = buildAutoinstallUserData({ blob, blobSignatureHex });
    const approveYaml = buildAutoinstallUserData({
      blob: { ...blob, bootUnlockMode: "approve" },
      blobSignatureHex,
    });
    expect(approveYaml).not.toBe(autoYaml);
    const autoB = extractBootstrap(autoYaml);
    const approveB = extractBootstrap(approveYaml);
    // Both define the same helpers + dispatch shell (the branch is runtime).
    for (const b of [autoB, approveB]) {
      expect(b).toContain("unlock_via_box_lease()");
      expect(b).toContain("unlock_via_relay()");
      expect(b).toContain('if [ "$BOOT_UNLOCK_MODE" = "approve" ]; then');
    }
    // The only bake difference is the mode literal written to /boot.
    expect(autoB).toContain('echo "auto" > /boot/flagship-boot-unlock-mode');
    expect(approveB).toContain('echo "approve" > /boot/flagship-boot-unlock-mode');
  });
});

describe("the locked default — LUKS path details (EXPERIMENTAL, needs live validation)", () => {
  function luksYaml(): string {
    // No flag → the default, which is now the encrypted path.
    const { blob, blobSignatureHex } = signedBlob();
    return buildAutoinstallUserData({ blob, blobSignatureHex });
  }

  it("emits a curtin custom-storage block with a LUKS-encrypted root", () => {
    const yaml = luksYaml();
    expect(yaml).toContain("storage:");
    expect(yaml).toContain("type: dm_crypt");
    expect(yaml).toContain("dm_name: flagship_root");
    // Unencrypted /boot + encrypted root, both labelled like boot-stage expects.
    expect(yaml).toContain("label: FLAGSHIP_BOOT");
    expect(yaml).toContain("label: FLAGSHIP_ROOT");
    expect(yaml).toContain("path: /boot");
    expect(yaml).toMatch(/EXPERIMENTAL/);
  });

  it("bakes flagship-unseal to /boot — build-at-install from cloned source", () => {
    const b = extractBootstrap(luksYaml());
    expect(b).toContain("apt-get install -y --no-install-recommends golang-go");
    expect(b).toContain("/opt/flagship/installer/unseal-helper");
    expect(b).toContain("-o /boot/flagship-unseal");
    expect(b).toContain("chmod 755 /boot/flagship-unseal");
    // CGO-free static linux/amd64, matching the helper Makefile.
    expect(b).toContain("CGO_ENABLED=0 GOOS=linux GOARCH=amd64");
  });

  it("re-keys LUKS to a random key + seals it for the phone + uploads to .com", () => {
    const b = extractBootstrap(luksYaml());
    // install.sh's random-key pattern.
    expect(b).toContain("head -c 64 /dev/urandom > \"$LUKS_KEY\"");
    expect(b).toContain("cryptsetup luksAddKey");
    expect(b).toContain("cryptsetup luksRemoveKey");
    // seal-for-bak + sign-sealed-key + POST to sealed-luks-key, like install.sh.
    expect(b).toContain("install-helper.ts seal-for-bak");
    expect(b).toContain("--bak-ed25519-pub \"$PHONE_DELEGATED_PUBKEY\"");
    expect(b).toContain("install-helper.ts sign-sealed-key");
    expect(b).toContain("/sealed-luks-key");
    // Plaintext key shredded after sealing — never persisted.
    expect(b).toContain('shred -u "$LUKS_KEY"');
  });

  it("installs an initramfs hook lifting unlock_via_relay() verbatim", () => {
    const b = extractBootstrap(luksYaml());
    expect(b).toContain("/etc/initramfs-tools/hooks/flagship-unlock");
    expect(b).toContain("/etc/initramfs-tools/scripts/local-top/flagship-unlock");
    // The lifted functions + the two-tier dispatch (plaintext-consume RETIRED).
    expect(b).toContain("unlock_via_relay()");
    expect(b).toContain("unlock_via_box_lease()");
    expect(b).toContain("flagship/secret-request/v1|");
    expect(b).not.toContain("flagship/consume-unlock-key/v1|");
    expect(b).not.toContain("unlock_via_plaintext_consume");
    expect(b).toContain("if ! unlock_via_box_lease; then");
    // The pre-unlock tools the hook must stage into the initramfs.
    expect(b).toContain("copy_exec /usr/bin/openssl");
    expect(b).toContain("copy_exec /usr/bin/curl");
    expect(b).toContain("copy_exec /usr/bin/xxd");
    expect(b).toContain("copy_exec /bin/sed");
    expect(b).toContain("copy_exec /sbin/cryptsetup");
    expect(b).toContain("copy_exec /boot/flagship-unseal /bin/flagship-unseal");
    // luksOpen the labelled root, then pivot (the relay path's terminal step).
    expect(b).toContain("/dev/disk/by-label/FLAGSHIP_ROOT");
    expect(b).toContain("cryptsetup luksOpen --key-file - \"$ROOT_PART\" flagship_root");
    // Rebuild the initrd so the hook lands in /boot.
    expect(b).toContain("update-initramfs -u");
  });
});
