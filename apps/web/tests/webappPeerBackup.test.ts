import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildServer } from "../src/server.js";
// @ts-expect-error plain JS module
import * as pb from "../public/webapp/lib/peerBackup.js";
// @ts-expect-error plain JS module
import { renderStatus } from "../public/webapp/views/peer-backup.js";
// @ts-expect-error plain JS module
import { helperServer, lostServerChoices } from "../public/webapp/views/import-backup.js";

const here = dirname(fileURLToPath(import.meta.url));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const V = JSON.parse(readFileSync(join(here, "../../../packages/protocol/test-vectors/peer-backup/vectors.json"), "utf8")) as any;
const seed = Uint8Array.from(Buffer.from(V.umkSeedHex, "hex"));

describe("peer backup keys on the webapp", () => {
  it("derives the PBK of the shared vector", async () => {
    expect(await pb.derivePbkHex(seed, V.serverId)).toBe(V.pbkHex);
  });
  it("refuses something that isn't a server address", async () => {
    await expect(pb.derivePbkHex(seed, "a|b")).rejects.toThrow();
  });
  it("opens the vector's sealed root and refuses another server or key", async () => {
    const root = await pb.openSealedRoot(V.root.sealed, V.pbkHex, V.serverId);
    expect(root.generation).toBe(3);
    expect(root.archive.archiveId).toBe("00112233445566778899aabbccddeeff");
    await expect(pb.openSealedRoot(V.root.sealed, V.pbkHex, "other.harry.flagship.services")).rejects.toThrow(/doesn't open/);
    await expect(pb.openSealedRoot(V.root.sealed, "00".repeat(32), V.serverId)).rejects.toThrow(/doesn't open/);
  });
  it("summarises a record like the box's /root does", async () => {
    const s = pb.summaryOfRoot(await pb.openSealedRoot(V.root.sealed, V.pbkHex, V.serverId));
    expect(s).toMatchObject({ serverId: V.serverId, generation: 3, revision: 2, holders: 1, needed: 1, keepUntil: 1799776000000 });
    expect(s.archive.bytes).toBe(1000);
  });
});

describe("finding a lost server's backup", () => {
  it("asks a running server with the PBK, never the key itself", async () => {
    const fetch = vi.fn(async () => ({ serverId: V.serverId }));
    const r = await pb.describePeerRoot({ client: { fetch }, umkSeed: seed, serverId: V.serverId.toUpperCase() });
    expect(r.serverId).toBe(V.serverId);
    expect(fetch).toHaveBeenCalledWith("/api/screens/peer-backup/root", { method: "POST", body: JSON.stringify({ serverId: V.serverId, pbkHex: V.pbkHex }) });
  });
  it("reads and opens the sealed record itself when no server of the account runs", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(V.root.sealed), { status: 200 }));
    const r = await pb.describePeerRoot({ client: null, umkSeed: seed, serverId: V.serverId, fetchImpl, comBase: "https://c.test" });
    expect(fetchImpl).toHaveBeenCalledWith(`https://c.test/api/peer-backup/root/${V.serverId}`);
    expect(r.holders).toBe(1);
  });
  it.each([[404, /No peer backup/], [503, /isn't set up/], [500, /Couldn't reach/]])("says why on %s", async (status, re) => {
    const fetchImpl = async () => new Response("{}", { status });
    await expect(pb.describePeerRoot({ client: null, umkSeed: seed, serverId: V.serverId, fetchImpl, comBase: "https://c.test" })).rejects.toThrow(re);
  });
  it("starts the new server's fetch with the PBK", async () => {
    const fetch = vi.fn(async () => ({}));
    await pb.startPeerRestore({ client: { fetch }, umkSeed: seed, serverId: V.serverId });
    expect(fetch).toHaveBeenCalledWith("/api/screens/server-restore/from-peers", { method: "POST", body: JSON.stringify({ serverId: V.serverId, pbkHex: V.pbkHex }) });
  });
});

