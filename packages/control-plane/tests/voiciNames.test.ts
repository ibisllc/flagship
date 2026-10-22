import { describe, expect, it } from "vitest";
import { deriveIRK, ed, signVoiciNameOrder, type Keypair, type VoiciNameOrder } from "@flagship/protocol";
import { InMemoryStorage } from "@flagship/storage";
import {
  VOICI_CHANGES_PER_ACCOUNT_DAY,
  VOICI_NAME_INACTIVE_MS,
  VOICI_NAME_LIMITS,
  VOICI_NAME_WAIT_MS,
  checkVoiciName,
  handleListVoiciNames,
  handleVoiciNameSet,
  releaseAccountLinks,
  runVoiciNamesMaintenance,
  voiciLinkState,
  type VoiciNamesDeps,
} from "../src/voiciNames.js";
import { handleVoiciRedirect } from "../src/voici.js";
import type { DibsFetch } from "../src/nameDibs.js";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 1);
const WINDOW = { start: Date.UTC(2026, 9, 15), end: Date.UTC(2027, 3, 15) };
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

const alice = deriveIRK({ seed: new Uint8Array(32).fill(1) });
const mallory = deriveIRK({ seed: new Uint8Array(32).fill(9) });
const SVC = "alice--party";
const SVC2 = "alice--wiki";

/** A scripted internet: which `<name>.com` are registered. `failDns` errors every lookup. */
function dns(registered: string[] = [], failDns = false): DibsFetch {
  return async (url) => {
    const u = new URL(url);
    if (failDns) return { ok: false, status: 502, json: async () => ({}), text: async () => "" };
    const name = u.searchParams.get("name")!;
    const reg = registered.includes(name);
    return { ok: true, status: 200, text: async () => "", json: async () => (reg ? { Status: 0, Answer: [{ type: 2, data: "ns1." }] } : { Status: 3 }) };
  };
}

async function setup(opts: { registered?: string[]; failDns?: boolean; window?: { start?: number; end?: number }; tier?: "free" | "hobby" | "maker"; now?: () => number } = {}) {
  const s = new InMemoryStorage();
  await s.usernames.put({ username: "alice", irkPubHex: hex(alice.publicKey), claimedAt: 1 });
  await s.usernames.put({ username: "bob", irkPubHex: hex(deriveIRK({ seed: new Uint8Array(32).fill(2) }).publicKey), claimedAt: 1 });
  if (opts.tier && opts.tier !== "free") await s.tiers.put({ username: "alice", tier: opts.tier, updatedAt: 1 });
  const clock = { t: NOW };
  const deps: VoiciNamesDeps = {
    usernames: s.usernames,
    voiciLinks: s.voiciLinks,
    voiciNames: s.voiciNames,
    tiers: s.tiers,
    auditEvents: s.auditEvents,
    dibs: { claims: s.nameDibsClaims, window: opts.window ?? WINDOW, fetch: dns(opts.registered, opts.failDns) },
    now: opts.now ?? (() => clock.t),
  };
  return { s, deps, clock };
}

let nonceN = 0;
function order(o: Partial<VoiciNameOrder> & { name?: string; op?: "set" | "clear" }, key: Keypair = alice, at = NOW) {
  const op = o.op ?? "set";
  const full: VoiciNameOrder = {
    user: o.user ?? "alice",
    serviceId: o.serviceId ?? SVC,
    name: op === "clear" ? "" : (o.name ?? "halloweenparty"),
    op,
    issuedAt: o.issuedAt ?? at,
    nonce: o.nonce ?? (++nonceN).toString(16).padStart(64, "0"),
  };
  return { order: full, signature: hex(signVoiciNameOrder(full, key)) };
}
const set = (d: VoiciNamesDeps, name: string, serviceId = SVC, extra: Partial<VoiciNameOrder> = {}, key = alice) =>
  handleVoiciNameSet(d, "alice", serviceId, order({ name, serviceId, ...extra }, key, d.now!()));
const clear = (d: VoiciNamesDeps, serviceId = SVC) => handleVoiciNameSet(d, "alice", serviceId, order({ op: "clear", serviceId }, alice, d.now!()));
const code = (r: { body: unknown }) => (r.body as { code?: string }).code;

