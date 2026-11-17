// The Social page's three tabs, counts, call button and first post (docs/social-tabs.md): the counts and their seen
// markers (lib/socialCounts.js), the Calls page's Who to call (lib/voiciCallOut.js callTargetUsername,
// resolveCallTarget) against a fake `.com`, a new page's first post (lib/voiciOwner.js publishVoiciPage firstPost),
// and the shell's markup. Mirrors iOS SocialTabsLogicTests and Android SocialCountsTest.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as P from "../public/webapp/lib/voiciProtocol.js";
import { buildVoiciIndex, defaultVoiciProfile, makeDraftOp, publishVoiciPage } from "../public/webapp/lib/voiciOwner.js";
import { callTargetUsername, resolveCallTarget } from "../public/webapp/lib/voiciCallOut.js";
import { callsSeenAt, markCallsSeen, socialCounts, unseenMissed } from "../public/webapp/lib/socialCounts.js";

const U = "alice";
const UMK = new Uint8Array(32).fill(7);
const ADMIN_SEED = new Uint8Array(32).fill(9);
const ADMIN_PUB = P.hex(P.ed25519PublicKey(ADMIN_SEED));
const NOW = 1_800_000_000_000;
const signer = { kind: "admin-root", pub: ADMIN_PUB, sign: async (b: Uint8Array) => P.ed25519SignHex(b, ADMIN_SEED) };
const session = { umk: UMK, username: U, adminRootSeed: ADMIN_SEED };
const WELCOME = "Hello. I am using the Flagship app, from flagshipserver.com";

function memoryStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
}

/** An in-memory `.com` holding alice's page (pieces, publish with the seq ladder, her account keys). */
function fakeCom() {
  const pieces = new Map<string, Uint8Array>();
  const state: { index: any } = { index: null };
  const json = (status: number, v: unknown) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
  const fetch = async (url: string, init: any = {}) => {
    const u = new URL(url);
    if (u.pathname === `/api/username/${U}`) return json(200, { adminRootPub: ADMIN_PUB, irkPub: "11".repeat(32) });
    if (u.pathname === `/api/voici/pages/${U}` && (init.method ?? "GET") === "GET") return state.index ? json(200, { index: state.index }) : json(404, { code: "not-found" });
    if (u.pathname === `/api/voici/pages/${U}/pieces` && init.method === "POST") {
      const bytes = new Uint8Array(init.body);
      pieces.set(P.sha256Hex(bytes), bytes);
      return json(200, { ok: true });
    }
    const piece = /^\/api\/voici\/pages\/alice\/pieces\/([0-9a-f]{64})$/.exec(u.pathname);
    if (piece) return pieces.has(piece[1]) ? new Response(pieces.get(piece[1])) : json(404, { code: "not-found" });
    if (u.pathname === `/api/voici/pages/${U}/publish`) {
      const idx = JSON.parse(init.body).index;
      const r = P.checkVoiciPublish(idx, { username: U, sensitiveKind: "admin-root", sensitivePub: ADMIN_PUB, storedSeq: state.index?.seq ?? 0, storedPageId: state.index?.pageId ?? null, now: NOW });
      if (!r.ok) return json(409, { code: r.code });
      state.index = idx;
      return json(200, { ok: true });
    }
    return json(404, { code: "not-found" });
  };
  return { fetch, state, pieces };
}

const deps = (com: ReturnType<typeof fakeCom>, extra: Record<string, unknown> = {}) => ({
  fetch: com.fetch,
  readFetch: (url: string, init: unknown) => com.fetch(url, init as any),
  now: () => NOW,
  session,
  profile: { accountId: U, deviceId: "a1".repeat(16) },
  apex: "https://flagshipserver.com",
  origin: "https://voi.ci",
  signer,
  ...extra,
});

describe("the Social counts", () => {
  it("adds the four counts; Profile stays 0 until comments and reactions exist", () => {
    expect(socialCounts({ inboxUnread: 2, replyAlerts: 1, requests: 3, missedCalls: 4 })).toEqual({ profile: 0, inbox: 3, requests: 3, calls: 4, total: 10 });
    expect(socialCounts().total).toBe(0);
  });

  it("counts missed calls until the Calls page is opened", () => {
    const h = [
      { direction: "in", outcome: "missed", at: 100 },
      { direction: "in", outcome: "missed", at: 300 },
      { direction: "out", outcome: "no-answer", at: 400 },
    ];
    expect(unseenMissed(h, 0)).toBe(2);
    expect(unseenMissed(h, 200)).toBe(1);
    const storage = memoryStorage();
    expect(callsSeenAt({ storage, session })).toBe(0);
    markCallsSeen({ storage, session, now: () => 300 });
    expect(unseenMissed(h, callsSeenAt({ storage, session }))).toBe(0);
    expect(callsSeenAt({ storage, session: { username: "bob" } }), "per account").toBe(0);
  });
});

