/**
 * W13 — Worker-side cloud-init-direct provisioning handler tests.
 *
 * Covers:
 *   - 404 / 409 / idempotent-200 / 202 / 502 (same contract surface as
 *     handleAdminSnapshotNow so a CLI that switches endpoints sees no
 *     surprises).
 *   - cloud-config YAML shape: write_files (install-blob.json +
 *     bootstrap.sh) + runcmd; base64-decoded blob JSON parses back to
 *     the InstallBlobJsonShort shape; bootstrap script contains the
 *     critical apt + git clone + npm + systemd-unit + register
 *     scaffolding.
 *   - Hetzner request uses image=debian-12 by default (NOT
 *     ubuntu-22.04, NOT the custom Debian-netinst ISO).
 *   - installerGitRef shape validation rejects disallowed chars.
 */

import { describe, expect, it } from "vitest";
import {
  InMemoryAuthCodeStorage,
  InMemoryDemoUsersStorage,
  InMemoryDeviceCapabilityGrantStorage,
  InMemoryUsernameStorage,
} from "@flagship/storage";
import {
  buildCloudConfigUserData,
  deriveDemoUserIrk,
  handleAdminCloudInitNow,
  type DemoCloudInitDeps,
  type ProvisioningHetznerClient,
} from "../src/index.js";

const KEK = new Uint8Array(32).fill(0x42);
// A throwaway 32-byte hex used only to satisfy buildCloudConfigUserData's
// shape validation in the unit tests that exercise the YAML/bootstrap
// rendering directly (the value is never verified by these tests).
const DEMO_IRK_PRIV = "11".repeat(32);

interface FakeHetzner extends ProvisioningHetznerClient {
  calls: Array<{
    name: string;
    location: string;
    serverType: string;
    image?: string;
    userData: string;
    username: string;
    sshKeyId?: number;
    fallbackServerTypes?: readonly string[];
  }>;
  failNext?: Error;
}

function makeHetzner(): FakeHetzner {
  const calls: FakeHetzner["calls"] = [];
  return {
    calls,
    async createServerWithUserData(args) {
      if (this.failNext) {
        const e = this.failNext;
        this.failNext = undefined;
        throw e;
      }
      calls.push(args);
      return { serverId: "srv-ci-abc", ipv4: "10.10.10.10" };
    },
  };
}

async function mkDeps(opts: { seedDemo?: boolean; seedUsername?: boolean } = {}): Promise<{
  deps: DemoCloudInitDeps;
  hetzner: FakeHetzner;
}> {
  const hetzner = makeHetzner();
  let counter = 0;
  const rand = (n: number) => {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = (counter + i) & 0xff;
    counter += n;
    return out;
  };
  const storage = new InMemoryDemoUsersStorage();
  const usernames = new InMemoryUsernameStorage();
  if (opts.seedDemo) {
    await storage.insert({
      username: "demoalice",
      display: "Demo Alice",
      snapshotId: null,
      isoR2Key: null,
      ttlIdleMinutes: 30,
      region: "fsn1",
      size: "cpx11",
      activeServerId: null,
      activeServerFqdn: null,
      lastActivityAt: 0,
      state: "none",
      createdAt: 1_000_000,
    });
  }
  if (opts.seedUsername) {
    const irk = deriveDemoUserIrk(KEK, "demoalice");
    const hex = (b: Uint8Array) =>
      Array.from(b)
        .map((x) => x.toString(16).padStart(2, "0"))
        .join("");
    await usernames.put({
      username: "demoalice",
      irkPubHex: hex(irk.publicKey),
      claimedAt: 1_000_000,
      isDemo: true,
    });
  }
  const deps: DemoCloudInitDeps = {
    storage,
    usernames,
    authCodes: new InMemoryAuthCodeStorage(),
    deviceCapabilityGrants: new InMemoryDeviceCapabilityGrantStorage(),
    hetzner,
    demoIrkKek: KEK,
    defaultRegion: "fsn1",
    defaultSize: "cpx11",
    random: rand,
    now: () => 2_000_000,
  };
  return { deps, hetzner };
}

