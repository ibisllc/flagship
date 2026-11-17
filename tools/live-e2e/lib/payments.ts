// The payments and private-relay helpers of the live gym (docs/payments-privacy-and-rails.md, docs/outbound-proxy.md
// "Failure handling"). A "device" here is the webapp's own payment code (apps/web/public/webapp/lib/plan.js) run in
// node with an admin device of a real gym account: its account key (UMK), its device key, a read token it mints for
// itself, and a fetch that records where every request went (the private relay or `.com`), so a check can say how
// a spend travelled. Nothing here is a second implementation of the wallet or the relay rule.
import { randomBytes } from "node:crypto";
import { bytesToHex } from "@noble/hashes/utils";
import { accountReadTokenPath, deriveAccountDeviceKeySeed, ed, signAccountDirectoryRequest, type Keypair } from "@flagship/protocol";
import { REAL_PRIMARY_DEVICE_ID, mintDeviceGrant, type Account } from "./fleet.js";
import { CONTROL, assert, http, short, sleep } from "./harness.js";
import { run } from "./upcloudVm.js";

// The webapp modules are plain browser ESM with injectable dependencies; they import in node as they do in vitest.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const PLAN_JS = "../../../apps/web/public/webapp/lib/plan.js";
const VOUCHERS_JS = "../../../apps/web/public/webapp/lib/vouchers.js";
export const Plan: Any = await import(PLAN_JS);
export const Vouchers: Any = await import(VOUCHERS_JS);

/** The gym's interim OHTTP relay (infra/ohttp-relay/fly.gym.toml), deployed for the run and destroyed after it. */
export const OHTTP_RELAY_APP = process.env.GYM_OHTTP_RELAY_APP || "flagship-ohttp-relay-gym";
export const OHTTP_RELAY_URL = process.env.GYM_OHTTP_RELAY_URL || `https://${OHTTP_RELAY_APP}.fly.dev/`;

export interface SentRequest {
  url: string;
  method: string;
  /** "relay" (the OHTTP relay), "com" (straight to `.com`), or "other". */
  to: "relay" | "com" | "other";
  path: string;
  headers: Record<string, string>;
  status: number | null;
  at: number;
}

function headersOf(h: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!h) return out;
  if (h instanceof Headers) h.forEach((v, k) => (out[k.toLowerCase()] = v));
  else if (Array.isArray(h)) for (const [k, v] of h as Array<[string, string]>) out[String(k).toLowerCase()] = String(v);
  else for (const [k, v] of Object.entries(h as Record<string, string>)) out[k.toLowerCase()] = String(v);
  return out;
}

/** An admin device of `acct` running the webapp's plan code. */
export class WebDevice {
  readonly seed: Uint8Array;
  readonly key: Keypair;
  readonly sent: SentRequest[] = [];
  /** The browser's localStorage stand-in: the trickle's next spend time and the relay state. Never money. */
  readonly kv = new Map<string, string>();
  private token: { token: string; expiresAt: number } | null = null;

  constructor(readonly acct: Account, readonly deviceId: string) {
    this.seed = deriveAccountDeviceKeySeed(acct.keys.umk, acct.username, deviceId);
    this.key = { privateKey: this.seed, publicKey: ed.getPublicKey(this.seed) };
  }

  get username(): string {
    return this.acct.username;
  }

  /** Requests sent since `t0` matching `pred`. */
  since(t0: number, pred: (r: SentRequest) => boolean = () => true): SentRequest[] {
    return this.sent.filter((r) => r.at >= t0 && pred(r));
  }

