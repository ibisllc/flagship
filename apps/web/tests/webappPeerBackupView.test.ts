import { describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";

/**
 * P9 — peer-backup view static-surface + field-contract tests.
 *
 * The daemon-side BFF (PeerBackupStatusResponse) landed in af9cbc7.
 * These tests assert the view reads the EXACT field names the BFF
 * returns and that empty / warming-up / honest-zero states render
 * the documented copy.
 */
describe("webapp /views/peer-backup.js — participation view", () => {
  async function fetchView() {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/views/peer-backup.js" });
    expect(r.statusCode).toBe(200);
    return r.body;
  }

  it("is reachable as a static asset and registers a view", async () => {
    const body = await fetchView();
    expect(body).toContain('registerView("view-peer-backup")');
  });

  it("hits the peer-backup BFF endpoints", async () => {
    const body = await fetchView();
    expect(body).toContain("/api/screens/peer-backup/status");
    expect(body).toContain("/api/screens/peer-backup/toggle");
  });

  it("exports the standard view contract", async () => {
    const body = await fetchView();
    expect(body).toContain("export function initPeerBackupView");
    expect(body).toContain("export async function enterPeerBackup");
    expect(body).toContain("export async function renderPeerBackup");
  });

  it("reads every field on PeerBackupStatusResponse", async () => {
    const body = await fetchView();
    // Top-level fields (PeerBackupStatusResponse).
    for (const f of [
      "participating",
      "peersBackingYouUp",
      "peersYouBackUp",
      "shards",
      "repair",
      "stats",
    ]) {
      expect(body, `top-level field ${f}`).toContain(`body.${f}`);
    }
  });

  it("reads every PeerBackupStats field", async () => {
    const body = await fetchView();
    for (const f of [
      "total",
      "durable",
      "atRisk",
      "yourBytesStored",
      "peerBytesHosted",
    ]) {
      expect(body, `stats field ${f}`).toContain(`stats.${f}`);
    }
  });

  it("reads every PeerBackupPeerHostingYou field", async () => {
    const body = await fetchView();
    // peer entries (each `p` in peersBackingYouUp.map)
    for (const f of ["peerFqdn", "shardsHosted", "lastSeenMs", "online"]) {
      expect(body, `hosting-you field ${f}`).toContain(`p.${f}`);
    }
  });

  it("reads every PeerBackupPeerYouHost field", async () => {
    const body = await fetchView();
    // bytesHosted + lastFetchedMs are the youhost-only fields
    for (const f of ["peerFqdn", "shardsHosted", "bytesHosted", "lastFetchedMs"]) {
      expect(body, `you-host field ${f}`).toContain(`p.${f}`);
    }
  });

  it("reads every PeerBackupShardSummary field", async () => {
    const body = await fetchView();
    for (const f of ["shardId", "replicas", "minReplicas", "bytes"]) {
      expect(body, `shard field ${f}`).toContain(`s.${f}`);
    }
  });

  it("reads every PeerBackupRepairStatus field", async () => {
    const body = await fetchView();
    for (const f of ["state", "lastTickMs", "queued", "completed24h", "lastError"]) {
      expect(body, `repair field ${f}`).toContain(`repair?.${f}`);
    }
  });

  it("speaks the unenrolled empty state ('not in the pool — enable to get started')", async () => {
    const body = await fetchView();
    expect(body).toMatch(/not in the peer-backup pool/);
    expect(body).toMatch(/enable to get started/);
  });

  it("speaks the participating-but-warming-up empty state", async () => {
    const body = await fetchView();
    // Phrase that surfaces when participation === true but no peers,
    // no shards, no traffic yet.
    expect(body).toMatch(/You're in the peer-backup pool/);
    expect(body).toMatch(/matchmaker hasn't paired/);
    expect(body).toContain("isWarmingUp");
  });

  it("speaks the per-section honest-empty copy mirror to iOS/Android", async () => {
    const body = await fetchView();
    expect(body).toMatch(/No peers yet/);
    expect(body).toMatch(/Not hosting any peer shards yet/);
  });

  it("renders shard health + repair status sections", async () => {
    const body = await fetchView();
    expect(body).toContain("Shard health");
    expect(body).toContain("Repair status");
    expect(body).toContain("Peers backing you up");
    expect(body).toContain("Peers you back up");
  });

  it("uses an honest 'not yet tracked' label for daemon-side zero byte counters", async () => {
    const body = await fetchView();
    // fmtBytesOrUntracked is what renders this — its 0-case label
    // surfaces in the stats card + the per-shard listing.
    expect(body).toContain("not yet tracked");
    expect(body).toContain("fmtBytesOrUntracked");
  });

  it("POSTs { participate: <bool> } to the toggle endpoint", async () => {
    const body = await fetchView();
    expect(body).toContain('method: "POST"');
    expect(body).toContain('"/api/screens/peer-backup/toggle"');
    expect(body).toMatch(/JSON\.stringify\(\s*\{\s*participate:/);
  });

  it("handles the 404 case (pre-P9 daemon) with a non-alarmist message", async () => {
    const body = await fetchView();
    expect(body).toContain("e.status === 404");
    expect(body).toMatch(/older build/i);
  });

  it("handles the 503 case (daemon up, peer-backup unconfigured)", async () => {
    const body = await fetchView();
    expect(body).toContain("e.status === 503");
    expect(body).toMatch(/hasn't been configured/i);
  });

  it("renders 'never' instead of an epoch date when lastSeenMs is 0", async () => {
    const body = await fetchView();
    // fmtDate explicitly downgrades 0/non-numeric to "never".
    expect(body).toContain('return "never"');
  });
});

describe("webapp index.html — peer-backup is reachable from Settings", () => {
  it("mounts the view-peer-backup section + content slot", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/index.html" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('id="view-peer-backup"');
    expect(r.body).toContain('id="peer-backup-content"');
    expect(r.body).toContain('id="peer-backup-refresh"');
    expect(r.body).toContain('id="peer-backup-back"');
  });

  it("adds a 'Peer-backup' entry in the Settings tab strip", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/index.html" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('id="settings-tab-peer-backup"');
  });

  it("app.js imports the view module + wires the settings entry", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/app.js" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('from "./views/peer-backup.js"');
    expect(r.body).toContain("initPeerBackupView");
    expect(r.body).toContain("enterPeerBackup");
    expect(r.body).toContain('wire("settings-tab-peer-backup", enterPeerBackup)');
  });

  it("tags view-peer-backup under the settings tab", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/app.js" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('"view-peer-backup": "settings"');
  });
});
