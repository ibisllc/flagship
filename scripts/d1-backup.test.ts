import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs without types
import { checkFreshness } from "./d1-backup-freshness.mjs";
import { inline } from "./refresh-model-capabilities-sql.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

describe("D1 backup freshness", () => {
  const NOW = Date.parse("2026-10-18T12:00:00Z");
  const latest = (takenAt: string) =>
    JSON.stringify({ takenAt, key: "d1/daily/flagship-state-20261018T030000Z.sql.gz.age", bytes: 1234, sha256: "ab" });

  it("accepts a backup under 36 hours old", () => {
    expect(checkFreshness(latest("2026-10-17T03:17:00Z"), NOW).ok).toBe(true);
    expect(checkFreshness(latest("2026-10-17T00:30:00Z"), NOW).ok).toBe(true);
  });

  it("fails when it is older than 36 hours, with the age in the message", () => {
    const r = checkFreshness(latest("2026-10-16T23:00:00Z"), NOW);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/37\.0 hours old/);
  });

  it("fails on anything that is not a backup record", () => {
    expect(checkFreshness("not json", NOW).ok).toBe(false);
    expect(checkFreshness("{}", NOW).ok).toBe(false);
    expect(checkFreshness(JSON.stringify({ takenAt: "2026-10-18T11:00:00Z", key: "x", bytes: 1 }), NOW).ok).toBe(false);
    expect(checkFreshness(JSON.stringify({ takenAt: "2026-10-18T11:00:00Z", key: "d1/daily/a.sql.gz.age", bytes: 0 }), NOW).ok).toBe(false);
  });

  it("the CLI exits 1 on a stale file and 0 on a fresh one", () => {
    // A real file: /dev/stdin cannot be opened when stdin is a socket, which is what spawnSync gives on Linux CI.
    const dir = mkdtempSync(join(tmpdir(), "d1-fresh-"));
    try {
      const run = (iso: string) => {
        const file = join(dir, "latest.json");
        writeFileSync(file, latest(iso));
        return spawnSync("node", [join(root, "scripts/d1-backup-freshness.mjs"), file, "--now", "2026-10-18T12:00:00Z"], { encoding: "utf8" });
      };
      expect(run("2026-10-18T03:00:00Z").status).toBe(0);
      const stale = run("2026-10-15T03:00:00Z");
      expect(stale.status).toBe(1);
      expect(stale.stdout).toMatch(/STALE/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("D1 backup wiring", () => {
  const wf = read(".github/workflows/d1-backup.yml");
  const script = read("scripts/d1-backup.sh");

  it("uses exactly the two repo secrets and never a literal credential", () => {
    const used = [...wf.matchAll(/secrets\.([A-Z_]+)/g)].map((m) => m[1]);
    expect([...new Set(used)].sort()).toEqual(["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"]);
    expect(wf).not.toMatch(/(?:token|secret|key)\s*[:=]\s*["']?[A-Za-z0-9_-]{30,}/i);
  });

  it("runs daily, checks freshness at 36 hours, and can be started by hand", () => {
    expect(wf).toMatch(/cron: "\d+ 3 \* \* \*"/);
    expect(wf).toMatch(/--max-hours 36/);
    expect(wf).toMatch(/workflow_dispatch/);
  });

  it("encrypts before anything leaves the runner and prunes nothing", () => {
    expect(script.indexOf("age -r")).toBeGreaterThan(0);
    expect(script.indexOf("age -r")).toBeLessThan(script.indexOf("r2 object put"));
    expect(script).not.toMatch(/r2 object delete|bucket lifecycle/);
    expect(script).toMatch(/flagship-d1-backups/);
  });

  it("ships a real age recipient, the one release.sh checks for", () => {
    const pub = read(".maintainers/backup-recipient.pub");
    expect(pub).not.toMatch(/PLACEHOLDER/);
    expect(pub).toMatch(/^age1[0-9a-z]{20,}/m);
  });

  it("accepts a real-looking age recipient (checked before any export)", () => {
    const dir = mkdtempSync(join(tmpdir(), "recip-"));
    try {
      writeFileSync(join(dir, "r.pub"), "age1k3m9h6vza5jmv487zlqq3zuvuw4m3y4d3qyj7r7v6ds8ethlrcdqgprs8s\n");
      const r = spawnSync("bash", [join(root, "scripts/d1-backup.sh"), "--local", join(dir, "out")], {
        encoding: "utf8",
        env: { ...process.env, D1_BACKUP_RECIPIENT_FILE: join(dir, "r.pub"), D1_PROJECT_DIR: join(dir, "no-such-project") },
      });
      expect(r.stderr).not.toMatch(/holds no age public key/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the Worker no longer has the backup binding or the cron job", () => {
    expect(read("apps/com/wrangler.toml")).not.toMatch(/BACKUPS_BUCKET/);
  });
});

describe("model capability refresh from CI", () => {
  it("inlines binds the way SQLite reads a literal", () => {
    expect(inline("INSERT INTO t VALUES (?, ?, ?, ?, ?)", ["it's", 5, null, true, '{"a":"b\\n"}'])).toBe(
      `INSERT INTO t VALUES ('it''s', 5, NULL, 1, '{"a":"b\\n"}')`,
    );
  });
});
