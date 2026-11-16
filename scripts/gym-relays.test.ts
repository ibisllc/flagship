import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// scripts/gym-relays.sh against a stub flyctl: `machines list --json` answers from a fixture per app, every
// other call is logged. HOME points at the temp dir so the real ~/.fly/bin/flyctl is never on PATH.

const SCRIPT = join(__dirname, "gym-relays.sh");
let dir = "";
let log = "";

function machine(id: string, state: string, autostart: boolean) {
  return { id, state, config: { services: [{ internal_port: 8443, autostart }, { internal_port: 3000, autostart }] } };
}

function fixture(app: string, ms: unknown[]) {
  writeFileSync(join(dir, "fx", `${app}.json`), JSON.stringify(ms));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gym-relays-"));
  log = join(dir, "calls.log");
  mkdirSync(join(dir, "bin"));
  mkdirSync(join(dir, "fx"));
  writeFileSync(
    join(dir, "bin", "flyctl"),
    `#!/usr/bin/env bash
if [ "$1 $2" = "machines list" ]; then cat "${dir}/fx/$4.json"; exit 0; fi
echo "$*" >> "${log}"
exit 0
`,
  );
  chmodSync(join(dir, "bin", "flyctl"), 0o755);
  fixture("flagship-services-gym", [machine("aaa", "started", true)]);
  fixture("flagship-services-gym-b", [machine("bbb", "stopped", false)]);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function run(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync("bash", [SCRIPT, ...args], {
    encoding: "utf8",
    env: {
      PATH: `${join(dir, "bin")}:/usr/bin:/bin:${dirname(process.execPath)}`,
      HOME: dir,
      FLAGSHIP_GYM_LOCK: join(dir, "gym.lock"),
      GYM_RELAYS_SETTLE_SEC: "0",
      ...env,
    },
    timeout: 30_000,
  });
  let calls = "";
  try {
    calls = readFileSync(log, "utf8");
  } catch {
    /* no calls */
  }
  return { code: r.status, out: `${r.stdout}${r.stderr}`, calls };
}

describe("gym-relays.sh", () => {
  it("never accepts an app outside the gym (production is flagship-services)", () => {
    const r = run(["off"], { GYM_RELAY_APPS: "flagship-services-gym flagship-services" });
    expect(r.code).toBe(2);
    expect(r.out).toContain("not a gym relay app");
    expect(r.calls).toBe("");
  });

  it("off turns autostart off before stopping, and looks again once the proxy caught up", () => {
    const r = run(["off"]);
    expect(r.code, r.out).toBe(0);
    expect(r.calls).toContain("machine update aaa -a flagship-services-gym --autostart=false --skip-start --yes");
    expect(r.calls).toContain("machine wait aaa -a flagship-services-gym --state stopped");
    expect(r.calls).toContain("machine wait bbb -a flagship-services-gym-b --state stopped");
    expect(r.calls).not.toContain("machine update bbb");
    expect(r.calls).not.toContain("machine start");
    expect(r.out).toContain("checking again");
  });

  it("off is refused while the gym lock is held, unless the run holding it asks", () => {
    writeFileSync(join(dir, "gym.lock"), "someone else's run");
    const r = run(["off"]);
    expect(r.code).toBe(4);
    expect(r.calls).toBe("");
    expect(run(["off"], { GYM_LOCK_HELD: "1" }).code).toBe(0);
  });

  it("on starts stopped machines and waits for them; a running one is only waited on", () => {
    fixture("flagship-services-gym", [machine("aaa", "started", false)]);
    const r = run(["on"]);
    expect(r.code, r.out).toBe(0);
    expect(r.calls).toContain("machine start bbb -a flagship-services-gym-b");
    expect(r.calls).not.toContain("machine start aaa");
    expect(r.calls).toContain("machine wait aaa -a flagship-services-gym --state started");
    expect(r.calls).not.toContain("machine update");
  });

  it("on fails when an app has no machine to start", () => {
    fixture("flagship-services-gym-b", []);
    const r = run(["on"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("no machine to start");
  });

  it("dry-run calls nothing", () => {
    for (const cmd of ["on", "off"]) {
      const r = run([cmd, "--dry-run"]);
      expect(r.code, r.out).toBe(0);
      expect(r.out).toContain("DRY-RUN");
    }
    expect(readFileSyncSafe(log)).toBe("");
  });
});

function readFileSyncSafe(p: string): string {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
}
