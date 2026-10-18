import { describe, expect, it } from "vitest";
import {
  answerFor,
  blockingRecords,
  classifyZoneName,
  evaluateZoneHealth,
  expectedApexCaaRdata,
  legacyAccountRecords,
  legacyDeletionRank,
  rootWildcardStatus,
  type ZoneRecordView,
} from "../src/rootWildcard.js";

const APEX = "flagship.services";
const RELAY = { servicesIpv4: "203.0.113.7", servicesIpv6: "2001:db8::7" };

const rec = (type: string, name: string, content: string, over: Partial<ZoneRecordView> = {}): ZoneRecordView => ({
  id: `${type}-${name}`,
  type,
  name,
  content,
  proxied: false,
  ...over,
});

const ROOT: ZoneRecordView[] = [
  rec("A", `*.${APEX}`, RELAY.servicesIpv4),
  rec("AAAA", `*.${APEX}`, RELAY.servicesIpv6),
  rec("CAA", APEX, '0 issue "letsencrypt.org"'),
  rec("CAA", APEX, '0 issuewild "letsencrypt.org"'),
];

describe("classifyZoneName", () => {
  it("separates the apex, the root wildcard, account names, challenges and system names", () => {
    expect(classifyZoneName(APEX, APEX)).toEqual({ kind: "apex" });
    expect(classifyZoneName(`*.${APEX}`, APEX)).toEqual({ kind: "root-wildcard" });
    expect(classifyZoneName(`alice.${APEX}`, APEX)).toEqual({ kind: "account", user: "alice", shape: "user" });
    expect(classifyZoneName(`*.alice.${APEX}`, APEX)).toEqual({ kind: "account", user: "alice", shape: "user-wild" });
    expect(classifyZoneName(`home.alice.${APEX}`, APEX)).toEqual({ kind: "account", user: "alice", shape: "box" });
    expect(classifyZoneName(`*.home.alice.${APEX}.`, APEX)).toEqual({ kind: "account", user: "alice", shape: "box-wild" });
    expect(classifyZoneName(`app.home.alice.${APEX}`, APEX)).toEqual({ kind: "account", user: "alice", shape: "deeper" });
    expect(classifyZoneName(`_acme-challenge.home.alice.${APEX}`, APEX)).toEqual({ kind: "challenge", user: "alice" });
    expect(classifyZoneName(`_acme-challenge.alice.${APEX}`, APEX)).toEqual({ kind: "challenge", user: "alice" });
  });

  it("leaves reserved labels, the gym subtree and foreign names alone", () => {
    expect(classifyZoneName(`www.${APEX}`, APEX)).toEqual({ kind: "system" });
    expect(classifyZoneName(`gym.${APEX}`, APEX)).toEqual({ kind: "system" });
    expect(classifyZoneName(`*.gym.${APEX}`, APEX)).toEqual({ kind: "system" });
    expect(classifyZoneName(`home.alice.gym.${APEX}`, APEX)).toEqual({ kind: "system" });
    expect(classifyZoneName(`broadcast--alice.${APEX}`, APEX)).toEqual({ kind: "system" });
    expect(classifyZoneName("home.alice.example.com", APEX)).toEqual({ kind: "foreign" });
  });

  it("is apex-relative: the gym's own apex sees its accounts", () => {
    expect(classifyZoneName(`home.alice.gym.${APEX}`, `gym.${APEX}`)).toEqual({ kind: "account", user: "alice", shape: "box" });
    expect(classifyZoneName(`*.gym.${APEX}`, `gym.${APEX}`)).toEqual({ kind: "root-wildcard" });
  });
});

