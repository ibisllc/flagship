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
import { createHash } from "node:crypto";
import {
  signAuthCode,
  signInstallBlob,
  verifyAuthCode,
  ed,
  type AuthCode,
  type InstallBlob,
} from "@flagship/protocol";
import {
  buildAutoinstallUserData,
  buildBootstrapScript,
  buildWifiSafetyNetBlock,
  buildInitramfsWifiBlock,
  wifiSetupScript,
  DEFAULT_BOOT_HOST,
} from "../src/userdata.js";

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

  it("installs docker so the daemon can run app containers + the data layer", () => {
    const b = bootstrap();
    // Root cause of the field "no docker" crash loop: docker was never
    // installed, so the daemon's ensureNetwork (`docker network create`)
    // hit ENOENT. The bootstrap apt line must install the engine, the CLI
    // (explicitly — --no-install-recommends drops the docker-cli Recommends),
    // and compose (the `docker compose` subcommand init.sh calls).
    expect(b).toMatch(/apt-get install -y --no-install-recommends .*docker\.io docker-cli docker-compose/);
    // docker.service is enabled so the engine is up on first real boot.
    expect(b).toContain("systemctl enable docker.service containerd.service");
  });

  it("brings up the data layer as a gated, daemon-independent first-boot oneshot", () => {
    const b = bootstrap();
    expect(b).toContain("cat > /etc/systemd/system/flagship-data-services.service");
    expect(b).toContain("ExecStart=/opt/flagship/installer/data-services/init.sh");
    expect(b).toContain("After=docker.service network-online.target");
    // Gated on the very file init.sh writes — re-running boots skip it once set up.
    expect(b).toContain("ConditionPathExists=!/var/flagship/data-services.env");
    expect(b).toContain("Type=oneshot");
    // Enabled alongside the other first-boot units…
    expect(b).toContain("flagship-data-services.service");
    // …but NEVER ordered before the daemon — a multi-image pull must not delay
    // the box reaching its green padlock.
    expect(b).not.toMatch(/flagship-data-services\.service[\s\S]*Before=flagship-daemon/);
    expect(b).not.toMatch(/Before=flagship-daemon[\s\S]*flagship-data-services/);
  });

  it("reports canonical phases ONLY to the order-status channel (one channel)", () => {
    const b = bootstrap();
    // The single sink: POST /api/order/<serial>/status.
    expect(b).toContain("/api/order/$AUTH_CODE_SERIAL/status");
    // No vestige of the retired install-events / provision-event channels.
    expect(b).not.toContain("/api/install-events/");
    expect(b).not.toContain("/provision-event");
    // `downloading` fires from the START of the in-target bootstrap (the
    // git-clone/apt/node flagship software fetch — AFTER the base OS install,
    // so it follows `installing` on the wire, matching the late_command beacon).
    expect(b).toContain("report_phase downloading");
  });

  it("fires `registering` UNCONDITIONALLY — including on the plain-path deferred register", () => {
    const b = bootstrap();
    // The deferred first-boot register wrapper carries its own report_phase +
    // calls `registering` before the sign/POST, so the plain path emits it too
    // (the encrypted path emits it inline; registered.flag stops a double-emit).
    expect(b).toContain("AUTH_CODE_SERIAL=$AUTH_CODE_SERIAL");
    const wrapperStart = b.indexOf("flagship-first-boot-register.sh <<'WRAPPER'");
    const wrapperEnd = b.indexOf("WRAPPER\n", wrapperStart);
    const wrapper = b.slice(wrapperStart, wrapperEnd);
    expect(wrapper).toContain("report_phase registering");
    expect(wrapper).toContain("/api/order/$AUTH_CODE_SERIAL/status");
  });

  it("installs a terminal `error` trap that reports on any non-zero bootstrap exit", () => {
    const b = bootstrap();
    expect(b).toContain("trap flagship_on_error EXIT");
    expect(b).toContain('report_phase error "bootstrap exited $_rc"');
    // …disarmed on the clean path so a 0 exit never misfires `error`.
    expect(b).toContain("trap - EXIT");
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
    expect(b).not.toContain("/boot/flagship-boot-host");
    expect(b).not.toContain("boot.flagshipserver.com");
    expect(b).not.toContain("/api/boot/");
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
    // box-lease helper present + GETs the box-sealed lease from the boot worker.
    expect(b).toContain("unlock_via_box_lease()");
    expect(b).toContain('LEASE_PATH="/api/boot/lease/${SERVER_DOMAIN}"');
    // The legacy .com lease-v2 + secret-request/-response paths are GONE.
    expect(b).not.toContain("/unlock-key/lease-v2");
    expect(b).not.toContain("/api/server/${SERVER_DOMAIN}/secret-request");
    expect(b).not.toContain("/api/server/${SERVER_DOMAIN}/secret-response");
    // Parses the hex sealedKey + unseals with --sealed-hex.
    expect(b).toContain('"sealedKey":"');
    expect(b).toContain('--identity-priv-hex "$SEED_HEX" --sealed-hex "$SEALED_KEY"');
    // auto dispatch: box-lease first, relay fallback.
    expect(b).toContain('if [ "$EFFECTIVE_MODE" = "approve" ]; then');
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
    expect(b).toContain('if [ "$EFFECTIVE_MODE" = "approve" ]; then');
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
      expect(b).toContain('if [ "$EFFECTIVE_MODE" = "approve" ]; then');
    }
    // The only bake difference is the mode literal written to /boot.
    expect(autoB).toContain('echo "auto" > /boot/flagship-boot-unlock-mode');
    expect(approveB).toContain('echo "approve" > /boot/flagship-boot-unlock-mode');
  });
});

