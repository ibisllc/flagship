/**
 * The box side of the `.com` doorbell (packages/control-plane/src/boxDoorbell.ts).
 *
 * A box polls `.com` for about a dozen things every few minutes (deposits for
 * it, an app rename, an admin-root rotation, a migration or transfer naming
 * it), and nearly every answer is "nothing". On the Workers Free plan `.com`
 * answers 100,000 requests a day for everybody, so those polls alone capped it
 * at about twenty boxes. The heartbeat reply now carries a doorbell saying
 * which lanes hold something and a digest of each list; this wrapper around
 * `fetch` answers a poll the doorbell says is empty without leaving the box,
 * and passes everything else through untouched.
 *
 *   - A GET for a lane the fresh doorbell does not list gets a plain 404, the
 *     answer `.com` itself would give (nothing to collect).
 *   - A GET for a list whose digest has not changed since this box last read it
 *     gets that last answer replayed.
 *   - Each lane and list is polled for real at least once an hour whatever the
 *     doorbell says, and every poll goes to `.com` while
 *     the doorbell is missing or older than a couple of heartbeats (an old
 *     `.com`, a lost beat, a doorbell that is wrong): the doorbell can delay an
 *     order by at most that, never lose one.
 *   - Writes, the read-token mint and every URL it does not know pass through.
 *   - When a lane starts to ring, its consumer is told at once, so an order
 *     waits for the next heartbeat and no longer for the next heartbeat plus the
 *     rest of the consumer's own interval.
 *
 * FLAGSHIP_DOORBELL=0 turns the skipping off.
 */

import { AccountGoneGate, accountGoneGate, accountOfPath } from "./accountGone.js";

export type DoorbellLane =
  | "swk"
  | "cgk"
  | "pairing"
  | "entitlement-deposit"
  | "update"
  | "self-delete"
  | "rehome"
  | "migration"
  | "decommission";

type StampKey = "aliases" | "rotations" | "grants" | "keyRotations";

interface Rung {
  receivedAt: number;
  lanes: ReadonlySet<string>;
  stamps: Readonly<Record<StampKey, string>>;
  /** The account's key epoch as `.com` reports it (a hint: accountKeyRotationConsumer.ts). */
  keyEpoch?: number;
}

export interface DoorbellOptions {
  serverDomain: string;
  username: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** A doorbell older than this is ignored (default 12 minutes: two lost beats). */
  freshMs?: number;
  /** A lane or list is polled for real at least this often (default one hour). */
  safetyMs?: number;
  /** Off switch; defaults to FLAGSHIP_DOORBELL=0. */
  disabled?: boolean;
  /** Holds calls while `.com` says the account is gone (default: the daemon's one gate). */
  gate?: AccountGoneGate;
  log?: (m: string) => void;
}

const LANE_PATHS: [string, DoorbellLane][] = [
  ["swk-deposit", "swk"],
  ["cgk-deposit", "cgk"],
  ["pairing-deposit", "pairing"],
  ["entitlement-deposit", "entitlement-deposit"],
  ["update", "update"],
  ["self-delete", "self-delete"],
  ["transfer/rehome", "rehome"],
  ["migration-assignment", "migration"],
  ["decommission", "decommission"],
];

const STAMP_PATHS: [string, StampKey][] = [
  ["apps/aliases", "aliases"],
  ["device-grants", "grants"],
  ["admin-root-rotations", "rotations"],
  ["account-key-rotations", "keyRotations"],
];

function parseRung(raw: unknown, now: number): Rung | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as { v?: unknown; lanes?: unknown; stamps?: unknown; keyEpoch?: unknown };
  if (r.v !== 1 || !Array.isArray(r.lanes) || r.lanes.some((l) => typeof l !== "string")) return null;
  const s = r.stamps as Partial<Record<StampKey, unknown>> | null | undefined;
  if (!s || typeof s.aliases !== "string" || typeof s.rotations !== "string" || typeof s.grants !== "string") return null;
  return {
    receivedAt: now,
    lanes: new Set(r.lanes as string[]),
    // An older `.com` sends no key-rotation stamp: the lane is then polled for real every time.
    stamps: { aliases: s.aliases, rotations: s.rotations, grants: s.grants, keyRotations: typeof s.keyRotations === "string" ? s.keyRotations : "" },
    ...(typeof r.keyEpoch === "number" && Number.isSafeInteger(r.keyEpoch) && r.keyEpoch >= 0 ? { keyEpoch: r.keyEpoch } : {}),
  };
}

export class Doorbell {
  private rung: Rung | null = null;
  private readonly real: typeof fetch;
  private readonly now: () => number;
  private readonly freshMs: number;
  private readonly safetyMs: number;
  private readonly disabled: boolean;
  private readonly host: string;
  private readonly user: string;
  /** When each lane or list last really went to `.com`. */
  private readonly lastReal = new Map<string, number>();
  private readonly replay = new Map<string, { stamp: string; body: string; contentType: string | null }>();
  private readonly listeners = new Map<string, Set<() => void>>();
  /** Polls answered without leaving the box, for the log. */
  skippedTotal = 0;