describe("what blocks the root wildcard", () => {
  const zone = [
    ...ROOT,
    rec("CAA", `alice.${APEX}`, '0 issue "letsencrypt.org"'),
    rec("A", `*.alice.${APEX}`, RELAY.servicesIpv4),
    rec("A", `home.alice.${APEX}`, RELAY.servicesIpv4),
    rec("AAAA", `*.home.alice.${APEX}`, RELAY.servicesIpv6),
    rec("TXT", `alice.${APEX}`, "stray"),
    rec("TXT", `_acme-challenge.home.alice.${APEX}`, "token"),
    rec("A", `hub.${APEX}`, "198.51.100.1"),
    rec("A", `*.gym.${APEX}`, "198.51.100.2"),
  ];

  it("lists A, AAAA and CAA at account and box names as legacy, in safe deletion order", () => {
    const l = legacyAccountRecords(zone, APEX);
    expect(l.map((r) => `${r.type} ${r.name}`)).toEqual([
      `CAA alice.${APEX}`,
      `A home.alice.${APEX}`,
      `AAAA *.home.alice.${APEX}`,
      `A *.alice.${APEX}`,
    ]);
    expect(legacyAccountRecords(zone, APEX, { user: "bob" })).toEqual([]);
  });

  it("takes an A, AAAA or TXT at a single-label name for a host record unless the label is an account", () => {
    expect(legacyAccountRecords(zone, APEX).some((r) => r.name === `hub.${APEX}`)).toBe(false);
    expect(blockingRecords(zone, APEX).some((r) => r.name === `hub.${APEX}`)).toBe(false);
    const withHub = blockingRecords(zone, APEX, { accounts: new Set(["hub"]) });
    expect(withHub.map((r) => r.name)).toContain(`hub.${APEX}`);
    // A CAA there is always the old per-account record.
    const caa = [rec("CAA", `hub.${APEX}`, '0 issue "letsencrypt.org"')];
    expect(blockingRecords(caa, APEX)).toHaveLength(1);
  });

  it("counts every type at an account or box name as blocking, never the challenge TXT", () => {
    const b = blockingRecords(zone, APEX, { accounts: new Set(["alice"]) }).map((r) => `${r.type} ${r.name}`);
    expect(b).toContain(`TXT alice.${APEX}`);
    expect(b.some((n) => n.includes("_acme-challenge"))).toBe(false);
    expect(b.some((n) => n.includes("hub.") || n.includes("gym."))).toBe(false);
    expect(b).toHaveLength(5);
  });

  it("ranks the user record first and the account wildcard last", () => {
    expect(legacyDeletionRank(`alice.${APEX}`, APEX)).toBeLessThan(legacyDeletionRank(`home.alice.${APEX}`, APEX));
    expect(legacyDeletionRank(`home.alice.${APEX}`, APEX)).toBeLessThan(legacyDeletionRank(`*.home.alice.${APEX}`, APEX));
    expect(legacyDeletionRank(`*.home.alice.${APEX}`, APEX)).toBeLessThan(legacyDeletionRank(`*.alice.${APEX}`, APEX));
  });

  it("deleting in that order never takes a name dark, for the 12-record layout and the 4-record layout", () => {
    const twelve: ZoneRecordView[] = [
      ...ROOT,
      ...["issue", "issuewild", "iodef"].map((t) => rec("CAA", `alice.${APEX}`, `0 ${t} "x"`, { id: `c-${t}` })),
      ...["issue", "issuewild", "iodef"].map((t) => rec("CAA", `*.alice.${APEX}`, `0 ${t} "x"`, { id: `cw-${t}` })),
      rec("A", `*.alice.${APEX}`, RELAY.servicesIpv4),
      rec("AAAA", `*.alice.${APEX}`, RELAY.servicesIpv6),
      rec("A", `home.alice.${APEX}`, RELAY.servicesIpv4),
      rec("AAAA", `home.alice.${APEX}`, RELAY.servicesIpv6),
      rec("A", `*.home.alice.${APEX}`, RELAY.servicesIpv4),
      rec("AAAA", `*.home.alice.${APEX}`, RELAY.servicesIpv6),
    ];
    const four: ZoneRecordView[] = [
      ...ROOT,
      rec("CAA", `alice.${APEX}`, '0 issue "letsencrypt.org"', { id: "c1" }),
      rec("CAA", `alice.${APEX}`, '0 issuewild "letsencrypt.org"', { id: "c2" }),
      rec("A", `*.alice.${APEX}`, RELAY.servicesIpv4),
      rec("AAAA", `*.alice.${APEX}`, RELAY.servicesIpv6),
    ];
    const names = [`home.alice.${APEX}`, `x.home.alice.${APEX}`, `app.alice.${APEX}`, `alice.${APEX}`];
    for (const start of [twelve, four]) {
      let live = [...start];
      for (const r of legacyAccountRecords(start, APEX)) {
        live = live.filter((x) => x !== r);
        for (const n of names.filter((n) => n !== `alice.${APEX}`)) {
          // IPv4 never goes dark; IPv6 may be NODATA for the instant between a
          // name's AAAA and A going, but is never NXDOMAIN (AAAA is deleted first).
          expect(answerFor(live, n, "A").result, `${n} A after deleting ${r.type} ${r.name}`).toBe("answer");
          expect(answerFor(live, n, "AAAA").result, `${n} AAAA after deleting ${r.type} ${r.name}`).not.toBe("nxdomain");
        }
      }
      expect(legacyAccountRecords(live, APEX)).toEqual([]);
      // Left with the root set only, every account name still answers the relay.
      for (const n of names.filter((n) => n !== `alice.${APEX}`)) {
        expect(answerFor(live, n)).toEqual({ result: "answer", values: [RELAY.servicesIpv4] });
      }
    }
  });
});

