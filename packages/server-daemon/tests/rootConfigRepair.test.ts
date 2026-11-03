import { execFileSync } from "node:child_process";
import { chmod, link, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ed, signAuthCode, signInstallBlob, type InstallBlob } from "@flagship/protocol";
import { buildBootstrapScript, DEFAULT_BOOT_HOST, installBlobToJson } from "../../flagship-builder/src/userdata.js";
import { controlPlaneBaseFromRegistrationUrl, repairRootConfig, rootConfigFromBlob } from "../src/rootConfigRepair.js";

const irkPriv = ed.utils.randomPrivateKey();
const irk = { privateKey: irkPriv, publicKey: ed.getPublicKey(irkPriv) };
const key = (b: number) => new Uint8Array(32).fill(b);

function signedBlobJson(over: Partial<InstallBlob> = {}, adminRoot = true): Record<string, unknown> {
  const authCode: InstallBlob["authCode"] = {
    version: 1,
    serial: "S123",
    username: "alice",
    serverName: "home",
    serverDomain: "home.alice.flagship.services",
    delegatedPubKey: key(2),
    userPubKey: irk.publicKey,
    issuedAt: 1_700_000_000_000,
    expiresAt: 1_700_086_400_000,
    ...(adminRoot ? { adminRootPubKey: key(0xef) } : {}),
  };
  const blob: InstallBlob = {
    version: 2,
    serverDomain: "home.alice.flagship.services",
    username: "alice",
    serverName: "home",
    phoneDelegatedPubKey: key(0xab),
    registrationUrl: "https://gym.flagshipserver.com/api/server/register",
    authCode,
    authCodeUserSignature: signAuthCode(authCode, irk),
    installerGitRef: "a".repeat(40),
    rckPubKey: key(3),
    bootUnlockMode: "approve",
    diskEncryption: "luks",
    ...over,
  };
  return installBlobToJson(blob, Buffer.from(signInstallBlob(blob, irk)).toString("hex"));
}

