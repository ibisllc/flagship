/**
 * A timeline of what DNS says about one box's names while its first certificate
 * is being issued (docs/wildcard-dns.md "Live verification").
 *
 * The wildcard design leans on two things nobody had seen live: that a name
 * which only has a descendant (the challenge TXT at `_acme-challenge.<box>`)
 * stops being answered from the account wildcard, so the shield must already be
 * there; and that shield and TXT are seen in the order they were written. This
 * polls, every 200 ms, the box name, a random label under it (never cached), the
 * challenge TXT, against Cloudflare's own name servers and public resolvers,
 * and polls the gym sweep dry run for the zone's record set, and writes down
 * every CHANGE of answer with its time. Nothing here writes to DNS.
 */
import { Resolver } from "node:dns";
import { randomBytes } from "node:crypto";
import { writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { sweep } from "./fleet.js";

export interface ProbeEvent {
  /** Milliseconds since the probe started. */
  t: number;
  at: string;
  target: string;
  via: string;
  state: string;
}

export type AnswerState = "NODATA" | "NXDOMAIN" | "ERROR" | string;

/** Collapses a c-ares result into a state a person can read. */
export function describeAnswer(err: NodeJS.ErrnoException | null, answers: unknown, type: string): AnswerState {
  if (err) {
    if (err.code === "ENODATA") return "NODATA";
    if (err.code === "ENOTFOUND") return "NXDOMAIN";
    return `ERROR(${err.code ?? err.message})`;
  }
  if (type === "TXT") {
    const rows = (answers as string[][]).map((r) => r.join("")).sort();
    return rows.length ? `TXT x${rows.length}` : "NODATA";
  }
  const rows = answers as Array<{ address: string; ttl: number }>;
  if (!rows.length) return "NODATA";
  return `${type} ${rows.map((r) => r.address).sort().join(",")}`;
}

const BOX_TARGETS = new Set(["box A", "box AAAA", "random label under box A"]);
const DARK = new Set(["NODATA", "NXDOMAIN"]);

/**
 * The stretches in [fromT, toT] where the box name, or a label under it, was
 * answered with NODATA or NXDOMAIN by any resolver. An event is a CHANGE of
 * answer, so a state lasts until the next event for the same target and
 * resolver. Empty = the box never went dark.
 */
export function darkDuringIssuance(events: readonly ProbeEvent[], fromT: number, toT: number): string[] {
  const out: string[] = [];
  const byKey = new Map<string, ProbeEvent[]>();
  for (const e of events) {
    if (!BOX_TARGETS.has(e.target)) continue;
    const k = `${e.via}|${e.target}`;
    byKey.set(k, [...(byKey.get(k) ?? []), e]);
  }
  for (const [k, list] of byKey) {
    list.sort((a, b) => a.t - b.t);
    list.forEach((e, i) => {
      const end = list[i + 1]?.t ?? Number.POSITIVE_INFINITY;
      if (!DARK.has(e.state) || end <= fromT || e.t >= toT) return;
      const until = Number.isFinite(end) ? `${((end - e.t) / 1000).toFixed(1)} s` : "to the end";
      out.push(`${k.replace("|", " / ")}: ${e.state} at ${(e.t / 1000).toFixed(1)} s for ${until}`);
    });
  }
  return out.sort();
}

export interface ProbeTargets {
  /** `<server>.<user>.<apex>` */
  box: string;
  /** `<user>.<apex>` */
  account: string;
  apex: string;
}

interface Poller {
  target: string;
  via: string;
  name: () => string;
  type: "A" | "AAAA" | "TXT";
  resolver: Resolver;
  everyMs: number;
}

export class DnsProbe {
  readonly events: ProbeEvent[] = [];
  readonly counts = new Map<string, Record<string, number>>();
  private readonly t0 = Date.now();
  private readonly file: string;
  private pollers: Array<{ dead: boolean; slow: boolean }> = [];
  private stopped = false;
  private issuanceStopped = false;
  private last = new Map<string, string>();
  private lastSet = "";

  constructor(private readonly targets: ProbeTargets, private readonly dir: string, private readonly resolvers: { auth: string[]; public: Array<{ name: string; ip: string }> }) {
    this.file = join(dir, "dns-probe.jsonl");
    writeFileSync(this.file, "");
  }

  private note(target: string, via: string, state: string): void {
    const key = `${via}|${target}`;
    const c = this.counts.get(key) ?? {};
    c[state] = (c[state] ?? 0) + 1;
    this.counts.set(key, c);
    if (this.last.get(key) === state) return;
    this.last.set(key, state);
    const ev: ProbeEvent = { t: Date.now() - this.t0, at: new Date().toISOString(), target, via, state };
    this.events.push(ev);
    appendFileSync(this.file, JSON.stringify(ev) + "\n");
  }

  private poll(p: Poller, slow = false): void {
    const handle = { dead: false, slow };
    this.pollers.push(handle);
    const tick = (): void => {
      if (this.stopped || handle.dead) return;
      const started = Date.now();
      const done = (err: NodeJS.ErrnoException | null, answers: unknown): void => {
        this.note(p.target, p.via, describeAnswer(err, answers, p.type));
        const wait = Math.max(0, p.everyMs - (Date.now() - started));
        setTimeout(tick, wait);
      };
      const name = p.name();
      try {
        if (p.type === "A") p.resolver.resolve4(name, { ttl: true }, done);
        else if (p.type === "AAAA") p.resolver.resolve6(name, { ttl: true }, done);
        else p.resolver.resolveTxt(name, done);
      } catch (e) {
        done(e as NodeJS.ErrnoException, []);
      }
    };
    tick();
  }

  start(): void {
    const { box, account } = this.targets;
    const mk = (ip: string): Resolver => {
      const r = new Resolver({ timeout: 1500, tries: 1 });
      r.setServers([ip]);
      return r;
    };
    const rnd = (under: string) => (): string => `p${randomBytes(4).toString("hex")}.${under}`;
    const auth = mk(this.resolvers.auth[0]!);
    const issuance: Array<[string, () => string, "A" | "AAAA" | "TXT"]> = [
      ["box A", () => box, "A"],
      ["box AAAA", () => box, "AAAA"],
      ["random label under box A", rnd(box), "A"],
      ["challenge TXT", () => `_acme-challenge.${box}`, "TXT"],
    ];
    for (const [target, name, type] of issuance) this.poll({ target, via: "authoritative", name, type, resolver: auth, everyMs: 200 });
    for (const pub of this.resolvers.public) {
      const r = mk(pub.ip);
      this.poll({ target: "box A", via: pub.name, name: () => box, type: "A", resolver: r, everyMs: 200 });
      this.poll({ target: "random label under box A", via: pub.name, name: rnd(box), type: "A", resolver: r, everyMs: 200 });
    }
    // The account name itself and a random label under it, slowly, to the end
    // (teardown deletes its records one by one: a name that loses its own
    // record while the wildcard below it stays is an empty non-terminal).
    this.poll({ target: "account A", via: "authoritative", name: () => account, type: "A", resolver: auth, everyMs: 1000 }, true);
    this.poll({ target: "random label under account A", via: "authoritative", name: rnd(account), type: "A", resolver: auth, everyMs: 1000 }, true);
    void this.pollZone();
  }

  /** The zone's record set for this account, from the gym sweep dry run (records the gym Worker's token can see). */
  private async pollZone(): Promise<void> {
    const mine = (n: string): boolean => n === this.targets.account || n.endsWith(`.${this.targets.account}`);
    while (!this.stopped && !this.issuanceStopped) {
      const started = Date.now();
      try {
        const z = await sweep(false);
        const recs = ((z.body?.dnsRecords ?? []) as Array<{ type: string; name: string }>).filter((r) => mine(r.name));
        const set = recs.map((r) => `${r.type} ${r.name}`).sort();
        const key = set.join(" ; ");
        if (key !== this.lastSet) {
          const prev = new Set(this.lastSet ? this.lastSet.split(" ; ") : []);
          const cur = new Set(set);
          for (const r of set) if (!prev.has(r)) this.zoneEvent(`+ ${r}`);
          for (const r of prev) if (!cur.has(r)) this.zoneEvent(`- ${r}`);
          this.lastSet = key;
        }
      } catch (e) {
        this.zoneEvent(`sweep error ${String(e).slice(0, 80)}`);
      }
      await new Promise((r) => setTimeout(r, Math.max(0, 1500 - (Date.now() - started))));
    }
  }

  private zoneEvent(state: string): void {
    const ev: ProbeEvent = { t: Date.now() - this.t0, at: new Date().toISOString(), target: "zone records (gym sweep)", via: "cloudflare API", state };
    this.events.push(ev);
    appendFileSync(this.file, JSON.stringify(ev) + "\n");
  }

  private issuanceEnd: number | null = null;

  /** When the account wildcard first showed in the zone (+3 s for it to reach the name servers); null if it never did. */
  issuanceStart(): number | null {
    const e = this.events.find((x) => x.via === "cloudflare API" && x.state === `+ A *.${this.targets.account}`);
    return e ? e.t + 3000 : null;
  }

  /** The box has its certificate, or the run is about to tear it down: what happens after is not issuance. */
  endIssuance(): void {
    if (this.issuanceEnd === null) this.issuanceEnd = Date.now() - this.t0;
    this.stopIssuance();
  }

  /** Dark stretches of the box name between the wildcard appearing and the end of issuance. */
  dark(): string[] {
    const from = this.issuanceStart();
    if (from === null) return ["the account wildcard never showed in the zone, so there was nothing to check"];
    return darkDuringIssuance(this.events, from, this.issuanceEnd ?? Date.now() - this.t0);
  }

  /** The box has its certificate: stop the 200 ms pollers (the slow account ones go on until {@link stop}). */
  stopIssuance(): void {
    this.issuanceStopped = true;
    for (const h of this.pollers) if (!h.slow) h.dead = true;
  }

  stop(): void {
    this.stopped = true;
  }

  summary(): Record<string, unknown> {
    const counts: Record<string, Record<string, number>> = {};
    for (const [k, v] of this.counts) counts[k] = v;
    const bad = [...this.counts.entries()]
      .filter(([k]) => /box A|box AAAA|random label under box A/.test(k) && !k.includes("TXT"))
      .flatMap(([k, v]) => Object.entries(v).filter(([s]) => s === "NODATA" || s === "NXDOMAIN").map(([s, n]) => `${k}: ${s} x${n}`));
    return { startedAt: new Date(this.t0).toISOString(), events: this.events.length, darkDuringIssuance: this.dark(), boxNameDarkAnswers: bad, counts };
  }
}

/** Starts a probe against the box a run is about to create. Resolves the zone's name servers first. */
export async function startDnsProbe(targets: ProbeTargets, dir: string): Promise<DnsProbe> {
  const { Resolver: R } = await import("node:dns/promises");
  const bootstrap = new R();
  bootstrap.setServers(["1.1.1.1"]);
  const ns = await bootstrap.resolveNs(targets.apex.split(".").slice(-2).join("."));
  const ips = (await Promise.all(ns.map((h) => bootstrap.resolve4(h).catch(() => [] as string[])))).flat();
  if (!ips.length) throw new Error("could not resolve the zone's name servers");
  const probe = new DnsProbe(targets, dir, {
    auth: ips,
    public: [
      { name: "1.1.1.1", ip: "1.1.1.1" },
      { name: "8.8.8.8", ip: "8.8.8.8" },
    ],
  });
  probe.start();
  return probe;
}
