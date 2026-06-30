/**
 * Box-side enforcement of the owner-authorized debug-access grant
 * (docs/recipe-delivery-and-remote-install.md).
 *
 * The recipe carries an UNSIGNED `debugGrant` install-blob sibling (a JSON
 * string of `{grant,signatureHex}`); the daemon enables the `debug` console user
 * + installs its SSH key ONLY if the owner-IRK signature verifies under the
 * config-pinned owner IRK AND the grant names THIS box. These tests cover:
 *   - the happy path: a verified grant → useradd + key install + marker;
 *   - absent grant (no sibling / no blob) → no-op (stays a production image);
 *   - a forged / wrong-IRK signature → no-op (NEVER enables);
 *   - a wrong serverDomain → no-op;
 *   - idempotency: a re-run with the marker present never re-applies.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ed,
  signDebugAccessGrant,
  type DebugAccessGrant,
  type Keypair,
} from "@flagship/protocol";
import {
  runDebugAccessGate,
  type DebugCommandRunner,
  type DebugMarkerStore,
} from "../src/debugAccessGate.js";

const DOMAIN = "home.alice.flagship.services";
const SSH_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleKeyBytes alice@phone";

function makeKey(seed: number): Keypair {
  const priv = new Uint8Array(32).fill(seed);
  return { privateKey: priv, publicKey: ed.getPublicKey(priv) };
}
function hex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

/** Records every command the gate would run, so we assert the effects. */
function recordingRunner(): DebugCommandRunner & { calls: Array<[string, string[]]> } {
  const calls: Array<[string, string[]]> = [];
  return {
    calls,
    async run(cmd, args) {
      calls.push([cmd, args]);
    },
  };
}

/** Records the config/banner files the gate writes, so tests never touch /etc. */
function recordingWriter(): {
  write: (p: string, c: string, m?: number) => Promise<void>;
  files: Array<[string, string]>;
} {
  const files: Array<[string, string]> = [];
  return {
    files,
    async write(p, c) {
      files.push([p, c]);
    },
  };
}

function memMarker(): DebugMarkerStore & { marked: boolean } {
  const state = { marked: false };
  return {
    get marked() {
      return state.marked;
    },
    async has() {
      return state.marked;
    },
    async mark() {
      state.marked = true;
    },
  };
}

let dir: string;
const savedEnv = process.env.FLAGSHIP_INSTALL_BLOB;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "flagship-debug-gate-"));
});
afterEach(async () => {
  if (savedEnv === undefined) delete process.env.FLAGSHIP_INSTALL_BLOB;
  else process.env.FLAGSHIP_INSTALL_BLOB = savedEnv;
  await rm(dir, { recursive: true, force: true });
});

/** Write an install blob carrying (optionally) a `debugGrant` sibling. */
async function writeBlob(obj: Record<string, unknown>): Promise<string> {
  const p = join(dir, "install-blob.json");
  await writeFile(p, JSON.stringify(obj));
  process.env.FLAGSHIP_INSTALL_BLOB = p;
  return p;
}

function grantSibling(grant: DebugAccessGrant, signer: Keypair): string {
  return JSON.stringify({
    grant,
    signatureHex: hex(signDebugAccessGrant(grant, signer)),
  });
}

