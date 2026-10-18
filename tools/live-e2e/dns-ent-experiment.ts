/**
 * Controlled experiment behind docs/wildcard-dns.md "Live verification": does a
 * temporary `_acme-challenge` TXT under a name make that name an empty
 * non-terminal, stop the wildcard from answering for it, and does a shield
 * (an A/AAAA at the same name) prevent that?
 *
 * Creates a few throwaway records under `<throwaway>.<gym apex>` with the gym's
 * own DNS token (GYM_DNS_TOKEN), asks Cloudflare's authoritative name servers
 * (direct, no recursion) and two public resolvers, writes one JSON line per
 * answer to `<GYM_RUN_DIR or cwd>/dns-ent-experiment.jsonl`, and deletes every
 * record it made, also when it fails. Names are all under the gym apex; nothing
 * outside it is read or written.
 *
 *   set -a; . ./.gym-secrets.env; set +a
 *   npx tsx tools/live-e2e/dns-ent-experiment.ts [--cache-watch-seconds 150]
 *   npx tsx tools/live-e2e/dns-ent-experiment.ts --canary   # ~30 s, exit 1 if a challenge TXT darkens a name
 *   npx tsx tools/live-e2e/dns-ent-experiment.ts --matrix [--only f-A,f-TXT]   # which names lose a zone-level wildcard
 *   npx tsx tools/live-e2e/dns-ent-experiment.ts --legacy-order   # delete a legacy account's records in the production order, back to back and then grouped with waits, polling every name at 100 ms
 *
 * `--canary` is the standing check behind the root-wildcard layout and its lack
 * of a challenge shield (docs/wildcard-dns.md "Live verification"): it writes NO
 * account records, only a challenge TXT under a throwaway account name, and the
 * zone's own `*.<apex>` must keep answering the box, a child of it and a
 * sibling. Re-run it after any change of Cloudflare plan or zone settings, and
 * weekly with the gym.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SERVICES } from "./lib/harness.js";

const TOKEN = process.env.GYM_DNS_TOKEN ?? "";
const ZONE_NAME = SERVICES.split(".").slice(-2).join(".");
const OUT = join(process.env.GYM_RUN_DIR ?? ".", "dns-ent-experiment.jsonl");
const arg = (n: string, d: string): string => {
  const i = process.argv.indexOf(n);
  return i >= 0 ? (process.argv[i + 1] ?? d) : d;
};
const CANARY = process.argv.includes("--canary");
const WATCH_S = CANARY ? 0 : Number(arg("--cache-watch-seconds", "150"));
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const created: Array<{ id: string; what: string }> = [];
let zoneId = "";

async function cf(method: string, path: string, body?: unknown): Promise<any> {
  const r = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j: any = await r.json().catch(() => ({}));
  if (!j.success) throw new Error(`cloudflare ${method} ${path}: ${r.status} ${JSON.stringify(j.errors ?? j).slice(0, 200)}`);
  return j.result;
}

function underApex(name: string): void {
  if (!name.endsWith(`.${SERVICES}`)) throw new Error(`refusing a name outside ${SERVICES}: ${name}`);
}

async function make(type: string, name: string, content: string | null, data?: unknown): Promise<void> {
  underApex(name);
  const rec = await cf("POST", `/zones/${zoneId}/dns_records`, data ? { type, name, data, ttl: 60 } : { type, name, content, ttl: 60, proxied: false });
  created.push({ id: rec.id, what: `${type} ${name}` });
  log({ step: "create", record: `${type} ${name}` });
}

async function drop(what: string): Promise<void> {
  for (const c of created.filter((x) => x.what === what)) {
    await cf("DELETE", `/zones/${zoneId}/dns_records/${c.id}`);
    created.splice(created.indexOf(c), 1);
    log({ step: "delete", record: what });
  }
}

function log(o: Record<string, unknown>): void {
  const line = { at: new Date().toISOString(), ...o };
  appendFileSync(OUT, JSON.stringify(line) + "\n");
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

interface Answer {
  rcode: string;
  answer: string;
  answerTtl: number | null;
  soaTtl: number | null;
  soaMinimum: number | null;
}

function dig(server: string, name: string, type: string, recurse: boolean): Answer {
  let out = "";
  try {
    out = execFileSync("dig", [`@${server}`, name, type, "+noall", "+comments", "+answer", "+authority", "+time=3", "+tries=1", recurse ? "+recurse" : "+norecurse"], { encoding: "utf8" });
  } catch (e) {
    return { rcode: `ERROR ${String(e).slice(0, 60)}`, answer: "", answerTtl: null, soaTtl: null, soaMinimum: null };
  }
  const rcode = /status: (\w+)/.exec(out)?.[1] ?? "?";
  const rows = out.split("\n").filter((l) => l && !l.startsWith(";"));
  const answers = rows.filter((l) => new RegExp(`\\s${type}\\s`).test(l));
  const soa = rows.find((l) => /\sSOA\s/.test(l));
  const soaParts = soa?.split(/\s+/);
  return {
    rcode,
    answer: answers.map((l) => l.split(/\s+/).slice(4).join(" ")).sort().join(",") || "(none)",
    answerTtl: answers[0] ? Number(answers[0].split(/\s+/)[1]) : null,
    soaTtl: soaParts ? Number(soaParts[1]) : null,
    soaMinimum: soaParts ? Number(soaParts[soaParts.length - 1]) : null,
  };
}

const RESOLVERS: Array<{ label: string; server: string; recurse: boolean }> = [];

function ask(phase: string, names: string[], types = ["A", "AAAA"], only?: string[]): void {
  for (const r of RESOLVERS) {
    if (only && !only.includes(r.label)) continue;
    for (const name of names) {
      for (const type of types) {
        log({ phase, resolver: r.label, query: `${name} ${type}`, ...dig(r.server, name, type, r.recurse) });
      }
    }
  }
}

async function main(): Promise<void> {
  if (process.argv.includes("--matrix")) return matrix();
  if (process.argv.includes("--legacy-order")) return legacyOrder();
  if (!TOKEN) throw new Error("GYM_DNS_TOKEN is required");
  writeFileSync(OUT, "");
  const zones = await cf("GET", `/zones?name=${ZONE_NAME}`);
  zoneId = zones[0]?.id;
  if (!zoneId) throw new Error("zone not found");
  const ns = execFileSync("dig", ["+short", "NS", ZONE_NAME, "@1.1.1.1"], { encoding: "utf8" }).split("\n").filter(Boolean)[0]!.replace(/\.$/, "");
  const nsIp = execFileSync("dig", ["+short", ns, "@1.1.1.1"], { encoding: "utf8" }).split("\n").filter(Boolean)[0]!;
  RESOLVERS.push({ label: `authoritative ${ns}`, server: nsIp, recurse: false }, { label: "1.1.1.1", server: "1.1.1.1", recurse: true }, { label: "8.8.8.8", server: "8.8.8.8", recurse: true });
  const AUTH = RESOLVERS[0]!.label;

  // The gym's own relay addresses: whatever the gym apex wildcard answers.
  const v4 = dig(nsIp, `probe-${randomBytes(3).toString("hex")}.${SERVICES}`, "A", false).answer.split(",")[0]!;
  const v6 = dig(nsIp, `probe-${randomBytes(3).toString("hex")}.${SERVICES}`, "AAAA", false).answer.split(",")[0]!;
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(v4) || !v6.includes(":")) throw new Error(`could not read the gym relay addresses (${v4} / ${v6})`);
  log({ step: "relay addresses", v4, v6, auth: AUTH });

  const U = `zz${randomBytes(3).toString("hex")}.${SERVICES}`; // throwaway account (its four records only in the full experiment, none in --canary)
  const V = `zy${randomBytes(3).toString("hex")}.${SERVICES}`; // throwaway account with NO records (zone-level wildcard only)
  const MARK4 = "192.0.2.1"; // a shield with its own address, so its arrival can be told from the wildcard's
  const MARK6 = "2001:db8::1";
  /** Polls the authoritative server until `pred` holds; logs how long the record took to show up. */
  const waitAuth = async (label: string, name: string, type: string, pred: (a: Answer) => boolean, maxMs = 30_000): Promise<number> => {
    const t0 = Date.now();
    for (;;) {
      const a = dig(nsIp, name, type, false);
      if (pred(a)) {
        const ms = Date.now() - t0;
        log({ step: "visible on authoritative", label, name, type, afterMs: ms, rcode: a.rcode, answer: a.answer });
        return ms;
      }
      if (Date.now() - t0 > maxMs) {
        log({ step: "NOT visible", label, name, type, afterMs: Date.now() - t0, rcode: a.rcode, answer: a.answer });
        return -1;
      }
      await sleep(250);
    }
  };
  /** Watches one name on the authoritative server for a while and logs each change of answer. */
  const watchAuth = async (label: string, name: string, type: string, ms: number): Promise<void> => {
    const t0 = Date.now();
    let last = "";
    while (Date.now() - t0 < ms) {
      const a = dig(nsIp, name, type, false);
      const key = `${a.rcode} ${a.answer}`;
      if (key !== last) {
        log({ step: "change", label, name, type, atMs: Date.now() - t0, rcode: a.rcode, answer: a.answer, answerTtl: a.answerTtl, soaTtl: a.soaTtl });
        last = key;
      }
      await sleep(200);
    }
  };
  const isRelay = (a: Answer): boolean => a.rcode === "NOERROR" && a.answer === v4;
  try {
    if (!CANARY) {
      // The previous per-account set: CAA at the account, wildcard A/AAAA below it.
      await make("CAA", U, null, { flags: 0, tag: "issue", value: "letsencrypt.org" });
      await make("A", `*.${U}`, v4);
      await make("AAAA", `*.${U}`, v6);
      await waitAuth("account wildcard A", `x.${U}`, "A", isRelay);
      await waitAuth("account wildcard AAAA", `x.${U}`, "AAAA", (a) => a.rcode === "NOERROR" && a.answer === v6);
    }

    // (a) the wildcard answers; then a TXT with NO shield.
    ask("a0 wildcard only", [`x.${U}`, `y.deep.${U}`], ["A", "AAAA"]);
    ask("a0 wildcard only (authoritative)", [`box.${U}`], ["A", "AAAA"], [AUTH]);
    const t0 = Date.now();
    await make("TXT", `_acme-challenge.box.${U}`, "\"probe-no-shield\"");
    const txtVisible = await waitAuth("TXT without shield", `_acme-challenge.box.${U}`, "TXT", (a) => a.rcode === "NOERROR" && a.answer !== "(none)");
    log({ step: "TXT visible after", ms: txtVisible, sinceCreateMs: Date.now() - t0 });
    ask("a1 TXT visible, no shield", [`box.${U}`, `x.box.${U}`, `y.${U}`]);
    ask("a1 TXT visible, no shield (sibling control)", [`other.${U}`], ["A"]);
    if (CANARY) {
      const dark: string[] = [];
      for (const r of RESOLVERS) {
        for (const name of [`box.${U}`, `x.box.${U}`, `y.deep.box.${U}`, `y.${U}`]) {
          for (const [type, want] of [["A", v4], ["AAAA", v6]] as const) {
            const a = dig(r.server, name, type, r.recurse);
            if (a.rcode !== "NOERROR" || a.answer !== want) dark.push(`${r.label} ${name} ${type}: ${a.rcode} ${a.answer}`);
          }
        }
      }
      log({ step: "canary", ok: dark.length === 0, dark });
      if (dark.length) process.exitCode = 1;
      return;
    }
    await drop(`TXT _acme-challenge.box.${U}`);
    const tDel = Date.now();
    log({ step: "TXT deleted" });
    await waitAuth("TXT deleted: box answers again", `box.${U}`, "A", isRelay, 60_000);
    log({ step: "box answered again", afterDeleteMs: Date.now() - tDel });
    ask("a2 TXT gone", [`box.${U}`, `x.box.${U}`], ["A"], [AUTH]);
    // Does a resolver keep the NODATA/NXDOMAIN it cached while the TXT existed? Its TTL counts down.
    const until = Date.now() + WATCH_S * 1000;
    while (Date.now() < until) {
      await sleep(30_000);
      ask("a3 cache watch after delete", [`box.${U}`, `x.box.${U}`], ["A"], ["1.1.1.1", "8.8.8.8"]);
    }

    // (b) shield first (with its own marker address), then the TXT: the box keeps answering.
    const b = `box3.${U}`;
    const tB = Date.now();
    await make("A", `*.${b}`, MARK4);
    await make("AAAA", `*.${b}`, MARK6);
    await make("A", b, MARK4);
    await make("AAAA", b, MARK6);
    const sBox = waitAuth("shield A at the box", b, "A", (a) => a.answer === MARK4);
    const sWild = waitAuth("shield A at *.box", `x.${b}`, "A", (a) => a.answer === MARK4);
    const [boxMs, wildMs] = await Promise.all([sBox, sWild]);
    log({ step: "shield visible", boxMs, wildMs, sinceFirstCreateMs: Date.now() - tB });
    await make("TXT", `_acme-challenge.${b}`, "\"probe-shield\"");
    await make("TXT", `_acme-challenge.${b}`, "\"probe-shield-2\"");
    await waitAuth("TXT with shield", `_acme-challenge.${b}`, "TXT", (a) => a.rcode === "NOERROR" && a.answer !== "(none)");
    ask("b1 TXT visible with shield", [b, `x.${b}`, `y.z.${b}`]);
    await drop(`TXT _acme-challenge.${b}`);
    await drop(`A ${b}`);
    await drop(`AAAA ${b}`);
    await drop(`A *.${b}`);
    await drop(`AAAA *.${b}`);
    await waitAuth("shield gone: box back on the wildcard", b, "A", isRelay, 60_000);
    ask("b2 shield and TXT gone", [b, `x.${b}`], ["A"], [AUTH]);

    // (c) zone-level wildcard only (the gym apex has `*.<apex>`): an account with no records of its own.
    ask("c0 no account records", [`box.${V}`, V, `other.${V}`], ["A"], [AUTH]);
    await make("TXT", `_acme-challenge.box.${V}`, "\"probe-zone-level\"");
    await waitAuth("TXT under the zone wildcard", `_acme-challenge.box.${V}`, "TXT", (a) => a.rcode === "NOERROR" && a.answer !== "(none)");
    ask("c1 TXT visible, zone wildcard only", [`box.${V}`, V, `other.${V}`, `x.box.${V}`], ["A"]);
    await drop(`TXT _acme-challenge.box.${V}`);
    await waitAuth("TXT gone: box.V answers again", `box.${V}`, "A", isRelay, 60_000);
    ask("c2 TXT gone", [`box.${V}`, V, `other.${V}`], ["A"], [AUTH]);
  } finally {
    for (const c of [...created]) {
      try {
        await cf("DELETE", `/zones/${zoneId}/dns_records/${c.id}`);
        log({ step: "cleanup delete", record: c.what });
      } catch (e) {
        log({ step: "CLEANUP FAILED", record: c.what, error: String(e).slice(0, 120) });
      }
    }
  }
  log({ step: "done", throwawayAccounts: [U, V] });
}