  readonly fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const u = new URL(url);
    const to: SentRequest["to"] = url.startsWith(OHTTP_RELAY_URL.replace(/\/+$/, "")) ? "relay" : u.hostname === CONTROL ? "com" : "other";
    const rec: SentRequest = { url, method: (init.method ?? "GET").toUpperCase(), to, path: u.pathname, headers: headersOf(init.headers), status: null, at: Date.now() };
    this.sent.push(rec);
    try {
      const r = await globalThis.fetch(url, init);
      rec.status = r.status;
      return r;
    } catch (e) {
      rec.status = -1;
      throw e;
    }
  };

  /** `authorization` for the account's reads, from a read token this device mints with its own key. */
  async readHeaders(): Promise<Record<string, string>> {
    if (this.token && Date.now() < this.token.expiresAt - 60_000) return { authorization: `Bearer ${this.token.token}` };
    const path = accountReadTokenPath(this.username);
    const requestId = randomBytes(16).toString("hex");
    const issuedAt = Date.now();
    const sig = signAccountDirectoryRequest(
      { accountId: this.username, deviceId: this.deviceId, signerPubHex: bytesToHex(this.key.publicKey), method: "POST", path, requestId, issuedAt },
      this.key,
    );
    const r = await http(`https://${CONTROL}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-flagship-device-id": this.deviceId,
        "x-flagship-device-pub": bytesToHex(this.key.publicKey),
        "x-flagship-request-id": requestId,
        "x-flagship-issued-at": String(issuedAt),
        "x-flagship-signature": sig,
      },
      body: "{}",
    });
    assert(r.status === 200 && typeof r.json?.token === "string", `device read token ${r.status}: ${short(r.text)}`);
    this.token = { token: r.json.token, expiresAt: Number(r.json.expiresAt) || Date.now() + 3_600_000 };
    return { authorization: `Bearer ${this.token.token}` };
  }

  readonly readFetch = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const auth = await this.readHeaders();
    return this.fetch(url, { ...init, headers: { ...headersOf(init.headers), ...auth } });
  };

  /** The `deps` plan.js takes: this device, unlocked, admin, against the gym's `.com`. */
  deps(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      fetch: this.fetch,
      readFetch: this.readFetch,
      session: { username: this.username, umk: this.acct.keys.umk },
      profile: { accountId: this.username, deviceId: this.deviceId, username: this.username },
      apex: `https://${CONTROL}`,
      deviceSeed: this.seed,
      store: { get: (k: string) => this.kv.get(k) ?? null, set: (k: string, v: string) => void this.kv.set(k, v) },
      isAdmin: () => true,
      ...extra,
    };
  }
}

/** The account's primary admin device (registered when the fleet made the real account). */
export function primaryDevice(acct: Account): WebDevice {
  return new WebDevice(acct, REAL_PRIMARY_DEVICE_ID);
}

/** A second admin device of the account, granted by its admin root (a new phone added to the account). */
export async function addAdminDevice(acct: Account, deviceId = `${"0".repeat(31)}2`): Promise<WebDevice> {
  const d = new WebDevice(acct, deviceId);
  const r = await mintDeviceGrant(acct, deviceId, d.key, ["admin", "view-directory", "browse", "install-service", "vibe-code"], acct.keys.adminRoot);
  assert(r.status === 200, `second device grant ${r.status}: ${short(r.text)}`);
  return d;
}

/** `GET /api/users/<u>/plan-attestation` as the device reads it: {tier, paidUntil, ...}. */
export async function planAttestation(d: WebDevice): Promise<Any> {
  const r = await http(`https://${CONTROL}/api/users/${d.username}/plan-attestation`, { headers: await d.readHeaders() });
  assert(r.status === 200 && r.json, `plan-attestation ${r.status}: ${short(r.text)}`);
  return r.json;
}

/** `count` free gym vouchers straight from `/api/vouchers/test-issue` (not saved in any wallet). */
export async function rawTestVouchers(count: number): Promise<Any[]> {
  const pc = await Plan.loadPaymentsConfig({ apex: `https://${CONTROL}` });
  const key = pc.keys.find((k: Any) => k.issuing !== false);
  assert(key, "the gym publishes no voucher key");
  const reqs = Array.from({ length: count }, () => Vouchers.newVoucherRequest(key));
  const r = await http(`https://${CONTROL}/api/vouchers/test-issue`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ k: key.keyId, blinded: reqs.map((q: Any) => q.blinded) }),
  });
  assert(r.status === 200 && Array.isArray(r.json?.sigs), `test-issue ${r.status}: ${short(r.text)}`);
  return reqs.map((q: Any, i: number) => Vouchers.finalizeVoucher(key, q.pending, r.json.sigs[i]));
}