describe("answerFor reproduces the measured Cloudflare matrix", () => {
  const U = `u.${APEX}`;
  const base = [rec("A", `*.${APEX}`, "WILD")];
  const at = (records: ZoneRecordView[], name: string) => answerFor([...base, ...records], name);
  it("a record owned by N blocks the wildcard below N, never beside or above it", () => {
    for (const type of ["TXT", "CAA", "A"]) {
      const z = [rec(type, `other.${U}`, "v")];
      expect(at(z, U).result).toBe("answer");
      expect(at(z, `box.${U}`).result).toBe("answer");
      expect(at(z, `c.other.${U}`).result).toBe("nxdomain");
      expect(at(z, `g.c.other.${U}`).result).toBe("nxdomain");
    }
    expect(at([rec("TXT", `other.${U}`, "v")], `other.${U}`).result).toBe("nodata");
    expect(at([rec("A", `other.${U}`, "own")], `other.${U}`)).toEqual({ result: "answer", values: ["own"] });
  });
  it("a TXT below a name and a `*.N` alone block nothing", () => {
    const z = [rec("TXT", `_acme-challenge.other.${U}`, "v")];
    for (const n of [`other.${U}`, `c.other.${U}`, `box.${U}`]) expect(at(z, n)).toEqual({ result: "answer", values: ["WILD"] });
    expect(at([rec("A", `*.other.${U}`, "NODE")], `other.${U}`)).toEqual({ result: "answer", values: ["WILD"] });
    expect(at([rec("A", `*.other.${U}`, "NODE")], `c.other.${U}`)).toEqual({ result: "answer", values: ["NODE"] });
  });
  it("a CAA at the user name alone kills the whole account (the reason for an apex CAA)", () => {
    const z = [rec("CAA", U, '0 issue "x"')];
    expect(at(z, U).result).toBe("nodata");
    expect(at(z, `box.${U}`).result).toBe("nxdomain");
  });
});