describe("runDebugAccessGate", () => {
  it("(a) valid grant → enables the debug user + installs the SSH key + marks", async () => {
    const owner = makeKey(1);
    const grant: DebugAccessGrant = {
      serverDomain: DOMAIN,
      sshAuthorizedKey: SSH_KEY,
      issuedAt: 1_700_000_000,
    };
    await writeBlob({ serverDomain: DOMAIN, debugGrant: grantSibling(grant, owner) });

    const runner = recordingRunner();
    const marker = memMarker();
    const writer = recordingWriter();
    let installedKey: string | null = null;

    const out = await runDebugAccessGate({
      serverDomain: DOMAIN,
      ownerIrkPub: owner.publicKey,
      markerStore: marker,
      runner,
      homeDir: join(dir, "home", "debug"),
      installAuthorizedKey: async (key) => {
        installedKey = key;
      },
      writeConfigFile: writer.write,
    });

    expect(out).toEqual({ enabled: true });
    expect(marker.marked).toBe(true);
    // The debug user is created.
    expect(runner.calls.some(([c, a]) => c === "useradd" && a.includes("debug"))).toBe(true);
    // The SSH key was installed (trimmed).
    expect(installedKey).toBe(SSH_KEY);
    // A known password is set (the load-bearing GA-guard line) so password SSH works.
    expect(
      runner.calls.some(
        ([c, a]) => c === "bash" && a.join(" ").includes("debug:flagship") && a.join(" ").includes("chpasswd"),
      ),
    ).toBe(true);
    // sshd is ensured enabled + a password-auth drop-in is written.
    expect(runner.calls.some(([c, a]) => c === "systemctl" && a.includes("ssh"))).toBe(true);
    expect(writer.files.some(([p]) => p.includes("sshd_config.d"))).toBe(true);
    // A console banner with the live LAN IP (\4) + creds is written.
    const banner = writer.files.find(([p]) => p.includes("issue.d"));
    expect(banner).toBeTruthy();
    expect(banner![1]).toContain("\\4");
    expect(banner![1]).toContain("flagship");
  });

  it("(a') valid grant with an empty SSH key → enables the user, no key install", async () => {
    const owner = makeKey(2);
    const grant: DebugAccessGrant = { serverDomain: DOMAIN, sshAuthorizedKey: "", issuedAt: 5 };
    await writeBlob({ debugGrant: grantSibling(grant, owner) });

    const runner = recordingRunner();
    const writer = recordingWriter();
    let installCalled = false;

    const out = await runDebugAccessGate({
      serverDomain: DOMAIN,
      ownerIrkPub: owner.publicKey,
      markerStore: memMarker(),
      runner,
      installAuthorizedKey: async () => {
        installCalled = true;
      },
      writeConfigFile: writer.write,
    });

    expect(out).toEqual({ enabled: true });
    expect(runner.calls.some(([c]) => c === "useradd")).toBe(true);
    expect(installCalled).toBe(false);
    // No chown/chmod of the .ssh dir either (no key path).
    expect(runner.calls.some(([c]) => c === "chmod")).toBe(false);
    // BUT a known password IS still set (the easy LAN-SSH path with no key) + banner.
    expect(
      runner.calls.some(([c, a]) => c === "bash" && a.join(" ").includes("debug:flagship")),
    ).toBe(true);
    expect(writer.files.some(([p]) => p.includes("issue.d"))).toBe(true);
  });

  it("(b) absent grant (no sibling) → no-op", async () => {
    const owner = makeKey(3);
    await writeBlob({ serverDomain: DOMAIN });

    const runner = recordingRunner();
    const out = await runDebugAccessGate({
      serverDomain: DOMAIN,
      ownerIrkPub: owner.publicKey,
      markerStore: memMarker(),
      runner,
    });

    expect(out).toEqual({ enabled: false, reason: "no-grant" });
    expect(runner.calls).toHaveLength(0);
  });

  it("(b') absent install blob entirely → no-op", async () => {
    const owner = makeKey(3);
    process.env.FLAGSHIP_INSTALL_BLOB = join(dir, "does-not-exist.json");

    const runner = recordingRunner();
    const out = await runDebugAccessGate({
      serverDomain: DOMAIN,
      ownerIrkPub: owner.publicKey,
      markerStore: memMarker(),
      runner,
    });

    expect(out).toEqual({ enabled: false, reason: "no-grant" });
    expect(runner.calls).toHaveLength(0);
  });

  it("(c) forged / wrong-IRK signature → no-op, does NOT enable", async () => {
    const owner = makeKey(4);
    const attacker = makeKey(99);
    const grant: DebugAccessGrant = {
      serverDomain: DOMAIN,
      sshAuthorizedKey: SSH_KEY,
      issuedAt: 7,
    };
    // Signed by the ATTACKER, but the gate verifies against the OWNER IRK.
    await writeBlob({ debugGrant: grantSibling(grant, attacker) });

    const runner = recordingRunner();
    const marker = memMarker();
    const out = await runDebugAccessGate({
      serverDomain: DOMAIN,
      ownerIrkPub: owner.publicKey,
      markerStore: marker,
      runner,
    });

    expect(out).toEqual({ enabled: false, reason: "rejected" });
    expect(runner.calls).toHaveLength(0);
    expect(marker.marked).toBe(false);
  });

  it("(c') tampered grant body (valid sig over DIFFERENT fields) → no-op", async () => {
    const owner = makeKey(5);
    const signed: DebugAccessGrant = { serverDomain: DOMAIN, sshAuthorizedKey: "", issuedAt: 1 };
    const sig = hex(signDebugAccessGrant(signed, owner));
    // Swap in a different SSH key after signing — the signature no longer covers it.
    const tampered = JSON.stringify({
      grant: { serverDomain: DOMAIN, sshAuthorizedKey: SSH_KEY, issuedAt: 1 },
      signatureHex: sig,
    });
    await writeBlob({ debugGrant: tampered });

    const runner = recordingRunner();
    const out = await runDebugAccessGate({
      serverDomain: DOMAIN,
      ownerIrkPub: owner.publicKey,
      markerStore: memMarker(),
      runner,
    });

    expect(out).toEqual({ enabled: false, reason: "rejected" });
    expect(runner.calls).toHaveLength(0);
  });

  it("(d) grant names a DIFFERENT box → no-op", async () => {
    const owner = makeKey(6);
    const grant: DebugAccessGrant = {
      serverDomain: "other.bob.flagship.services",
      sshAuthorizedKey: SSH_KEY,
      issuedAt: 9,
    };
    await writeBlob({ debugGrant: grantSibling(grant, owner) });

    const runner = recordingRunner();
    const out = await runDebugAccessGate({
      serverDomain: DOMAIN, // this box is alice's, not bob's
      ownerIrkPub: owner.publicKey,
      markerStore: memMarker(),
      runner,
    });

    expect(out).toEqual({ enabled: false, reason: "rejected" });
    expect(runner.calls).toHaveLength(0);
  });

  it("(e) idempotent: a re-run with the marker present never re-applies", async () => {
    const owner = makeKey(7);
    const grant: DebugAccessGrant = {
      serverDomain: DOMAIN,
      sshAuthorizedKey: SSH_KEY,
      issuedAt: 11,
    };
    await writeBlob({ debugGrant: grantSibling(grant, owner) });

    const marker = memMarker();
    const runner1 = recordingRunner();
    const first = await runDebugAccessGate({
      serverDomain: DOMAIN,
      ownerIrkPub: owner.publicKey,
      markerStore: marker,
      runner: runner1,
      installAuthorizedKey: async () => {},
      writeConfigFile: async () => {},
    });
    expect(first).toEqual({ enabled: true });
    expect(marker.marked).toBe(true);

    const runner2 = recordingRunner();
    const second = await runDebugAccessGate({
      serverDomain: DOMAIN,
      ownerIrkPub: owner.publicKey,
      markerStore: marker,
      runner: runner2,
      installAuthorizedKey: async () => {
        throw new Error("should not run on the second pass");
      },
    });
    expect(second).toEqual({ enabled: false, reason: "already-enabled" });
    expect(runner2.calls).toHaveLength(0);
  });

  it("(f) case-insensitive FQDN match still enables", async () => {
    const owner = makeKey(8);
    const grant: DebugAccessGrant = {
      serverDomain: DOMAIN.toUpperCase(),
      sshAuthorizedKey: "",
      issuedAt: 3,
    };
    await writeBlob({ debugGrant: grantSibling(grant, owner) });

    const out = await runDebugAccessGate({
      serverDomain: DOMAIN,
      ownerIrkPub: owner.publicKey,
      markerStore: memMarker(),
      runner: recordingRunner(),
      writeConfigFile: async () => {},
    });
    expect(out).toEqual({ enabled: true });
  });
});
