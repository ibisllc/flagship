// scripts/release.sh is the owner's interactive release script (docs/runbooks/
// final-deploy.md). Nothing here runs a real step: the modes under test are
// --list, --dry-run, --status and the phase-order refusal, all of which run with
// shims for every network tool on PATH that record any call.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "..");
const SCRIPT = join(ROOT, "scripts/release.sh");
const SOURCE = readFileSync(SCRIPT, "utf8");
const RUNBOOK = readFileSync(join(ROOT, "docs/runbooks/final-deploy.md"), "utf8");
const REAL_GIT = spawnSync("bash", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();

type Env = { dir: string; home: string; calls: string };

function sandbox(): Env {
  const dir = mkdtempSync(join(tmpdir(), "release-test-"));
  const bin = join(dir, "bin");
  const home = join(dir, "home");
  mkdirSync(bin);
  mkdirSync(home);
  const calls = join(dir, "calls.log");
  writeFileSync(calls, "");
  for (const tool of ["gh", "wrangler", "flyctl", "curl", "npm", "npx", "dig", "xcodebuild", "openssl"]) {
    writeFileSync(join(bin, tool), `#!/bin/sh\necho "${tool} $*" >> "${calls}"\nexit 99\n`);
    chmodSync(join(bin, tool), 0o755);
  }
  // git: local reads work, anything that talks to a remote is recorded and refused
  writeFileSync(
    join(bin, "git"),
    `#!/bin/sh
for a in "$@"; do
  case "$a" in
    fetch|push|pull|clone|ls-remote|remote) echo "git $*" >> "${calls}"; exit 98 ;;
  esac
done
exec "${REAL_GIT}" "$@"
`,
  );
  chmodSync(join(bin, "git"), 0o755);
  return { dir, home, calls };
}

function run(env: Env, args: string[], extra: Record<string, string> = {}) {
  const r = spawnSync("bash", [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    stdin: "ignore",
    env: {
      PATH: `${join(env.dir, "bin")}:/usr/bin:/bin:${process.execPath.replace(/\/node$/, "")}`,
      HOME: env.home,
      FLAGSHIP_RELEASE_HOME: join(env.home, ".flagship-release"),
      NO_COLOR: "1",
      ...extra,
    },
    timeout: 60_000,
  } as Parameters<typeof spawnSync>[2]);
  return { code: r.status, out: String(r.stdout), err: String(r.stderr) };
}
const calls = (env: Env) => readFileSync(env.calls, "utf8").trim();

const STEP_RE = /^(\d\d)\. (.+)$/gm;
function planSteps(out: string) {
  return [...out.matchAll(STEP_RE)].map((m) => ({ n: Number(m[1]), title: m[2]! }));
}

describe("release.sh", () => {
  it("is valid bash and bash 3.2 friendly", () => {
    const r = spawnSync("bash", ["-n", SCRIPT], { encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    expect(SOURCE).not.toMatch(/declare -A|mapfile|readarray|\$\{[A-Za-z_]+(,,|\^\^)\}/);
    expect(SOURCE.startsWith("#!/usr/bin/env bash")).toBe(true);
    expect(SOURCE).toContain("set -Eeuo pipefail");
    expect(SOURCE).toContain("trap on_exit EXIT");
  });

  it("--list prints the plan in two phases, every step with phase, commands, gate and rollback", () => {
    const env = sandbox();
    const r = run(env, ["--list"]);
    expect(r.code).toBe(0);
    const steps = planSteps(r.out);
    expect(steps).toHaveLength(27);
    expect(steps.map((s) => s.n)).toEqual(Array.from({ length: 27 }, (_, i) => i + 1));
    const phases = [...r.out.matchAll(/^ {4}phase ([AB]) \|/gm)].map((m) => m[1]);
    expect(phases).toHaveLength(27);
    expect(phases.slice(0, 16).every((p) => p === "A")).toBe(true);
    expect(phases.slice(16).every((p) => p === "B")).toBe(true);
    expect([...r.out.matchAll(/^ {4}gate: /gm)]).toHaveLength(27);
    expect([...r.out.matchAll(/^ {4}rollback: /gm)]).toHaveLength(27);
    expect(calls(env)).toBe("");
  });

  it("orders the steps as the runbook sections, with only the documented moves", () => {
    const env = sandbox();
    const r = run(env, ["--list"]);
    const sections = [...r.out.matchAll(/runbook: (\S+?)\. /g)].map((m) => m[1]);
    // 0 ready | 1 plan | 2 lease | 3 endorse | 9 appliance builds start after the endorsement
    // | 5 secrets | 6 gym | 1b backup prerequisites | 4 migrations (after the gym gate and a fresh backup)
    // | 8 .services FIRST | 6a DNS wildcard (before .com: the new .com writes no per-box records)
    // | 7 .com (+ zone-health post-check) | 14 cpu watch | 9 publish | 9 redeploy | 9 status ...
    expect(sections).toEqual([
      "0", "1", "2", "3", "9", "5", "6", "1b", "4", "8", "6a", "7", "14", "9", "9", "9",
      "12", "12", "12", "12", "10", "10", "9", "7", "11", "11", "13",
    ]);
    // every referenced heading exists verbatim in the runbook
    for (const m of r.out.matchAll(/runbook: (.+)$/gm)) {
      expect(RUNBOOK, m[1]).toContain(`## ${m[1]}`);
    }
    // gym gate before any prod change; DNS after the deploys; scrub after DNS; reap after scrub
    const idx = (needle: string) => planSteps(r.out).find((s) => s.title.includes(needle))!.n;
    expect(idx("Gym gate")).toBeLessThan(idx("Pending D1 migrations"));
    expect(idx("D1 backup prerequisites")).toBeLessThan(idx("Pending D1 migrations"));
    expect(idx("D1 backup prerequisites")).toBeLessThan(idx("Deploy .com"));
    expect(idx("Pending D1 migrations")).toBeLessThan(idx("Deploy .services"));
    expect(idx("Deploy .services")).toBeLessThan(idx("Cloudflare DNS by hand"));
    expect(idx("Cloudflare DNS by hand")).toBeLessThan(idx("Deploy .com"));
    expect(idx("Endorse")).toBeLessThan(idx("Start the VM appliance builds"));
    expect(idx("Deploy .com")).toBeLessThan(idx("Pre-GA scrub"));
    expect(idx("Pre-GA scrub")).toBeLessThan(idx("Reap orphaned"));
    expect(idx("Reap orphaned")).toBeLessThan(idx("Land chore/delete-wipe-tooling"));
    expect(idx("Write DEPLOYED-FINAL")).toBe(16);
  });

  it("--list --phase B lists only phase B", () => {
    const r = run(sandbox(), ["--list", "--short", "--phase", "B"]);
    const steps = planSteps(r.out);
    expect(steps[0]!.n).toBe(17);
    expect(steps).toHaveLength(11);
  });

  it("--dry-run --from 1 prints every command of phase A and runs no tool", () => {
    const env = sandbox();
    const r = run(env, ["--dry-run", "--from", "1"]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain("[dry-run]");
    const steps = planSteps(r.out);
    expect(steps.map((s) => s.n)).toEqual(Array.from({ length: 16 }, (_, i) => i + 1));
    expect(r.out).toContain("npm run deploy");
    expect(r.out).toContain("flyctl deploy --remote-only --strategy=rolling --yes -a flagship-services");
    expect(r.out).toContain("endorse-release.mjs --to <PIN> --from <endorsed> --sign");
    expect(r.out).toContain("wrangler tail flagship-com --format json");
    // the two-Worker deploy: terminal-attached, domain prompt, webapp/remote post-checks, backup first
    expect(r.out).toContain("answer YES to the custom-domain prompt");
    expect(r.out).toContain("curl -sI https://webapp.flagshipserver.com/ ; curl -sI https://remote.flagshipserver.com/");
    expect(r.out).toContain("gh workflow run model-capabilities.yml --ref main");
    expect(r.out).toContain("wrangler r2 bucket lifecycle add flagship-d1-backups expire-daily d1/daily/ --expire-days 30");
    expect(r.out).toContain("put the two custom_domain lines for webapp. and remote. back");
    // .services, then the DNS wildcard (dig only), then .com with zone-health as its post-check
    expect(r.out.indexOf("flyctl deploy --remote-only")).toBeLessThan(r.out.indexOf("dig +short A anything-at-all"));
    expect(r.out.indexOf("dig +short A anything-at-all")).toBeLessThan(r.out.indexOf("(cd apps/com && npm run deploy)"));
    expect(r.out).toContain("gh secret list");
    expect(calls(env)).toBe(""); // no gh, wrangler, flyctl, curl, npm, npx, dig, openssl, and no git fetch/push
    expect(existsSync(join(env.home, ".flagship-release"))).toBe(false); // nothing written, no worktree
  });

  it("--dry-run --only N shows one step", () => {
    const r = run(sandbox(), ["--dry-run", "--only", "10"]);
    expect(planSteps(r.out).map((s) => s.n)).toEqual([10]);
  });

  it("resumes at the first unfinished step from the state file and never rewrites it in a dry run", () => {
    const env = sandbox();
    const stateDir = join(env.home, ".flagship-release");
    mkdirSync(stateDir, { recursive: true });
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const state = JSON.stringify({ pinned: sha, done: ["1", "2", "3"] }, null, 2) + "\n";
    writeFileSync(join(stateDir, "state.json"), state);

    const status = run(env, ["--status"]);
    expect(status.out).toContain(`pinned:      ${sha}`);
    expect(status.out).toContain("done steps:  1 2 3");
    expect(status.out).toContain("next step:   4");

    const dry = run(env, ["--dry-run", "--phase", "A"]);
    expect(dry.out).toContain("would start at step 4");
    expect(dry.out).toContain(sha);
    expect(planSteps(dry.out)[0]!.n).toBe(4);
    expect(readFileSync(join(stateDir, "state.json"), "utf8")).toBe(state);
    expect(calls(env)).toBe("");
  });

  it("keeps state in a helper that adds, queries and deletes list entries", () => {
    const env = sandbox();
    const home = join(env.home, ".flagship-release");
    const script = `RELEASE_SOURCE_ONLY=1 source ${SCRIPT}
st set pinned abc; st add done 1; st add done 2; st add done 2; st del done 1
echo "done=$(st_get done) pinned=$(st_get pinned)"; st_has done 2 && echo has2; st_has done 1 || echo no1
echo "open=$(phase_open A | wc -w | tr -d ' ')"`;
    const r = spawnSync("bash", ["-c", script], {
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", HOME: env.home, FLAGSHIP_RELEASE_HOME: home },
    });
    expect(r.stdout.trim().split("\n")).toEqual(["done=2 pinned=abc", "has2", "no1", "open=15"]);
    expect(JSON.parse(readFileSync(join(home, "state.json"), "utf8")).done).toEqual(["2"]);
  });

  it("refuses to run phase B before phase A is finished, with or without a terminal", () => {
    const env = sandbox();
    const r = run(env, ["--phase", "B"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("refusing to run phase B before phase A");
    expect(calls(env)).toBe("");
  });

  it("refuses to run unattended: a real run needs a terminal and a phase", () => {
    const r = run(sandbox(), ["--phase", "A"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("interactive");
  });

  it("rejects unknown flags and has no auto-yes flag", () => {
    expect(run(sandbox(), ["--yes-to-safe"]).code).toBe(2);
    expect(run(sandbox(), ["--yes"]).code).toBe(2);
    expect(SOURCE).not.toMatch(/yes-to-safe|--assume-yes|--auto-yes/);
  });

  it("never force-pushes, never uploads the Worker outside npm run deploy, never stages everything", () => {
    const env = sandbox();
    const plan = run(env, ["--list"]).out;
    for (const text of [SOURCE.replace(/^ *#.*$/gm, ""), plan]) {
      expect(text).not.toMatch(/push\s+(-f\b|--force)/);
      expect(text).not.toMatch(/force-with-lease/);
      expect(text).not.toMatch(/wrangler deploy(\s|$|")/);
      expect(text).not.toMatch(/git add (-A|--all|\.)(\s|$)/);
    }
    expect(SOURCE).toContain("npm run deploy");
    // the only pushes target main (fast-forward) or the device-results branch
    const pushes = [...SOURCE.matchAll(/push origin (\S+)/g)].map((m) => m[1]!.replace(/["')?]+$/, "").replace(/^"/, ""));
    expect(pushes.length).toBeGreaterThan(3);
    for (const p of pushes) expect(p).toMatch(/^HEAD:(main|refs\/heads\/(\$RESULTS_BRANCH|device-results\/windows-2026-10-17))$/);
  });

  it("runs npm run deploy attached to the terminal and refuses .com without the backup", () => {
    expect(SOURCE).toMatch(/XA "\$WT\/apps\/com" npm run deploy\n/); // foreground: not piped, not redirected, not tee'd
    expect(SOURCE).not.toMatch(/npm run deploy\s*(\||>|2>)/);
    expect(SOURCE).toContain("no-backup-accepted");
    expect(SOURCE).toContain("answer YES");
  });

  it("never prints or stores the admin secret", () => {
    expect(SOURCE).toContain("read -rs ADMIN_SECRET");
    const leaks = SOURCE.split("\n").filter((l) => /(echo|printf|say)[^\n]*\$\{?ADMIN_SECRET/.test(l));
    expect(leaks).toHaveLength(1); // the curl config line, which goes to curl's stdin
    expect(leaks[0]).toContain("| curl -s -m 30 -K -");
    expect(SOURCE).not.toMatch(/export FLAGSHIP_ADMIN_SECRET=/); // only inside the with_secret subshell
    expect(SOURCE).toContain("unset FLAGSHIP_ADMIN_SECRET ADMIN_SECRET");
    expect(SOURCE).toContain('-K -'); // the curl header travels on stdin, not argv
  });

  it("also runs under the system bash 3.2 of macOS", () => {
    const sysbash = "/bin/bash";
    if (!existsSync(sysbash)) return;
    const env = sandbox();
    for (const args of [["--list", "--short"], ["--dry-run", "--from", "1"], ["--status"]]) {
      const r = spawnSync(sysbash, [SCRIPT, ...args], {
        cwd: ROOT,
        encoding: "utf8",
        env: { PATH: `${join(env.dir, "bin")}:/usr/bin:/bin:${process.execPath.replace(/\/node$/, "")}`, HOME: env.home, FLAGSHIP_RELEASE_HOME: join(env.home, ".flagship-release"), NO_COLOR: "1" },
      });
      expect(r.status, `${args.join(" ")}: ${r.stderr}`).toBe(0);
      expect(r.stderr).not.toMatch(/unbound variable|bad substitution|syntax error/);
    }
    expect(calls(env)).toBe("");
  });
});

// Step 19 (the reap): the gym sweep gate, the left-on-purpose review with its typed
// acknowledgement, and the owner checklist. The functions run for real in a sourced
// shell; every tool that would touch Cloudflare, UpCloud or the gym is a logging stub.
describe("release.sh step 19 (reap): cleanup review", () => {
  const goodPlan = {
    version: 1,
    generatedAt: "2026-10-18T12:00:00Z",
    apex: "flagship.services",
    zoneRecords: 2,
    knownAccounts: 1,
    protectedAccounts: ["playstore-test-0725"],
    serversChecked: true,
    summary: { dnsTotal: 2, dnsKeep: 2, dnsOrphan: 0, serversTotal: 1, serversKeep: 1, serversOrphan: 0, zoneRecordsAfter: 2 },
    accounts: [],
    dns: [
      { id: "a".repeat(32), name: "flagship.services", type: "CAA", owner: null, action: "keep", reason: "the zone apex" },
      { id: "b".repeat(32), name: "*.flagship.services", type: "A", owner: null, action: "keep", reason: "the zone's root wildcard", content: "149.248.216.86" },
    ],
    servers: [{ serverId: "00000000-0000-4000-8000-0000000000a1", title: "home", state: "started", labels: {}, action: "keep", owner: "playstore-test-0725", reason: "protected account" }],
  };
  function reapRun(env: Env, answers: string[], plan: unknown, extra: Record<string, string> = {}) {
    if (plan) writeFileSync(join(env.home, "pre-ga-reap-plan-after.json"), JSON.stringify(plan));
    const log = join(env.dir, "stubs.log");
    writeFileSync(log, "");
    const script = `RELEASE_SOURCE_ONLY=1 source ${SCRIPT}
WT=${ROOT}; DRY=0; PROBE_FAILS=0
require_done() { :; }; ensure_wt() { :; }; need_admin_secret() { ADMIN_SECRET=x; }
confirm() { echo "confirm: $1" >> ${log}; case "$1" in *"Treat the step"*) return 1 ;; esac; return 0; }
XA() { shift; echo "XA $*" >> ${log}; }
with_secret() { echo "with_secret $*" >> ${log}; }
run_reap`;
    const r = spawnSync("bash", ["-c", script], {
      encoding: "utf8",
      input: answers.join("\n") + "\n",
      env: { PATH: `${join(env.dir, "bin")}:/usr/bin:/bin:${process.execPath.replace(/\/node$/, "")}`, HOME: env.home, FLAGSHIP_RELEASE_HOME: join(env.home, ".flagship-release"), NO_COLOR: "1", FLAGSHIP_GYM_LOCK: join(env.dir, "no-gym.lock"), ...extra },
    });
    return { code: r.status, out: r.stdout, err: r.stderr, log: readFileSync(log, "utf8"), state: () => JSON.parse(readFileSync(join(env.home, ".flagship-release", "state.json"), "utf8")) };
  }
  const CHECKS = ["checked", "skipped", "checked", "checked", "skipped"];

  it("is a plan step with the sweep, the review and the checklist in its commands", () => {
    const out = run(sandbox(), ["--list"]).out;
    const reap = out.slice(out.indexOf("Reap orphaned"));
    expect(reap).toContain("sweep-cli.ts --destroy");
    expect(reap).not.toContain("(optional)");
    expect(reap).toContain("flagship-locks/gym.lock");
    expect(reap).toContain("reap-orphans.mjs --review --plan ~/pre-ga-reap-plan-after.json");
    expect(reap).toContain("UpCloud console, Hetzner, flagshipserver.com Cloudflare zone, R2 buckets, Fly");
  });

  it("sweeps by default, reviews what is left, and finishes only after reviewed and the five checklist answers", () => {
    const env = sandbox();
    const r = reapRun(env, ["sweep", "reviewed", ...CHECKS], goodPlan);
    expect(r.code, r.err).toBe(0);
    const order = ["sweep-cli.ts", "sweep-cli.ts --destroy", "--show --out", "--apply --plan", "zone-health"].map((n) => r.log.indexOf(n));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(r.out).toContain("Left on purpose in flagship.services");
    expect(r.out).toContain("DNS records kept: 2 of 2");
    expect(r.out).toContain("Servers kept (UpCloud servers labelled flagship-demo): 1 of 1");
    for (const t of ["UpCloud console", "Hetzner", "153213447", "flagshipserver.com", "R2 buckets", "Fly:"]) expect(r.out).toContain(t);
    const st = r.state();
    expect(st.reapGymSweep).toBe("swept");
    expect(st.reapOwnerChecklist).toBe("upcloud=checked hetzner=skipped cfcom=checked r2=checked fly=skipped");
    expect(st.reapReviewed).toMatch(/^2\d{3}-/);
  });

  it("refuses the sweep while the gym lock exists, and runs nothing", () => {
    const env = sandbox();
    const lock = join(env.dir, "gym.lock");
    mkdirSync(lock);
    const r = reapRun(env, ["sweep"], goodPlan, { FLAGSHIP_GYM_LOCK: lock });
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("holds " + lock);
    expect(r.log).not.toContain("sweep-cli");
    expect(r.log).not.toContain("--apply");
  });

  it("lets the owner skip the gym sweep only by typing skip-gym, and records it", () => {
    const skipped = reapRun(sandbox(), ["skip-gym", "reviewed", ...CHECKS], goodPlan);
    expect(skipped.code, skipped.err).toBe(0);
    expect(skipped.log).not.toContain("sweep-cli");
    expect(skipped.state().reapGymSweep).toBe("skipped");
    const vague = reapRun(sandbox(), ["y"], goodPlan);
    expect(vague.code).not.toBe(0);
    expect(vague.log).not.toContain("sweep-cli");
  });

  it("does not finish without the typed reviewed, or with a vague checklist answer", () => {
    const noAck = reapRun(sandbox(), ["skip-gym", "ok"], goodPlan);
    expect(noAck.code).not.toBe(0);
    expect(noAck.err).toContain("not acknowledged");
    const vague = reapRun(sandbox(), ["skip-gym", "reviewed", "checked", "yes"], goodPlan);
    expect(vague.code).not.toBe(0);
    expect(vague.err).toContain("answer checked or skipped for hetzner");
  });

  it("stops at the review while the second dry run still lists deletions", () => {
    const left = { ...goodPlan, dns: [...goodPlan.dns, { id: "c".repeat(32), name: "bob.flagship.services", type: "CAA", owner: "bob", action: "orphan", reason: "no account of this name in D1" }] };
    const r = reapRun(sandbox(), ["skip-gym", "reviewed", ...CHECKS], left);
    expect(r.out).toContain("STILL LISTED FOR DELETION");
    expect(r.err).toContain("still lists records or servers to delete");
    expect(r.code).toBe(11);
    expect(r.state().reapReviewed).toBeUndefined();
  });

  it("runbooks describe the same default sweep, review and checklist", () => {
    const scrub = readFileSync(join(ROOT, "docs/runbooks/pre-ga-scrub.md"), "utf8");
    for (const doc of [RUNBOOK, scrub]) {
      expect(doc).toContain("--review --plan");
      expect(doc).toContain("reviewed");
      expect(doc).toContain("skip-gym");
      expect(doc).toContain("gym.lock");
      for (const t of ["Hetzner", "153213447", "R2", "Fly", "UpCloud console", "flagshipserver.com"]) expect(doc, t).toContain(t);
    }
  });
});

// The parsers the steps depend on, fed with REAL captured outputs of the tools
// (scripts/release-fixtures/, captured 2026-10-18 from read-only commands; the D1
// ledger one is synthetic in wrangler's documented --json shape because the live
// read was not run from the automation). Same functions the script calls.
describe("release.sh parsers against captured tool output", () => {
  const FX = join(ROOT, "scripts/release-fixtures");
  const fx = (n: string) => readFileSync(join(FX, n), "utf8");
  const sh = (fn: string, input: string, extra = "") => {
    const r = spawnSync("bash", ["-c", `RELEASE_SOURCE_ONLY=1 source ${SCRIPT}\n${extra}\n${fn}`], {
      encoding: "utf8",
      input,
      env: { PATH: process.env.PATH ?? "", HOME: tmpdir(), FLAGSHIP_RELEASE_HOME: join(tmpdir(), "release-parsers") },
    });
    return { code: r.status, out: r.stdout.trim(), err: r.stderr };
  };

  it("wrangler secret list -> names", () => {
    const r = sh("json_names", fx("wrangler-secret-list.json"));
    const names = r.out.split("\n");
    expect(names).toContain("ACCOUNT_READ_TOKEN_SECRET");
    expect(names.length).toBe(JSON.parse(fx("wrangler-secret-list.json")).length);
    expect(names.every((n) => /^[A-Z0-9_]+$/.test(n))).toBe(true);
    expect(fx("wrangler-secret-list.json")).not.toMatch(/"value"/);
  });

  it("gh secret list -> names", () => {
    expect(sh("gh_secret_names", fx("gh-secret-list.txt")).out).toBe("BILLING_MIRROR_DEPLOY_KEY");
    expect(sh("gh_secret_names", "").out).toBe("");
  });

  it("schema_version ledger -> pending migration files", () => {
    const dir = join(ROOT, "packages/storage/migrations");
    const r = sh(`pending_migrations ${dir}`, fx("wrangler-d1-ledger.synthetic.json"));
    // The fixture ledger ends at 0104, so everything after it is pending.
    expect(r.out).toMatch(/^0105_re_pair_proof\.sql$/m);
    expect(r.out).toMatch(/^0106_outbound_hosts\.sql$/m);
    expect(r.out).toMatch(/^0107_boot_suspensions\.sql$/m);
    expect(r.out.split("\n")).toHaveLength(3);
    // a ledger that has everything -> nothing pending
    const all = JSON.stringify([{ results: ["0105", "0106", "0107", ...JSON.parse(fx("wrangler-d1-ledger.synthetic.json"))[0].results.map((x: { version: string }) => x.version)].map((version) => ({ version })) }]);
    expect(sh(`pending_migrations ${dir}`, all).out).toBe("");
  });

  it("gh run list -> green runs after the endorsement, newest first", () => {
    expect(sh("runs_after", fx("gh-run-list.json")).out.split("\n")).toEqual(["39160505562", "39158345483", "39153553427", "39142014433"]);
    expect(sh("runs_after 2026-10-18T19:00:00Z", fx("gh-run-list.json")).out.split("\n")).toEqual(["39160505562", "39158345483"]);
    expect(sh("runs_after 2027-01-01T00:00:00Z", fx("gh-run-list.json")).out).toBe("");
  });

  it("gh api artifacts -> which arch a run built", () => {
    expect(sh("artifacts_have amd64", fx("gh-run-artifacts.json")).code).toBe(0);
    expect(sh("artifacts_have arm64", fx("gh-run-artifacts.json")).code).toBe(1);
    expect(sh("artifacts_have arm64", fx("gh-run-artifacts-arm64.json")).code).toBe(0);
    expect(sh("artifacts_have amd64", fx("gh-run-artifacts-arm64.json")).code).toBe(1);
    const expired = JSON.stringify({ artifacts: [{ name: "vm-appliance-amd64", expired: true }] });
    expect(sh("artifacts_have amd64", expired).code).toBe(1);
  });

  it("gh run view --json jobs -> the boot smoke step state", () => {
    expect(sh("smoke_state", fx("gh-run-view-jobs.json")).out).toBe("success");
    expect(sh("smoke_state", fx("gh-run-view-jobs-arm64.json")).out).toBe("success");
    const failed = JSON.parse(fx("gh-run-view-jobs.json"));
    for (const s of failed.jobs[0].steps) if (/boot smoke/i.test(s.name)) s.conclusion = "failure";
    expect(sh("smoke_state", JSON.stringify(failed)).out).toBe("failure");
    expect(sh("smoke_state", JSON.stringify({ jobs: [{ steps: [{ name: "Set up job", conclusion: "success" }] }] })).out).toBe("");
  });

  it("flyctl ips list agrees with the relay addresses in apps/com/wrangler.toml", () => {
    const ips = fx("flyctl-ips.txt");
    const [v4, v6] = sh("relay_ips", "", `WT=${ROOT}`).out.split(" ");
    expect(v4).toBe("149.248.216.86");
    expect(sh(`ips_agree ${v4} ${v6}`, ips).code).toBe(0);
    expect(sh(`ips_agree 1.2.3.4 ${v6}`, ips).code).toBe(1);
    expect(sh(`ips_agree ${v4} 2001:db8::1`, ips).code).toBe(1);
  });

  it("backup-recipient.pub: the placeholder is refused, a real age key is accepted", () => {
    expect(readFileSync(join(ROOT, ".maintainers/backup-recipient.pub"), "utf8").length).toBeGreaterThan(0);
    expect(sh("age_recipient_ok", fx("backup-recipient.placeholder.pub")).code).toBe(1);
    expect(sh("age_recipient_ok", fx("backup-recipient.valid.synthetic.pub")).code).toBe(0);
    expect(sh("age_recipient_ok", "age1short\n").code).toBe(1);
    expect(sh("age_recipient_ok", "").code).toBe(1);
  });

  it("the run a workflow dispatch started -> its id", () => {
    expect(sh("newest_run_since 2026-10-18T19:00:00Z", fx("gh-run-list.json")).out).toBe("39160505562");
    expect(sh("newest_run_since 2026-10-18T18:00:00Z", fx("gh-run-list.json")).out).toBe("39160505562");
    expect(sh("newest_run_since 2027-01-01T00:00:00Z", fx("gh-run-list.json")).out).toBe("");
  });

  it("latest.json of the backup: fresh and keyed, else refused (synthetic shape from the runbook)", () => {
    const at = (min: number) => new Date(Date.now() - min * 60000).toISOString();
    const good = JSON.stringify({ takenAt: at(2), tables: 89, key: "d1/daily/2026-10-18.sql.gz.age" });
    expect(sh("latest_json_ok 15", good).code).toBe(0);
    expect(sh("latest_json_ok 15", good).out).toContain("tables 89");
    expect(sh("latest_json_ok 15", JSON.stringify({ takenAt: at(300), tables: 89, key: "d1/daily/x" })).code).toBe(1);
    expect(sh("latest_json_ok 15", JSON.stringify({ takenAt: at(2), tables: 0, key: "d1/daily/x" })).code).toBe(1);
    expect(sh("latest_json_ok 15", JSON.stringify({ takenAt: at(2), tables: 89, key: "other/x" })).code).toBe(1);
    expect(sh("latest_json_ok 15", "not json").code).toBe(1);
  });

  it("git diff names -> box files and test filters", () => {
    const names = fx("git-diff-names.txt");
    const box = sh("box_files_in", names).out.split("\n");
    expect(box).toContain("packages/server-daemon/src/doorbell.ts");
    expect(box.every((f) => /^(packages\/(server-daemon|boot-core|protocol|tunnel-protocol|llm-providers)|installer|package(-lock)?\.json)/.test(f))).toBe(true);
    expect(sh("box_files_in", "apps/web/public/index.html\ndocs/x.md\n").out).toBe("");
    const filters = sh("test_filters_from_names", names).out.split(/\s+/);
    expect(filters).toEqual(expect.arrayContaining(["scripts", "apps/com", "packages/server-daemon"]));
  });
});
