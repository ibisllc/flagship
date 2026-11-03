/**
 * The acceptance tests of docs/voici-namespace-spec.md, one per line of its table (T16 is dropped by the owner's
 * clarification 1: holding a name gives nobody priority; T14 runs at the registry level, since the rename action
 * ships with feat/custom-names). The same rules at the storage level, against the D1 adapter too, are in
 * packages/storage/tests/namesRegistry.test.ts; the HTTP answers on the voi.ci host in apps/com/test/voiciHost.test.ts.
 */
import { describe, expect, it } from "vitest";
import { deriveIRK, isVoiciCodeShape, signClaimUsername, voiciNameKey } from "@flagship/protocol";
import { InMemoryStorage, NAME_HOLD_MS } from "@flagship/storage";
import { handleUsernameClaim } from "../src/usernameClaim.js";
import { mintShortLink, resolveVoiciPath, VOICI_CODE_LENGTH } from "../src/voici.js";
import { runNamesUpkeep, RESERVED_NAMES } from "../src/voiciNamespace.js";
import { checkVoiciName, type VoiciNamesDeps } from "../src/voiciNames.js";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 2);
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const keyFor = (n: number) => deriveIRK({ seed: new Uint8Array(32).fill(n) });

async function world() {
  const s = new InMemoryStorage();
  await s.names.addReserved(RESERVED_NAMES, 0);
  const clock = { t: NOW };
  const claim = (username: string, n = 1) => {
    const irk = keyFor(n);
    const request = { username, irkPub: irk.publicKey, issuedAt: clock.t };
    const signature = hex(signClaimUsername(request, irk));
    return handleUsernameClaim(
      { storage: s.usernames, now: () => clock.t },
      { request: { username, irkPub: hex(irk.publicKey), issuedAt: clock.t }, signature },
    );
  };
  const nameDeps: VoiciNamesDeps = {
    usernames: s.usernames,
    voiciLinks: s.voiciLinks,
    voiciNames: s.voiciNames,
    names: s.names,
    dibs: { claims: s.nameDibsClaims, window: {}, fetch: async () => ({ ok: true, status: 200, json: async () => ({ Status: 3 }), text: async () => "" }) },
    now: () => clock.t,
  };
  const linkName = async (name: string, username = "rapid-bison", serviceId = `${username}--app`) => {
    const check = await checkVoiciName(nameDeps, username, serviceId, name);
    if (check.status !== "available") return check;
    const r = await s.voiciNames.claim({ key: name, display: name, username, serviceId, state: "live", setAt: clock.t, lastActiveAt: clock.t, warned: 0 });
    return r.ok ? { status: "claimed" as const } : { status: "taken" as const };
  };
  const resolve = (path: string) => resolveVoiciPath({ names: s.names, pages: s.voici, now: () => clock.t }, path);
  const publish = (username: string) =>
    s.voici.publishPage(
      { username, pageId: "ab".repeat(16), seq: 1, issuedAt: 1, acceptsMessages: 1, inboxEpoch: 1, ownerSignPub: "cc".repeat(32), indexJson: "{}", publishedAt: 1 },
      0,
    );
  return { s, clock, claim, linkName, resolve, publish };
}

const body = (r: { body: unknown }) => r.body as { code?: string; problem?: string; error?: string };