describe("buildCloudConfigUserData", () => {
  it("renders #cloud-config with all write_files entries + runcmd", () => {
    const yaml = buildCloudConfigUserData({
      installBlobJson: JSON.stringify({ serverDomain: "home.alice.flagship.services" }),
      installerGitRef: "main",
      demoUserIrkPrivHex: DEMO_IRK_PRIV,
    });
    expect(yaml.startsWith("#cloud-config\n")).toBe(true);
    expect(yaml).toContain("write_files:");
    expect(yaml).toContain("path: /var/flagship/install-blob.json");
    expect(yaml).toContain("path: /usr/local/sbin/flagship-bootstrap.sh");
    expect(yaml).toContain("path: /run/flagship-demo-irk.hex");
    expect(yaml).toContain("encoding: b64");
    expect(yaml).toContain("runcmd:");
    expect(yaml).toContain("/usr/local/sbin/flagship-bootstrap.sh");
  });

  it("ships the demo IRK priv (the 3rd content block) for on-box entitlement minting", () => {
    const yaml = buildCloudConfigUserData({
      installBlobJson: "{}",
      installerGitRef: "main",
      demoUserIrkPrivHex: DEMO_IRK_PRIV,
    });
    const all = [...yaml.matchAll(/content:\s*([A-Za-z0-9+/=]+)/g)];
    expect(all.length).toBe(3);
    const irk = Buffer.from(all[2]![1]!, "base64").toString("utf8").trim();
    expect(irk).toBe(DEMO_IRK_PRIV);
  });

  it("rejects a demoUserIrkPrivHex that is not 32-byte hex", () => {
    expect(() =>
      buildCloudConfigUserData({
        installBlobJson: "{}",
        installerGitRef: "main",
        demoUserIrkPrivHex: "nothex",
      }),
    ).toThrow(/32-byte hex/);
  });

  it("inlines the install-blob.json as decodable base64", () => {
    const blobJson = JSON.stringify({
      version: 1,
      serverDomain: "home.alice.flagship.services",
      username: "alice",
    });
    const yaml = buildCloudConfigUserData({
      installBlobJson: blobJson,
      installerGitRef: "main",
      demoUserIrkPrivHex: DEMO_IRK_PRIV,
    });
    // Extract the first base64 content under the install-blob.json
    // path. The line is `    content: <base64>`.
    const m = yaml.match(/install-blob\.json[\s\S]*?content:\s*([A-Za-z0-9+/=]+)/);
    expect(m).not.toBeNull();
    const decoded = Buffer.from(m![1]!, "base64").toString("utf8");
    expect(JSON.parse(decoded)).toEqual({
      version: 1,
      serverDomain: "home.alice.flagship.services",
      username: "alice",
    });
  });

  it("bootstrap script (decoded) installs deps + clones repo + writes systemd units", () => {
    const yaml = buildCloudConfigUserData({
      installBlobJson: "{}",
      installerGitRef: "main",
      demoUserIrkPrivHex: DEMO_IRK_PRIV,
    });
    // The bootstrap is the SECOND base64 content block.
    const all = [...yaml.matchAll(/content:\s*([A-Za-z0-9+/=]+)/g)];
    expect(all.length).toBeGreaterThanOrEqual(2);
    const bootstrap = Buffer.from(all[1]![1]!, "base64").toString("utf8");
    expect(bootstrap.startsWith("#!/bin/bash\n")).toBe(true);
    expect(bootstrap).toContain("apt-get install -y");
    expect(bootstrap).toContain("git clone");
    expect(bootstrap).toContain("npm install");
    expect(bootstrap).toContain("npx tsc -b");
    expect(bootstrap).toContain("install-helper.ts gen-identity");
    // N12b — the box mints the IRK-signed entitlement bundle on-box
    // (after gen-identity) using the shipped demo IRK priv, writes it to
    // /var/flagship/entitlements.json, then shreds the IRK priv. Without
    // this the daemon exits 1 ("entitlement bundle not found").
    expect(bootstrap).toContain("install-helper.ts mint-entitlements");
    expect(bootstrap).toContain("--out /var/flagship/entitlements.json");
    expect(bootstrap).toContain("/run/flagship-demo-irk.hex");
    expect(bootstrap).toContain("shred -u");
    // seal-for-bak is line-broken across a `\` continuation; just
    // assert both pieces are present.
    expect(bootstrap).toContain("install-helper.ts");
    expect(bootstrap).toContain("seal-for-bak");
    // flagship-data-services removed — daemon registration on the demo
    // path doesn't depend on docker/postgres.
    expect(bootstrap).toContain("flagship-daemon.service");
    // The daemon must launch via the npm "start" script (tsx src/index.ts).
    // Regression guard: `npx … run start` makes npx execute the unrelated
    // `run` package, which dies with MODULE_NOT_FOUND and the daemon never
    // boots (observed live 2026-05-22). Must be `npm run start`.
    expect(bootstrap).toContain(
      "ExecStart=/usr/bin/npm run start --workspace=@flagship/server-daemon",
    );
    expect(bootstrap).not.toContain("npx --workspace=@flagship/server-daemon run start");
    // The daemon reads FLAGSHIP_SUBDOMAIN + FLAGSHIP_IDENTITY_PRIV_HEX from
    // env only; the unit must load them via EnvironmentFile and the
    // bootstrap must write that file. Regression: without this the daemon
    // logs "Missing required inputs" and crash-loops (observed live
    // 2026-05-22, restart counter 154).
    expect(bootstrap).toContain("EnvironmentFile=/etc/flagship/daemon.env");
    expect(bootstrap).toContain("FLAGSHIP_SUBDOMAIN=$SERVER_DOMAIN");
    expect(bootstrap).toContain("FLAGSHIP_IDENTITY_PRIV_HEX=$SERVER_IDENTITY_PRIV_HEX");
    // The daemon must be pinned to the SAME control plane that provisioned
    // it (CTRL_BASE = blob registrationUrl minus /api/server/register), so
    // hub-discovery, ACME DNS-01, and the status heartbeat target this env.
    // Without it the daemon defaults to flagshipserver.com — a gym/test box
    // would then vanish into prod's hub + DNS zone. Regression: gym e2e.
    expect(bootstrap).toContain("FLAGSHIP_CONTROL_PLANE_BASE_URL=$CTRL_BASE");
    // Full-platform enablement: the SWK + config make the daemon construct the
    // ServicePlatform (services / build / deploy / screens / vibe); the PSK pub
    // enables paired-session minting; docker + the data-services unit run apps.
    expect(bootstrap).toContain("/var/flagship/swk.hex");
    expect(bootstrap).toContain("FLAGSHIP_SWK_HEX=");
    expect(bootstrap).toContain("FLAGSHIP_PSK_PUB_HEX=$PHONE_DELEGATED_PUBKEY");
    expect(bootstrap).toContain("docker.io docker-cli docker-compose");
    expect(bootstrap).toContain("flagship-data-services.service");
    expect(bootstrap).toContain("flagship-first-boot-register.service");
    expect(bootstrap).toContain("/api/server/register");
    expect(bootstrap).toContain("/sealed-luks-key");
    // The git-ref is interpolated into the bootstrap at template time.
    expect(bootstrap).toContain('GIT_REF="main"');
  });

  it("bootstrap emits provisioning PHASE checkpoints (fail-open)", () => {
    const yaml = buildCloudConfigUserData({
      installBlobJson: "{}",
      installerGitRef: "main",
      demoUserIrkPrivHex: DEMO_IRK_PRIV,
    });
    const all = [...yaml.matchAll(/content:\s*([A-Za-z0-9+/=]+)/g)];
    const bootstrap = Buffer.from(all[1]![1]!, "base64").toString("utf8");
    // A report_phase helper that POSTs canonical phases to the SINGLE
    // order-status channel, keyed by the auth-code serial the box holds. The
    // legacy provision-event channel is retired — no vestige of it.
    expect(bootstrap).toContain("report_phase()");
    expect(bootstrap).toContain("/api/order/$AUTH_CODE_SERIAL/status");
    expect(bootstrap).not.toContain("/provision-event");
    expect(bootstrap).not.toContain("authCodeSerial");
    // Every cloud-init checkpoint is emitted as a canonical ProvisionStatusPhase.
    expect(bootstrap).toContain("report_phase booting");
    expect(bootstrap).toContain("report_phase downloading");
    expect(bootstrap).toContain("report_phase installing");
    expect(bootstrap).toContain("report_phase registering");
    // Fail-open: the POST must never abort the install.
    expect(bootstrap).toContain("|| true");
  });

  it("rejects disallowed characters in installerGitRef", () => {
    expect(() =>
      buildCloudConfigUserData({
        installBlobJson: "{}",
        installerGitRef: "main; rm -rf /",
        demoUserIrkPrivHex: DEMO_IRK_PRIV,
      }),
    ).toThrow(/disallowed/);
    expect(() =>
      buildCloudConfigUserData({
        installBlobJson: "{}",
        installerGitRef: "../etc/passwd",
        demoUserIrkPrivHex: DEMO_IRK_PRIV,
      }),
    ).toThrow();
  });

  it("interpolates a custom installerGitRef (e.g. a commit SHA)", () => {
    const sha = "deadbeefcafebabe1234567890abcdef12345678";
    const yaml = buildCloudConfigUserData({
      installBlobJson: "{}",
      installerGitRef: sha,
      demoUserIrkPrivHex: DEMO_IRK_PRIV,
    });
    const m = [...yaml.matchAll(/content:\s*([A-Za-z0-9+/=]+)/g)];
    const bootstrap = Buffer.from(m[1]![1]!, "base64").toString("utf8");
    expect(bootstrap).toContain(`GIT_REF="${sha}"`);
  });
});