describe("checkVoiciName", () => {
  it("answers invalid, reserved, available and current", async () => {
    const { deps } = await setup();
    expect(await checkVoiciName(deps, "alice", SVC, "abc")).toEqual({ status: "invalid", problem: "too-short" });
    expect(await checkVoiciName(deps, "alice", SVC, "my party")).toEqual({ status: "invalid", problem: "characters" });
    expect(await checkVoiciName(deps, "alice", SVC, "log-in")).toEqual({ status: "reserved" });
    expect(await checkVoiciName(deps, "alice", SVC, "Halloween-Party")).toEqual({ status: "available" });
    await set(deps, "halloween-party");
    expect(await checkVoiciName(deps, "alice", SVC, "halloweenparty")).toEqual({ status: "current" });
  });

  it("calls a name taken by another account, another service of the same account, or a random code", async () => {
    const { deps, s } = await setup();
    await s.voiciNames.claim({ key: "chessclub", display: "chess-club", username: "bob", serviceId: "bob--chess", state: "live", setAt: 1, lastActiveAt: 1, warned: 0 });
    await s.voiciLinks.insert({ code: "k3x9qa", username: "bob", serviceId: "bob--x", targetUrl: "https://x.example/", createdAt: 1 });
    expect(await checkVoiciName(deps, "alice", SVC, "chess-club")).toEqual({ status: "taken" });
    expect(await checkVoiciName(deps, "alice", SVC, "chessclub")).toEqual({ status: "taken" });
    expect(await checkVoiciName(deps, "alice", SVC, "k3x9qa")).toEqual({ status: "taken" });
    await set(deps, "mynotes", SVC);
    expect(await checkVoiciName(deps, "alice", SVC2, "mynotes")).toEqual({ status: "taken" });
  });

  it("holds a name for its .com owner while dibs is open, and fails closed when the lookup fails", async () => {
    const reg = await setup({ registered: ["nike.com"] });
    expect(await checkVoiciName(reg.deps, "alice", SVC, "nike")).toEqual({ status: "dibs", domain: "nike.com", until: WINDOW.end });
    const down = await setup({ failDns: true });
    expect(await checkVoiciName(down.deps, "alice", SVC, "nike")).toEqual({ status: "dibs-unchecked", domain: "nike.com" });
  });

  it("lets the account that proved the domain take the name, and nobody else", async () => {
    const { deps, s } = await setup({ registered: ["nike.com"] });
    await s.nameDibsClaims.start({ name: "nike", username: "alice", irkPubHex: hex(alice.publicKey), nonce: "aa", createdAt: 1 });
    await s.nameDibsClaims.markVerified("nike", "alice", "dns", 2);
    expect((await checkVoiciName(deps, "alice", SVC, "nike")).status).toBe("available");
    expect((await checkVoiciName(deps, "bob", "bob--x", "nike")).status).toBe("dibs");
  });

  it("ignores .com registrations before and after the window", async () => {
    const early = await setup({ registered: ["nike.com"], window: { start: NOW + DAY, end: NOW + 2 * DAY } });
    expect((await checkVoiciName(early.deps, "alice", SVC, "nike")).status).toBe("available");
    const late = await setup({ registered: ["nike.com"], window: { start: NOW - 3 * DAY, end: NOW - DAY } });
    expect((await checkVoiciName(late.deps, "alice", SVC, "nike")).status).toBe("available");
    const off = await setup({ registered: ["nike.com"], window: {} });
    expect((await checkVoiciName(off.deps, "alice", SVC, "nike")).status).toBe("available");
  });

  it("checks the hyphenated label's .com too", async () => {
    const { deps } = await setup({ registered: ["halloween-party.com"] });
    expect(await checkVoiciName(deps, "alice", SVC, "halloween-party")).toEqual({ status: "dibs", domain: "halloween-party.com", until: WINDOW.end });
    expect((await checkVoiciName(deps, "alice", SVC, "halloweenparty")).status).toBe("available");
  });
});