describe("waiting for the pieces to come back", () => {
  const client = (jobs: unknown[]) => {
    let i = 0;
    return { fetch: async () => ({ restore: jobs[Math.min(i++, jobs.length - 1)] }) };
  };
  it("reports progress, then returns at ready", async () => {
    const seen: number[] = [];
    const job = await pb.waitForPeerData({
      client: client([{ state: "uploading", received: 5, bytes: 10 }, { state: "ready", received: 10, bytes: 10 }]),
      onProgress: (j: { received: number }) => seen.push(j.received),
      sleep: async () => {},
    });
    expect(job.state).toBe("ready");
    expect(seen).toEqual([5]);
  });
  it("throws the box's sentence when the fetch failed", async () => {
    await expect(
      pb.waitForPeerData({ client: client([{ state: "uploading", received: 0, bytes: 10, reason: "The backup from other servers came back the wrong size." }]), sleep: async () => {} }),
    ).rejects.toThrow("The backup from other servers came back the wrong size.");
  });
  it("stops when cancelled", async () => {
    await expect(pb.waitForPeerData({ client: client([{ state: "uploading" }]), isCancelled: () => true })).rejects.toMatchObject({ code: "cancelled" });
  });
});

describe("status words", () => {
  const status = {
    v: 2, state: "at-risk", reason: "two servers went away", lastPlacedAt: 1_700_000_000_000, healthyBricks: 3, totalBricks: 8, holders: 8,
    keepUntil: 1_700_000_000_000 + 10 * 86_400_000,
    holderList: [{ label: "Server 1", state: "ok", lastProofAt: 1_700_000_000_000, bricks: 1 }, { label: "Server 2", state: "failing", lastProofAt: null, bricks: 2 }],
    hosting: { poolBytes: 8 * 1024 ** 3, realBytes: 2 * 1024 ** 3, fillerBytes: 5 * 1024 ** 3, provenBytes: 7 * 1024 ** 3, leases: 1, bricks: 4, reliability: 80, leaving: false },
  };
  it("lists holders as Server n with proof and pieces", () => {
    const rows = pb.holderRows(status, { formatTime: () => "T" });
    expect(rows[0].line).toBe("Answering · last proof T · 1 piece");
    expect(rows[1].line).toBe("Not answering · no proof yet · 2 pieces");
  });
  it("names the restore-by date", () => {
    expect(pb.restoreByLine(status.keepUntil, { now: 1_700_000_000_000, formatTime: () => "D" })).toBe("Restore by D (10 days left).");
    expect(pb.restoreByLine(5, { now: 10 })).toMatch(/no longer kept/);
    expect(pb.restoreByLine(null)).toBe("");
  });
  it("renders the page with no holder names and escapes the box's words", () => {
    const html = renderStatus({ ...status, reason: "<b>x</b>" }, { formatTime: () => "T", now: 1_700_000_000_000 });
    expect(html).toContain("At risk");
    expect(html).toContain("3 of 8");
    expect(html).toContain("Server 2");
    expect(html).toContain("Reliability score: 80 of 100");
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(html).not.toContain("<b>x</b>");
  });
  it("renders the empty and off states", () => {
    const html = renderStatus({ v: 2, state: "off", lastPlacedAt: null, healthyBricks: 0, totalBricks: 0, holders: 0, holderList: [], keepUntil: null, hosting: { poolBytes: 0 } });
    expect(html).toContain("Choose Peer-distributed backups");
    expect(html).toContain("None yet");
  });
  it("describes a found record", () => {
    const lines = pb.rootLines({ serverId: "home.x", holders: 8, needed: 4, keepUntil: 0, archive: { createdAt: 0, bytes: 2 * 1024 ** 3 } });
    expect(lines[1]).toBe("8 servers hold its pieces; 4 bring it back.");
  });
});

describe("choosing the lost server", () => {
  const pods = [
    { serverDomain: "home.a.flagship.services", liveness: "live" },
    { serverDomain: "old.a.flagship.services", revokedAt: 1 },
    { serverDomain: "home2.a.flagship.services", liveness: "live" },
  ];
  it("offers lost servers first", () => {
    expect(lostServerChoices(pods).map((c: { fqdn: string }) => c.fqdn)).toEqual(["old.a.flagship.services", "home.a.flagship.services", "home2.a.flagship.services"]);
  });
  it("asks a running, paired server other than the lost one, else none", () => {
    expect(helperServer(pods, "home.a.flagship.services", () => true)).toBe("home2.a.flagship.services");
    expect(helperServer(pods, "home.a.flagship.services", (f: string) => f === "home.a.flagship.services")).toBeNull();
    expect(helperServer([pods[1]], "x", () => true)).toBeNull();
  });
});

describe("the peer-backup page is v2 only", () => {
  it("reads the v2 status and has no v1 toggle", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/views/peer-backup.js" });
    expect(r.body).toContain("/api/screens/peer-backup/status");
    expect(r.body).not.toContain("peer-backup/toggle");
    expect(r.body).not.toContain("peersBackingYouUp");
  });
});