describe("boot worker repoint — boot.flagshipserver.com + box-STK Flagship-Boot-v1 auth", () => {
  function bootstrap(opts: { bootHost?: string } = {}): string {
    const { blob, blobSignatureHex } = signedBlob();
    return extractBootstrap(buildAutoinstallUserData({ blob, blobSignatureHex, ...opts }));
  }

  it("bakes the DEFAULT boot host (boot.flagshipserver.com) to /boot/flagship-boot-host", () => {
    const b = bootstrap();
    expect(b).toContain('echo "https://boot.flagshipserver.com" > /boot/flagship-boot-host');
    // Default constant is exported + matches the bake.
    expect(DEFAULT_BOOT_HOST).toBe("https://boot.flagshipserver.com");
  });

  it("an enterprise clone can override the boot host (bootHost option)", () => {
    const b = bootstrap({ bootHost: "https://boot.acme-enterprise.example" });
    expect(b).toContain('echo "https://boot.acme-enterprise.example" > /boot/flagship-boot-host');
    expect(b).not.toContain('echo "https://boot.flagshipserver.com" > /boot/flagship-boot-host');
  });

  it("rejects a non-https boot host", () => {
    const { blob, blobSignatureHex } = signedBlob();
    expect(() =>
      buildAutoinstallUserData({ blob, blobSignatureHex, bootHost: "http://insecure.example" }),
    ).toThrow(/bootHost must be https/);
  });

  it("the premount unlock hook reads the boot host (override-capable; default if absent)", () => {
    const b = bootstrap();
    expect(b).toContain(
      'BOOT_HOST="$(cat /boot/flagship-boot-host 2>/dev/null || echo https://boot.flagshipserver.com)"',
    );
    // The hook stages the boot-host fact into the initramfs so it's readable pre-pivot.
    expect(b).toContain('cp /boot/flagship-boot-host "${DESTDIR}/boot/flagship-boot-host"');
  });

  it("hits the FIXED /api/boot/* contract with the box-STK Authorization header", () => {
    const b = bootstrap();
    // Lease (auto), request + response (relay) all hit the boot worker paths.
    expect(b).toContain('LEASE_PATH="/api/boot/lease/${SERVER_DOMAIN}"');
    expect(b).toContain('REQ_PATH="/api/boot/request"');
    expect(b).toContain('POLL_PATH="/api/boot/response/${SERVER_DOMAIN}/${NONCE}"');
    // Each call carries a fresh box-STK Authorization header.
    expect(b).toContain('LEASE_AUTH="$(sign_box_auth_header GET "$LEASE_PATH")"');
    expect(b).toContain('REQ_AUTH="$(sign_box_auth_header POST "$REQ_PATH")"');
    expect(b).toContain('POLL_AUTH="$(sign_box_auth_header GET "$POLL_PATH")"');
    expect(b).toContain('Authorization: $LEASE_AUTH');
    expect(b).toContain('Authorization: $REQ_AUTH');
    expect(b).toContain('Authorization: $POLL_AUTH');
    // The legacy .com unlock endpoints are gone (the SecretRequest BODY canonical
    // `flagship/secret-request/v1|` legitimately stays — only the URL moved).
    expect(b).not.toContain("/unlock-key/lease-v2");
    expect(b).not.toContain("/api/server/${SERVER_DOMAIN}/secret-request");
    expect(b).not.toContain("/api/server/${SERVER_DOMAIN}/secret-response");
  });

  it("the box-auth header signing matches apps/boot/src/gate.ts canonical bytes", () => {
    const b = bootstrap();
    // The canonical string the box signs MUST equal canonicalBootAuth() in
    // gate.ts: tag|role|serverDomain|METHOD|path|pubHex|nonceHex|issuedAt.
    expect(b).toContain(
      '_bcanon="flagship/boot-auth/v1|box|${SERVER_DOMAIN}|${_bm}|${_bp}|${PUB_HEX}|${_bnonce}|${_bnow}"',
    );
    // base64url(JSON envelope) of {role,serverDomain,method,path,pubKeyHex,
    // nonceHex,issuedAt,signatureHex}, signed with the box STK priv via openssl.
    expect(b).toContain('"role":"box","serverDomain":"%s","method":"%s","path":"%s"');
    expect(b).toContain('"pubKeyHex":"%s","nonceHex":"%s","issuedAt":%s,"signatureHex":"%s"');
    // base64url = base64 with +→-, /→_, trailing '=' stripped.
    expect(b).toContain("openssl base64 -A | tr '+/' '-_' | tr -d '='");
    // The Ed25519 signature is over the canonical bytes via the box STK priv.
    expect(b).toContain("printf 'Flagship-Boot-v1 %s'");
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

  it("UEFI Secure Boot: ESP carries grub_device (signed chain), disk does NOT (avoids unsigned BIOS grub)", () => {
    const yaml = luksYaml();
    // The UEFI ESP (flag boot, fat32, grub device, mounted /boot/efi).
    expect(yaml).toContain("flag: boot, grub_device: true");
    expect(yaml).toContain("fstype: fat32");
    expect(yaml).toContain("path: /boot/efi");
    // The DISK must NOT be a grub_device — that triggers a BIOS grub-pc install
    // whose unsigned EFI grub fails Secure Boot ("invalid signature").
    expect(yaml).toContain("wipe: superblock-recursive, grub_device: false");
    expect(yaml).not.toContain("grub_device: true, preserve: false}\n      - {id: bios_grub");
    // reserved bios_grub partition kept for a future BIOS variant.
    expect(yaml).toContain("flag: bios_grub");
    // ESP partition precedes its format precedes its mount.
    expect(yaml.indexOf("esp_part")).toBeLessThan(yaml.indexOf("esp_fs"));
    expect(yaml.indexOf("esp_fs")).toBeLessThan(yaml.indexOf("esp_mount"));
  });

  it("broken-NVRAM firmware: skips the EFI NVRAM write + installs grub to the removable fallback path", () => {
    const yaml = luksYaml();
    // curtin must NOT try to write the EFI NVRAM entry (that aborts the install
    // on firmware that rejects efivarfs writes — "failed to register the EFI
    // boot entry: Invalid argument").
    expect(yaml).toContain("grub:\n      update_nvram: false");
    // … and a late-command copies the SIGNED shim+grub to /EFI/BOOT/BOOTX64.EFI
    // (the removable fallback firmware boots with no NVRAM entry).
    expect(yaml).toContain('cp "$D/ubuntu/shimx64.efi" "$D/BOOT/BOOTX64.EFI"');
    expect(yaml).toContain('cp "$D/ubuntu/grubx64.efi" "$D/BOOT/grubx64.efi"');
    // the fallback copy runs before our install-blob/bootstrap late-commands.
    expect(yaml.indexOf("BOOTX64.EFI")).toBeLessThan(yaml.indexOf("install-blob.json"));
    // SECOND mechanism (in case subiquity ignores storage.grub.update_nvram):
    // the debconf preseed MAAS uses so grub-install passes --no-nvram.
    expect(yaml).toContain("debconf-selections: |");
    expect(yaml).toContain("grub2/update_nvram boolean false");
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
    // Seal to the account IRK (userPubKey) — a phone-rederivable, recovery-
    // surviving key — NOT phoneDelegatedPubKey (whose private half the phone
    // discards, which made phone-approval unlock fail to unseal).
    expect(b).toContain('USER_PUB_HEX="$(jq -r .authCode.userPubKey "$BLOB_JSON")"');
    expect(b).toContain("--bak-ed25519-pub \"$USER_PUB_HEX\"");
    expect(b).not.toContain("--bak-ed25519-pub \"$PHONE_DELEGATED_PUBKEY\"");
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
    // Repointed to the dedicated boot worker via the box-STK auth header.
    expect(b).toContain('REQ_PATH="/api/boot/request"');
    expect(b).toContain('POLL_PATH="/api/boot/response/${SERVER_DOMAIN}/${NONCE}"');
    expect(b).toContain('sign_box_auth_header POST "$REQ_PATH"');
    expect(b).toContain('sign_box_auth_header GET "$POLL_PATH"');
    expect(b).toContain('Authorization: $REQ_AUTH');
    expect(b).toContain("flagship/boot-auth/v1|box|");
    // The hook stages the boot-host fact into the initramfs.
    expect(b).toContain("/boot/flagship-boot-host");
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

describe("optional Wi-Fi — for a box with no Ethernet (burn-time local input)", () => {
  function userData(opts: { wifiSSID?: string; wifiPassword?: string }): string {
    const { blob, blobSignatureHex } = signedBlob();
    return buildAutoinstallUserData({ blob, blobSignatureHex, ...opts });
  }

  it("absent Wi-Fi === byte-identical to before (no network: block, no wpasupplicant)", () => {
    const { blob, blobSignatureHex } = signedBlob();
    const none = buildAutoinstallUserData({ blob, blobSignatureHex });
    const empty = buildAutoinstallUserData({ blob, blobSignatureHex, wifiSSID: "" });
    const wsOnly = buildAutoinstallUserData({ blob, blobSignatureHex, wifiSSID: "   " });
    expect(empty).toBe(none);
    expect(wsOnly).toBe(none); // whitespace-only SSID is treated as absent
    expect(none).not.toContain("network:");
    expect(none).not.toContain("wpasupplicant");
  });

  /** Decode the base64 Wi-Fi setup script out of the early-command line. */
  function extractWifiScript(yaml: string): string {
    const m = yaml.match(/echo ([A-Za-z0-9+/=]+) \| base64 -d > \/tmp\/flagship-wifi\.sh/);
    if (!m) throw new Error("wifi setup command not found in user-data");
    return Buffer.from(m[1]!, "base64").toString("utf8");
  }

  it("with an SSID: wired-only network: fallback + early/late commands + wpasupplicant, NO wifi match in YAML", () => {
    const yaml = userData({ wifiSSID: "HomeNet", wifiPassword: "s3cret" });
    // networkd allows ethernet match (the optional wired fallback) …
    expect(yaml).toContain("  network:\n    version: 2");
    expect(yaml).toContain('match: {name: "en*"}');
    // … but NOT a wifi match — so the YAML must carry no wifis:/wl* glob.
    expect(yaml).not.toContain("wifis:");
    expect(yaml).not.toContain("wl*");
    // Wi-Fi is configured at runtime: early-command (live) + /target late-command.
    expect(yaml).toContain("  early-commands:");
    expect(yaml).toContain('bash /tmp/flagship-wifi.sh"'); // live (no arg)
    expect(yaml).toContain('bash /tmp/flagship-wifi.sh /target"'); // target
    expect(yaml).toContain("    - wpasupplicant\n");
    // SSID + password never appear in plaintext — only inside the base64 script.
    expect(yaml).not.toContain("HomeNet");
    expect(yaml).not.toContain("s3cret");
    // network: → early-commands: → identity: (sibling keys under autoinstall:).
    expect(yaml.indexOf("network:")).toBeLessThan(yaml.indexOf("early-commands:"));
    expect(yaml.indexOf("early-commands:")).toBeLessThan(yaml.indexOf("identity:"));
  });

  it("the runtime script detects the interface, writes a name-keyed netplan, escapes SSID/pw", () => {
    const yaml = userData({ wifiSSID: 'My "Net" \\x', wifiPassword: 'p"a\\ss' });
    const s = extractWifiScript(yaml);
    expect(s).toContain("for d in /sys/class/net/*/wireless; do");
    expect(s).toContain("<<'FLAGSHIP_WIFI_EOF'");
    expect(s).toContain("    __IFACE__:");
    expect(s).toContain('sed -i "s/__IFACE__/${IF}/"');
    // escaped for the YAML scalar inside the quoted heredoc.
    expect(s).toContain('"My \\"Net\\" \\\\x":');
    expect(s).toContain('password: "p\\"a\\\\ss"');
  });

  it("the Wi-Fi script is BYTE-IDENTICAL to the Swift twin (cross-language lockstep)", () => {
    // The Swift burner (EngineTests.testWifiSetupScriptIsByteIdenticalToTs)
    // pins this SAME sha256. The base64 embedded in the autoinstall only matches
    // across the two burners if the script does — so both suites assert it.
    const yaml = userData({ wifiSSID: "Flagship Test AP", wifiPassword: "test-only-not-real" });
    const s = extractWifiScript(yaml);
    expect(createHash("sha256").update(s).digest("hex")).toBe(
      "f215b57a79ae7f12cd6b372dd7631842a8f6dafbdc1beca7b6f3588535c770b9",
    );
  });

  it("a password with no SSID is ignored (SSID is what gates the block)", () => {
    const { blob, blobSignatureHex } = signedBlob();
    const none = buildAutoinstallUserData({ blob, blobSignatureHex });
    const pwOnly = buildAutoinstallUserData({ blob, blobSignatureHex, wifiPassword: "orphan" });
    expect(pwOnly).toBe(none);
    expect(pwOnly).not.toContain("orphan");
  });

  it("Wi-Fi composes with the locked LUKS default (network: + storage: both present)", () => {
    const yaml = userData({ wifiSSID: "HomeNet", wifiPassword: "s3cret" });
    expect(yaml).toContain("network:");
    expect(yaml).toContain("storage:");
    expect(yaml).toContain("type: dm_crypt");
    // ordering under autoinstall: network → early-commands → packages(+wpasupplicant) → storage → late-commands
    expect(yaml.indexOf("network:")).toBeLessThan(yaml.indexOf("early-commands:"));
    expect(yaml.indexOf("early-commands:")).toBeLessThan(yaml.indexOf("wpasupplicant"));
    expect(yaml.indexOf("wpasupplicant")).toBeLessThan(yaml.indexOf("storage:"));
    expect(yaml.indexOf("storage:")).toBeLessThan(yaml.indexOf("late-commands:"));
  });
});

describe("wifiSetupScript — distro-correct installed-system config (Ubuntu netplan vs Debian networkd)", () => {
  it("is one script that branches at RUNTIME on whether netplan is present", () => {
    const s = wifiSetupScript("HomeNet", "s3cret");
    // The discriminator: netplan dir present in the target ⇒ Ubuntu, else Debian.
    expect(s).toContain('if [ -d "${ROOT}/etc/netplan" ]; then');
    expect(s).toContain("else");
  });

  it("Ubuntu branch keeps the netplan file UNCHANGED (name-keyed, 0600, dhcp4+optional)", () => {
    const s = wifiSetupScript('My "Net" \\x', 'p"a\\ss');
    expect(s).toContain('cat > "${ROOT}/etc/netplan/99-flagship-wifi.yaml"');
    expect(s).toContain("  wifis:");
    expect(s).toContain("      dhcp4: true");
    expect(s).toContain("      optional: true");
    expect(s).toContain('sed -i "s/__IFACE__/${IF}/" "${ROOT}/etc/netplan/99-flagship-wifi.yaml"');
    expect(s).toContain('chmod 600 "${ROOT}/etc/netplan/99-flagship-wifi.yaml"');
    // SSID/pw escaped for the YAML scalar.
    expect(s).toContain('"My \\"Net\\" \\\\x":');
    expect(s).toContain('password: "p\\"a\\\\ss"');
  });

  it("Debian branch writes a networkd .network (DHCP) keyed by the detected iface", () => {
    const s = wifiSetupScript("HomeNet", "s3cret");
    expect(s).toContain('cat > "${ROOT}/etc/systemd/network/10-flagship-wifi.network"');
    expect(s).toContain("Name=__IFACE__");
    expect(s).toContain("DHCP=yes");
    expect(s).toContain('sed -i "s/__IFACE__/${IF}/" "${ROOT}/etc/systemd/network/10-flagship-wifi.network"');
  });

  it("Debian branch writes the per-iface wpa_supplicant conf the @.service template reads (0600)", () => {
    const s = wifiSetupScript("HomeNet", "s3cret");
    // The exact path wpa_supplicant@<iface>.service consumes.
    expect(s).toContain('cat > "${ROOT}/etc/wpa_supplicant/wpa_supplicant-${IF}.conf"');
    expect(s).toContain("ctrl_interface=DIR=/run/wpa_supplicant GROUP=netdev");
    expect(s).toContain('ssid="HomeNet"');
    expect(s).toContain('psk="s3cret"');
    expect(s).toContain('chmod 600 "${ROOT}/etc/wpa_supplicant/wpa_supplicant-${IF}.conf"');
  });

  it("Debian branch NEUTRALIZES d-i's ifupdown wpa stanza (so two managers don't fight the radio)", () => {
    const s = wifiSetupScript("HomeNet", "s3cret");
    // It must touch /etc/network/interfaces and comment out the iface + wpa- lines.
    expect(s).toContain('IFACES_FILE="${ROOT}/etc/network/interfaces"');
    expect(s).toContain("allow-hotplug|auto|iface");
    expect(s).toContain("/^[[:space:]]*wpa-/");
    expect(s).toContain("neutralized ifupdown wireless stanza");
  });

  it("Debian branch enables networkd + wpa_supplicant@<iface> via .wants symlinks (chroot-safe)", () => {
    const s = wifiSetupScript("HomeNet", "s3cret");
    expect(s).toContain('multi-user.target.wants/systemd-networkd.service"');
    expect(s).toContain('sockets.target.wants/systemd-networkd.socket"');
    expect(s).toContain('multi-user.target.wants/wpa_supplicant@${IF}.service"');
    // Symlinks point at the shipped unit templates.
    expect(s).toContain("ln -sf /lib/systemd/system/systemd-networkd.service");
    expect(s).toContain('ln -sf "/lib/systemd/system/wpa_supplicant@.service"');
  });
});

describe("first-boot Wi-Fi safety-net — the headless-box backstop", () => {
  function bootstrapWith(opts: { wifiSSID?: string; wifiPassword?: string }): string {
    const { blob, blobSignatureHex } = signedBlob();
    return extractBootstrap(buildAutoinstallUserData({ blob, blobSignatureHex, ...opts }));
  }

  it("is ABSENT on a wired burn (no SSID) — keeps the bootstrap byte-identical", () => {
    const b = bootstrapWith({});
    expect(b).not.toContain("flagship-wifi-safetynet");
    expect(b).not.toContain("/etc/flagship/wifi.env");
    // wpasupplicant NOT added to the bootstrap apt line on the wired path.
    expect(b).not.toMatch(/apt-get install .*wpasupplicant/);
    // returns "" for an empty SSID.
    expect(buildWifiSafetyNetBlock("", "x")).toBe("");
    expect(buildWifiSafetyNetBlock("   ", "x")).toBe("");
  });

  it("is PRESENT on a Wi-Fi burn: a oneshot unit + script + base64 creds + wpasupplicant", () => {
    const b = bootstrapWith({ wifiSSID: "HomeNet", wifiPassword: "s3cret" });
    expect(b).toContain("/usr/local/sbin/flagship-wifi-safetynet.sh");
    expect(b).toContain("cat > /etc/systemd/system/flagship-wifi-safetynet.service");
    expect(b).toContain("systemctl enable flagship-wifi-safetynet.service");
    // Creds embedded base64 (never plaintext) at 0600 in the SAFETY-NET block.
    // (The separate initramfs Wi-Fi premount embeds escaped plaintext on purpose —
    // it's pinned by its own tests below — so scope this to the safety-net region.)
    expect(b).toContain("FLAGSHIP_WIFI_SSID_B64=");
    expect(b).toContain("chmod 600 /etc/flagship/wifi.env");
    const safetyNet = buildWifiSafetyNetBlock("HomeNet", "s3cret");
    expect(safetyNet).not.toContain("HomeNet");
    expect(safetyNet).not.toContain("s3cret");
    // The bootstrap apt line now includes wpasupplicant (safety-net needs it).
    expect(b).toMatch(/apt-get install .*wpasupplicant/);
  });

  it("only acts when OFFLINE (route-gated) + is idempotent + retries — never fights a working config", () => {
    const b = bootstrapWith({ wifiSSID: "HomeNet", wifiPassword: "s3cret" });
    // Route check + grace loop that EXITS if a default route already exists.
    expect(b).toContain("has_route() { ip route show default 2>/dev/null | grep -q .; }");
    expect(b).toContain("default route present — primary config OK");
    // Retries DHCP (networkd-first, with explicit-client fallbacks).
    expect(b).toContain("systemctl restart systemd-networkd");
    expect(b).toContain("dhclient -1");
    expect(b).toContain("dhcpcd -t 20");
    expect(b).toContain("udhcpc -i");
    // wpa_supplicant brought up directly on the detected iface.
    expect(b).toContain('wpa_supplicant -B -i "$IF" -c "$CONF"');
  });

  it("the unit has NO network ordering at all (network.target can be delayed on a Wi-Fi-only box)", () => {
    const b = bootstrapWith({ wifiSSID: "HomeNet", wifiPassword: "s3cret" });
    // Only Before= the register/daemon units; the script's own grace wait
    // replaces any After= on network targets (the chicken-and-egg fix for #27).
    expect(b).toContain("Before=flagship-first-boot-register.service flagship-daemon.service");
    const unitStart = b.indexOf("flagship-wifi-safetynet.service <<");
    const unitEnd = b.indexOf("WIFIUNIT", unitStart + 1);
    const unit = b.slice(unitStart, unitEnd);
    expect(unit).not.toContain("network-online.target");
    expect(unit).not.toContain("After=");
    expect(unit).not.toContain("Wants=network");
  });

  it("the safety-net block is BYTE-IDENTICAL to the Swift twin (cross-language sha pin)", () => {
    // EngineTests.testWifiSafetyNetBlockIsByteIdenticalToTs pins this SAME sha256.
    const s = buildWifiSafetyNetBlock("Flagship Test AP", "test-only-not-real");
    expect(createHash("sha256").update(s).digest("hex")).toBe(
      "f7c3c21f0d6f669a887ac88fd906f0aa443790a6c408a9441c7e18402781141f",
    );
  });
});

// The encrypted root is unlocked in the INITRAMFS via the phone-relay, but the
// premount curls the relay assuming the network is already up — true on Ethernet
// (the initramfs auto-configures wired DHCP) but NOT on Wi-Fi, where early boot
// brings up no radio. A headless Wi-Fi-only box installed + bootstrapped fine,
// then HANGED at the LUKS unlock on every reboot. These tests pin the fix: the
// initramfs Wi-Fi hook/premount + the kept burn-time recovery slot.
describe("BRING-UP SAFETY NET — burn-time recovery slot kept (remove before GA)", () => {
  function encBootstrap(opts: Record<string, unknown> = {}): string {
    const { blob, blobSignatureHex } = signedBlob();
    return extractBootstrap(
      buildAutoinstallUserData({ blob, blobSignatureHex, ...opts }),
    );
  }

  it("does NOT remove the burn-time passphrase (the luksRemoveKey is guarded off)", () => {
    const b = encBootstrap();
    // The re-key + seal/upload still happen.
    expect(b).toContain("cryptsetup luksAddKey");
    // The luksRemoveKey command is still present in the text (so a GA cut is a
    // one-line flip) but guarded by `if false; then` so it NEVER runs.
    expect(b).toContain("cryptsetup luksRemoveKey");
    const removeIdx = b.indexOf("cryptsetup luksRemoveKey");
    const guardIdx = b.lastIndexOf("if false; then", removeIdx);
    const fiIdx = b.indexOf("\nfi\n", removeIdx);
    expect(guardIdx).toBeGreaterThanOrEqual(0);
    expect(guardIdx).toBeLessThan(removeIdx);
    expect(fiIdx).toBeGreaterThan(removeIdx); // closes after the removeKey
    // The bring-up rationale is spelled out (and flags the GA removal).
    expect(b).toContain("BRING-UP SAFETY NET");
    expect(b).toContain("recovery slot");
  });
});

describe("INITRAMFS Wi-Fi (phone-gated unlock needs network in early boot)", () => {
  function encBootstrap(opts: Record<string, unknown> = {}): string {
    const { blob, blobSignatureHex } = signedBlob();
    return extractBootstrap(
      buildAutoinstallUserData({ blob, blobSignatureHex, ...opts }),
    );
  }

  it("is ABSENT on a wired encrypted burn (no Wi-Fi creds)", () => {
    const b = encBootstrap();
    expect(b).not.toContain("/etc/initramfs-tools/hooks/flagship-wifi");
    expect(b).not.toContain("init-premount/flagship-wifi");
    // The helper returns "" when there's no SSID.
    expect(buildInitramfsWifiBlock("", "x")).toBe("");
    expect(buildInitramfsWifiBlock("   ", "x")).toBe("");
  });

  it("is ABSENT on the unencrypted (plain) path even WITH Wi-Fi creds", () => {
    // The initramfs unlock only exists on the encrypted path; the plain path has
    // no LUKS prompt to network-unlock past.
    const b = encBootstrap({ encryptRoot: false, wifiSSID: "HomeNet", wifiPassword: "s3cret" });
    expect(b).not.toContain("init-premount/flagship-wifi");
    expect(b).not.toContain("/etc/initramfs-tools/hooks/flagship-wifi");
  });

  it("is PRESENT on a Wi-Fi encrypted burn: build-time hook stages driver+firmware+wpa_supplicant", () => {
    const b = encBootstrap({ wifiSSID: "HomeNet", wifiPassword: "s3cret" });
    expect(b).toContain("cat > /etc/initramfs-tools/hooks/flagship-wifi");
    // Runtime driver detection inside the hook (build time, on real hardware),
    // VALIDATED step by step (an empty WLIF must never silently no-op the hook).
    expect(b).toContain("WLIF=$(ls /sys/class/net 2>/dev/null | grep -E '^wl' | head -1)");
    expect(b).toContain('DRV=$(basename "$(readlink -f "/sys/class/net/$WLIF/device/driver" 2>/dev/null)" 2>/dev/null)');
    expect(b).toContain('if [ -n "$WLIF" ]; then');
    expect(b).toContain('if [ -n "$DRV" ]; then');
    expect(b).toContain('manual_add_modules "$DRV"');
    // Firmware staged for the driver AND its module dependencies, accepting the
    // Debian 13 compressed variants (.xz/.zst) with the variant name preserved.
    expect(b).toContain('modprobe --show-depends "$DRV"');
    expect(b).toContain('for fw in $(modinfo -F firmware "$_m" 2>/dev/null); do stage_fw "$fw"; done');
    expect(b).toContain('for _v in "" .xz .zst; do');
    expect(b).toContain('cp -a "/lib/firmware/$1$_v" "$DESTDIR/lib/firmware/$1$_v"');
    expect(b).toContain("for r in regulatory.db regulatory.db.p7s");
    // cfg80211/mac80211 staged EXPLICITLY (not just as $DRV dependencies).
    expect(b).toContain("manual_add_modules cfg80211");
    expect(b).toContain("manual_add_modules mac80211");
    // No-detection fallback: the whole wireless module class, bounded.
    expect(b).toContain("copy_modules_dir kernel/drivers/net/wireless");
    // Every premount tool staged: wpa_supplicant + wpa_cli + ip (both paths tried).
    expect(b).toMatch(/copy_exec\s+\/sbin\/wpa_supplicant/);
    expect(b).toContain("copy_exec /usr/sbin/wpa_supplicant /sbin/wpa_supplicant");
    expect(b).toContain("copy_exec /sbin/wpa_cli /sbin/wpa_cli");
    expect(b).toContain("copy_exec /usr/sbin/wpa_cli /sbin/wpa_cli");
    expect(b).toContain("copy_exec /sbin/ip /sbin/ip");
    expect(b).toContain("copy_exec /bin/ip /sbin/ip");
    // wpasupplicant package ensured before the hook references the binary.
    expect(b).toMatch(/apt-get install .*wpasupplicant/);
  });

  it("the hook writes a stage-by-stage BUILD-TIME diagnostic log to /boot (best-effort)", () => {
    const b = encBootstrap({ wifiSSID: "HomeNet", wifiPassword: "s3cret" });
    expect(b).toContain("BLOG=/boot/flagship-wifi-build.log");
    expect(b).toContain('blog() { echo "flagship-wifi-hook: $*" >> "$BLOG" 2>/dev/null || true; }');
    // The decision points all log: detection, resolution, staging, the fallback.
    expect(b).toContain('blog "interface detected: $WLIF"');
    expect(b).toContain('blog "NO wl* interface visible at build time"');
    expect(b).toContain('blog "driver resolved: $DRV"');
    expect(b).toContain('blog "firmware staged: $1$_v"');
    expect(b).toContain('blog "firmware MISSING: $1');
    expect(b).toContain('blog "driver UNRESOLVED — falling back to the whole wireless module class"');
    expect(b).toContain('blog "MISSING: wpa_supplicant"');
    expect(b).toContain('blog "MISSING: wpa_cli"');
    expect(b).toContain('blog "MISSING: ip"');
    expect(b).toContain('blog "hook done"');
    // The hook can never abort update-initramfs: explicit final exit 0.
    const hookStart = b.indexOf("<<'WIFIHOOK'");
    const hookEnd = b.indexOf("\nWIFIHOOK");
    const hook = b.slice(hookStart, hookEnd);
    expect(hook.trimEnd().endsWith("exit 0")).toBe(true);
  });

  it("boot-time premount brings Wi-Fi up: modprobe + wpa_supplicant + bounded DHCP", () => {
    const b = encBootstrap({ wifiSSID: "HomeNet", wifiPassword: "s3cret" });
    expect(b).toContain("cat > /etc/initramfs-tools/scripts/init-premount/flagship-wifi");
    // Re-detect the wl* iface at boot (name can differ from build time), bounded ~30s.
    expect(b).toContain("grep -E '^wl' | head -1");
    expect(b).toContain("+ 30 ))");
    expect(b).toContain("no wl* interface in 30s — falling through");
    // The premount is written via an UNQUOTED `cat <<WIFIPREMOUNT` heredoc, so the
    // bootstrap text carries the shell vars escaped (`\$DRV`) — the cat un-escapes
    // them to `$DRV` in the on-disk premount.
    expect(b).toContain('modprobe "\\$DRV"');
    expect(b).toContain('ip link set "\\$IF" up');
    // wpa_supplicant against the baked conf.
    expect(b).toContain("wpa_supplicant -B -i");
    expect(b).toContain("/run/flagship-wpa.conf");
    // DHCP: klibc ipconfig preferred, busybox udhcpc fallback — both bounded.
    expect(b).toContain('ipconfig -t 20 "\\$IF"');
    expect(b).toContain('udhcpc -i "\\$IF" -n -q -t 5');
    // Best-effort: a standard premount header, and an exit 0 fall-through.
    expect(b).toContain('PREREQ=""');
    expect(b).toContain("falling through");
  });

  it("the creds are embedded (single-quote-escaped) in the premount, NOT base64", () => {
    // The initramfs is a /bin/sh env (no base64 guaranteed); the creds are on the
    // unencrypted /boot initramfs regardless, so embedding them is not a new
    // exposure. The premount writes them into /run/flagship-wpa.conf.
    const b = encBootstrap({ wifiSSID: "HomeNet", wifiPassword: "s3cret" });
    expect(b).toContain("WIFI_SSID='HomeNet'");
    expect(b).toContain("WIFI_PSK='s3cret'");
    // A quote in the SSID is single-quote-escaped so it can never break out.
    const evil = buildInitramfsWifiBlock("Net's AP", "p'w");
    expect(evil).toContain("WIFI_SSID='Net'\\''s AP'");
    expect(evil).toContain("WIFI_PSK='p'\\''w'");
  });

  it("the premount logs FIRST (before any mount/iface work) so an empty log = never ran", () => {
    const b = encBootstrap({ wifiSSID: "HomeNet", wifiPassword: "s3cret" });
    // "premount start" is logged before the boot-fs mount; the accumulator is
    // seeded into the persistent log after the mount so the early lines survive.
    const startLog = b.indexOf('log_stage "premount start (ssid baked)"');
    const mountAt = b.indexOf("mount /dev/disk/by-label/FLAGSHIP_BOOT", startLog);
    expect(startLog).toBeGreaterThan(0);
    expect(mountAt).toBeGreaterThan(0);
    expect(startLog).toBeLessThan(mountAt);
    // Bounded wait for udev to settle the by-label symlink before mounting.
    expect(b).toContain("while [ ! -e /dev/disk/by-label/FLAGSHIP_BOOT ]; do");
    expect(b).toContain("+ 10 ))");
    // The mount RESULT is logged either way, and the /run prefix is seeded in.
    expect(b).toContain('log_stage "boot fs mounted (persistent log live)"');
    expect(b).toContain('log_stage "boot fs mount FAILED — log stays in /run (survives pivot)"');
    expect(b).toContain("flagship-wifi.log");
  });

  it("the Wi-Fi premount runs BEFORE the unlock relay (init-premount precedes local-top)", () => {
    // init-premount scripts run strictly before local-top in initramfs-tools, so
    // the radio is up before the unlock hook curls the boot relay. We also assert
    // the bootstrap EMITS the Wi-Fi premount before the unlock relay reference, and
    // that the unlock hook still lives under local-top (the directory ordering).
    const b = encBootstrap({ wifiSSID: "HomeNet", wifiPassword: "s3cret" });
    const wifiAt = b.indexOf("init-premount/flagship-wifi");
    const unlockDir = b.indexOf("scripts/local-top/flagship-unlock");
    const relayAt = b.search(/\/api\/boot\/(request|lease)/);
    expect(wifiAt).toBeGreaterThanOrEqual(0);
    expect(unlockDir).toBeGreaterThanOrEqual(0);
    // Wi-Fi premount is in init-premount (runs first); unlock is in local-top.
    expect(b).toContain("/etc/initramfs-tools/scripts/init-premount");
    expect(b).toContain("/etc/initramfs-tools/scripts/local-top/flagship-unlock");
    // And the Wi-Fi block is emitted before update-initramfs rebuilds the initrd.
    const updateAt = b.indexOf("update-initramfs -u");
    expect(wifiAt).toBeLessThan(updateAt);
    expect(relayAt).toBeGreaterThan(0);
  });

  it("the initramfs Wi-Fi block is BYTE-IDENTICAL to the Swift twin (cross-language sha pin)", () => {
    // EngineTests.testInitramfsWifiBlockIsByteIdenticalToTs pins this SAME sha256.
    const s = buildInitramfsWifiBlock("Flagship Test AP", "test-only-not-real");
    expect(createHash("sha256").update(s).digest("hex")).toBe(
      "5a0ad7e25ec0e8bd6b44082797d4dba6838ce025f11947b7cd2d5d69732cb444",
    );
  });
});

// The 2026-06-09 live #27 root-cause: four defects found on real hardware
// (Intel AX211, Debian 13, encrypted Wi-Fi-only). These pin the four fixes.
describe("#27 root-cause fixes — op-mode staging, initramfs DNS, wired net-ensure, safety-net self-heal", () => {
  function encBootstrap(opts: Record<string, unknown> = {}): string {
    const { blob, blobSignatureHex } = signedBlob();
    return extractBootstrap(
      buildAutoinstallUserData({ blob, blobSignatureHex, ...opts }),
    );
  }

  it("FIX 1 — the build hook stages the driver's whole module dir (op-modes are reverse deps)", () => {
    // manual_add_modules iwlwifi does NOT stage iwlmvm (request_module'd at
    // runtime) — the initrd lacked it, iwlwifi loaded firmware but created no
    // interface, and stayed wedged into the full OS too.
    const b = encBootstrap({ wifiSSID: "HomeNet", wifiPassword: "s3cret" });
    expect(b).toContain('d=$(modinfo -n "$DRV" 2>/dev/null)');
    expect(b).toContain("*/kernel/*)");
    expect(b).toContain('sub="kernel/${d#*/kernel/}"');
    expect(b).toContain('sub=$(dirname "$sub")');
    expect(b).toContain('if copy_modules_dir "$sub" 2>/dev/null; then blog "module dir staged: $sub"; else blog "module dir STAGING FAILED: $sub"; fi');
    // The no-DRV wireless-class fallback is kept.
    expect(b).toContain("copy_modules_dir kernel/drivers/net/wireless");
  });

  it("FIX 2 — the Wi-Fi premount belt-and-braces-loads the op-mode + writes /etc/resolv.conf", () => {
    const b = encBootstrap({ wifiSSID: "HomeNet", wifiPassword: "s3cret" });
    // (a) op-mode load right after the driver modprobe (unquoted heredoc ⇒ \$).
    expect(b).toContain('if [ "\\$DRV" = iwlwifi ]; then');
    expect(b).toContain("for m in iwlmvm iwlmld iwldvm; do");
    expect(b).toContain('modprobe "\\$m" 2>/dev/null && log_stage "op-mode loaded: \\$m" && break');
    // (b) DNS: klibc ipconfig records DNS in /run/net-<if>.conf but nothing
    // writes /etc/resolv.conf — tonight's actual failure (curl (6)).
    expect(b).toContain('[ -f "/run/net-\\$IF.conf" ] && . "/run/net-\\$IF.conf"');
    expect(b).toContain('[ -n "\\$_d" ] && [ "\\$_d" != "0.0.0.0" ] && _dns="\\$_dns \\$_d"');
    expect(b).toContain('echo "nameserver \\$_d" >> /etc/resolv.conf');
    expect(b).toContain('log_stage "dns configured:\\$_dns"');
    expect(b).toContain("printf 'nameserver 1.1.1.1\\nnameserver 8.8.8.8\\n' > /etc/resolv.conf");
    expect(b).toContain('log_stage "dns fallback: public resolvers"');
    // The misleading wording is gone: the /run log SURVIVES the pivot
    // (initramfs-tools moves /run onto the root).
    expect(b).not.toContain("lost on pivot)\"");
    expect(b).toContain('log_stage "boot fs mount FAILED — log stays in /run (survives pivot)"');
  });

  it("FIX 3 — the unlock script self-ensures net (wired path) + DNS (both paths)", () => {
    // The wired initramfs had NO networking bring-up at all (no ip=dhcp, no
    // configure_networking) — present on EVERY LUKS burn, wired or Wi-Fi.
    const b = encBootstrap();
    // The hook stages `ip` so the route check always has its tool.
    expect(b).toContain("copy_exec /sbin/ip /sbin/ip 2>/dev/null || copy_exec /bin/ip /sbin/ip");
    // net-ensure: route-check FIRST (Wi-Fi path skips instantly), then link-up
    // + DHCP the first carrier interface, bounded + best-effort.
    expect(b).toContain("if ! ip route 2>/dev/null | grep -q '^default'; then");
    expect(b).toContain('echo "flagship: no default route — bringing up interfaces for DHCP"');
    expect(b).toContain('if [ "$IFW" = "lo" ]; then continue; fi');
    expect(b).toContain('if [ "$(cat "/sys/class/net/$IFW/carrier" 2>/dev/null || echo 0)" != "1" ]; then continue; fi');
    expect(b).toContain('ipconfig -t 20 "$IFW" 2>/dev/null || true');
    expect(b).toContain('udhcpc -i "$IFW" -n -q -t 5 2>/dev/null || true');
    // resolv-ensure runs on BOTH paths, sourcing every /run/net-*.conf.
    expect(b).toContain("if [ ! -s /etc/resolv.conf ]; then");
    expect(b).toContain("for _nc in /run/net-*.conf; do");
    expect(b).toContain('echo "flagship: dns configured:$_rdns"');
    expect(b).toContain('echo "flagship: dns fallback: public resolvers"');
    // Both run before the unlock dispatch.
    expect(b.indexOf("net-ensure")).toBeLessThan(b.indexOf('echo "flagship: boot-unlock mode = $EFFECTIVE_MODE'));
    // The Wi-Fi-only blocks stay ABSENT on a wired burn.
    expect(b).not.toContain("init-premount/flagship-wifi");
    expect(b).not.toContain("flagship-wifi-safetynet");
  });

  it("FIX 4 — the full-OS safety-net persists the initramfs log + reloads idle wireless modules", () => {
    const b = encBootstrap({ wifiSSID: "HomeNet", wifiPassword: "s3cret" });
    // (a) the /run log survives the pivot — persist it under /var/log.
    expect(b).toContain("cp /run/flagship-wifi.log /var/log/flagship-wifi-initramfs.log 2>/dev/null || true");
    // (b) before giving up on "no wireless interface": reload every loaded
    // wireless driver with refcount 0 (the loaded-but-interface-less case),
    // re-scan, and only then give up.
    expect(b).toContain('echo "[safety-net] no wireless interface — reloading idle wireless modules"');
    expect(b).toContain('modinfo -n "$m" 2>/dev/null | grep -q /drivers/net/wireless/ || continue');
    expect(b).toContain('[ "$(cat "/sys/module/$m/refcnt" 2>/dev/null || echo 1)" = "0" ] || continue');
    expect(b).toContain('modprobe -r "$m" 2>/dev/null || true');
    const reload = b.indexOf("reloading idle wireless modules");
    const giveUp = b.indexOf("[safety-net] no wireless interface; giving up");
    expect(reload).toBeGreaterThan(0);
    expect(giveUp).toBeGreaterThan(reload);
  });

  it("the encrypted-off (no-LUKS) bootstrap is untouched — no unlock script at all", () => {
    const b = encBootstrap({ encryptRoot: false });
    expect(b).not.toContain("net-ensure");
    expect(b).not.toContain("resolv.conf");
    expect(b).not.toContain("local-top/flagship-unlock");
    expect(b.trimEnd().endsWith('echo "[flagship-bootstrap] done"')).toBe(true);
  });

  it("the encrypted wired bootstrap is BYTE-IDENTICAL to the Swift twin (cross-language sha pin)", () => {
    // EngineTests.testEncryptedWiredBootstrapIsByteIdenticalToTs pins this SAME
    // sha256 — the unlock hook/premount (which fix 3 changed on every LUKS
    // burn) had no cross-language pin before.
    const s = buildBootstrapScript({
      ref: "main",
      repoUrl: "https://github.com/ibisllc/flagship.git",
      encryptRoot: true,
      bootUnlockMode: "auto",
      bootHost: DEFAULT_BOOT_HOST,
    });
    expect(createHash("sha256").update(s).digest("hex")).toBe(
      "ba0f4fcc758a1fda7f6d6649f941059de0adc17bae8756b3819ecfe0b9ab5c4f",
    );
  });

  it("the encrypted DEBIAN bootstrap is BYTE-IDENTICAL to the Swift twin (cross-language sha pin)", () => {
    // EngineTests.testEncryptedDebianBootstrapIsByteIdenticalToTs pins this SAME
    // sha256. The Debian premount must open the LUKS container under the
    // CRYPTTAB target name (read from /cryptroot/crypttab, e.g. sda4_crypt) so
    // Debian's local-top/cryptroot — which runs after us and skips an
    // already-active target — recognizes the unlock. Opening as flagship_root
    // hung every phone-approved boot at "Please unlock disk" (metal, 2026-06-12).
    const s = buildBootstrapScript({
      ref: "main",
      repoUrl: "https://github.com/ibisllc/flagship.git",
      encryptRoot: true,
      bootUnlockMode: "auto",
      bootHost: DEFAULT_BOOT_HOST,
      family: "debian",
    });
    expect(s).toContain("/cryptroot/crypttab 2>/dev/null | head -n1");
    expect(s).toContain('[ -n "$CRYPT_NAME" ] || CRYPT_NAME=flagship_root');
    expect(s).toContain('cryptsetup luksOpen --key-file - "$ROOT_LUKS_PART" "$CRYPT_NAME"');
    expect(createHash("sha256").update(s).digest("hex")).toBe(
      "21cfa21b7e4a2f64818a841c890264bcd21c49e97fda7e648670426aadfadf40",
    );
  });
});