describe("handleVoiciNameSet", () => {
  it("sets a name, shows it in the link state and writes an audit row", async () => {
    const { deps, s } = await setup();
    const r = await set(deps, "Halloween-Party");
    expect(r.status).toBe(200);
    expect((r.body as { link: { name: string } }).link.name).toBe("halloween-party");
    expect((await s.voiciNames.get("halloweenparty"))?.state).toBe("live");
    const rows = await s.auditEvents.list("alice", 0, 10);
    expect(rows.map((r) => r.eventKind)).toContain("voici-name-set");
  });

  it("replaces a name: the old one enters its wait and the count stays the same", async () => {
    const { deps, s } = await setup();
    await set(deps, "firstname");
    const r = await set(deps, "secondname");
    expect(r.status).toBe(200);
    expect(await s.voiciNames.countLive("alice")).toBe(1);
    expect(await s.voiciNames.get("firstname")).toMatchObject({ state: "waiting", releaseReason: "replaced" });
  });

  it("clears a name back to the code, and clearing nothing is fine", async () => {
    const { deps, s } = await setup();
    await set(deps, "mynotes");
    expect((await clear(deps)).status).toBe(200);
    expect((await s.voiciNames.get("mynotes"))?.releaseReason).toBe("cleared");
    expect((await clear(deps)).status).toBe(200);
    expect(await s.voiciNames.changesForService("alice", SVC, 0)).toHaveLength(2);
  });

  it("setting the same name again changes nothing and counts nothing", async () => {
    const { deps, s } = await setup();
    await set(deps, "mynotes");
    expect((await set(deps, "my-notes")).status).toBe(200);
    expect(await s.voiciNames.changesForService("alice", SVC, 0)).toHaveLength(1);
  });

  it("refuses an invalid, a reserved and a taken name with a code", async () => {
    const { deps, s } = await setup();
    expect(code(await set(deps, "abc"))).toBe("invalid");
    expect(code(await set(deps, "flagship"))).toBe("reserved");
    await s.voiciNames.claim({ key: "chessclub", display: "chessclub", username: "bob", serviceId: "bob--chess", state: "live", setAt: 1, lastActiveAt: 1, warned: 0 });
    expect(code(await set(deps, "chess-club"))).toBe("taken");
  });

  it("refuses a name held for its .com, with the domain and the end of the window", async () => {
    const { deps } = await setup({ registered: ["nike.com"] });
    const r = await set(deps, "nike");
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: "dibs", domain: "nike.com", until: WINDOW.end });
    const down = await setup({ failDns: true });
    expect(code(await set(down.deps, "nike"))).toBe("dibs-unchecked");
  });

  it("only an admin device can change a link: another key is refused", async () => {
    const { deps } = await setup();
    const r = await set(deps, "mynotes", SVC, {}, mallory);
    expect(r.status).toBe(403);
    expect(code(r)).toBe("not-admin");
  });

  it("refuses a stale order, another account's order, a url mismatch and a replayed nonce", async () => {
    const { deps } = await setup();
    expect(code(await set(deps, "mynotes", SVC, { issuedAt: NOW - 10 * 60_000 }))).toBe("stale");
    expect((await handleVoiciNameSet(deps, "alice", SVC, order({ user: "bob", name: "mynotes" }))).status).toBe(403);
    expect((await handleVoiciNameSet(deps, "alice", SVC2, order({ name: "mynotes" }))).status).toBe(403);
    const o = order({ name: "mynotes" });
    expect((await handleVoiciNameSet(deps, "alice", SVC, o)).status).toBe(200);
    expect(code(await handleVoiciNameSet(deps, "alice", SVC, o))).toBe("replayed");
  });

  it("holds each plan to its number of names: a new name needs a free slot, a replace needs to be within the limit", async () => {
    const { deps, s } = await setup();
    const free = VOICI_NAME_LIMITS.free;
    for (let i = 0; i < free; i++) {
      const r = await set(deps, `name${"abcdefghij"[i]}x${i}ab`, `alice--app${i}`);
      expect(r.status, String(i)).toBe(200);
    }
    const over = await set(deps, "onetoomany", "alice--extra");
    expect(over.status).toBe(409);
    expect(over.body).toMatchObject({ code: "name-limit", held: free, limit: free });
    // A replace at the limit is fine: the count doesn't move.
    expect((await set(deps, "swapped-name", "alice--app0")).status).toBe(200);
    expect(await s.voiciNames.countLive("alice")).toBe(free);
    // Clearing frees a slot at once.
    expect((await clear(deps, "alice--app1")).status).toBe(200);
    expect((await set(deps, "onetoomany", "alice--extra")).status).toBe(200);
  });

  it("after a downgrade the account keeps its names but can neither add nor replace until it is back within the limit", async () => {
    const { deps, s, clock } = await setup({ tier: "hobby" });
    for (let i = 0; i < 7; i++) {
      expect((await set(deps, `held${"abcdefg"[i]}name`, `alice--app${i}`)).status).toBe(200);
    }
    await s.tiers.put({ username: "alice", tier: "free", updatedAt: 2 });
    clock.t += 2 * DAY; // past the daily brake the seven sets used up
    expect(code(await set(deps, "brandnew", "alice--fresh"))).toBe("name-limit");
    expect(code(await set(deps, "swapped-it", "alice--app0"))).toBe("name-limit");
    expect((await clear(deps, "alice--app0")).status).toBe(200);
    expect((await clear(deps, "alice--app1")).status).toBe(200);
    // 5 held, limit 5: a replace works, a new name still does not.
    expect((await set(deps, "swapped-it", "alice--app2")).status).toBe(200);
    expect(code(await set(deps, "brandnew", "alice--fresh"))).toBe("name-limit");
    await clear(deps, "alice--app3");
    expect((await set(deps, "brandnew", "alice--fresh")).status).toBe(200);
  });

  it("allows three changes to a service in 30 days, then says when the next one is allowed", async () => {
    const { deps, clock } = await setup();
    await set(deps, "namea1x");
    clock.t += DAY;
    await set(deps, "nameb2x");
    clock.t += DAY;
    await set(deps, "namec3x");
    clock.t += DAY;
    const r = await set(deps, "named4x");
    expect(r.status).toBe(429);
    expect(r.body).toMatchObject({ code: "change-limit", nextChangeAt: NOW + 30 * DAY });
    // Clearing is a change too.
    expect(code(await clear(deps))).toBe("change-limit");
    clock.t = NOW + 30 * DAY + 1;
    expect((await set(deps, "named4x")).status).toBe(200);
  });

  it("applies a brake of ten changes a day to the whole account", async () => {
    const { deps } = await setup({ tier: "maker" });
    for (let i = 0; i < VOICI_CHANGES_PER_ACCOUNT_DAY; i++) {
      expect((await set(deps, `dayname${i}x`, `alice--a${i}`)).status).toBe(200);
    }
    expect(code(await set(deps, "onetoomuch", "alice--zz"))).toBe("rate-limited");
  });

  it("nobody can take a name in its wait, the account that gave it up included; then it is free to anyone", async () => {
    const { deps, s, clock } = await setup();
    await set(deps, "mynotes");
    await clear(deps);
    expect(code(await set(deps, "mynotes", SVC2))).toBe("taken");
    expect(await checkVoiciName({ ...deps }, "bob", "bob--x", "mynotes")).toEqual({ status: "taken" });
    clock.t += VOICI_NAME_WAIT_MS + 1;
    await runVoiciNamesMaintenance(deps, async () => true, { offset: 0, count: 10 });
    expect(await s.voiciNames.get("mynotes")).toBeUndefined();
    expect((await checkVoiciName(deps, "bob", "bob--x", "mynotes")).status).toBe("available");
  });
});

