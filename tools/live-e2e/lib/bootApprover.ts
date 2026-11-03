/**
 * The owner's phone answering a LUKS box's start-up, simulated in node for the ISO lanes (a gym fleet box has
 * no encrypted disk and never asks). Mirrors the webapp's lib/bootApproval.js (the co-equal client):
 *
 *   1. POST /api/secret-requests on `.com` with an IRK-signed mailbox claim: the account's pending requests.
 *   2. Keep only this server's, signed by the key they name (the STK, or the boot key a disk unlock is signed
 *      with; the lane's own box, so the binding to the directory STK is reported, not enforced).
 *   3. unlock-key: GET the disk key `.com` holds sealed to the IRK (`/sealed-luks-key`, read token), open it
 *      with the IRK seed, seal it to the request's key bound to (nonce, purpose), POST it to the boot worker
 *      under an owner-IRK `Flagship-Boot-v1` header. entitlement: answer with an admin-root-signed
 *      RootEntitlement carrier. After the first unlock, deposit the entitlement too (consent to boot is
 *      consent to serve), as the apps do.
 *
 * Never used against a box the lane did not make; the keys are the lane's throwaway account's.
 */
import { randomBytes } from "node:crypto";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import {
  buildSealedSecretResponse,
  openSealedFromEd25519Recipient,
  signBootAuth,
  signDeviceEndpointClaim,
  signRootEntitlement,
  verifySecretRequest,
  type RootEntitlement,
  type SecretPurpose,
} from "@flagship/protocol";
import { accountReadHeaders } from "../readToken.js";
import type { Account } from "./fleet.js";
import { CONTROL, assert, postJson, short, sleep, tryHttp } from "./harness.js";

/** The boot worker host `.com`'s CONTROL_APEX names (boot.<apex>), as the gym's bootHost does. */
export const BOOT_HOST = process.env.GYM_BOOT_HOST || `boot.${CONTROL}`;

export interface PendingBootRequest {
  serverDomain: string;
  stkPub: string;
  purpose: string;
  requestNonceHex: string;
  requestSignature: string;
  issuedAt: number;
  pq?: unknown;
}

/** The IRK-signed DeviceEndpointClaim `.com`'s mailbox lanes take (`auth` + `authSignature`). */
export function mailboxClaim(acct: Account, now = Date.now()): { auth: Record<string, unknown>; authSignature: string } {
  const nonce = new Uint8Array(randomBytes(32));
  const claim = { username: acct.username, endpointLabel: "device", phoneIrkPub: acct.keys.irk.publicKey, issuedAt: now, expiresAt: now + 120_000, nonce };
  return {
    auth: { ...claim, phoneIrkPub: bytesToHex(claim.phoneIrkPub), nonce: bytesToHex(nonce) },
    authSignature: bytesToHex(signDeviceEndpointClaim(claim, acct.keys.irk)),
  };
}

/** Whether a pending request is signed by the key it names (the webapp's step 2). */
export function requestIsSigned(r: PendingBootRequest): boolean {
  try {
    return verifySecretRequest(
      { serverDomain: r.serverDomain, stkPub: hexToBytes(r.stkPub), purpose: r.purpose as SecretPurpose, nonce: hexToBytes(r.requestNonceHex), issuedAt: r.issuedAt },
      hexToBytes(r.requestSignature),
      hexToBytes(r.stkPub),
    );
  } catch {
    return false;
  }
}

/** The disk key sealed to the request's key, bound to its (nonce, purpose): the `sealed` hex of a boot response. */
export function sealedUnlockReply(diskKey: Uint8Array, r: Pick<PendingBootRequest, "serverDomain" | "stkPub" | "purpose" | "requestNonceHex" | "issuedAt">): string {
  const resp = buildSealedSecretResponse(diskKey, {
    serverDomain: r.serverDomain,
    stkPub: hexToBytes(r.stkPub),
    purpose: r.purpose as SecretPurpose,
    nonce: hexToBytes(r.requestNonceHex),
    issuedAt: r.issuedAt,
  });
  return bytesToHex(resp.sealed);
}

/**
 * The public EntitlementBundle carrier a box presents at the relay HELLO, hex of its JSON (the webapp's
 * buildEntitlementCarrier; the daemon's serializeEntitlementBundle). Signed by the admin root on a pinned account.
 */
export function entitlementCarrierHex(username: string, stkPubHex: string, serverDomain: string, signer: Account["keys"]["adminRoot"], issuedAt = Date.now()): string {
  for (const v of [username, serverDomain]) if (/[|\x00-\x1f\x7f]/.test(v)) throw new Error("root entitlement: a separator or control character");
  const c: RootEntitlement = { username, podPubKey: hexToBytes(stkPubHex), podCanonical: serverDomain, issuedAt };
  const json = JSON.stringify({
    rootEntitlement: { username, podPubKey: stkPubHex.toLowerCase(), podCanonical: serverDomain, issuedAt },
    rootEntitlementSig: bytesToHex(signRootEntitlement(c, signer)),
    serviceEntitlement: null,
    serviceEntitlementSig: null,
  });
  return bytesToHex(new TextEncoder().encode(json));
}

export interface ApproverEvent {
  at: number;
  purpose: string;
  nonce: string;
  outcome: "answered" | "refused" | "skipped";
  detail: string;
}

/**
 * Answers every start-up request of one server, in the background, until stopped. `events` records each
 * answer (the lane reads how many unlocks it approved, and when).
 */
