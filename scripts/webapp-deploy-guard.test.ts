// The production static Worker `flagship-webapp` owns webapp. and remote.flagshipserver.com.
// Once a gym refresh deployed it from the gym branch (its own CA pin, gym adopt seam) and the gym
// webapp went live on the production hostnames. These tests hold the three guards:
//   1. scripts/gym-refresh.sh never reaches the production static Worker;
//   2. scripts/deploy-webapp-static.sh refuses a gym, off-main, dirty or re-pinned tree;
//   3. the predeploy `check` catches a re-pinned or gym-seeded webapp.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  GYM_SEAM_MARKER,
  WEBAPP_DEPLOY_OVERRIDE_ENV,
  WEBAPP_DEPLOY_OVERRIDE_VALUE,
  checkStaticAssets,
  readBakedPin,
  readMandatePin,
  servedWebappFindings,
  webappDeployGuardFindings,
  type WebappDeployFacts,
} from "./static-assets.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const PROD_PIN = "5016749377de07fd3296e8207539bbe52b40fb58f971d946f4cc8990c7e801ae";
const GYM_PIN = "87f5ae60" + "0".repeat(56);

const tmp: string[] = [];
afterEach(() => {
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true });
});
function mkTmp(): string {
  const d = mkdtempSync(join(tmpdir(), "webapp-guard-"));
  tmp.push(d);
  return d;
}

/** A tree with just the files servedWebappFindings reads. */
function fixture(opts: { baked: string; mandate: string; app?: string }): { served: string; root: string } {
  const r = mkTmp();
  const served = join(r, "served");
  mkdirSync(join(served, "lib"), { recursive: true });
  mkdirSync(join(r, "packages/protocol/src"), { recursive: true });
  writeFileSync(join(served, "lib/serverTrust.js"), `export const BAKED_PIN = "${opts.baked}";\n`);
  writeFileSync(join(served, "app.js"), opts.app ?? "boot();\n");
  writeFileSync(
    join(r, "packages/protocol/src/maintainerCa.ts"),
    `export const MAINTAINER_PINNED_MANDATE_HASH =\n  "${opts.mandate}";\n`,
  );
  return { served, root: r };
}

const good: WebappDeployFacts = { onMain: true, clean: true, env: {}, args: [], ancestry: [], served: [] };

describe("gym-refresh.sh never deploys the production static Worker", () => {
  const code = readFileSync(join(root, "scripts/gym-refresh.sh"), "utf8")
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");

  it("does not call deploy-webapp-static.sh, flagship-webapp, apps/webapp-static or `npm run deploy`", () => {
    expect(code).not.toMatch(/deploy-webapp-static/);
    expect(code).not.toMatch(/flagship-webapp/);
    expect(code).not.toMatch(/webapp-static/);
    expect(code).not.toMatch(/npm run deploy/);
    expect(code).not.toMatch(/webapp\.flagshipserver\.com|remote\.flagshipserver\.com/);
  });

  it("deploys the gym Worker directly, behind the same gates, flagged as a gym deploy", () => {
    expect(code).toMatch(/clean-build-com\.sh/);
    expect(code).toMatch(/predeploy-com\.sh/);
    expect(code).toMatch(/wrangler deploy --config "\$CFG"/);
    expect(code).toMatch(/FLAGSHIP_GYM_DEPLOY=1/);
    expect(code).toMatch(/CFG="wrangler\.gym\.toml"/);
  });

  it("the gym Worker serves its own webapp and is not a route owner of the production hosts", () => {
    const gym = readFileSync(join(root, "apps/com/wrangler.gym.toml"), "utf8");
    expect(gym).toMatch(/^name = "flagship-com-gym"/m);
    expect(gym).not.toMatch(/"(webapp|remote)\.flagshipserver\.com"/);
  });
});

