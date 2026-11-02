/**
 * `.services` self-key + daily relay-blessing provider
 * (docs/maintainer-trust-enforcement.md § "The relay blessing").
 *
 * On hub startup the `.services` Fly app:
 *   1. Generates (or loads) its OWN Ed25519 keypair. Ephemeral-per-boot is
 *      fine — the box re-verifies a fresh blessing each connect; we persist
 *      to a Fly volume ONLY when a `keyPath` is provided AND a key already
 *      exists there (we don't create a volume that isn't mounted).
 *   2. Asks `.com` `POST /api/services/hub-blessing` to bless its pubkey,
 *      getting back a short-lived (~26h) `ServiceBlessing` signed by the
 *      live hot CA key.
 *   3. Refreshes every ~12h, holding the current blessing in memory.
 *
 * On each HELLO_ACK the hub attaches the current blessing and signs the
 * box's HELLO nonce with the hub key (`hubSig`) — proof it holds the
 * blessed key. If no blessing is held yet (startup race / `.com` down) the
 * hub omits it, which is OBSERVE-safe: a box that gets no blessing keeps
 * relaying (it only locks down under ENFORCE on a blessing that FAILS).
 */

import { readFileSync, writeFileSync } from "node:fs";
import { canonicalRelayBlessingRequest, ed, RELAY_BLESSING_REFRESH_MS, verifyRelayBlessing } from "@flagship/protocol";
import type { ServiceBlessing } from "@flagship/protocol";

export interface HubKeypair {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
}

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

function hexToBytes(h: string): Uint8Array {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * Load a persisted hub key (Fly volume) or generate a fresh one. Persists
 * the freshly-generated key back ONLY when `keyPath` is set and writable;
 * a write failure (no volume) is non-fatal — ephemeral-per-boot is the
 * documented default.
 */
export function loadOrCreateHubKeypair(keyPath?: string): HubKeypair {
  if (keyPath) {
    try {
      const hex = readFileSync(keyPath, "utf8").trim();
      if (/^[0-9a-f]{64}$/.test(hex)) {
        const privateKey = hexToBytes(hex);
        return { privateKey, publicKey: ed.getPublicKey(privateKey) };
      }
    } catch {
      /* no existing key — fall through to generate */
    }
  }
  const privateKey = ed.utils.randomPrivateKey();
  const kp = { privateKey, publicKey: ed.getPublicKey(privateKey) };
  if (keyPath) {
    try {
      writeFileSync(keyPath, bytesToHex(privateKey), { mode: 0o600 });
    } catch {
      /* ephemeral-per-boot — fine, re-blessed each boot */
    }
  }
  return kp;
}

export interface HubBlessingProviderOptions {
  /** The hub's self-generated signing keypair. */
  keypair: HubKeypair;
  /** Host this hub answers as, e.g. `flagship.services`. */
  hubHost: string;
  /** `.com` base URL, e.g. `https://flagshipserver.com`. */
  comBaseUrl: string;
  /** `SERVICES_CONTROL_SECRET` — `.com` blesses only a caller holding it. */
  sharedSecret?: string;
  /** Refresh cadence. Default 12h (blessing TTL is ~26h, so this is slack). */
  refreshIntervalMs?: number;
  /** Test seam — replace global fetch. */
  fetchImpl?: typeof fetch;
  /** Test seam — replace setInterval/clearInterval. */
  setIntervalImpl?: typeof setInterval;
  clearIntervalImpl?: typeof clearInterval;
  /** Optional structured log sink (default console.log). */
  log?: (line: string) => void;
}

const DEFAULT_REFRESH_MS = 12 * 60 * 60_000;

/**
 * Holds the current relay blessing, refreshes it on a timer, and signs box
 * HELLO nonces with the hub key.
 */
export class HubBlessingProvider {
  private readonly keypair: HubKeypair;
  private readonly hubHost: string;
  private readonly comBaseUrl: string;
  private readonly sharedSecret: string | undefined;
  private readonly refreshIntervalMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly setIntervalFn: typeof setInterval;
  private readonly clearIntervalFn: typeof clearInterval;
  private readonly log: (line: string) => void;
  private current: ServiceBlessing | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: HubBlessingProviderOptions) {
    this.keypair = opts.keypair;
    this.hubHost = opts.hubHost;
    this.comBaseUrl = opts.comBaseUrl.replace(/\/$/, "");
    this.sharedSecret = opts.sharedSecret;
    this.refreshIntervalMs = opts.refreshIntervalMs ?? DEFAULT_REFRESH_MS;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.setIntervalFn = opts.setIntervalImpl ?? setInterval;
    this.clearIntervalFn = opts.clearIntervalImpl ?? clearInterval;
    this.log = opts.log ?? ((l) => console.log(l));
  }

  /** lower-hex hub pubkey (the key `.com` blesses). */
  hubKeyPubHex(): string {
    return bytesToHex(this.keypair.publicKey);
  }

  /** The current in-memory blessing, or null if none has been fetched yet. */
  currentBlessing(): ServiceBlessing | null {
    return this.current;
  }

  /**
   * Sign a box's HELLO nonce with the hub key. Returns lower-hex. The box
   * verifies this against the blessing's `hubKeyPub` to prove the hub holds
   * the blessed key.
   */
  signNonce(nonce: Uint8Array): string {
    return bytesToHex(ed.sign(nonce, this.keypair.privateKey));
  }

  /**
   * Fetch a fresh blessing from `.com`. Best-effort: on any failure we keep
   * the previous blessing (or null) and log — never throw, so a `.com` blip
   * can't crash the hub.
   */
  async refresh(): Promise<ServiceBlessing | null> {
    try {
      const resp = await this.fetchImpl(
        `${this.comBaseUrl}/api/services/hub-blessing`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(this.sharedSecret ? { authorization: `Bearer ${this.sharedSecret}` } : {}),
          },
          body: JSON.stringify({
            hubKeyPub: this.hubKeyPubHex(),
            hubHost: this.hubHost,
          }),
        },
      );
      if (!resp.ok) {
        this.log(
          `[relay-blessing] refresh failed status=${resp.status} (keeping prior blessing)`,
        );
        return this.current;
      }
      const body = (await resp.json()) as { blessing?: ServiceBlessing };
      if (
        body.blessing &&
        body.blessing.kind === "ServiceBlessing" &&
        body.blessing.hubKeyPub.toLowerCase() === this.hubKeyPubHex()
      ) {
        this.current = body.blessing;
        this.log(
          `[relay-blessing] refreshed expiresAt=${body.blessing.expiresAt} signedBy=${body.blessing.signedBy}`,
        );
        return this.current;
      }
      this.log("[relay-blessing] refresh returned no usable blessing (keeping prior)");
      return this.current;
    } catch (e) {
      this.log(
        `[relay-blessing] refresh error=${e instanceof Error ? e.message : String(e)} (keeping prior blessing)`,
      );
      return this.current;
    }
  }

  /** Fetch once immediately, then on the refresh cadence. */
  async start(): Promise<void> {
    await this.refresh();
    this.timer = this.setIntervalFn(() => {
      void this.refresh();
    }, this.refreshIntervalMs);
    (this.timer as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (this.timer !== null) {
      this.clearIntervalFn(this.timer);
      this.timer = null;
    }
  }
}