/**
 * Zone-level wildcard (`*.<apex>` only, no per-account wildcard): which names
 * under an account lose it when one name owns a record of a given type? One
 * throwaway account per case; every query goes to both Cloudflare name servers
 * and the two public resolvers (each name asked once per resolver, so nothing
 * answers from cache).
 */
async function matrix(): Promise<void> {
  if (!TOKEN) throw new Error("GYM_DNS_TOKEN is required");
  writeFileSync(OUT, "");
  const zones = await cf("GET", `/zones?name=${ZONE_NAME}`);
  zoneId = zones[0]?.id;
  if (!zoneId) throw new Error("zone not found");
  const nsHosts = execFileSync("dig", ["+short", "NS", ZONE_NAME, "@1.1.1.1"], { encoding: "utf8" }).split("\n").filter(Boolean).map((h) => h.replace(/\.$/, "")).sort();
  for (const h of nsHosts.slice(0, 2)) {
    const ip = execFileSync("dig", ["+short", h, "@1.1.1.1"], { encoding: "utf8" }).split("\n").filter(Boolean)[0]!;
    RESOLVERS.push({ label: `authoritative ${h}`, server: ip, recurse: false });
  }
  RESOLVERS.push({ label: "1.1.1.1", server: "1.1.1.1", recurse: true }, { label: "8.8.8.8", server: "8.8.8.8", recurse: true });
  const nsIp = RESOLVERS[0]!.server;
  const v4 = dig(nsIp, `probe-${randomBytes(3).toString("hex")}.${SERVICES}`, "A", false).answer.split(",")[0]!;
  log({ step: "matrix start", nsHosts, apexWildcardAnswer: v4 });
  const cases: Array<{ id: string; what: string; make: (n: string) => Promise<void>; owner: string; extra?: string[] }> = [
    { id: "e", what: "CAA issue + issuewild at the account only", owner: "", make: async (u) => { await make("CAA", u, null, { flags: 0, tag: "issue", value: "letsencrypt.org" }); await make("CAA", u, null, { flags: 0, tag: "issuewild", value: "letsencrypt.org" }); } },
    { id: "f-A", what: "an A record at other.<account>", owner: "other", make: async (u) => { await make("A", `other.${u}`, "192.0.2.7"); } },
    { id: "f-TXT", what: "a TXT record at other.<account>", owner: "other", make: async (u) => { await make("TXT", `other.${u}`, "\"probe\""); } },
    { id: "f-CAA", what: "a CAA record at other.<account>", owner: "other", make: async (u) => { await make("CAA", `other.${u}`, null, { flags: 0, tag: "issue", value: "letsencrypt.org" }); } },
    { id: "f-wild", what: "only *.other.<account> A (no record at other.<account> itself)", owner: "other", make: async (u) => { await make("A", `*.other.${u}`, "192.0.2.7"); } },
    { id: "f-deep", what: "only a TXT at _acme-challenge.other.<account> (a descendant, no record at other)", owner: "other", make: async (u) => { await make("TXT", `_acme-challenge.other.${u}`, "\"probe\""); } },
  ];
  const only = (process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1]! : "").split(",").filter(Boolean);
  try {
    for (const c of cases) {
      if (only.length && !only.includes(c.id)) continue;
      const U = `zx${randomBytes(3).toString("hex")}.${SERVICES}`;
      await c.make(U);
      // Wait until the record can be seen, on both name servers, before asking.
      const probeName = c.id === "e" ? U : c.id === "f-wild" ? `x.other.${U}` : c.id === "f-deep" ? `_acme-challenge.other.${U}` : `other.${U}`;
      const probeType = c.id === "e" ? "CAA" : c.id === "f-deep" || c.id === "f-TXT" ? "TXT" : c.id === "f-CAA" ? "CAA" : "A";
      for (const r of RESOLVERS.filter((x) => !x.recurse)) {
        const t0 = Date.now();
        while (Date.now() - t0 < 40_000) {
          const a = dig(r.server, probeName, probeType, false);
          // An A record is only "visible" once the marker address shows, not the wildcard's answer.
          const seen = a.rcode === "NOERROR" && a.answer !== "(none)" && (probeType !== "A" || a.answer.includes("192.0.2.7"));
          if (seen) break;
          await sleep(300);
        }
        log({ step: "record visible", case: c.id, on: r.label, afterMs: Date.now() - t0 });
      }
      const names: Array<[string, string]> = [
        ["the account", U],
        ["a box name (box.<account>)", `box.${U}`],
        ["a child of the box (x.box.<account>)", `x.box.${U}`],
        ["the owner name (other.<account>)", `other.${U}`],
        ["a child of the owner (c.other.<account>)", `c.other.${U}`],
        ["a grandchild of the owner (g.c.other.<account>)", `g.c.other.${U}`],
      ];
      for (const [role, name] of names) {
        for (const type of ["A", "TXT", "CAA"]) {
          if (type !== "A" && !["the account", "the owner name (other.<account>)"].includes(role)) continue;
          for (const r of RESOLVERS) {
            log({ phase: `${c.id} ${c.what}`, role, resolver: r.label, query: `${name} ${type}`, ...dig(r.server, name, type, r.recurse) });
          }
        }
      }
      for (const x of created.splice(0)) await cf("DELETE", `/zones/${zoneId}/dns_records/${x.id}`).then(() => log({ step: "delete", record: x.what }));
    }
  } finally {
    for (const c of [...created]) {
      await cf("DELETE", `/zones/${zoneId}/dns_records/${c.id}`).then(() => log({ step: "cleanup delete", record: c.what })).catch(() => log({ step: "CLEANUP FAILED", record: c.what }));
    }
  }
  log({ step: "done" });
}