describe("pins and seams in the served webapp", () => {
  it("reads both pins out of the real tree and they match on main", () => {
    const baked = readBakedPin(readFileSync(join(root, "apps/web/public/webapp/lib/serverTrust.js"), "utf8"));
    const mandate = readMandatePin(readFileSync(join(root, "packages/protocol/src/maintainerCa.ts"), "utf8"));
    expect(baked).toBe(PROD_PIN);
    expect(mandate).toBe(PROD_PIN);
    expect(servedWebappFindings(join(root, "apps/web/public/webapp"), root)).toEqual([]);
  });

  it("passes when the webapp carries the tree's own pin", () => {
    const f = fixture({ baked: PROD_PIN, mandate: PROD_PIN });
    expect(servedWebappFindings(f.served, f.root)).toEqual([]);
  });

  it("refuses a webapp baked with another pin", () => {
    const f = fixture({ baked: GYM_PIN, mandate: PROD_PIN });
    expect(servedWebappFindings(f.served, f.root).map((x) => x.message).join("\n")).toMatch(/BAKED_PIN \(87f5ae60/);
  });

  it("refuses the gym adopt seam even when a gym tree's two pins agree", () => {
    const f = fixture({ baked: GYM_PIN, mandate: GYM_PIN, app: `function ${GYM_SEAM_MARKER}() {}\n` });
    const msgs = servedWebappFindings(f.served, f.root).map((x) => x.message).join("\n");
    expect(msgs).toContain(GYM_SEAM_MARKER);
  });

  it("refuses a missing BAKED_PIN", () => {
    const f = fixture({ baked: PROD_PIN, mandate: PROD_PIN });
    writeFileSync(join(f.served, "lib/serverTrust.js"), "export const OTHER = 1;\n");
    expect(servedWebappFindings(f.served, f.root).length).toBe(1);
  });

  it("the predeploy check includes it on this tree", () => {
    const before = process.env.FLAGSHIP_GYM_DEPLOY;
    try {
      delete process.env.FLAGSHIP_GYM_DEPLOY;
      expect(checkStaticAssets(root)).toEqual([]);
    } finally {
      if (before !== undefined) process.env.FLAGSHIP_GYM_DEPLOY = before;
    }
  });
});

describe("webappDeployGuardFindings", () => {
  const refused = (over: Partial<WebappDeployFacts>) => webappDeployGuardFindings({ ...good, ...over });

  it("lets a clean, on-main, production-pinned tree through", () => {
    expect(refused({})).toEqual([]);
  });

  it("refuses a tree that is not on origin/main", () => {
    expect(refused({ onMain: false }).join("\n")).toMatch(/not on origin\/main/);
  });

  it("refuses a dirty worktree", () => {
    expect(refused({ clean: false }).join("\n")).toMatch(/uncommitted/);
  });

  it("refuses served findings (wrong pin, gym seam)", () => {
    const served = [{ level: "error" as const, message: "BAKED_PIN differs" }];
    expect(refused({ served })).toContain("BAKED_PIN differs");
  });

  it.each([
    ["FLAGSHIP_GYM_DEPLOY", { FLAGSHIP_GYM_DEPLOY: "1" }],
    ["a GYM_ variable", { GYM_WORKTREE: "/x" }],
    ["the gym migration config", { FLAGSHIP_MIGRATION_CHECK_CONFIG: "wrangler.gym.toml" }],
    ["the gym database", { FLAGSHIP_MIGRATION_CHECK_DB: "flagship-state-gym" }],
  ])("refuses a gym environment: %s", (_n, env) => {
    expect(refused({ env }).join("\n")).toMatch(/gym deployment is in progress/);
  });

  it("refuses wrangler.gym.toml as an argument or an ancestor command", () => {
    expect(refused({ args: ["--config", "wrangler.gym.toml"] }).join("\n")).toMatch(/gym deployment/);
    expect(refused({ ancestry: ["bash scripts/gym-refresh.sh --no-push"] }).join("\n")).toMatch(/gym deployment/);
    expect(refused({ ancestry: ["node wrangler deploy --config wrangler.gym.toml"] }).join("\n")).toMatch(/gym deployment/);
  });

  it("the override waives only off-main and dirty, never a gym, pin or seam finding", () => {
    const env = { [WEBAPP_DEPLOY_OVERRIDE_ENV]: WEBAPP_DEPLOY_OVERRIDE_VALUE };
    expect(refused({ env, onMain: false, clean: false })).toEqual([]);
    expect(refused({ env: { ...env, FLAGSHIP_GYM_DEPLOY: "1" } }).length).toBeGreaterThan(0);
    expect(refused({ env, served: [{ level: "error", message: "pin" }] })).toEqual(["pin"]);
    expect(refused({ env: { [WEBAPP_DEPLOY_OVERRIDE_ENV]: "1" }, onMain: false }).length).toBe(1);
  });
});

describe("deploy-webapp-static.sh", () => {
  it("refuses under a gym environment before any build or wrangler call", () => {
    const bin = mkTmp();
    const trap = join(bin, "trap.log");
    writeFileSync(join(bin, "wrangler"), `#!/usr/bin/env bash\necho "wrangler $*" >> "${trap}"\nexit 0\n`);
    chmodSync(join(bin, "wrangler"), 0o755);
    const r = spawnSync("bash", [join(root, "scripts/deploy-webapp-static.sh")], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FLAGSHIP_GYM_DEPLOY: "1" },
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/REFUSING TO DEPLOY flagship-webapp/);
    expect(r.stderr).toMatch(/gym deployment is in progress/);
    expect(existsSync(trap)).toBe(false);
  }, 60_000);
});