describe("rootWildcardStatus", () => {
  it("is ready only with exactly the relay's A and AAAA, DNS only", () => {
    expect(rootWildcardStatus(ROOT, APEX, RELAY)).toMatchObject({ ready: true, a: "ok", aaaa: "ok", proxied: false });
    expect(rootWildcardStatus(ROOT.slice(1), APEX, RELAY)).toMatchObject({ ready: false, a: "missing" });
    expect(rootWildcardStatus([ROOT[0]!, ...ROOT.slice(2)], APEX, RELAY)).toMatchObject({ ready: false, aaaa: "missing" });
    expect(rootWildcardStatus([rec("A", `*.${APEX}`, "198.51.100.1"), ...ROOT.slice(1)], APEX, RELAY)).toMatchObject({ a: "wrong" });
    expect(
      rootWildcardStatus([...ROOT, rec("A", `*.${APEX}`, "198.51.100.1")], APEX, RELAY),
    ).toMatchObject({ ready: false, a: "wrong" });
    expect(
      rootWildcardStatus([rec("A", `*.${APEX}`, RELAY.servicesIpv4, { proxied: true }), ROOT[1]!], APEX, RELAY),
    ).toMatchObject({ ready: false, proxied: true });
  });

  it("wants no AAAA when the relay has no IPv6", () => {
    const v4 = { servicesIpv4: RELAY.servicesIpv4 };
    expect(rootWildcardStatus([ROOT[0]!], APEX, v4).ready).toBe(true);
    expect(rootWildcardStatus(ROOT, APEX, v4)).toMatchObject({ ready: false, aaaa: "wrong" });
  });
});

describe("evaluateZoneHealth", () => {
  const health = (records: ZoneRecordView[], over = {}) => evaluateZoneHealth(records, { apex: APEX, relay: RELAY, ...over });

  it("passes on the at-rest zone, with challenges in flight", () => {
    const h = health([...ROOT, rec("TXT", `_acme-challenge.home.alice.${APEX}`, "t"), rec("A", `hub.${APEX}`, "198.51.100.1")]);
    expect(h.ok).toBe(true);
    expect(h.problems).toEqual([]);
    expect(h.atRest).toBe(4);
    expect(h.challenges).toBe(1);
  });

  it("fails on a missing wildcard, a wrong address or a missing apex CAA", () => {
    expect(health(ROOT.slice(1)).problems.map((p) => p.code)).toContain("wildcard");
    expect(health(ROOT.slice(0, 2)).problems.map((p) => p.code)).toEqual(["caa-missing", "caa-missing"]);
    expect(health([rec("A", `*.${APEX}`, "198.51.100.1"), ...ROOT.slice(1)]).ok).toBe(false);
    expect(health([...ROOT, rec("CAA", APEX, '0 issue "other-ca.example"')]).problems.map((p) => p.code)).toContain("caa-unexpected");
    expect(expectedApexCaaRdata()).toEqual(['0 issue "letsencrypt.org"', '0 issuewild "letsencrypt.org"']);
  });

  it("fails on any record at a user or box name and names each with its id", () => {
    const h = health([...ROOT, rec("CAA", `alice.${APEX}`, '0 issue "letsencrypt.org"'), rec("TXT", `home.bob.${APEX}`, "x")]);
    expect(h.ok).toBe(false);
    expect(h.problems.filter((p) => p.code === "account-record").map((p) => p.name)).toEqual([`alice.${APEX}`, `home.bob.${APEX}`]);
    expect(h.problems.every((p) => p.code !== "account-record" || p.id)).toBe(true);
  });

  it("turns a protected account's records into warnings", () => {
    const h = health([...ROOT, rec("A", `*.review.${APEX}`, RELAY.servicesIpv4)], { skipUsers: ["review"] });
    expect(h.ok).toBe(true);
    expect(h.warnings.join(" ")).toMatch(/review/);
  });

  it("warns near the cap and fails over it", () => {
    const filler = (n: number) => Array.from({ length: n }, (_, i) => rec("A", `s${i}.${APEX}`, "198.51.100.9"));
    expect(health([...ROOT, ...filler(185)]).warnings.join(" ")).toMatch(/of 200/);
    expect(health([...ROOT, ...filler(200)]).ok).toBe(false);
  });
});
