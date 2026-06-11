import { sha256 } from "@noble/hashes/sha256";
import {
  signDns01Delete,
  signDns01Publish,
  type Bytes,
  type Dns01DeleteRequest,
  type Dns01PublishRequest,
  type Keypair,
  type ServiceCertAuthority,
} from "@flagship/protocol";
import type { FetchLike } from "@flagship/llm-providers";
import type { DnsChallengeWriter } from "./letsEncryptIssuer.js";

/**
 * DnsChallengeWriter that calls the .com control plane to publish/delete
 * DNS-01 TXT records on behalf of this server. Each call is signed with
 * the server's identity key; the Worker-side route verifies against the
 * pubkey registered via `/api/server/register`.
 *
 * The plaintext TXT value rides alongside the signed-hash so the control
 * plane can re-hash and reject if a man-in-the-middle swapped the value
 * after the daemon signed.
 *
 * Endpoints: `POST /api/dns-01/publish` and `POST /api/dns-01/delete`
 * on `https://flagshipserver.com`. (Earlier versions targeted
 * `/api/services-zone/dns-01-*` on `flagship.services`; that legacy
 * Fastify route still exists for now but the Worker is the canonical
 * location since `.com` holds the Cloudflare DNS API token.)
 */
export interface RemoteDnsChallengeWriterOptions {
  /**
   * Base URL of the control plane. Default `https://flagshipserver.com`.
   * Override for tests or non-production environments.
   */
  controlPlaneBaseUrl?: string;
  serverId: string;
  /**
   * The server's identity keypair (registered via `/api/server/register`).
   * Field name preserved as `stk` for backward compatibility with
   * existing callers, but semantically this is the identity key.
   */
  stk: Keypair;
  fetchImpl?: FetchLike;
  now?: () => number;
  /**
   * Tier-2 shared-service-cert grant (cert model A′ Phase 5). When set,
   * the IRK-signed authority is forwarded with EVERY publish AND delete
   * so the control plane / broker accept a challenge name outside this
   * box's own `_acme-challenge.<serverFqdn>` — the verifier checks the
   * phone's signature, that we are `boxServerId`, and that the record
   * matches `serviceFqdn`. Never set on the normal per-box writer; use
   * {@link RemoteDnsChallengeWriter.withServiceCertAuthority}.
   */
  serviceCertAuthority?: { authority: ServiceCertAuthority; signature: Bytes };
}

function bytesToHex(b: Bytes): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

export class RemoteDnsChallengeWriter implements DnsChallengeWriter {
  constructor(private readonly opts: RemoteDnsChallengeWriterOptions) {}

  /**
   * A copy of this writer that forwards the given phone-issued grant on
   * every publish/delete — used for ONE tier-2 service-cert issuance,
   * leaving the shared per-box writer untouched.
   */
  withServiceCertAuthority(grant: {
    authority: ServiceCertAuthority;
    signature: Bytes;
  }): RemoteDnsChallengeWriter {
    return new RemoteDnsChallengeWriter({ ...this.opts, serviceCertAuthority: grant });
  }

  private authorityWire(): { serviceCertAuthority: { authority: ServiceCertAuthority; signature: string } } | Record<string, never> {
    const g = this.opts.serviceCertAuthority;
    if (!g) return {};
    return {
      serviceCertAuthority: {
        authority: g.authority,
        signature: bytesToHex(g.signature),
      },
    };
  }

  async publishTxt(host: string, value: string): Promise<() => Promise<void>> {
    const f = this.opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    const baseUrl = this.opts.controlPlaneBaseUrl ?? "https://flagshipserver.com";
    const recordValueHash = sha256(new TextEncoder().encode(value));
    const issuedAt = (this.opts.now ?? (() => Date.now()))();
    const claim: Dns01PublishRequest = {
      serverId: this.opts.serverId,
      recordName: host,
      recordValueHash,
      issuedAt,
    };
    const sig = signDns01Publish(claim, this.opts.stk);

    const res = await f(`${baseUrl}/api/dns-01/publish`, {
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
        ...this.authorityWire(),
      }),
    });
    if (!res.ok) {
      throw new Error(`dns-01 publish failed: ${res.status} ${await res.text()}`);
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
      await f(`${baseUrl}/api/dns-01/delete`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          request: {
            serverId: this.opts.serverId,
            recordId: body.recordId,
            issuedAt: dIssuedAt,
          },
          signature: bytesToHex(dSig),
          ...this.authorityWire(),
        }),
      }).catch(() => {
        // best-effort cleanup; the control plane has its own GC for stale records
      });
    };
  }
}