  constructor(private readonly opts: DoorbellOptions) {
    this.real = opts.fetchImpl ?? ((...a) => fetch(...a));
    this.now = opts.now ?? Date.now;
    this.freshMs = opts.freshMs ?? 12 * 60_000;
    this.safetyMs = opts.safetyMs ?? 60 * 60_000;
    this.disabled = opts.disabled ?? process.env.FLAGSHIP_DOORBELL === "0";
    this.host = opts.serverDomain.toLowerCase();
    this.user = opts.username.toLowerCase();
  }

  /** Called with the `doorbell` object of each heartbeat reply. */
  update(raw: unknown): void {
    const next = parseRung(raw, this.now());
    if (!next) return;
    const before = this.rung;
    this.rung = next;
    const rang: string[] = [];
    for (const lane of next.lanes) if (!before || !before.lanes.has(lane)) rang.push(lane);
    if (next.keyEpoch !== undefined) {
      for (const fn of this.epochListeners) {
        try {
          fn(next.keyEpoch);
        } catch {
          /* a listener must never break the heartbeat */
        }
      }
    }
    for (const key of ["aliases", "rotations", "grants", "keyRotations"] as const) {
      if (before && before.stamps[key] !== next.stamps[key]) rang.push(key);
    }
    for (const name of rang) {
      for (const fn of this.listeners.get(name) ?? []) {
        try {
          fn();
        } catch {
          /* a listener must never break the heartbeat */
        }
      }
    }
  }

  private readonly epochListeners = new Set<(epoch: number) => void>();

  /** Tell `fn` the account key epoch each doorbell reports. */
  onKeyEpoch(fn: (epoch: number) => void): void {
    this.epochListeners.add(fn);
  }

  /** Tell `fn` the moment a lane starts holding something, or a list changes. */
  onRing(name: DoorbellLane | StampKey, fn: () => void): void {
    let set = this.listeners.get(name);
    if (!set) this.listeners.set(name, (set = new Set()));
    set.add(fn);
  }

  private fresh(): Rung | null {
    if (this.disabled || !this.rung) return null;
    return this.now() - this.rung.receivedAt <= this.freshMs ? this.rung : null;
  }

  /** True when `key` has not really been polled for a safety interval; the
   *  first poll after boot counts as due, so a fresh box asks once. A due poll
   *  is recorded as made. */
  private safetyDue(key: string): boolean {
    const last = this.lastReal.get(key);
    const due = last === undefined || this.now() - last >= this.safetyMs;
    if (due) this.lastReal.set(key, this.now());
    return due;
  }

  /** The wrapper to hand to a poller as its `fetchImpl`. */
  readonly fetch: typeof fetch = async (input, init) => {
    // `.com` said the account is gone: calls about it stay on the box for a while (accountGone.ts).
    let account: string | null = null;
    try {
      account = accountOfPath(new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).pathname);
    } catch {
      account = null;
    }
    const gate = this.opts.gate ?? accountGoneGate;
    if (account !== null) {
      if (gate.held(account)) return AccountGoneGate.localAnswer();
      const res = await this.ringing(input, init);
      if (res.headers.get("x-flagship-doorbell") === null) await gate.observe(account, res);
      return res;
    }
    return this.ringing(input, init);
  };

  private readonly ringing: typeof fetch = async (input, init) => {
    const rung = this.fresh();
    const method = (init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET")).toUpperCase();
    if (!rung || method !== "GET") return this.real(input, init);
    let pathname: string;
    try {
      pathname = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).pathname;
    } catch {
      return this.real(input, init);
    }

    const serverPrefix = `/api/server/${this.host}/`;
    const lowerPath = pathname.toLowerCase();
    if (lowerPath.startsWith(serverPrefix)) {
      const tail = lowerPath.slice(serverPrefix.length);
      const lane = LANE_PATHS.find(([p]) => p === tail)?.[1];
      if (lane && rung.lanes.has(lane)) this.lastReal.set(lane, this.now());
      if (lane && !rung.lanes.has(lane) && !this.safetyDue(lane)) {
        this.skippedTotal++;
        return new Response(JSON.stringify({ error: "nothing waiting (doorbell)" }), {
          status: 404,
          headers: { "content-type": "application/json", "x-flagship-doorbell": "skipped" },
        });
      }
      return this.real(input, init);
    }

    const userPrefix = `/api/users/${this.user}/`;
    if (lowerPath.startsWith(userPrefix)) {
      const key = STAMP_PATHS.find(([p]) => p === lowerPath.slice(userPrefix.length))?.[1];
      if (key) {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const held = this.replay.get(url);
        if (held && rung.stamps[key] !== "" && held.stamp === rung.stamps[key] && !this.safetyDue(key)) {
          this.skippedTotal++;
          return new Response(held.body, {
            status: 200,
            headers: {
              ...(held.contentType ? { "content-type": held.contentType } : {}),
              "x-flagship-doorbell": "replayed",
            },
          });
        }
        // The digest the doorbell holds now is at most as new as what we are
        // about to read; if the list moves meanwhile the next doorbell differs.
        const stampAtFetch = rung.stamps[key];
        this.lastReal.set(key, this.now());
        const res = await this.real(input, init);
        if (res.ok) {
          try {
            this.replay.set(url, {
              stamp: stampAtFetch,
              body: await res.clone().text(),
              contentType: res.headers.get("content-type"),
            });
          } catch {
            /* an unreadable body is just not remembered */
          }
        } else {
          this.replay.delete(url);
        }
        return res;
      }
    }
    return this.real(input, init);
  };
}