describe("handleAdminCloudInitNow (W13)", () => {
  it("404s on missing demo_users row", async () => {
    const { deps } = await mkDeps();
    const r = await handleAdminCloudInitNow(deps, "ghost-user");
    expect(r.status).toBe(404);
  });

  it("409s when usernames row missing", async () => {
    const { deps } = await mkDeps({ seedDemo: true });
    const r = await handleAdminCloudInitNow(deps, "demoalice");
    expect(r.status).toBe(409);
    expect((r.body as { error: string }).error).toMatch(/admin-claim-and-issue/);
  });

  it("happy path: 202, posts cloud-config with debian-12 + inlined blob", async () => {
    const { deps, hetzner } = await mkDeps({ seedDemo: true, seedUsername: true });
    const r = await handleAdminCloudInitNow(deps, "demoalice");
    expect(r.status).toBe(202);
    const body = r.body as {
      state: string;
      activeServerId: string;
      ipv4: string | null;
      image: string;
    };
    expect(body.state).toBe("provisioning");
    expect(body.activeServerId).toBe("srv-ci-abc");
    expect(body.image).toBe("debian-12");

    // The demo_users row transitioned. isoR2Key is null on this path.
    const row = await deps.storage.get("demoalice");
    expect(row?.state).toBe("provisioning");
    expect(row?.activeServerId).toBe("srv-ci-abc");
    expect(row?.isoR2Key).toBeNull();

    // The Hetzner client received the right shape: debian-12 image +
    // cloud-config user_data with both write_files entries.
    expect(hetzner.calls).toHaveLength(1);
    const call = hetzner.calls[0]!;
    expect(call.image).toBe("debian-12");
    expect(call.username).toBe("demoalice");
    expect(call.location).toBe("fsn1");
    expect(call.serverType).toBe("cpx11");
    expect(call.userData.startsWith("#cloud-config\n")).toBe(true);
    expect(call.userData).toContain("/var/flagship/install-blob.json");
    expect(call.userData).toContain("/usr/local/sbin/flagship-bootstrap.sh");

    // Confirm the inlined blob is valid + carries the expected fields.
    const m = call.userData.match(
      /install-blob\.json[\s\S]*?content:\s*([A-Za-z0-9+/=]+)/,
    );
    expect(m).not.toBeNull();
    const blob = JSON.parse(Buffer.from(m![1]!, "base64").toString("utf8"));
    expect(blob.serverDomain).toBe("home.demoalice.flagship.services");
    expect(blob.username).toBe("demoalice");
    expect(blob.serverName).toBe("home");
    expect(blob.registrationUrl).toBe(
      "https://flagshipserver.com/api/server/register",
    );
    expect(blob.installerGitRef).toBe("main");
    expect(blob.authCode.username).toBe("demoalice");

    // The cloud-init ships the deterministic demo User IRK priv (3rd
    // content block) so the box can mint the entitlement bundle on-box.
    // It must equal deriveDemoUserIrk(KEK, user) — the same key the hub's
    // irkLookup would return — or the minted RootEntitlement wouldn't
    // verify if IRK checking is ever enabled on the hub.
    const allContent = [...call.userData.matchAll(/content:\s*([A-Za-z0-9+/=]+)/g)];
    expect(allContent.length).toBe(3);
    const shippedIrkHex = Buffer.from(allContent[2]![1]!, "base64")
      .toString("utf8")
      .trim();
    const expectedIrk = deriveDemoUserIrk(KEK, "demoalice");
    const expectedIrkHex = Array.from(expectedIrk.privateKey)
      .map((x) => x.toString(16).padStart(2, "0"))
      .join("");
    expect(shippedIrkHex).toBe(expectedIrkHex);
  });

  it("idempotent — second call with state=provisioning returns 200 + reused", async () => {
    const { deps } = await mkDeps({ seedDemo: true, seedUsername: true });
    await handleAdminCloudInitNow(deps, "demoalice");
    const r2 = await handleAdminCloudInitNow(deps, "demoalice");
    expect(r2.status).toBe(200);
    expect((r2.body as { reused: boolean }).reused).toBe(true);
  });

  it("502 when the Hetzner client throws", async () => {
    const { deps, hetzner } = await mkDeps({ seedDemo: true, seedUsername: true });
    hetzner.failNext = new Error("hetzner upstream 503");
    const r = await handleAdminCloudInitNow(deps, "demoalice");
    expect(r.status).toBe(502);
    expect((r.body as { error: string }).error).toMatch(/hetzner/);
    const row = await deps.storage.get("demoalice");
    expect(row?.state).toBe("none");
  });

  it("400 on malformed username", async () => {
    const { deps } = await mkDeps();
    const r = await handleAdminCloudInitNow(deps, "a");
    expect(r.status).toBe(400);
  });

  it("honors a custom installerGitRef from deps", async () => {
    const { deps, hetzner } = await mkDeps({ seedDemo: true, seedUsername: true });
    const customDeps = { ...deps, installerGitRef: "v0.1.0" };
    await handleAdminCloudInitNow(customDeps, "demoalice");
    const userData = hetzner.calls[0]!.userData;
    const m = [...userData.matchAll(/content:\s*([A-Za-z0-9+/=]+)/g)];
    const bootstrap = Buffer.from(m[1]![1]!, "base64").toString("utf8");
    expect(bootstrap).toContain('GIT_REF="v0.1.0"');
    const blobJson = JSON.parse(
      Buffer.from(m[0]![1]!, "base64").toString("utf8"),
    );
    expect(blobJson.installerGitRef).toBe("v0.1.0");
  });

  it("supports overriding the Hetzner image (for future ubuntu-24 / etc)", async () => {
    const { deps, hetzner } = await mkDeps({ seedDemo: true, seedUsername: true });
    const customDeps = { ...deps, hetznerImage: "ubuntu-24.04" };
    const r = await handleAdminCloudInitNow(customDeps, "demoalice");
    expect(r.status).toBe(202);
    expect((r.body as { image: string }).image).toBe("ubuntu-24.04");
    expect(hetzner.calls[0]!.image).toBe("ubuntu-24.04");
  });
});
