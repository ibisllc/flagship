/**
 * Runs the box's real scripts/flagship-trailer-validate against trailers
 * signed by @flagship/protocol, so its hand-rolled InstallBlob v2 canonical
 * (optional appends included) is proven against the source of truth rather
 * than against a transcribed copy. It runs twice: from this package (ESM,
 * "type": "module") and copied to a bare directory the way the apkovl
 * installs it to /usr/local/bin (CommonJS, no package.json).
 */
import { afterAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deriveIRK,
  ed,
  signAuthCode,
  verifyAuthCode,
  type AuthCode,
  type InstallBlob,
} from "@flagship/protocol";
import { buildTrailer, installBlobToJson } from "@flagship/iso-personalizer";

const SCRIPT = join(__dirname, "..", "scripts", "flagship-trailer-validate");
const irk = deriveIRK({ seed: new Uint8Array(32).fill(11) });
const work = mkdtempSync(join(tmpdir(), "trailer-validate-"));
const bareScript = join(work, "flagship-trailer-validate");
copyFileSync(SCRIPT, bareScript);
afterAll(() => rmSync(work, { recursive: true, force: true }));

function key(fill: number): Uint8Array {
  return ed.getPublicKey(new Uint8Array(32).fill(fill));
}

function blob(extra: { adminRoot?: boolean } & Partial<InstallBlob> = {}): InstallBlob {
  const { adminRoot, ...overrides } = extra;
  const code: AuthCode = {
    version: 1,
    serial: "01HXAFVALIDATE01",
    username: "harry",
    serverName: "home",
    serverDomain: "home.harry.flagship.services",
    delegatedPubKey: key(3),
    userPubKey: irk.publicKey,
    issuedAt: 1_700_000_000_000,
    expiresAt: 1_700_000_000_000 + 3_600_000,
    ...(adminRoot ? { adminRootPubKey: key(5) } : {}),
  };
  return {
    version: 2,
    serverDomain: code.serverDomain,
    username: code.username,
    serverName: code.serverName,
    phoneDelegatedPubKey: code.delegatedPubKey,
    registrationUrl: "https://flagship.services/api/server/register",
    authCode: code,
    authCodeUserSignature: signAuthCode(code, irk),
    installerGitRef: "main",
    rckPubKey: key(9),
    ...overrides,
  };
}

let n = 0;
/** A fake device: padding, then the trailer at the very end. */
function device(trailer: Uint8Array): string {
  const path = join(work, `dev-${n++}.img`);
  writeFileSync(path, Buffer.concat([Buffer.alloc(4096, 0xaa), Buffer.from(trailer)]));
  return path;
}

function validate(script: string, path: string) {
  const r = spawnSync(process.execPath, [script, path], { encoding: "utf8" });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** Rewrite the trailer's JSON while keeping the original signature. */
function tampered(b: InstallBlob, edit: (j: Record<string, any>) => void): Uint8Array {
  const good = buildTrailer(b, irk).bytes;
  const json = installBlobToJson(b) as unknown as Record<string, any>;
  edit(json);
  const body = Buffer.from(JSON.stringify(json));
  const sig = good.subarray(good.length - 4 - 16 - 64, good.length - 4 - 16);
  const total = 16 + 1 + 4 + body.length + 64 + 16 + 4;
  const out = Buffer.alloc(total);
  let o = 0;
  out.write("FLAGSHIP-BOOT\0\0\0", o, "binary"); o += 16;
  out[o++] = 1;
  out.writeUInt32LE(body.length, o); o += 4;
  body.copy(out, o); o += body.length;
  Buffer.from(sig).copy(out, o); o += 64;
  Buffer.concat([Buffer.from([0, 0, 0]), Buffer.from("FLAGSHIP-END"), Buffer.from([0])]).copy(out, o); o += 16;
  out.writeUInt32LE(total, o);
  return out;
}

const cases: Array<[string, InstallBlob]> = [
  ["a minimal recipe", blob()],
  ["bootUnlockMode", blob({ bootUnlockMode: "approve" })],
  ["diskEncryption", blob({ diskEncryption: "none" })],
  ["every optional signed field", blob({ adminRoot: true, bootUnlockMode: "auto", diskEncryption: "luks" })],
];

for (const [label, script] of [["package (ESM)", SCRIPT], ["installed (CommonJS)", bareScript]] as const) {
  describe(`flagship-trailer-validate as ${label}`, () => {
    for (const [name, b] of cases) {
      it(`accepts ${name} signed by @flagship/protocol`, () => {
        const r = validate(script, device(buildTrailer(b, irk).bytes));
        expect(r.stderr).toBe("");
        expect(r.code).toBe(0);
        expect(JSON.parse(r.stdout)).toEqual(installBlobToJson(b));
      });
    }

    it("hands registration an authCode that still verifies, admin root included", () => {
      const b = blob({ adminRoot: true, diskEncryption: "none" });
      const out = JSON.parse(validate(script, device(buildTrailer(b, irk).bytes)).stdout);
      expect(out.authCode.adminRootPubKey).toBe(Buffer.from(key(5)).toString("hex"));
      expect(verifyAuthCode(b.authCode, b.authCodeUserSignature, irk.publicKey)).toBe(true);
    });

    it("refuses a trailer whose diskEncryption was flipped after signing", () => {
      const b = blob({ diskEncryption: "luks" });
      const r = validate(script, device(tampered(b, (j) => { j.diskEncryption = "none"; })));
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/does not verify/);
    });

    it("refuses a trailer whose diskEncryption was stripped", () => {
      const b = blob({ diskEncryption: "luks" });
      const r = validate(script, device(tampered(b, (j) => { delete j.diskEncryption; })));
      expect(r.code).toBe(1);
    });

    it("refuses a separator smuggled into a free-text field", () => {
      const r = validate(script, device(tampered(blob(), (j) => { j.serverName = "home|x"; })));
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/separator/);
    });
  });
}