// ── relay mesh (docs/architecture-v2/relay-mesh.md §3.2) ──────────────────


/**
 * Mesh mode: the relay key comes from `FLAGSHIP_RELAY_KEY_SEED` (64 hex), never generated per boot, because peers and
 * `.com` know the relay by it. The same key signs HELLO_ACK `hubSig`, bridge auth, legacy attachments, move hints,
 * account moves and phone route grants.
 */
export function relayKeypairFromSeed(seedHex: string): HubKeypair {
  const s = seedHex.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(s)) throw new Error("FLAGSHIP_RELAY_KEY_SEED must be 64 lowercase hex");
  const privateKey = hexToBytes(s);
  return { privateKey, publicKey: ed.getPublicKey(privateKey) };
}

export interface RelayBlessingProviderOptions {
  keypair: HubKeypair;
  relayId: string;
  servicesApex: string;
  comBaseUrl: string;
  /** The CA keys authorized now: a blessing from `.com` or a peer is kept only if it verifies under them. */
  caKeys: () => readonly string[];
  /** Renewal cadence. Default 24 h (blessings last 30 d, §3.2); a relay without a valid blessing retries every `retryMs`. */
  refreshIntervalMs?: number;
  retryMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  log?: (line: string) => void;
  /**
   * Whatever else `.com` returned with the blessing (owner decision: the feed's epoch key, sealed to this relay key);
   * the feed cipher takes it from here. Called after every successful renewal.
   */
  onIssued?: (body: Record<string, unknown>) => void;
}