export class BootApprover {
  readonly events: ApproverEvent[] = [];
  private seen = new Set<string>();
  private running = false;
  private loop: Promise<void> | null = null;
  private deposited = false;

  constructor(private readonly acct: Account, private readonly serverDomain: string, private readonly log: (s: string) => void = () => undefined) {}

  start(everyMs = 8_000): void {
    if (this.running) return;
    this.running = true;
    this.loop = (async () => {
      while (this.running) {
        await this.tick().catch((e) => this.log(`approver: ${(e as Error).message}`));
        await sleep(everyMs);
      }
    })();
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.loop;
  }

  /** Unlocks answered since `t` (ms). */
  unlocksSince(t: number): ApproverEvent[] {
    return this.events.filter((e) => e.at >= t && e.purpose === "unlock-key" && e.outcome === "answered");
  }

  async tick(): Promise<void> {
    const r = await postJson(`https://${CONTROL}/api/secret-requests`, mailboxClaim(this.acct), {}, 20_000);
    if (r.status !== 200) throw new Error(`secret-requests ${r.status}: ${short(r.text)}`);
    for (const req of (r.json?.requests ?? []) as PendingBootRequest[]) {
      if (String(req.serverDomain).toLowerCase() !== this.serverDomain) continue;
      const key = `${req.purpose}#${req.requestNonceHex}`;
      if (this.seen.has(key)) continue;
      this.seen.add(key);
      const ev = (outcome: ApproverEvent["outcome"], detail: string) => {
        this.events.push({ at: Date.now(), purpose: req.purpose, nonce: req.requestNonceHex, outcome, detail });
        this.log(`approver: ${req.purpose} ${req.requestNonceHex.slice(0, 8)} ${outcome}${detail ? ` (${detail})` : ""}`);
      };
      if (!requestIsSigned(req)) {
        ev("refused", "not signed by the key it names");
        continue;
      }
      try {
        if (req.purpose === "unlock-key") {
          await this.post(req, sealedUnlockReply(await this.diskKey(), req));
          ev("answered", req.pq ? "classical reply to a hybrid request" : "");
          await this.depositEntitlement().catch((e) => this.log(`approver: entitlement deposit: ${(e as Error).message}`));
        } else if (req.purpose === "entitlement") {
          await this.post(req, entitlementCarrierHex(this.acct.username, req.stkPub, this.serverDomain, this.acct.keys.adminRoot));
          ev("answered", "");
        } else {
          ev("skipped", `purpose ${req.purpose}`);
        }
      } catch (e) {
        this.seen.delete(key); // try again next tick
        ev("refused", (e as Error).message);
      }
    }
  }

  private async diskKey(): Promise<Uint8Array> {
    const headers = await accountReadHeaders(CONTROL, this.acct.username, this.acct.keys.irk);
    const r = await tryHttp(`https://${CONTROL}/api/server/${encodeURIComponent(this.serverDomain)}/sealed-luks-key`, { headers }, 20_000);
    assert(r.status === 200 && typeof r.json?.sealedKey === "string", `sealed-luks-key ${r.status}: ${short(r.text)}`);
    return openSealedFromEd25519Recipient(hexToBytes(r.json.sealedKey), this.acct.keys.irk.privateKey);
  }

  private async post(req: PendingBootRequest, sealedHex: string): Promise<void> {
    const path = "/api/boot/response";
    const now = Date.now();
    const auth = signBootAuth(
      { role: "owner", serverDomain: req.serverDomain, method: "POST", path, pubKeyHex: bytesToHex(this.acct.keys.irk.publicKey), nonceHex: randomBytes(32).toString("hex"), issuedAt: now },
      this.acct.keys.irk.privateKey,
    );
    const r = await postJson(
      `https://${BOOT_HOST}${path}`,
      { response: { serverDomain: req.serverDomain, requestNonceHex: req.requestNonceHex, purpose: req.purpose, sealed: sealedHex, issuedAt: now } },
      { authorization: auth },
      20_000,
    );
    // 409: already answered (another tick, or a re-announce of the same request).
    assert([200, 201, 204, 409].includes(r.status), `boot response ${r.status}: ${short(r.text)}`);
  }

  /** The folded-in "authorize it to serve" (the apps' depositEntitlement), once per run. */
  private async depositEntitlement(): Promise<void> {
    if (this.deposited) return;
    const headers = await accountReadHeaders(CONTROL, this.acct.username, this.acct.keys.irk);
    const pods = await tryHttp(`https://${CONTROL}/api/users/${encodeURIComponent(this.acct.username)}/pods`, { headers }, 20_000);
    const row = ((pods.json?.pods ?? []) as Array<{ serverDomain?: string; identityPubKey?: string }>).find((p) => p.serverDomain === this.serverDomain);
    if (!row?.identityPubKey) return; // not registered yet; the box asks for its entitlement itself
    const r = await postJson(`https://${CONTROL}/api/server/${encodeURIComponent(this.serverDomain)}/entitlement-deposit`, {
      ...mailboxClaim(this.acct),
      deposit: {
        serverDomain: this.serverDomain,
        requestNonceHex: randomBytes(32).toString("hex"),
        stkPub: row.identityPubKey.toLowerCase(),
        sealed: entitlementCarrierHex(this.acct.username, row.identityPubKey, this.serverDomain, this.acct.keys.adminRoot),
        issuedAt: Date.now(),
      },
    });
    assert(r.status === 200, `entitlement-deposit ${r.status}: ${short(r.text)}`);
    this.deposited = true;
  }
}
