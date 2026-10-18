// The webapp's security notice client (lib/securityNotice.js, lib/noticeUi.js,
// lib/updateLock.js, the lock in lib/comFetch.js): the anonymous fetch, the
// fail-open rules, anti-rollback, the lock's reach and its exact strings.
// Chains are synthetic (a test pin), signed with a test maintainer key.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { generateKeypair, mandatePinHash, signMandate, type Mandate } from "@ibisllc/maintainers";
import { CLIENT_PROTOCOL_LEVEL, signSecurityNotice, type SecurityNoticeBody } from "@flagship/protocol";

const LIB = resolve(__dirname, "../public/webapp/lib");
const imp = (f: string) => import(pathToFileURL(resolve(LIB, f)).href);

const DAY = 24 * 3600_000;
const NOW = Date.parse("2026-10-20T12:00:00Z");

function seedBytes(b: number): Uint8Array {
  const s = new Uint8Array(32);
  s[0] = b;
  return s;
}

function chain(seedByte: number, issuedAt = "2026-09-01T00:00:00.000Z") {
  const kp = generateKeypair(seedBytes(seedByte));
  const unsigned: Omit<Mandate, "signatures"> = {
    kind: "Mandate",
    version: 1,
    mandateId: `ca${seedByte.toString(16).padStart(2, "0")}0000-0000-4000-8000-000000000000`,
    track: "ca",
    holder: kp.pubKey,
    issuedAt,
    expiresAt: "2027-03-01T00:00:00.000Z",
    successors: [kp.pubKey],
    approvalRule: { kind: "threshold", threshold: 1 },
    minSuccessors: 1,
    maxDurationSeconds: 365 * 86400,
    defaultDurationSeconds: 180 * 86400,
    signedBy: kp.pubKey,
  };
  const mandate = signMandate(unsigned, [{ privKey: kp.privKey }]);
  const sign = (body: SecurityNoticeBody) =>
    signSecurityNotice(body, {
      publicKey: Uint8Array.from(Buffer.from(kp.pubKey, "hex")),
      privateKey: Uint8Array.from(Buffer.from(kp.privKey, "hex")),
    });
  return { kp, mandate, pin: mandatePinHash(mandate), sign };
}

const lockBody = (over: Partial<SecurityNoticeBody> = {}): SecurityNoticeBody => ({
  seq: 5,
  kind: "update-required",
  validFrom: NOW - DAY,
  validUntil: NOW + 10 * DAY,
  eventAt: 0,
  lockFrom: NOW - 1000,
  platforms: { web: { minBuild: 999, minProtocol: 0 } },
  advisoryId: "FSA-2026-001",
  deprecatesProtocol: 0,
  reason: "A signing flaw lets an attacker act as you.",
  message: "You must update Flagship.",
  ...over,
});

function memStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    raw: m,
  };
}

function okFetch(doc: unknown, calls: Array<{ url: string; init: RequestInit }> = []) {
  return async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(doc), { status: 200, headers: { "content-type": "application/json" } });
  };
}

beforeEach(async () => {
  (await imp("securityNotice.js"))._resetSecurityNoticesForTests();
});
afterEach(async () => {
  (await imp("securityNotice.js"))._resetSecurityNoticesForTests();
});

describe("what this build is", () => {
  it("WEB_BUILD is the shell version and PROTOCOL_LEVEL is the protocol's", async () => {
    const info = await imp("buildInfo.js");
    const sw = readFileSync(resolve(LIB, "../service-worker.js"), "utf8");
    const m = sw.match(/const SHELL_VERSION = "v(\d+)"/);
    expect(info.WEB_BUILD).toBe(Number(m![1]));
    expect(info.PROTOCOL_LEVEL).toBe(CLIENT_PROTOCOL_LEVEL);
    expect(info.PLATFORM).toBe("web");
  });
});

