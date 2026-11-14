/**
 * The co-manager cap (owner decision 2026-11-14, docs/share-a-server.md §5.8):
 * the box refuses a new share once the account's active shares across its
 * servers reach the plan's cap, keeps every share an account over the cap
 * already has, learns the plan only from the CA-signed attestation (none:
 * Free), and asks its sibling servers box to box under the gossip-key MAC.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  deriveIRK,
  deriveShareMemberKey,
  signServerShareAccept,
  signServerShareGrant,
  verifyServerShareGrant,
  type ServerShareGrant,
} from "@flagship/protocol";
import { AccessJournal } from "../../src/accessJournal.js";
import { buildAccessSync, deriveAccessSyncKey, type AccessSync } from "../../src/accessSync.js";
import { authorizeSensitiveOrder } from "../../src/adminAuthorityLocal.js";
import type { HttpRequest, HttpResponse } from "../../src/runtime.js";
import { ActivityLog } from "../../src/shares/activityLog.js";
import { CoManagerCap, type CoManagerCapSource } from "../../src/shares/coManagerCap.js";
import { ShareStore } from "../../src/shares/shareStore.js";
import { ShareSessionStore, buildShares } from "../../src/shares/sharesHttp.js";
import { adminProof, testVerifyAcceptAdmin } from "./acceptAdminFixture.js";

const BOX = "home.harry.flagship.services";
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const owner = deriveIRK({ seed: new Uint8Array(32).fill(42) });
const OWNER_TOKEN = "owner-token";
let clock = 1_800_000_000_000;
const now = () => clock;

const shareId = (i: number) => i.toString(16).padStart(32, "0");
const memberOf = (i: number) => deriveShareMemberKey({ seed: new Uint8Array(32).fill(100 + i) }, shareId(i));

function req(method: string, path: string, body?: unknown): HttpRequest {
  return {
    method,
    path,
    headers: { "x-flagship-session": OWNER_TOKEN },
    body: body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body)),
  };
}
const parse = (r: HttpResponse | null) => ({ status: r!.status, body: JSON.parse(String(r!.body)) as Record<string, any> });

function setup(source: CoManagerCapSource | null, dir: string | null = null) {
  const auth = { ownerIrkPub: owner.publicKey, username: "harry" };
  const cap: CoManagerCap = new CoManagerCap({
    path: dir ? join(dir, "share-cap-peers.json") : null,
    localCount: () => store.list().length,
    source: () => source,
    askTimeoutMs: 50,
    now,
  });
  const store: ShareStore = new ShareStore(null, {
    serverDomain: BOX,
    verifyOwnerGrant: (g, sig) => authorizeSensitiveOrder({ ...auth, order: g, signature: sig, verify: verifyServerShareGrant }),
    verifyAcceptAdmin: testVerifyAcceptAdmin(now),
    admitNew: () => cap.admit(),
    now,
  });
  const shares = buildShares({
    serverDomain: BOX,
    store,
    sessions: new ShareSessionStore(null, now),
    activity: new ActivityLog(null, now),
    verifyOwnerRevoke: () => true,
    coManagers: cap,
    now,
    log: () => {},
  });
  const http = async (r: HttpRequest) => {
    const path = r.path.split("?")[0]!;
    return shares.handleOwner(path, r.method, r);
  };
  return { store, cap, http };
}

function grantOf(i: number, o: Partial<ServerShareGrant> = {}): ServerShareGrant {
  return {
    serverDomain: BOX,
    shareId: shareId(i),
    memberPubHex: hex(memberOf(i).publicKey),
    level: "manage",
    unlockAtBoot: false,
    seeAppData: false,
    label: `Person ${i}`,
    issuedAt: clock,
    ...o,
  };
}

async function share(x: ReturnType<typeof setup>, i: number, o: Partial<ServerShareGrant> = {}) {
  clock += 1;
  const g = grantOf(i, o);
  const accept = { serverDomain: BOX, shareId: g.shareId, memberPubHex: g.memberPubHex, acceptedAt: clock };
  return parse(
    await x.http(
      req("POST", "/api/screens/shares", {
        grant: g,
        signature: hex(signServerShareGrant(g, owner)),
        accept,
        acceptSignature: hex(signServerShareAccept(accept, memberOf(i))),
        acceptAdmin: adminProof(accept),
      }),
    ),
  );
}

function source(o: Partial<CoManagerCapSource> & { tierNow?: () => string } = {}): CoManagerCapSource {
  return {
    tier: o.tierNow ?? (() => "free"),
    servers: o.servers ?? (() => []),
    sharesOn: o.sharesOn ?? (async () => 0),
    ...(o.refreshPlan ? { refreshPlan: o.refreshPlan } : {}),
  };
}

describe("the co-manager cap on the box", () => {
  it("refuses the sixth share on Free with a coded refusal naming the cap and the plan", async () => {
    const x = setup(source());
    for (let i = 1; i <= 5; i++) expect((await share(x, i)).status).toBe(200);
    const r = await share(x, 6);
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ error: "co-manager-cap", code: "co-manager-cap", count: 5, cap: 5, plan: "free" });
    expect(x.store.list()).toHaveLength(5);
  });

  it("counts Free with no plan attestation at all (no source yet)", async () => {
    const x = setup(null);
    for (let i = 1; i <= 5; i++) await share(x, i);
    expect((await share(x, 6)).body.code).toBe("co-manager-cap");
  });

  it("follows the attested plan: Pro 10, Pro Max 25, Enterprise unlimited", async () => {
    for (const [tier, cap] of [["hobby", 10], ["maker", 25]] as const) {
      const x = setup(source({ tierNow: () => tier }));
      for (let i = 1; i <= cap; i++) expect((await share(x, i)).status).toBe(200);
      expect((await share(x, cap + 1)).body).toMatchObject({ code: "co-manager-cap", cap, plan: tier });
    }
    const e = setup(source({ tierNow: () => "enterprise" }));
    for (let i = 1; i <= 30; i++) expect((await share(e, i)).status).toBe(200);
  });

  it("counts the shares the account's other servers hold", async () => {
    const x = setup(source({ servers: () => ["media.harry.flagship.services", "cabin.harry.flagship.services"], sharesOn: async (p) => (p.startsWith("media") ? 2 : 1) }));
    expect((await share(x, 1)).status).toBe(200);
    expect((await share(x, 2)).status).toBe(200);
    expect((await share(x, 3)).body).toMatchObject({ code: "co-manager-cap", count: 5 });
    const list = parse(await x.http(req("GET", "/api/screens/shares")));
    expect(list.body.coManagers).toEqual({ count: 5, cap: 5, plan: "free" });
  });

  it("keeps a sibling's last answer while it is off, and forgets a server gone from the account for a week", async () => {
    let up = true;
    let listed = ["media.harry.flagship.services"];
    const dir = mkdtempSync(join(tmpdir(), "cap-"));
    const src = source({ servers: () => listed, sharesOn: async () => (up ? 4 : null) });
    const x = setup(src, dir);
    expect((await share(x, 1)).status).toBe(200);
    up = false;
    expect((await share(x, 2)).body).toMatchObject({ code: "co-manager-cap", count: 5 });
    // A restart remembers what the sibling said.
    const y = setup(src, dir);
    await y.cap.load();
    expect((await y.cap.count({ fresh: true })).count).toBe(4);
    listed = [];
    clock += 8 * 24 * 3600_000;
    expect((await y.cap.count({ fresh: true })).count).toBe(0);
  });

  it("an account over its cap keeps its shares and can change them, but adds none", async () => {
    let tier = "hobby";
    const x = setup(source({ tierNow: () => tier }));
    for (let i = 1; i <= 8; i++) await share(x, i);
    tier = "free";
    // Pro ended: all eight stay, a level change still applies, a ninth is refused.
    expect(x.store.list()).toHaveLength(8);
    expect((await share(x, 3, { level: "view" })).status).toBe(200);
    expect(x.store.get(shareId(3))?.grant.level).toBe("view");
    expect((await share(x, 9)).body).toMatchObject({ code: "co-manager-cap", count: 8, cap: 5 });
    // Ending one isn't enough while still over; under the cap a new one goes live.
    for (const i of [1, 2, 3]) await x.store.end(shareId(i), "revoked");
    expect((await share(x, 9)).body.code).toBe("co-manager-cap");
    await x.store.end(shareId(4), "revoked");
    expect((await share(x, 9)).status).toBe(200);
  });

  it("re-reads the plan before refusing, so an upgrade a minute ago counts", async () => {
    let tier = "free";
    const x = setup(source({ tierNow: () => tier, refreshPlan: async () => { tier = "hobby"; } }));
    for (let i = 1; i <= 5; i++) await share(x, i);
    expect((await share(x, 6)).status).toBe(200);
  });

  it("lets only one of two simultaneous acceptances take the last slot", async () => {
    const x = setup(source());
    for (let i = 1; i <= 4; i++) await share(x, i);
    const [a, b] = await Promise.all([share(x, 5), share(x, 6)]);
    expect([a.status, b.status].sort()).toEqual([200, 403]);
    expect(x.store.list()).toHaveLength(5);
  });
});

describe("servers asking each other (/api/access-sync/shares)", () => {
  const key = deriveAccessSyncKey(new Uint8Array(32).fill(0x77));
  function box(fqdn: string, count: () => number, fetchImpl: typeof fetch, k = key): AccessSync {
    const journal = new AccessJournal(join(mkdtempSync(join(tmpdir(), "cap-sync-")), "journal.json"));
    return buildAccessSync({
      selfFqdn: fqdn,
      journal,
      store: { setCatchingUp: () => {}, isCatchingUp: () => false },
      apply: async () => "skipped",
      peers: () => null,
      key: k,
      installed: () => false,
      apps: () => [],
      shareCount: count,
      fetchImpl,
      now,
    });
  }

  it("answers its count to a server of the same account, and nothing to anyone else", async () => {
    const boxes = new Map<string, AccessSync>();
    const fetchBetween = (async (url: string | URL, init?: RequestInit) => {
      const u = new URL(String(url));
      const to = boxes.get(u.hostname);
      if (!to) throw new Error("unreachable");
      const res = await to.handle({ method: "POST", path: u.pathname, headers: {}, body: Buffer.from(String(init?.body ?? "")) });
      return new Response(res?.body ?? "", { status: res?.status ?? 404 });
    }) as unknown as typeof fetch;
    const home = box("home.harry.flagship.services", () => 0, fetchBetween);
    boxes.set("home.harry.flagship.services", home);
    boxes.set("media.harry.flagship.services", box("media.harry.flagship.services", () => 3, fetchBetween));
    expect(await home.sharesOn("media.harry.flagship.services")).toBe(3);
    expect(await home.sharesOn("gone.harry.flagship.services")).toBeNull();
    // Another account's key (another CGK) gets a refusal, not a number.
    const stranger = box("evil.mallory.flagship.services", () => 0, fetchBetween, deriveAccessSyncKey(new Uint8Array(32).fill(0x11)));
    expect(await stranger.sharesOn("media.harry.flagship.services")).toBeNull();
  });
});