/**
 * Holds this relay's RelayBlessing (and the v1 ServiceBlessing old boxes still check), renewed with proof of key:
 * `POST /api/services/relay-blessing` `{relayId, relayKey, servicesApex, issuedAt, signature}`, the signature by the
 * relay key over `flagship/relay-blessing-request/v1`. No state on disk: after a restart during a `.com` outage a peer
 * returns the relay its last blessing in the bridge handshake (`adopt`).
 */
export class RelayBlessingProvider {
  private relayBlessing: import("@flagship/protocol").RelayBlessing | null = null;
  private serviceBlessing: ServiceBlessing | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private stopped = false;

  constructor(private readonly opts: RelayBlessingProviderOptions) {
    this.now = opts.now ?? (() => Date.now());
    this.log = opts.log ?? ((l) => console.log(l));
  }

  relayKeyHex(): string {
    return bytesToHex(this.opts.keypair.publicKey);
  }

  sign(msg: Uint8Array): Uint8Array {
    return ed.sign(msg, this.opts.keypair.privateKey);
  }

  signNonce(nonce: Uint8Array): string {
    return bytesToHex(ed.sign(nonce, this.opts.keypair.privateKey));
  }

  /** The v1 ServiceBlessing (`hubKeyPub` = relay key) for old boxes' observe-mode check. */
  currentBlessing(): ServiceBlessing | null {
    return this.serviceBlessing && this.serviceBlessing.expiresAt > this.now() ? this.serviceBlessing : null;
  }

  /** This relay's RelayBlessing while it is valid, else null. */
  currentRelayBlessing(): import("@flagship/protocol").RelayBlessing | null {
    const b = this.relayBlessing;
    if (!b) return null;
    return verifyRelayBlessing(b, this.opts.caKeys(), this.now(), this.opts.servicesApex).ok ? b : null;
  }

  /** A blessing for this relay from anywhere (`.com`, or a peer after a restart): kept when it verifies and names our key. */
  adopt(raw: unknown): boolean {
    const b = raw as import("@flagship/protocol").RelayBlessing;
    if (b?.relayId !== this.opts.relayId || b.relayKey !== this.relayKeyHex()) return false;
    if (!verifyRelayBlessing(b, this.opts.caKeys(), this.now(), this.opts.servicesApex).ok) return false;
    if (this.relayBlessing && this.currentRelayBlessing() && this.relayBlessing.expiresAt >= b.expiresAt) return false;
    this.relayBlessing = b;
    return true;
  }

  async refresh(): Promise<boolean> {
    const issuedAt = this.now();
    const req = { relayId: this.opts.relayId, relayKey: this.relayKeyHex(), servicesApex: this.opts.servicesApex, issuedAt };
    try {
      const signature = bytesToHex(this.sign(canonicalRelayBlessingRequest(req)));
      const resp = await (this.opts.fetchImpl ?? fetch)(`${this.opts.comBaseUrl.replace(/\/+$/, "")}/api/services/relay-blessing`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...req, signature }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!resp.ok) {
        this.log(`[relay-blessing] renewal refused status=${resp.status} (keeping the one held)`);
        return false;
      }
      const body = (await resp.json()) as Record<string, unknown>;
      const ok = this.adopt(body.relayBlessing);
      const sb = body.serviceBlessing as ServiceBlessing | undefined;
      if (sb?.kind === "ServiceBlessing" && sb.hubKeyPub?.toLowerCase() === this.relayKeyHex()) this.serviceBlessing = sb;
      if (ok) {
        this.log(`[relay-blessing] renewed ${this.opts.relayId} expiresAt=${this.relayBlessing?.expiresAt}`);
        this.opts.onIssued?.(body);
      } else this.log("[relay-blessing] .com returned no usable relay blessing (keeping the one held)");
      return ok;
    } catch (e) {
      this.log(`[relay-blessing] renewal failed: ${e instanceof Error ? e.message : String(e)} (keeping the one held)`);
      return false;
    }
  }

  async start(): Promise<void> {
    const loop = async () => {
      if (this.stopped) return;
      await this.refresh();
      if (this.stopped) return;
      const next = this.currentRelayBlessing() ? (this.opts.refreshIntervalMs ?? RELAY_BLESSING_REFRESH_MS) : (this.opts.retryMs ?? 60_000);
      this.timer = setTimeout(() => void loop(), next);
      (this.timer as { unref?: () => void }).unref?.();
    };
    await loop();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
