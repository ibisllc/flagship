import { describe, expect, it } from "vitest";
import { buildCloudConfigUserData } from "../src/demoCloudConfig.js";

const DEMO_IRK_PRIV = "11".repeat(32);

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

  it("gating v2 — pins ownerAidPubHex into the box config.json when supplied", () => {
    const aid = "cd".repeat(32);
    const yaml = buildCloudConfigUserData({
      installBlobJson: "{}",
      installerGitRef: "main",
      demoUserIrkPrivHex: DEMO_IRK_PRIV,
      ownerAidPubHex: aid,
    });
    const all = [...yaml.matchAll(/content:\s*([A-Za-z0-9+/=]+)/g)];
    const bootstrap = Buffer.from(all[1]![1]!, "base64").toString("utf8");
    // The config heredoc carries the AID field.
    const m = bootstrap.match(/\{"serverId":[^\n]*"ownerAidPubHex":"([0-9a-f]{64})"\}/);
    expect(m).not.toBeNull();
    expect(m![1]).toBe(aid);
  });

  it("omits ownerAidPubHex from config.json when not supplied (IRK fallback)", () => {
    const yaml = buildCloudConfigUserData({
      installBlobJson: "{}",
      installerGitRef: "main",
      demoUserIrkPrivHex: DEMO_IRK_PRIV,
    });
    const all = [...yaml.matchAll(/content:\s*([A-Za-z0-9+/=]+)/g)];
    const bootstrap = Buffer.from(all[1]![1]!, "base64").toString("utf8");
    expect(bootstrap).not.toContain("ownerAidPubHex");
  });

  it("admin-pinned — pins adminRootPubHex into config.json AND ships the admin priv for minting", () => {
    const adminPub = "ab".repeat(32);
    const adminPriv = "12".repeat(32);
    const yaml = buildCloudConfigUserData({
      installBlobJson: "{}",
      installerGitRef: "main",
      demoUserIrkPrivHex: DEMO_IRK_PRIV,
      adminRootPubHex: adminPub,
      adminRootPrivHex: adminPriv,
    });
    const all = [...yaml.matchAll(/content:\s*([A-Za-z0-9+/=]+)/g)];
    const bootstrap = Buffer.from(all[1]![1]!, "base64").toString("utf8");
    // config.json carries adminRootPubHex so the box's local self-check accepts
    // an admin-signed entitlement.
    const m = bootstrap.match(/\{"serverId":[^\n]*"adminRootPubHex":"([0-9a-f]{64})"\}/);
    expect(m).not.toBeNull();
    expect(m![1]).toBe(adminPub);
    // The admin priv is shipped to its own tmpfs file and the mint step prefers it.
    expect(yaml).toContain("/run/flagship-demo-admin-root.hex");
    expect(bootstrap).toContain("ADMIN_ROOT_PRIV_FILE=/run/flagship-demo-admin-root.hex");
    expect(bootstrap).toContain("minting entitlement with the admin master root");
  });

  it("un-pinned — omits adminRootPubHex + the admin-root file (legacy IRK mint)", () => {
    const yaml = buildCloudConfigUserData({
      installBlobJson: "{}",
      installerGitRef: "main",
      demoUserIrkPrivHex: DEMO_IRK_PRIV,
    });
    expect(yaml).not.toContain("adminRootPubHex");
    expect(yaml).not.toContain("/run/flagship-demo-admin-root.hex");
  });

  it("rejects adminRootPub without adminRootPriv (all-or-nothing)", () => {
    expect(() =>
      buildCloudConfigUserData({
        installBlobJson: "{}",
        installerGitRef: "main",
        demoUserIrkPrivHex: DEMO_IRK_PRIV,
        adminRootPubHex: "ab".repeat(32),
      }),
    ).toThrow(/adminRootPubHex and adminRootPrivHex must be provided together/);
  });

  it("rejects an ownerAidPubHex that is not 32-byte hex", () => {
    expect(() =>
      buildCloudConfigUserData({
        installBlobJson: "{}",
        installerGitRef: "main",
        demoUserIrkPrivHex: DEMO_IRK_PRIV,
        ownerAidPubHex: "nothex",
      }),
    ).toThrow(/ownerAidPubHex must be 32-byte hex/);
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
    expect(bootstrap).toContain("docker.io docker-compose");
    expect(bootstrap).not.toContain("docker.io docker-cli"); // docker-cli aborts apt on Debian
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