describe("voiciLinkState and the names list", () => {
  it("reports the name, the slots and the changes left", async () => {
    const { deps, clock } = await setup();
    expect(await voiciLinkState(deps, "alice", SVC)).toMatchObject({ name: null, held: 0, limit: 5, changesLeft: 3, nextChangeAt: null, releasesAt: null });
    await set(deps, "mynotes");
    clock.t += DAY;
    await set(deps, "othername");
    clock.t += DAY;
    await set(deps, "thirdname");
    const st = await voiciLinkState(deps, "alice", SVC);
    expect(st).toMatchObject({ name: "thirdname", held: 1, changesLeft: 0, nextChangeAt: NOW + 30 * DAY });
    expect(st.releasesAt).toBe(NOW + 2 * DAY + VOICI_NAME_INACTIVE_MS);
  });

  it("lists the account's live names", async () => {
    const { deps } = await setup();
    await set(deps, "mynotes", SVC);
    await set(deps, "thewiki", SVC2);
    await clear(deps, SVC2);
    const r = await handleListVoiciNames(deps, "alice");
    expect((r.body as { names: Array<{ name: string }> }).names.map((n) => n.name)).toEqual(["mynotes"]);
  });
});

describe("the voi.ci redirect", () => {
  async function world() {
    const w = await setup();
    await w.s.voiciLinks.insert({ code: "k3x9qa", username: "alice", serviceId: SVC, targetUrl: "https://stored.example/", createdAt: 1 });
    await set(w.deps, "halloween-party");
    const redirect = (path: string, extra: object = {}) =>
      handleVoiciRedirect(
        { usernames: w.s.usernames, voiciLinks: w.s.voiciLinks, voiciNames: w.s.voiciNames, now: () => NOW, ...extra },
        path,
      );
    return { ...w, redirect };
  }

  it("sends the code and the name (with or without its hyphens) to the same place", async () => {
    const { redirect } = await world();
    const canonical = { resolveCanonical: async (u: string, id: string) => `https://party.${u}.flagship.services/#${id}` };
    for (const p of ["k3x9qa", "halloween-party", "halloweenparty"]) {
      const r = await redirect(p, canonical);
      expect(r.status, p).toBe(302);
      expect(r.headers?.location).toBe("https://party.alice.flagship.services/#alice--party");
      expect(r.headers?.["cache-control"]).toBe("private, no-store");
    }
  });

  it("falls back to the box that runs the app, then to the stored target, and 404s a name with nowhere to go", async () => {
    const { redirect } = await world();
    expect((await redirect("k3x9qa", { resolveAppUrl: async () => "https://box.example/" })).headers?.location).toBe("https://box.example/");
    expect((await redirect("k3x9qa")).headers?.location).toBe("https://stored.example/");
    expect((await redirect("halloweenparty")).status).toBe(404);
  });

  it("answers 410 and redirects nowhere for a name in its wait", async () => {
    const { redirect, deps } = await world();
    await clear(deps);
    const r = await redirect("halloween-party", { resolveCanonical: async () => "https://party.alice.flagship.services/" });
    expect(r.status).toBe(410);
    expect(r.headers?.location).toBeUndefined();
  });

  it("answers 410 for a retired code and 404 for one that never existed", async () => {
    const { redirect, s } = await world();
    await s.voiciLinks.retireByService("alice", SVC, 5);
    expect((await redirect("k3x9qa")).status).toBe(410);
    expect((await redirect("zzzzzz")).status).toBe(404);
    expect((await redirect("no-such-name")).status).toBe(404);
  });
});