describe("Who to call", () => {
  it("takes a username or a page link, nothing else", () => {
    for (const s of ["alex", " Alex ", "@alex", "voi.ci/alex", "https://voi.ci/alex", "https://voi.ci/alex/", "voi.ci/alex#call=x", "http://www.voi.ci/alex?x=1"]) {
      expect(callTargetUsername(s), s).toBe("alex");
    }
    expect(callTargetUsername("gym.voi.ci/bo-1", "gym.voi.ci")).toBe("bo-1");
    for (const s of ["", "   ", "-alex", "al ex", "voi.ci/", "https://example.com/alex", "+1 555 0100"]) expect(callTargetUsername(s), s).toBeNull();
  });

  it("finds the page under its account's key, and says when there is none or it takes no calls", async () => {
    const com = fakeCom();
    expect(await resolveCallTarget("not a name", deps(com))).toEqual({ ok: false, code: "bad-target" });
    expect(await resolveCallTarget("alice", deps(com))).toMatchObject({ ok: false, code: "no-page", username: "alice" });
    const page = await publishVoiciPage({ ops: [] }, deps(com, { published: null }));
    const r = await resolveCallTarget("https://voi.ci/alice", deps(com));
    expect(r).toEqual({ ok: true, page: { username: "alice", pageId: page.index.pageId } });
    // Calls turned off: the page is there but can't be called.
    const off = await buildVoiciIndex({ username: U, published: page, merged: page, images: page.pieces, signer, umk: { seed: UMK }, now: NOW, calls: { acceptsCalls: 0, callsFrom: "accepted" } });
    com.state.index = off.index;
    expect(await resolveCallTarget("alice", deps(com))).toMatchObject({ ok: false, code: "calls-off" });
    // A page signed by another key is no page.
    com.state.index = { ...off.index, signature: "00".repeat(64) };
    expect(await resolveCallTarget("alice", deps(com))).toMatchObject({ ok: false, code: "no-page" });
  });
});

describe("a new page's first post", () => {
  it("goes up with the first publish as an ordinary plain-text post, first among the new posts", async () => {
    const com = fakeCom();
    const mine = makeDraftOp("post-add", { post: { id: "ab".repeat(16), createdAt: NOW - 50, editedAt: null, text: "Mine", links: [] } }, { now: NOW - 50 });
    const page = await publishVoiciPage({ ops: [mine], firstPost: WELCOME }, deps(com, { published: null }));
    const posts = page.chunks.flat();
    expect(posts.map((p: any) => p.text).sort()).toEqual(["Mine", WELCOME].sort());
    const first = posts.find((p: any) => p.text === WELCOME);
    expect(first.links).toEqual([]);
    expect(first.createdAt).toBeLessThan(NOW - 50);
  });

  it("is never added to a page that exists or was removed", async () => {
    const com = fakeCom();
    const page = await publishVoiciPage({ ops: [], firstPost: WELCOME }, deps(com, { published: null }));
    const again = await publishVoiciPage({ ops: [], firstPost: WELCOME }, deps(com, { published: page }));
    expect(again.chunks.flat().filter((p: any) => p.text === WELCOME)).toHaveLength(1);
    const removed = { ...page, chunks: [], index: { ...page.index, seq: page.index.seq + 1, pieces: [] } };
    const back = await publishVoiciPage({ ops: [], firstPost: WELCOME }, deps(com, { published: null, removed }));
    expect(back.chunks.flat().some((p: any) => p.text === WELCOME)).toBe(false);
    expect(defaultVoiciProfile(U).displayName).toBeDefined();
  });
});

describe("the shell", () => {
  const root = join(__dirname, "../public/webapp");
  const html = readFileSync(join(root, "index.html"), "utf8");
  it("has Profile, Inbox and Requests, a call button, and no Messages side or Calls row", () => {
    for (const id of ["social-tab-profile", "social-tab-inbox", "social-tab-requests", "social-call-button", "social-compact-header"]) expect(html).toContain(`data-testid="${id}"`);
    expect(html).not.toContain('data-testid="social-tab-messages"');
    expect(html).not.toContain('id="messages-calls"');
    expect(html).not.toContain("data-messages-tab");
  });

  it("caches the counts module", () => {
    expect(readFileSync(join(root, "service-worker.js"), "utf8")).toContain('"/lib/socialCounts.js"');
  });

  it("asks for the first post in the browser's language", () => {
    expect(readFileSync(join(root, "lib/voiciPageControl.js"), "utf8")).toContain(`tr("${WELCOME}")`);
  });
});