describe("the anonymous fetch", () => {
  it("is one plain GET with no credentials, headers, query or referrer", async () => {
    const sn = await imp("securityNotice.js");
    const c = chain(1);
    const calls: Array<{ url: string; init: RequestInit }> = [];
    await sn.refreshSecurityNotice({
      fetchImpl: okFetch({ version: 1, notice: c.sign(lockBody()), mandates: [c.mandate] }, calls),
      now: NOW, storage: memStorage(), pin: c.pin, client: { platform: "web", build: 1, protocol: 1 },
    });
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    expect(url).toMatch(/\/api\/notices$/);
    expect(new URL(url).search).toBe("");
    expect(init.method).toBe("GET");
    expect(init.credentials).toBe("omit");
    expect(init.referrerPolicy).toBe("no-referrer");
    expect(init.headers).toBeUndefined();
    expect(init.body).toBeUndefined();
  });
});

describe("a verified update-required notice", () => {
  it("locks a build below the minimum, and the lock reaches the network guard", async () => {
    const sn = await imp("securityNotice.js");
    const lock = await imp("updateLock.js");
    const c = chain(2);
    const storage = memStorage();
    const r = await sn.refreshSecurityNotice({
      fetchImpl: okFetch({ version: 1, notice: c.sign(lockBody()), mandates: [c.mandate] }),
      now: NOW, storage, pin: c.pin, client: { platform: "web", build: 144, protocol: 1 },
    });
    expect(r.refused).toBeNull();
    expect(sn.securityNotices.outcome.action).toBe("lock");
    expect(lock.isUpdateLocked()).toBe(true);
    const allow = (req: object) => lock.updateLockAllows(req);
    expect(allow({ url: "https://webapp.x/lib/a.js", method: "GET", sameOrigin: true, controlHost: false })).toBe(true);
    expect(allow({ url: "https://flagshipserver.com/api/notices", method: "GET", sameOrigin: false, controlHost: true })).toBe(true);
    expect(allow({ url: "https://flagshipserver.com/api/x", method: "POST", sameOrigin: false, controlHost: true })).toBe(false);
    expect(allow({ url: "https://home.u.flagship.services/api/screens/x", method: "GET", sameOrigin: false, controlHost: false })).toBe(false);
    expect(allow({ url: "https://home.u.flagship.services/api/orders", method: "POST", sameOrigin: false, controlHost: false })).toBe(false);
  });

  it("the global fetch guard refuses orders and box calls but not the shell or .com reads", async () => {
    const sn = await imp("securityNotice.js");
    const cf = await imp("comFetch.js");
    const c = chain(3);
    const seen: string[] = [];
    const real = globalThis.fetch;
    const realLoc = (globalThis as { location?: unknown }).location;
    (globalThis as { location?: unknown }).location = { href: "https://webapp.flagshipserver.com/", origin: "https://webapp.flagshipserver.com" };
    globalThis.fetch = (async (input: string | Request) => {
      seen.push(typeof input === "string" ? input : input.url);
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    try {
      cf.installComFetchGuard();
      await sn.refreshSecurityNotice({
        fetchImpl: okFetch({ version: 1, notice: c.sign(lockBody()), mandates: [c.mandate] }),
        now: NOW, storage: memStorage(), pin: c.pin, client: { platform: "web", build: 144, protocol: 1 },
      });
      await expect(fetch("https://home.u.flagship.services/api/screens/orders", { method: "POST" })).rejects.toMatchObject({ updateRequired: true });
      await expect(fetch("https://flagshipserver.com/api/accounts/u/read-token", { method: "POST" })).rejects.toMatchObject({ updateRequired: true });
      await expect(fetch("https://home.u.flagship.services/api/screens/pods")).rejects.toMatchObject({ updateRequired: true });
      await fetch("https://webapp.flagshipserver.com/service-worker.js");
      await fetch("https://flagshipserver.com/api/users/u/recovery");
      expect(seen).toEqual([
        "https://webapp.flagshipserver.com/service-worker.js",
        "https://flagshipserver.com/api/users/u/recovery",
      ]);
    } finally {
      cf.uninstallComFetchGuard();
      globalThis.fetch = real;
      (globalThis as { location?: unknown }).location = realLoc;
    }
  });

  it("does not lock a build at the minimum, and nothing is locked before lockFrom (it nags)", async () => {
    const sn = await imp("securityNotice.js");
    const c = chain(4);
    const s1 = memStorage();
    await sn.refreshSecurityNotice({
      fetchImpl: okFetch({ version: 1, notice: c.sign(lockBody({ platforms: { web: { minBuild: 144, minProtocol: 0 } } })), mandates: [c.mandate] }),
      now: NOW, storage: s1, pin: c.pin, client: { platform: "web", build: 144, protocol: 1 },
    });
    expect(sn.securityNotices.outcome).toMatchObject({ action: "none", why: "up-to-date" });

    sn._resetSecurityNoticesForTests();
    const s2 = memStorage();
    await sn.refreshSecurityNotice({
      fetchImpl: okFetch({ version: 1, notice: c.sign(lockBody({ lockFrom: NOW + 3 * DAY })), mandates: [c.mandate] }),
      now: NOW, storage: s2, pin: c.pin, client: { platform: "web", build: 144, protocol: 1 },
    });
    expect(sn.securityNotices.outcome).toMatchObject({ action: "banner", style: "update" });
    expect((await imp("updateLock.js")).isUpdateLocked()).toBe(false);
    await sn.evaluateSecurityNotice({ now: NOW + 3 * DAY + 1, storage: s2, pin: c.pin, client: { platform: "web", build: 144, protocol: 1 } });
    expect(sn.securityNotices.outcome.action).toBe("lock");
  });

  it("keeps a cached lock while offline, and drops it the moment it expires", async () => {
    const sn = await imp("securityNotice.js");
    const c = chain(5);
    const storage = memStorage();
    const client = { platform: "web", build: 144, protocol: 1 };
    await sn.refreshSecurityNotice({
      fetchImpl: okFetch({ version: 1, notice: c.sign(lockBody()), mandates: [c.mandate] }),
      now: NOW, storage, pin: c.pin, client,
    });
    const offline = async () => { throw new TypeError("offline"); };
    await sn.refreshSecurityNotice({ fetchImpl: offline, now: NOW + DAY, storage, pin: c.pin, client });
    expect(sn.securityNotices.outcome.action).toBe("lock");
    await sn.evaluateSecurityNotice({ now: NOW + 10 * DAY - 1, storage, pin: c.pin, client });
    expect(sn.securityNotices.outcome.action).toBe("lock");
    await sn.evaluateSecurityNotice({ now: NOW + 10 * DAY, storage, pin: c.pin, client });
    expect(sn.securityNotices.outcome).toMatchObject({ action: "none", why: "expired" });
    expect((await imp("updateLock.js")).isUpdateLocked()).toBe(false);
    await sn.evaluateSecurityNotice({ now: NOW + 400 * DAY, storage, pin: c.pin, client });
    expect(sn.securityNotices.outcome.action).toBe("none");
  });

  it("unlocks when the build is updated past the minimum", async () => {
    const sn = await imp("securityNotice.js");
    const c = chain(6);
    const storage = memStorage();
    await sn.refreshSecurityNotice({
      fetchImpl: okFetch({ version: 1, notice: c.sign(lockBody()), mandates: [c.mandate] }),
      now: NOW, storage, pin: c.pin, client: { platform: "web", build: 144, protocol: 1 },
    });
    expect(sn.securityNotices.outcome.action).toBe("lock");
    await sn.evaluateSecurityNotice({ now: NOW, storage, pin: c.pin, client: { platform: "web", build: 999, protocol: 1 } });
    expect(sn.securityNotices.outcome.action).toBe("none");
    expect((await imp("updateLock.js")).isUpdateLocked()).toBe(false);
  });
});

describe("fail open", () => {
  const client = { platform: "web", build: 1, protocol: 1 };
  async function run(response: () => Promise<Response>, c = chain(7), storage = memStorage()) {
    const sn = await imp("securityNotice.js");
    const r = await sn.refreshSecurityNotice({ fetchImpl: response, now: NOW, storage, pin: c.pin, client });
    return { sn, r, storage };
  }
  const json = (v: unknown, status = 200) => async () => new Response(JSON.stringify(v), { status });

  it("an unreachable endpoint, a 500, a 204 and junk lock nothing", async () => {
    for (const resp of [
      async () => { throw new TypeError("network"); },
      json({}, 500),
      async () => new Response(null, { status: 204 }),
      async () => new Response("<html>", { status: 200 }),
      json({ version: 1 }),
      json({ version: 2, notice: {}, mandates: [] }),
      json({ version: 1, notice: "x", mandates: "y" }),
    ]) {
      const { sn } = await run(resp);
      expect(sn.securityNotices.outcome.action).toBe("none");
      sn._resetSecurityNoticesForTests();
    }
  });

  it("a notice signed by a key that is not the authority locks nothing", async () => {
    const real = chain(8);
    const attacker = chain(9);
    const { sn, r } = await run(json({ version: 1, notice: attacker.sign(lockBody()), mandates: [real.mandate] }), real);
    expect(r.refused).toBe("unauthorized-signer");
    expect(sn.securityNotices.outcome.action).toBe("none");
  });

  it("an attacker's own chain does not hash to the baked pin, so nothing locks", async () => {
    const real = chain(10);
    const attacker = chain(11);
    const { sn, r } = await run(json({ version: 1, notice: attacker.sign(lockBody()), mandates: [attacker.mandate] }), real);
    expect(r.refused).toBe("unauthorized-signer");
    expect(sn.securityNotices.outcome.action).toBe("none");
  });

  it("a tampered notice, an unsigned one and one past its window lock nothing", async () => {
    const c = chain(12);
    const good = c.sign(lockBody());
    for (const notice of [
      { ...good, message: "Something else." },
      { ...good, signature: "00".repeat(64) },
      { ...good, validUntil: good.validFrom + 31 * DAY },
      { ...good, advisoryId: "" },
    ]) {
      const { sn } = await run(json({ version: 1, notice, mandates: [c.mandate] }), c);
      expect(sn.securityNotices.outcome.action).toBe("none");
      sn._resetSecurityNoticesForTests();
    }
    const old = c.sign(lockBody({ validFrom: NOW - 20 * DAY, validUntil: NOW - 10 * DAY, lockFrom: NOW - 20 * DAY }));
    const { sn } = await run(json({ version: 1, notice: old, mandates: [c.mandate] }), c);
    expect(sn.securityNotices.outcome).toMatchObject({ action: "none", why: "expired" });
  });

  it("a mandate chain that has lapsed at this clock cannot lock", async () => {
    const c = chain(13);
    const sn = await imp("securityNotice.js");
    const storage = memStorage();
    const r = await sn.refreshSecurityNotice({
      fetchImpl: json({ version: 1, notice: c.sign(lockBody()), mandates: [c.mandate] }),
      now: Date.parse("2027-04-01T00:00:00Z"), storage, pin: c.pin, client,
    });
    expect(r.refused).toBe("unauthorized-signer");
    expect(sn.securityNotices.outcome.action).toBe("none");
  });

  it("a stored lock whose authority can no longer be shown locks nothing", async () => {
    const c = chain(14);
    const sn = await imp("securityNotice.js");
    const storage = memStorage();
    await sn.refreshSecurityNotice({ fetchImpl: json({ version: 1, notice: c.sign(lockBody()), mandates: [c.mandate] }), now: NOW, storage, pin: c.pin, client });
    expect(sn.securityNotices.outcome.action).toBe("lock");
    await sn.evaluateSecurityNotice({ now: NOW, storage, pin: chain(15).pin, client });
    expect(sn.securityNotices.outcome.action).toBe("none");
  });

  it("a corrupt cache is ignored", async () => {
    const sn = await imp("securityNotice.js");
    const storage = memStorage();
    storage.setItem(sn.STORE_KEY, "{not json");
    await sn.evaluateSecurityNotice({ now: NOW, storage, client });
    expect(sn.securityNotices.outcome.action).toBe("none");
    storage.setItem(sn.STORE_KEY, JSON.stringify({ highestSeq: "x", doc: 7 }));
    await sn.evaluateSecurityNotice({ now: NOW, storage, client });
    expect(sn.securityNotices.outcome.action).toBe("none");
  });
});

describe("anti-rollback", () => {
  const client = { platform: "web", build: 1, protocol: 1 };

  it("an older notice cannot bring a lock back after an all clear", async () => {
    const sn = await imp("securityNotice.js");
    const c = chain(16);
    const storage = memStorage();
    const feed = (notice: unknown) => okFetch({ version: 1, notice, mandates: [c.mandate] });
    const clear = c.sign(lockBody({ seq: 8, kind: "none", lockFrom: 0, platforms: {}, advisoryId: "", reason: "", message: "" }));
    await sn.refreshSecurityNotice({ fetchImpl: feed(c.sign(lockBody({ seq: 7 }))), now: NOW, storage, pin: c.pin, client });
    expect(sn.securityNotices.outcome.action).toBe("lock");
    await sn.refreshSecurityNotice({ fetchImpl: feed(clear), now: NOW, storage, pin: c.pin, client });
    expect(sn.securityNotices.outcome.action).toBe("none");
    const r = await sn.refreshSecurityNotice({ fetchImpl: feed(c.sign(lockBody({ seq: 7 }))), now: NOW, storage, pin: c.pin, client });
    expect(r.refused).toBe("stale");
    expect(sn.securityNotices.outcome.action).toBe("none");
    expect(sn.loadStore(storage).highestSeq).toBe(8);
  });

  it("an authority chain older than one already verified is refused", async () => {
    const sn = await imp("securityNotice.js");
    const old = chain(17, "2026-06-01T00:00:00.000Z");
    // A later renewal by the same holder: same pin chain, later issuedAt.
    const kp = old.kp;
    const renewalUnsigned: Omit<Mandate, "signatures"> = {
      ...old.mandate,
      mandateId: "ca110000-0000-4000-8000-0000000000aa",
      issuedAt: "2026-10-01T00:00:00.000Z",
      expiresAt: "2027-03-01T00:00:00.000Z",
    } as never;
    delete (renewalUnsigned as { signatures?: unknown }).signatures;
    const renewal = signMandate(renewalUnsigned, [{ privKey: kp.privKey }]);
    const storage = memStorage();
    const client = { platform: "web", build: 1, protocol: 1 };
    const full = [old.mandate, renewal];
    const first = await sn.refreshSecurityNotice({ fetchImpl: okFetch({ version: 1, notice: old.sign(lockBody({ seq: 1, kind: "maintenance", lockFrom: 0, platforms: {}, advisoryId: "", reason: "", eventAt: 0, message: "We will update soon." })), mandates: full }), now: NOW, storage, pin: old.pin, client });
    expect(first.refused).toBeNull();
    expect(sn.loadStore(storage).tip).toBe(Date.parse("2026-10-01T00:00:00.000Z"));
    // A hostile carrier replays only the chain from before the renewal.
    const replay = await sn.refreshSecurityNotice({ fetchImpl: okFetch({ version: 1, notice: old.sign(lockBody({ seq: 2 })), mandates: [old.mandate] }), now: NOW, storage, pin: old.pin, client });
    expect(replay.refused).toBe("unauthorized-signer");
  });
});

describe("banners", () => {
  const banner = (kind: string, style: string, seq = 1) =>
    ({ action: "banner", style, notice: { seq, kind } }) as never;

  it("a maintenance banner stays dismissed for its seq; a new seq shows again", async () => {
    const sn = await imp("securityNotice.js");
    const store = { highestSeq: 1, doc: null, tip: 0, dismissed: { seq: 1, at: NOW } };
    expect(sn.bannerVisible(banner("maintenance", "maintenance"), store, { now: NOW + 30 * DAY })).toBe(false);
    expect(sn.bannerVisible(banner("maintenance", "maintenance", 2), store, { now: NOW })).toBe(true);
    expect(sn.bannerVisible({ action: "none" }, store)).toBe(false);
  });

  it("an update banner comes back after a day; the grace window of a required one comes back each launch", async () => {
    const sn = await imp("securityNotice.js");
    const store = { highestSeq: 1, doc: null, tip: 0, dismissed: { seq: 1, at: NOW } };
    expect(sn.bannerVisible(banner("update-advisory", "update"), store, { now: NOW + 1000 })).toBe(false);
    expect(sn.bannerVisible(banner("update-advisory", "update"), store, { now: NOW + DAY })).toBe(true);
    expect(sn.bannerVisible(banner("update-required", "update"), store, { now: NOW + 1000 })).toBe(true);
    expect(sn.bannerVisible(banner("update-required", "update"), store, { now: NOW + 1000, sessionDismissed: true })).toBe(false);
  });
});

describe("the screens' exact strings", () => {
  it("the lock screen", async () => {
    const ui = await imp("noticeUi.js");
    const sn = await imp("securityNotice.js");
    const c = chain(18);
    const n = sn.parseSecurityNotice(
      JSON.parse(JSON.stringify(c.sign(lockBody({ eventAt: NOW + 2 * DAY, message: "You must update Flagship by {date}. Older versions will stop working." })))),
    );
    const m = ui.lockModel(n, { unlocked: true, formatDate: () => "Thursday 22 October" });
    expect(m).toEqual({
      kicker: "Security update",
      title: "Update required",
      body: "You must update Flagship by Thursday 22 October. Older versions will stop working.",
      why: "Why: A signing flaw lets an attacker act as you.",
      reassure: "Your accounts and servers are unchanged and nothing has been deleted. Flagship is paused on this device until you update.",
      update: "Reload to update",
      backup: "Back up my account key",
      signOut: "Sign out",
      meta: "Advisory FSA-2026-001 · Signed by the Flagship maintainers",
    });
    expect(ui.lockModel(n, { unlocked: false }).backup).toBe("Unlock to back up my account key");
  });

  it("the banners", async () => {
    const ui = await imp("noticeUi.js");
    const sn = await imp("securityNotice.js");
    const c = chain(19);
    const maint = sn.parseSecurityNotice(
      JSON.parse(JSON.stringify(c.sign(lockBody({ kind: "maintenance", lockFrom: 0, platforms: {}, advisoryId: "", reason: "", eventAt: NOW + DAY, message: "We will update on {date}. flagshipserver.com may be briefly unavailable." })))),
    );
    expect(ui.bannerModel({ action: "banner", style: "maintenance", notice: maint }, () => "Wednesday 21 October")).toEqual({
      style: "maintenance",
      text: "We will update on Wednesday 21 October. flagshipserver.com may be briefly unavailable.",
      update: false,
      dismiss: "Dismiss",
      action: null,
    });
    const upd = ui.bannerModel({ action: "banner", style: "update", notice: maint }, () => "x");
    expect(upd.action).toBe("Reload to update");
    expect(ui.bannerModel({ action: "none", why: "expired" })).toBeNull();
  });

  it("no em dash, en dash or emoji in any string the screens show", async () => {
    const ui = await imp("noticeUi.js");
    const all = Object.values(ui.NOTICE_COPY).map((v) => (typeof v === "function" ? (v as (s: string) => string)("FSA-1") : String(v))).join(" ");
    expect(all).not.toMatch(/[–—]/);
    expect(all).not.toMatch(/\p{Extended_Pictographic}/u);
  });
});