describe("account deletion", () => {
  it("puts every name into its wait and retires every code", async () => {
    const { deps, s } = await setup();
    await s.voiciLinks.insert({ code: "k3x9qa", username: "alice", serviceId: SVC, targetUrl: "https://x.example/", createdAt: 1 });
    await set(deps, "mynotes");
    await releaseAccountLinks(deps, "alice");
    expect(await s.voiciNames.get("mynotes")).toMatchObject({ state: "waiting", releaseReason: "deleted" });
    expect((await s.voiciLinks.get("k3x9qa"))?.retiredAt).toBe(NOW);
  });
});

describe("runVoiciNamesMaintenance", () => {
  const events: Array<{ kind: string; name: string }> = [];
  const hooks = { notify: async (e: { kind: string; name: string }) => void events.push({ kind: e.kind, name: e.name }) };

  it("keeps a name whose app runs, and counts its idle time from the last time it ran", async () => {
    const { deps, s, clock } = await setup();
    await set(deps, "mynotes");
    clock.t += 50 * DAY;
    await runVoiciNamesMaintenance(deps, async () => true, { offset: 0, count: 10 }, hooks);
    expect((await s.voiciNames.get("mynotes"))?.lastActiveAt).toBe(NOW + 50 * DAY);
    clock.t += 50 * DAY;
    const r = await runVoiciNamesMaintenance(deps, async () => false, { offset: 0, count: 10 }, hooks);
    expect(r.released).toBe(0);
    expect((await s.voiciNames.get("mynotes"))?.state).toBe("live");
  });

  it("warns 30 and 7 days before the release, once each, then releases at 60 days of idleness", async () => {
    events.length = 0;
    const { deps, s, clock } = await setup();
    await set(deps, "mynotes");
    const tick = async (days: number) => {
      clock.t = NOW + days * DAY;
      return runVoiciNamesMaintenance(deps, async () => false, { offset: 0, count: 10 }, hooks);
    };
    expect((await tick(10)).warned).toBe(0);
    expect((await tick(31)).warned).toBe(1);
    expect((await tick(40)).warned).toBe(0);
    expect((await tick(54)).warned).toBe(1);
    expect((await tick(58)).warned).toBe(0);
    const last = await tick(61);
    expect(last.released).toBe(1);
    expect(events.map((e) => e.kind)).toEqual(["warning", "warning", "released"]);
    expect(await s.voiciNames.get("mynotes")).toMatchObject({ state: "waiting", releaseReason: "lapsed" });
  });

  it("walks windows of names in turn and wraps around", async () => {
    const { deps, s } = await setup({ tier: "maker" });
    for (const k of ["aaaa1", "bbbb2", "cccc3"]) await s.voiciNames.claim({ key: k, display: k, username: "alice", serviceId: `alice--${k}`, state: "live", setAt: 1, lastActiveAt: 1, warned: 0 });
    const seen: string[] = [];
    const running = async (_u: string, id: string) => (seen.push(id), true);
    await runVoiciNamesMaintenance(deps, running, { offset: 0, count: 2 });
    await runVoiciNamesMaintenance(deps, running, { offset: 2, count: 2 });
    await runVoiciNamesMaintenance(deps, running, { offset: 4, count: 2 });
    expect(seen).toEqual(["alice--aaaa1", "alice--bbbb2", "alice--cccc3", "alice--bbbb2", "alice--cccc3"]);
  });
});
