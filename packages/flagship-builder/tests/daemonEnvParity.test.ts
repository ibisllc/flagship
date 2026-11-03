/**
 * The ISO/USB bootstrap must give the daemon what the cloud-init path gives it. On 2026-11-03
 * three gym boxes installed from the ISO unlocked, showed their server code and then never
 * reached `.com`: the ISO's daemon.env had no FLAGSHIP_CONTROL_PLANE_BASE_URL, so the daemon
 * used production's `.com` for its entitlement claim, heartbeat and certificate, while the
 * cloud-init boxes (which set it) came online on the same gym. The ISO also wrote no
 * /etc/flagship/config.json, which root's setup steps (debug access, the stack switch) read.
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { buildBootstrapScript, DEFAULT_BOOT_HOST } from "../src/userdata.js";
import { buildCloudConfigUserData } from "../../control-plane/src/demoCloudConfig.js";

/** Keys only the demo cloud-init writes: test secrets and demo knobs a real box gets elsewhere. */
const CLOUD_INIT_ONLY = new Set([
  "FLAGSHIP_SWK_HEX", // a real box gets its SWK from the phone (swk deposit)
  "FLAGSHIP_PSK_PUB_HEX", // a dead path: the orders endpoint falls back to the owner IRK
  "FLAGSHIP_LLM_DEFAULT_MODEL_OPENAI",
  "FLAGSHIP_BACKUP_INTERVAL_MS",
]);

function daemonEnvKeys(script: string): string[] {
  const body = script.split("cat > /etc/flagship/daemon.env <<ENVEOF\n")[1]?.split("\nENVEOF")[0];
  if (body === undefined) throw new Error("no daemon.env heredoc");
  return body.split("\n").map((l) => l.split("=")[0]!).filter(Boolean);
}

function cloudInitBootstrap(): string {
  const yaml = buildCloudConfigUserData({
    installBlobJson: "{}",
    installerGitRef: "a".repeat(40),
    demoUserIrkPrivHex: "11".repeat(32),
    backupIntervalMs: 60_000,
  });
  const entry = yaml.split("  - path: /usr/local/sbin/flagship-bootstrap.sh\n")[1]!;
  return Buffer.from(entry.match(/content: (\S+)/)![1]!, "base64").toString("utf8");
}

const iso = (encryptRoot: boolean): string =>
  buildBootstrapScript({ ref: "a".repeat(40), repoUrl: "https://github.com/ibisllc/flagship.git", encryptRoot, bootUnlockMode: "approve", bootHost: DEFAULT_BOOT_HOST });

describe("the ISO bootstrap gives the daemon what cloud-init gives it", () => {
  it.each([true, false])("daemon.env carries every cloud-init key a real box needs (encrypted=%s)", (encryptRoot) => {
    const cloud = daemonEnvKeys(cloudInitBootstrap()).filter((k) => !CLOUD_INIT_ONLY.has(k));
    const mine = daemonEnvKeys(iso(encryptRoot));
    expect(cloud).toContain("FLAGSHIP_CONTROL_PLANE_BASE_URL");
    for (const k of cloud) expect(mine, `ISO daemon.env lacks ${k}`).toContain(k);
  });

  it("pins the daemon to the .com that issued the recipe, and fails the install when it can't", () => {
    const s = iso(true);
    expect(s).toContain("FLAGSHIP_CONTROL_PLANE_BASE_URL=$CONTROL_PLANE_BASE\n");
    expect(s).toContain("FLAGSHIP_CONFIG=/etc/flagship/config.json\n");
    expect(s.indexOf('CONTROL_PLANE_BASE="$(echo "$REGISTRATION_URL"')).toBeLessThan(s.indexOf("cat > /etc/flagship/daemon.env"));
    expect(s).toContain('*) echo "[flagship-bootstrap] FATAL: cannot derive the control plane from $REGISTRATION_URL"; exit 1 ;;');
  });

  describe.skipIf(!(() => { try { execFileSync("jq", ["--version"]); return true; } catch { return false; } })())("config.json from the install blob", () => {
    const program = iso(true).split("jq -ce '")[1]!.split("' \\\n    \"$BLOB_JSON\"")[0]!;
    const run = (blob: unknown): { ok: boolean; out: unknown } => {
      try {
        return { ok: true, out: JSON.parse(execFileSync("jq", ["-ce", program], { input: JSON.stringify(blob), encoding: "utf8" })) };
      } catch {
        return { ok: false, out: null };
      }
    };
    const K = (b: string) => b.repeat(32);
    const blob = {
      serverDomain: "home.alice.flagship.services",
      username: "alice",
      phoneDelegatedPubKey: K("AB"),
      registrationUrl: "https://gym.flagshipserver.com/api/server/register",
      authCode: { userPubKey: K("cd"), adminRootPubKey: K("ef"), serial: "x" },
      adminRootPubHex: K("99"),
      ownerAidPubHex: K("12"),
    };

    it("matches the daemon's config shape (config.ts parseConfig), preferring the signed AuthCode's admin root", () => {
      expect(run(blob)).toEqual({
        ok: true,
        out: { serverId: blob.serverDomain, userId: "alice", bakPublicKey: K("ab"), irkPublicKey: K("cd"), ownerAidPubHex: K("12"), adminRootPubHex: K("ef") },
      });
    });

    it("falls back to the sibling admin root, and leaves out what the blob lacks", () => {
      const { ownerAidPubHex: _a, ...noAid } = blob;
      expect(run({ ...noAid, authCode: { userPubKey: K("cd") } }).out).toEqual({
        serverId: blob.serverDomain, userId: "alice", bakPublicKey: K("ab"), irkPublicKey: K("cd"), adminRootPubHex: K("99"),
      });
    });

    it("refuses a blob with no usable owner keys", () => {
      expect(run({ ...blob, authCode: { userPubKey: "nope" } }).ok).toBe(false);
      expect(run({ ...blob, phoneDelegatedPubKey: null }).ok).toBe(false);
    });
  });
});
