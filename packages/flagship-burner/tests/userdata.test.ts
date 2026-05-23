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
