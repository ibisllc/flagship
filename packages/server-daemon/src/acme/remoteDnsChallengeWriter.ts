import { sha256 } from "@noble/hashes/sha256";
import {
  signDns01Delete,
  signDns01Publish,
  type Bytes,
  type Dns01DeleteRequest,
  type Dns01PublishRequest,
  type Keypair,
} from "@flagship/protocol";
import type { FetchLike } from "@flagship/llm-providers";
import type { DnsChallengeWriter } from "./letsEncryptIssuer.js";

/**
 * DnsChallengeWriter that calls flagship.services to publish/delete DNS-01
 * TXT records on behalf of this server. Each call is STK-signed; the
 * service-side route verifies against the server's registered STK pubkey.
 *
 * The plaintext TXT value rides alongside the signed-hash so the service
 * can re-hash and reject if a man-in-the-middle swapped the value after
 * the daemon signed.
 */
export interface RemoteDnsChallengeWriterOptions {
  /** Base URL of flagship.services. e.g. "https://flagship.services". */
  servicesBaseUrl: string;
  serverId: string;
  stk: Keypair;
  fetchImpl?: FetchLike;
  now?: () => number;
}

function bytesToHex(b: Bytes): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

export class RemoteDnsChallengeWriter implements DnsChallengeWriter {
  constructor(private readonly opts: RemoteDnsChallengeWriterOptions) {}

  async publishTxt(host: string, value: string): Promise<() => Promise<void>> {
    const f = this.opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    const recordValueHash = sha256(new TextEncoder().encode(value));
    const issuedAt = (this.opts.now ?? (() => Date.now()))();
    const claim: Dns01PublishRequest = {
      serverId: this.opts.serverId,
      recordName: host,
      recordValueHash,
      issuedAt,
    };
    const sig = signDns01Publish(claim, this.opts.stk);

    const res = await f(`${this.opts.servicesBaseUrl}/api/services-zone/dns-01-publish`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        request: {
          serverId: this.opts.serverId,
          recordName: host,
          recordValueHash: bytesToHex(recordValueHash),
          issuedAt,
        },
        signature: bytesToHex(sig),
        recordValue: value,
      }),
    });
    if (!res.ok) {
      throw new Error(`dns-01-publish failed: ${res.status} ${await res.text()}`);
    }
    const body = (await res.json()) as { recordId: string };

    return async () => {
      const dIssuedAt = (this.opts.now ?? (() => Date.now()))();
      const dClaim: Dns01DeleteRequest = {
        serverId: this.opts.serverId,
        recordId: body.recordId,
        issuedAt: dIssuedAt,
      };
      const dSig = signDns01Delete(dClaim, this.opts.stk);
      await f(`${this.opts.servicesBaseUrl}/api/services-zone/dns-01-delete`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          request: {
            serverId: this.opts.serverId,
            recordId: body.recordId,
            issuedAt: dIssuedAt,
          },
          signature: bytesToHex(dSig),
        }),
      }).catch(() => {
        // best-effort cleanup; the .services side has its own GC for stale records
      });
    };
  }
}