/**
 * What clearLegacyAccountDns does to a legacy account, measured: seed the
 * 8-record legacy set (CAA issue + issuewild at <user>, A + AAAA at `*.<user>`,
 * `<box>.<user>` and `*.<box>.<user>`) under the gym apex's own wildcard, delete
 * it in the production order (a) back to back, as the Worker does, and (b) one
 * rank group at a time with a wait in between, as the reap CLI does, and poll
 * four names on both Cloudflare name servers every 100 ms the whole time.
 */
async function legacyOrder(): Promise<void> {
  if (!TOKEN) throw new Error("GYM_DNS_TOKEN is required");
  const { Resolver: DnsResolver } = await import("node:dns");
  const { legacyAccountRecords, legacyDeletionOrder } = await import("@flagship/services-zone");
  writeFileSync(OUT, "");
  const zones = await cf("GET", `/zones?name=${ZONE_NAME}`);
  zoneId = zones[0]?.id;
  if (!zoneId) throw new Error("zone not found");
  const nsHosts = execFileSync("dig", ["+short", "NS", ZONE_NAME, "@1.1.1.1"], { encoding: "utf8" }).split("\n").filter(Boolean).map((h) => h.replace(/\.$/, "")).sort().slice(0, 2);
  const servers = nsHosts.map((h) => ({ label: h.split(".")[0]!, ip: execFileSync("dig", ["+short", h, "@1.1.1.1"], { encoding: "utf8" }).split("\n").filter(Boolean)[0]! }));
  const v4 = dig(servers[0]!.ip, `probe-${randomBytes(3).toString("hex")}.${SERVICES}`, "A", false).answer.split(",")[0]!;
  const v6 = dig(servers[0]!.ip, `probe-${randomBytes(3).toString("hex")}.${SERVICES}`, "AAAA", false).answer.split(",")[0]!;
  log({ step: "legacy-order start", servers, v4, v6 });

  const run = async (variant: "back-to-back" | "grouped"): Promise<void> => {
    const U = `zw${randomBytes(3).toString("hex")}.${SERVICES}`;
    const user = U.split(".")[0]!;
    const BOX = `home.${U}`;
    await make("CAA", U, null, { flags: 0, tag: "issue", value: "letsencrypt.org" });
    await make("CAA", U, null, { flags: 0, tag: "issuewild", value: "letsencrypt.org" });
    for (const name of [`*.${U}`, BOX, `*.${BOX}`]) {
      await make("A", name, v4);
      await make("AAAA", name, v6);
    }
    // Everyone sees the whole set before the clock starts.
    for (const sv of servers) {
      const t0 = Date.now();
      while (Date.now() - t0 < 60_000) {
        const a = dig(sv.ip, U, "CAA", false);
        const b = dig(sv.ip, `*.${BOX}`.replace("*", "probe"), "A", false);
        if (a.answer !== "(none)" && b.rcode === "NOERROR") break;
        await sleep(300);
      }
    }
    await sleep(12_000);
    const names = [BOX, `x.${BOX}`, `app.${U}`, `x.y.${U}`];
    const lastState = new Map<string, string>();
    const dark: Array<{ key: string; since: number; until: number | null; state: string }> = [];
    const open = new Map<string, number>();
    const t0 = Date.now();
    let stop = false;
    const resolvers = servers.map((sv) => {
      const r = new DnsResolver({ timeout: 1500, tries: 1 });
      r.setServers([sv.ip]);
      return { sv, r };
    });
    const loop = (async () => {
      while (!stop) {
        const tick = Date.now();
        await Promise.all(
          resolvers.flatMap(({ sv, r }) =>
            names.map(
              (n) =>
                new Promise<void>((resolve) => {
                  r.resolve4(n, (err, ans) => {
                    const state = err ? (err.code === "ENODATA" ? "NODATA" : err.code === "ENOTFOUND" ? "NXDOMAIN" : `ERROR(${err.code})`) : `A ${[...ans].sort().join(",")}`;
                    const key = `${sv.label} ${n.replace(`.${U}`, ".<U>")}`;
                    if (lastState.get(key) !== state) {
                      lastState.set(key, state);
                      log({ phase: `legacy-order ${variant}`, t: Date.now() - t0, key, state });
                    }
                    const isDark = state === "NODATA" || state === "NXDOMAIN";
                    if (isDark && !open.has(key)) open.set(key, Date.now() - t0);
                    if (!isDark && open.has(key)) {
                      dark.push({ key, since: open.get(key)!, until: Date.now() - t0, state });
                      open.delete(key);
                    }
                    resolve();
                  });
                }),
            ),
          ),
        );
        await sleep(Math.max(0, 100 - (Date.now() - tick)));
      }
    })();

    await sleep(2000);
    const tStart = Date.now() - t0;
    // The production order, from the real function, so the experiment cannot drift from the code.
    const live = (await cf("GET", `/zones/${zoneId}/dns_records?per_page=500&name=${encodeURIComponent(U)}`)).concat(
      ...(await Promise.all([`*.${U}`, BOX, `*.${BOX}`].map((n) => cf("GET", `/zones/${zoneId}/dns_records?name=${encodeURIComponent(n)}`)))),
    ) as Array<{ id: string; type: string; name: string; content: string }>;
    const plan = legacyAccountRecords(live, SERVICES, { user });
    log({ step: "plan", variant, order: plan.map((r) => `${r.type} ${r.name}`) });
    let lastGroup: number | null = null;
    for (const r of plan) {
      const group = Math.floor(legacyDeletionOrder(r, SERVICES) / 10);
      if (variant === "grouped" && lastGroup !== null && group > lastGroup) await sleep(15_000);
      lastGroup = group;
      await cf("DELETE", `/zones/${zoneId}/dns_records/${r.id}`);
      const i = created.findIndex((c) => c.id === r.id);
      if (i >= 0) created.splice(i, 1);
      log({ step: "deleted", variant, t: Date.now() - t0, record: `${r.type} ${r.name}` });
    }
    const tEnd = Date.now() - t0;
    await sleep(40_000);
    stop = true;
    await loop;
    for (const [key, since] of open) dark.push({ key, since, until: null, state: lastState.get(key) ?? "?" });
    log({
      step: "result",
      variant,
      deletesStartedAtMs: tStart,
      deletesDoneAtMs: tEnd,
      darkIntervals: dark.map((d) => ({ ...d, lasted: d.until === null ? "still dark" : `${((d.until - d.since) / 1000).toFixed(1)} s` })),
      darkNames: [...new Set(dark.map((d) => d.key))],
    });
    for (const c of [...created]) {
      await cf("DELETE", `/zones/${zoneId}/dns_records/${c.id}`).catch(() => undefined);
      created.splice(created.indexOf(c), 1);
    }
  };

  try {
    const trials = Number(arg("--trials", "1"));
    const only = arg("--variants", "back-to-back,grouped").split(",");
    for (let i = 0; i < trials; i++) {
      for (const v of ["back-to-back", "grouped"] as const) if (only.includes(v)) await run(v);
    }
  } finally {
    for (const c of [...created]) {
      await cf("DELETE", `/zones/${zoneId}/dns_records/${c.id}`).then(() => log({ step: "cleanup delete", record: c.what })).catch(() => log({ step: "CLEANUP FAILED", record: c.what }));
    }
  }
  log({ step: "done" });
}

main().catch((e) => {
  process.stdout.write(`experiment failed: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