/** POST /api/vouchers/redeem directly (no relay, no credential), as anyone may pay anyone's bill. */
export function redeemDirect(username: string, forWhat: string, vouchers: Any[]) {
  return http(`https://${CONTROL}/api/vouchers/redeem`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ v: 1, username, for: forWhat, vouchers }),
  });
}

/**
 * Makes `acct` Pro if it isn't (the outbound proxy is part of Pro): three free gym vouchers spent directly. Returns
 * the plan's paid-until.
 */
export async function ensurePro(d: WebDevice): Promise<number> {
  const a = await planAttestation(d);
  if (a.tier === "hobby" && Number(a.paidUntil) > Date.now() + 86_400_000) return Number(a.paidUntil);
  const r = await redeemDirect(d.username, "pro", await rawTestVouchers(3));
  assert(r.status === 200 && r.json?.paidUntil, `pro redeem ${r.status}: ${short(r.text)}`);
  return Number(r.json.paidUntil);
}

/** `privateRelay` from `.com`'s status probe: {state, arrivals: {ohttp, directFallback}} for today (UTC). */
export async function relayArrivals(): Promise<{ state: string; ohttp: number; directFallback: number }> {
  const r = await http(`https://${CONTROL}/api/_status/probe`, {}, 30_000);
  const p = r.json?.privateRelay;
  assert(p && p.arrivals, `status probe ${r.status} has no privateRelay: ${short(r.text)}`);
  return { state: String(p.state), ohttp: Number(p.arrivals.ohttp) || 0, directFallback: Number(p.arrivals.directFallback) || 0 };
}

// ── the relay itself (a real outage: the Fly machine is stopped, autostart off) ──────────────────────────────

async function flyctl(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  assert(OHTTP_RELAY_APP.startsWith("flagship-ohttp-relay-gym"), `refusing to touch ${OHTTP_RELAY_APP}: not the gym relay`);
  return run(`${process.env.HOME}/.fly/bin/flyctl`, [...args, "-a", OHTTP_RELAY_APP], 180_000);
}

async function relayMachines(): Promise<Array<{ id: string; state: string }>> {
  const r = await flyctl(["machine", "list", "--json"]);
  assert(r.code === 0, `flyctl machine list: ${short(r.stderr)}`);
  return (JSON.parse(r.stdout) as Array<{ id: string; state: string }>).map((m) => ({ id: m.id, state: m.state }));
}

/** Stop (or start) every machine of the gym relay and wait until /healthz agrees. */
export async function setRelay(on: boolean, log: (s: string) => void = () => {}): Promise<string> {
  const ms = await relayMachines();
  assert(ms.length > 0, `${OHTTP_RELAY_APP} has no machine`);
  for (const m of ms) {
    const r = await flyctl(["machine", on ? "start" : "stop", m.id]);
    if (r.code !== 0) log(`flyctl machine ${on ? "start" : "stop"} ${m.id}: ${short(r.stderr)}`);
  }
  for (let i = 0; i < 36; i++) {
    let ok = false;
    try {
      const r = await fetch(`${OHTTP_RELAY_URL.replace(/\/+$/, "")}/healthz`, { signal: AbortSignal.timeout(8000) });
      ok = r.status === 200;
    } catch {
      ok = false;
    }
    if (ok === on) return `${ms.length} machine(s) ${on ? "started" : "stopped"}; /healthz ${on ? "answers" : "doesn't answer"}`;
    await sleep(5000);
  }
  throw new Error(`the relay did not ${on ? "come up" : "go down"} in 3 min`);
}
