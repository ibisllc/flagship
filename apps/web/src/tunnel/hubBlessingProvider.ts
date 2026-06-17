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
import { ed } from "@flagship/protocol";
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
          headers: { "content-type": "application/json" },
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