describe("voi.ci namespace acceptance tests (docs/voici-namespace-spec.md)", () => {
  it("T1: voi.ci/Plucky-Avocet/ 301s to voi.ci/plucky-avocet", async () => {
    const w = await world();
    expect((await w.claim("plucky-avocet")).status).toBe(200);
    expect(await w.resolve("/Plucky-Avocet/")).toEqual({ kind: "redirect", location: "https://voi.ci/plucky-avocet" });
    expect(await w.resolve("/plucky-avocet/")).toEqual({ kind: "redirect", location: "https://voi.ci/plucky-avocet" });
  });

  it("T2: claiming pluckyavocet next to plucky-avocet is refused as taken or too similar", async () => {
    const w = await world();
    await w.claim("plucky-avocet");
    const r = await w.claim("pluckyavocet", 2);
    expect(r.status).toBe(409);
    expect(body(r)).toEqual({ error: "taken or too similar to an existing name", code: "taken" });
  });

  it("T3: claiming p1ucky-avocet is refused (1 read as l)", async () => {
    const w = await world();
    await w.claim("plucky-avocet");
    expect(body(await w.claim("p1ucky-avocet", 2)).code).toBe("taken");
  });

  it("T4: the link name plucky-avocet is refused next to the username", async () => {
    const w = await world();
    await w.claim("plucky-avocet");
    expect(await w.linkName("plucky-avocet")).toEqual({ status: "taken" });
  });

  it("T5: the username 50cent is accepted (a username may start with a digit)", async () => {
    const w = await world();
    const r = await w.claim("50cent");
    expect(r.status).toBe(200);
    expect((await w.s.names.lookup("50cent"))?.kind).toBe("username");
  });

  it("T6: the link name 5ocent is refused next to 50cent (0 read as o)", async () => {
    const w = await world();
    await w.claim("50cent");
    expect(await w.linkName("5ocent")).toEqual({ status: "taken" });
  });

  it("T7: voi.ci/@50cent 301s to voi.ci/50cent, which shows the page once it is published", async () => {
    const w = await world();
    await w.claim("50cent");
    expect(await w.resolve("/@50cent")).toEqual({ kind: "redirect", location: "https://voi.ci/50cent" });
    expect(await w.resolve("/50cent")).toEqual({ kind: "not-found" });
    await w.publish("50cent");
    expect(await w.resolve("/50cent")).toEqual({ kind: "page", username: "50cent" });
  });

  it("T8: 10,000 minted codes all start with a digit, have no hyphen and are CODE_LENGTH long", async () => {
    const w = await world();
    await w.claim("plucky-avocet");
    for (let i = 0; i < 10_000; i++) {
      const r = await mintShortLink({ usernames: w.s.usernames, voiciLinks: w.s.voiciLinks, now: () => NOW }, { username: "plucky-avocet", targetUrl: "https://example.com/" });
      if (!("code" in r)) throw new Error(r.error);
      expect(r.code).toHaveLength(VOICI_CODE_LENGTH);
      expect(r.code).toMatch(/^[0-9][0-9a-z]{5}$/);
      expect(isVoiciCodeShape(r.code)).toBe(true);
    }
  }, 60_000);

  it("T9: a minter forced onto a username's safety key retries and returns a different code", async () => {
    const w = await world();
    await w.claim("50cent");
    await w.claim("plucky-avocet", 2);
    // The first draw spells 50cent (5, 0, c, e, n, t from the alphabets), then a free one (1, a, a, a, a, a).
    const draws = [[5], [0], [12], [14], [23], [29], [1], [10], [10], [10], [10], [10]];
    const random = (n: number) => {
      const next = draws.shift() ?? [1];
      return Uint8Array.from({ length: n }, (_, i) => next[i % next.length]!);
    };
    const r = await mintShortLink({ usernames: w.s.usernames, voiciLinks: w.s.voiciLinks, random }, { username: "plucky-avocet", targetUrl: "https://example.com/" });
    expect(r).toMatchObject({ code: "1aaaaa" });
    expect(voiciNameKey((r as { code: string }).code)).not.toBe(voiciNameKey("50cent"));
  });

  it("T10: voi.ci/@chess-club 404s when chess-club is a link name", async () => {
    const w = await world();
    await w.linkName("chess-club");
    expect(await w.resolve("/@chess-club")).toEqual({ kind: "not-found" });
  });

  it("T11: a retired code is refused as a link name or a username", async () => {
    const w = await world();
    await w.s.voiciLinks.insert({ code: "3k9x2q", username: "rapid-bison", serviceId: "rapid-bison--app", targetUrl: "https://x/", createdAt: 1 });
    await w.s.voiciLinks.retireByService("rapid-bison", "rapid-bison--app", 2);
    expect(await w.linkName("3k9x2q", "other-one")).toEqual({ status: "taken" });
    expect(body(await w.claim("3k9x2q", 3)).code).toBe("taken");
  });

  it("T12: a retired code answers 410 and is never minted again", async () => {
    const w = await world();
    await w.claim("plucky-avocet");
    await w.s.voiciLinks.insert({ code: "1aaaaa", username: "plucky-avocet", serviceId: "plucky-avocet--app", targetUrl: "https://x/", createdAt: 1 });
    await w.s.voiciLinks.retireByService("plucky-avocet", "plucky-avocet--app", 2);
    expect(await w.resolve("/1aaaaa")).toEqual({ kind: "gone" });
    // A minter that keeps drawing the retired code first must skip it.
    let calls = 0;
    const random = (n: number) => Uint8Array.from({ length: n }, () => (calls++ < 6 ? [1, 10, 10, 10, 10, 10][calls - 1]! : 2));
    const r = await mintShortLink({ usernames: w.s.usernames, voiciLinks: w.s.voiciLinks, random }, { username: "plucky-avocet", targetUrl: "https://example.com/" });
    expect((r as { code: string }).code).not.toBe("1aaaaa");
    expect((await w.s.voiciLinks.get("1aaaaa"))?.retiredAt).toBe(2);
  });

  it("T13: ab, -ab, ab-, a--b and a 31-character name are all refused for their format", async () => {
    const w = await world();
    const cases: Array<[string, string]> = [["ab", "too-short"], ["-ab", "hyphens"], ["ab-", "hyphens"], ["a--b", "hyphens"], ["a".repeat(31), "too-long"]];
    for (const [name, problem] of cases) {
      const r = await w.claim(name);
      expect(r.status, name).toBe(400);
      expect(body(r), name).toMatchObject({ code: "invalid", problem });
      expect(await w.linkName(name), name).toEqual({ status: "invalid", problem });
    }
  });

  it("T14 (registry): after alice → alice-smith, voi.ci/alice 301s to alice-smith and nobody else can claim alice", async () => {
    const w = await world();
    await w.claim("alice");
    expect(await w.s.names.renameUsername("alice", "alice-smith", NOW)).toEqual({ ok: true });
    expect(await w.resolve("/alice")).toEqual({ kind: "redirect", location: "https://voi.ci/alice-smith" });
    expect(await w.resolve("/@alice")).toEqual({ kind: "redirect", location: "https://voi.ci/alice-smith" });
    expect(body(await w.claim("alice", 2)).code).toBe("taken");
  });

  it("T15: once alice's hold is over and the job has run, another account gets alice as a new row; the old page is not there", async () => {
    const w = await world();
    await w.claim("alice");
    await w.publish("alice");
    await w.s.voici.deleteAccount("alice");
    await w.s.usernames.delete("alice", NOW);
    w.clock.t = NOW + NAME_HOLD_MS;
    expect(await runNamesUpkeep({ names: w.s.names, words: RESERVED_NAMES }, w.clock.t)).toEqual({ released: 1, added: [], conflicts: [] });
    expect((await w.claim("alice", 2)).status).toBe(200);
    const rows = w.s.names.rows.filter((r) => r.name === "alice");
    expect(rows.map((r) => r.status)).toEqual(["released", "active"]);
    expect(rows[1]!.createdAt).toBe(NOW + NAME_HOLD_MS);
    expect(await w.resolve("/alice")).toEqual({ kind: "not-found" });
  });

  it("T17: a deleted account's username 404s during the grace period and can't be claimed until it is released", async () => {
    const w = await world();
    await w.claim("alice");
    await w.publish("alice");
    await w.s.voici.deleteAccount("alice");
    await w.s.usernames.delete("alice", NOW);
    expect(await w.resolve("/alice")).toEqual({ kind: "not-found" });
    expect(await w.resolve("/@alice")).toEqual({ kind: "not-found" });
    w.clock.t = NOW + 29 * DAY;
    await runNamesUpkeep({ names: w.s.names, words: RESERVED_NAMES }, w.clock.t);
    expect(body(await w.claim("alice", 2)).code).toBe("taken");
    expect(body(await w.claim("alice", 1)).code).toBe("taken");
  });

  it("T18: two concurrent claims of the same name: exactly one succeeds", async () => {
    const w = await world();
    const results = await Promise.all([w.claim("chess-club", 1), w.claim("chess-club", 2), w.claim("chessclub", 3)]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
  });

  it("T19: admin, ad-min and supp0rt are refused as usernames and as link names", async () => {
    const w = await world();
    for (const n of ["admin", "ad-min", "supp0rt"]) {
      expect(body(await w.claim(n)).code, n).toBe("taken");
      expect(await w.linkName(n), n).toEqual({ status: "taken" });
    }
  });

  it("T20: after CODE_LENGTH grows from 6 to 7 an old code still redirects and a new one has 7 characters", async () => {
    const w = await world();
    await w.claim("plucky-avocet");
    await w.s.voiciLinks.insert({ code: "7old66", username: "plucky-avocet", targetUrl: "https://example.com/old", createdAt: 1 });
    const r = await mintShortLink({ usernames: w.s.usernames, voiciLinks: w.s.voiciLinks, codeLength: 7 }, { username: "plucky-avocet", targetUrl: "https://example.com/new" });
    expect((r as { code: string }).code).toMatch(/^[0-9][0-9a-z]{6}$/);
    expect(await w.resolve("/7old66")).toEqual({ kind: "link", target: "https://example.com/old" });
  });

  it("D10/D11: system routes keep their case under /-/, and reserved words, unknown names and the root are not pages", async () => {
    const w = await world();
    expect(await w.resolve("/-/0123456789abcdef/fonts/Geist-Variable.woff2")).toEqual({ kind: "system", rest: "0123456789abcdef/fonts/Geist-Variable.woff2" });
    expect(await w.resolve("/admin")).toEqual({ kind: "not-found" });
    expect(await w.resolve("/nobody-here")).toEqual({ kind: "not-found" });
    expect(await w.resolve("/")).toEqual({ kind: "home" });
    expect(await w.resolve("/%40alice")).toEqual({ kind: "not-found" });
  });
});
