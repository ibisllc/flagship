/**
 * Runs the real `parse-trailer.sh` against protocol-signed InstallBlob v2
 * trailers built by the real trailer serializer. The script used to rebuild
 * the obsolete v1 payload (`|1|…|issuedAt|expiresAt`), so it could not verify
 * any current recipe. PATH holds only the tools a d-i environment has, minus
 * python3, so the openssl verify path is the one exercised.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deriveIRK,
  ed,
  signAuthCode,
  type AuthCode,
  type InstallBlob,
} from "@flagship/protocol";
import { buildTrailer, installBlobToJson } from "../../iso-personalizer/src/trailer.js";

const SCRIPT = join(__dirname, "..", "parse-trailer.sh");
const owner = deriveIRK({ seed: new Uint8Array(32).fill(11) });
const stranger = deriveIRK({ seed: new Uint8Array(32).fill(99) });

function keypair(n: number) {
  const sk = new Uint8Array(32).fill(n);
  return { privateKey: sk, publicKey: ed.getPublicKey(sk) };
}

function blob(overrides: Partial<InstallBlob> = {}, codeExtra: Partial<AuthCode> = {}): InstallBlob {
  const delegated = keypair(3).publicKey;
  const code: AuthCode = {
    version: 1,
    serial: "01HXAFEXAMPLE0001",
    username: "harry",
    serverName: "home",
    serverDomain: "home.harry.flagship.services",
    delegatedPubKey: delegated,
    userPubKey: owner.publicKey,
    issuedAt: 1_700_000_000_000,
    expiresAt: 1_700_000_000_000 + 3_600_000,
    ...codeExtra,
  };
  return {
    version: 2,
    serverDomain: code.serverDomain,
    username: code.username,
    serverName: code.serverName,
    phoneDelegatedPubKey: delegated,
    registrationUrl: "https://flagship.services/api/server/register",
    authCode: code,
    authCodeUserSignature: signAuthCode(code, owner),
    installerGitRef: "main",
    rckPubKey: keypair(5).publicKey,
    ...overrides,
  };
}

let work: string;
let tools: string;

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "netboot-trailer-"));
  tools = join(work, "bin");
  spawnSync("mkdir", [tools]);
  for (const t of ["dd", "xxd", "jq", "openssl", "base64", "fold", "tr", "mktemp", "rm", "stat", "wc", "cat"]) {
    const found = spawnSync("/bin/sh", ["-c", `command -v ${t}`], { encoding: "utf8" }).stdout.trim();
    if (found) symlinkSync(found, join(tools, t));
  }
});

afterAll(() => rmSync(work, { recursive: true, force: true }));

/** A disk image ending in the trailer, then the script's verdict. */
function run(trailer: Uint8Array) {
  const img = join(work, `disk-${Math.random().toString(36).slice(2)}.img`);
  const disk = new Uint8Array(4096 + trailer.length);
  disk.set(trailer, 4096);
  writeFileSync(img, disk);
  return spawnSync("/bin/bash", [SCRIPT, img], {
    encoding: "utf8",
    env: { PATH: tools },
  });
}

/** Re-pack a trailer around edited JSON with the ORIGINAL signature. */
function repack(original: Uint8Array, json: object): Uint8Array {
  const sigOff = 21 + new DataView(original.buffer, original.byteOffset + 17, 4).getUint32(0, true);
  const sig = original.subarray(sigOff, sigOff + 64);
  const body = new TextEncoder().encode(JSON.stringify(json));
  const total = 16 + 1 + 4 + body.length + 64 + 16 + 4;
  const out = new Uint8Array(total);
  out.set(original.subarray(0, 17), 0);
  new DataView(out.buffer).setUint32(17, body.length, true);
  out.set(body, 21);
  out.set(sig, 21 + body.length);
  out.set(original.subarray(sigOff + 64, sigOff + 80), 21 + body.length + 64);
  new DataView(out.buffer).setUint32(total - 4, total, true);
  return out;
}

describe("parse-trailer.sh verifies InstallBlob v2", () => {
  it("has the tools it needs on this host (openssl 3, jq, xxd)", () => {
    for (const t of ["openssl", "jq", "xxd"]) expect(existsSync(join(tools, t))).toBe(true);
  });

  it("accepts a minimal signed blob and emits its fields", () => {
    const r = run(buildTrailer(blob(), owner).bytes);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("FLAGSHIP_USERNAME='harry'");
    expect(r.stdout).toContain("FLAGSHIP_SERVER_DOMAIN='home.harry.flagship.services'");
  });

  it("accepts a blob carrying every optional signed field", () => {
    const b = blob(
      { bootUnlockMode: "approve", diskEncryption: "none" },
      { adminRootPubKey: keypair(7).publicKey },
    );
    const r = run(buildTrailer(b, owner).bytes);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
  });

  it("accepts an empty installerGitRef (it means main)", () => {
    expect(run(buildTrailer(blob({ installerGitRef: "" }), owner).bytes).status).toBe(0);
  });

  it("refuses a blob signed by a different key than its userPubKey", () => {
    const r = run(buildTrailer(blob(), stranger).bytes);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/does NOT verify/);
  });

  it("refuses a downgrade of a signed optional field", () => {
    const b = blob({ diskEncryption: "luks" });
    const signed = buildTrailer(b, owner).bytes;
    const tampered = repack(signed, { ...installBlobToJson(b), diskEncryption: "none" });
    expect(run(tampered).status).toBe(1);
  });

  it("refuses stripping a signed optional field", () => {
    const b = blob({ bootUnlockMode: "approve" });
    const signed = buildTrailer(b, owner).bytes;
    const { bootUnlockMode: _dropped, ...stripped } = installBlobToJson(b);
    expect(run(repack(signed, stripped)).status).toBe(1);
  });

  it("refuses an unknown optional-field value outright", () => {
    const b = blob();
    const signed = buildTrailer(b, owner).bytes;
    const r = run(repack(signed, { ...installBlobToJson(b), diskEncryption: "plaintext" }));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/invalid diskEncryption/);
  });

  it("refuses a v1 blob", () => {
    const b = blob();
    const signed = buildTrailer(b, owner).bytes;
    const r = run(repack(signed, { ...installBlobToJson(b), version: 1 }));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/unsupported InstallBlob version/);
  });
});