let dir: string;
let boot: string;
let etc: string;
const uid = process.getuid!();
const logs: string[] = [];
const deps = () => ({ bootBlobPath: join(boot, "install-blob.json"), configPath: join(etc, "config.json"), envPath: join(etc, "daemon.env"), rootUid: uid, log: (m: string) => logs.push(m) });
const OLD_ENV = "FLAGSHIP_SUBDOMAIN=home.alice.flagship.services\nFLAGSHIP_IDENTITY_PRIV_HEX=00\n";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "root-config-"));
  boot = join(dir, "boot");
  etc = join(dir, "etc");
  await mkdir(boot, { mode: 0o755 });
  await mkdir(etc, { mode: 0o755 });
  await chmod(boot, 0o755);
  await writeFile(join(boot, "install-blob.json"), JSON.stringify(signedBlobJson()), { mode: 0o600 });
  await writeFile(join(etc, "daemon.env"), OLD_ENV, { mode: 0o600 });
  logs.length = 0;
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe("root rebuilds what an older bootstrap left out", () => {
  it("writes config.json 0600 and both daemon.env keys from a valid root-owned blob, once", async () => {
    expect(await repairRootConfig(deps())).toEqual({ repaired: ["config", "control-plane", "config-path"] });
    const cfg = JSON.parse(await readFile(join(etc, "config.json"), "utf8"));
    expect(cfg).toEqual({
      serverId: "home.alice.flagship.services",
      userId: "alice",
      bakPublicKey: "ab".repeat(32),
      irkPublicKey: Buffer.from(irk.publicKey).toString("hex"),
      adminRootPubHex: "ef".repeat(32),
    });
    expect((await stat(join(etc, "config.json"))).mode & 0o777).toBe(0o600);
    expect(await readFile(join(etc, "daemon.env"), "utf8")).toBe(
      `${OLD_ENV}FLAGSHIP_CONTROL_PLANE_BASE_URL=https://gym.flagshipserver.com\nFLAGSHIP_CONFIG=${join(etc, "config.json")}\n`,
    );
    expect(logs).toHaveLength(1);
    const env = await readFile(join(etc, "daemon.env"), "utf8");
    expect(await repairRootConfig(deps())).toEqual({ repaired: [] });
    expect(await readFile(join(etc, "daemon.env"), "utf8")).toBe(env);
    expect(logs).toHaveLength(1);
  });

  it("leaves an existing config.json and daemon.env keys alone", async () => {
    await writeFile(join(etc, "config.json"), "{\"mine\":1}", { mode: 0o600 });
    await writeFile(join(etc, "daemon.env"), `${OLD_ENV}FLAGSHIP_CONTROL_PLANE_BASE_URL=https://x.example\n`);
    expect(await repairRootConfig(deps())).toEqual({ repaired: ["config-path"] });
    expect(await readFile(join(etc, "config.json"), "utf8")).toBe("{\"mine\":1}");
    expect(await readFile(join(etc, "daemon.env"), "utf8")).toBe(`${OLD_ENV}FLAGSHIP_CONTROL_PLANE_BASE_URL=https://x.example\nFLAGSHIP_CONFIG=${join(etc, "config.json")}\n`);
  });

  const refusedCase = async (setup: () => Promise<void>, why: RegExp) => {
    await setup();
    const r = await repairRootConfig(deps());
    expect(r.repaired).toEqual([]);
    expect(r.refused).toMatch(why);
    await expect(stat(join(etc, "config.json"))).rejects.toThrow();
    expect(await readFile(join(etc, "daemon.env"), "utf8")).toBe(OLD_ENV);
    expect(logs).toHaveLength(1);
  };

  it("refuses a group- or world-writable blob", () => refusedCase(() => chmod(join(boot, "install-blob.json"), 0o620), /writable by others/));
  it("refuses a world-writable /boot", () => refusedCase(() => chmod(boot, 0o777), /not root's alone/));
  it("refuses a blob (and /boot) root doesn't own", async () => {
    const r = await repairRootConfig({ ...deps(), rootUid: uid + 1 });
    expect(r).toEqual({ repaired: [], refused: expect.stringMatching(/not root's alone/) });
    await expect(stat(join(etc, "config.json"))).rejects.toThrow();
  });
  it("refuses a symlink", () => refusedCase(async () => {
    await writeFile(join(dir, "elsewhere.json"), JSON.stringify(signedBlobJson()), { mode: 0o600 });
    await rm(join(boot, "install-blob.json"));
    await symlink(join(dir, "elsewhere.json"), join(boot, "install-blob.json"));
  }, /is a link/));
  it("refuses a hard-linked blob", () => refusedCase(() => link(join(boot, "install-blob.json"), join(boot, "second-name.json")), /more than one name/));
  it("refuses a bad signature", () => refusedCase(async () => {
    const b = signedBlobJson();
    await writeFile(join(boot, "install-blob.json"), JSON.stringify({ ...b, registrationUrl: "https://evil.example/api/server/register" }), { mode: 0o600 });
  }, /isn't signed by the owner/));
  it("refuses a swapped admin root in the AuthCode", () => refusedCase(async () => {
    const b = signedBlobJson();
    await writeFile(join(boot, "install-blob.json"), JSON.stringify({ ...b, authCode: { ...(b.authCode as object), adminRootPubKey: "99".repeat(32) } }), { mode: 0o600 });
  }, /AuthCode isn't signed/));
  it("refuses a blob for another server than root's daemon.env names", async () => {
    const env = OLD_ENV.replace("home.alice", "work.alice");
    await writeFile(join(etc, "daemon.env"), env);
    expect((await repairRootConfig(deps())).refused).toMatch(/another server/);
    await expect(stat(join(etc, "config.json"))).rejects.toThrow();
    expect(await readFile(join(etc, "daemon.env"), "utf8")).toBe(env);
  });
  it("does nothing destructive without a /boot copy", () => refusedCase(() => rm(join(boot, "install-blob.json")), /is missing/));
});

describe("the TS config and the bootstrap's jq program stay one", () => {
  it("derives the control plane as the bootstrap's sed does", () => {
    expect(controlPlaneBaseFromRegistrationUrl("https://flagshipserver.com/api/server/register")).toBe("https://flagshipserver.com");
    expect(controlPlaneBaseFromRegistrationUrl("http://localhost:8787/api/server/register")).toBe("http://localhost:8787");
    expect(controlPlaneBaseFromRegistrationUrl("ftp://x/api/server/register")).toBeNull();
    expect(controlPlaneBaseFromRegistrationUrl("https://a\nFLAGSHIP_X=1/api/server/register")).toBeNull();
  });

  const hasJq = (() => {
    try {
      execFileSync("jq", ["--version"]);
      return true;
    } catch {
      return false;
    }
  })();
  describe.skipIf(!hasJq)("byte for byte against jq", () => {
    const script = buildBootstrapScript({ ref: "a".repeat(40), repoUrl: "https://github.com/ibisllc/flagship.git", encryptRoot: true, bootUnlockMode: "approve", bootHost: DEFAULT_BOOT_HOST });
    const program = script.split("jq -ce '")[1]!.split("' \\\n    \"$BLOB_JSON\"")[0]!;
    const jq = (blob: unknown): string | null => {
      try {
        return execFileSync("jq", ["-ce", program], { input: JSON.stringify(blob), encoding: "utf8" });
      } catch {
        return null;
      }
    };
    const ts = (blob: unknown): string | null => {
      const c = rootConfigFromBlob(blob);
      return c ? `${JSON.stringify(c)}\n` : null;
    };
    const K = (b: string) => b.repeat(32);
    const base = signedBlobJson();
    const samples: unknown[] = [
      base,
      signedBlobJson({}, false),
      { ...base, ownerAidPubHex: K("1A") },
      { ...base, authCode: { ...(base.authCode as object), adminRootPubKey: "nope" }, adminRootPubHex: K("99") },
      { ...base, phoneDelegatedPubKey: K("AB"), authCode: { userPubKey: K("CD") } },
      { ...base, ownerAidPubHex: "short" },
      { ...base, serverDomain: "näme.alice/x\"y" },
      { ...base, authCode: { userPubKey: "nope" } },
      { ...base, phoneDelegatedPubKey: null },
      { ...base, username: 7 },
      { ...base, authCode: null },
    ];
    it.each(samples.map((s, i) => [i, s]))("sample %i", (_i, s) => {
      expect(ts(s)).toBe(jq(s));
    });
  });
});
