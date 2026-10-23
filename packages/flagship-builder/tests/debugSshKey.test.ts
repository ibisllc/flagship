/**
 * DEBUG remote-access image — the `--debug-ssh-key[-file]` bring-up/diagnosis
 * path threaded through the CLI into BOTH installers (buildDebianPreseed +
 * buildDebianPreseed).
 *
 * When a dev SSH key is supplied the image becomes remote-access ONLY: sshd +
 * the key on the `flagship` user, no provisioning, no LUKS re-key — so a
 * first-boot that never registers is still reachable to diagnose. When the key
 * is ABSENT the output must be byte-identical to the production image (this is
 * what keeps the field safe to plumb everywhere). These pin both halves for the
 * two installers, since the VM-appliance `prepare` path can now bake a key.
 */
import { describe, it, expect } from "vitest";
import {
  signAuthCode,
  signInstallBlob,
  ed,
  type AuthCode,
  type InstallBlob,
} from "@flagship/protocol";
import { buildDebianPreseed } from "../src/preseed.js";

function makeKeypair(seedByte: number) {
  const sk = new Uint8Array(32).fill(seedByte);
  return { privateKey: sk, publicKey: ed.getPublicKey(sk) };
}
function hx(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

function baseOptions() {
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
    issuedAt: 1_700_000_000_000,
    expiresAt: 1_700_000_000_000 + 6 * 60 * 60_000,
  };
  const blob: InstallBlob = {
    version: 2,
    serverDomain: authCode.serverDomain,
    username: authCode.username,
    serverName: authCode.serverName,
    phoneDelegatedPubKey: delegate.publicKey,
    registrationUrl: "https://flagshipserver.com/api/server/register",
    authCode,
    authCodeUserSignature: signAuthCode(authCode, irk),
    installerGitRef: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    rckPubKey: rck.publicKey,
  };
  return { blob, blobSignatureHex: hx(signInstallBlob(blob, irk)) };
}

const DEV_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITESTKEYdiagnostic dev@flagship";

/** Decode the first-boot bootstrap out of the preseed's in-target echo. */
function bootstrapFromPreseed(cfg: string): string {
  const m = cfg.match(
    /echo '([A-Za-z0-9+/=]+)' \| base64 -d > \/target\/usr\/local\/sbin\/flagship-bootstrap\.sh/,
  );
  if (!m) throw new Error("bootstrap not found in preseed");
  return Buffer.from(m[1]!, "base64").toString("utf8");
}

describe("--debug-ssh-key threads into the Debian preseed (the VM prepare path)", () => {
  it("with a key: sshd + the key on `flagship`, and NO provisioning / NO re-key", () => {
    const cfg = buildDebianPreseed({ ...baseOptions(), debugSshAuthorizedKey: DEV_KEY });
    const bootstrap = bootstrapFromPreseed(cfg);
    expect(bootstrap).toContain("Flagship DEBUG bootstrap");
    expect(bootstrap).toContain(DEV_KEY);
    expect(bootstrap).toContain("/home/flagship/.ssh/authorized_keys");
    expect(bootstrap).toContain("openssh-server");
    // The whole point: it is NOT the provisioning bootstrap.
    expect(bootstrap).not.toContain("flagship-daemon");
    expect(bootstrap).not.toContain("gen-identity");
  });

  it("absent key === byte-identical to the production preseed", () => {
    const opts = baseOptions();
    const production = buildDebianPreseed(opts);
    const explicitUndefined = buildDebianPreseed({ ...opts, debugSshAuthorizedKey: undefined });
    expect(explicitUndefined).toBe(production);
    expect(bootstrapFromPreseed(production)).not.toContain("Flagship DEBUG bootstrap");
  });
});
