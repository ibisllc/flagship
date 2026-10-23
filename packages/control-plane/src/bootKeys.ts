import { bootKeyBindingFromWire, bootKeyBindingToWire, verifiedBootKey, verifiedBootKeyGated } from "@flagship/protocol";
import type { PqTrustStorage, ServerBootKeyStorage, ServerStorage } from "@flagship/storage";
import { installationPolicy, verifiedStoredStkBinding } from "./pqKeyBindings.js";
import { forbidden, malformed, notFound, type HandlerResponse } from "./types.js";

/**
 * The boot key a box keeps on /boot for the jobs before its disk is open
 * (packages/protocol/src/bootKey.ts).
 *
 * `PUT /api/server/:host/boot-key`   body = the binding, signed by the registered STK
 * `GET /api/server/:host/boot-key`   public: the binding, for phones and the boot
 *                                    worker to verify under the STK they trust
 *
 * Only a binding that verifies under the server's CURRENT STK is ever served, so
 * a binding from before an STK change is never handed out.
 *
 * Architecture v2: the body may carry `hybridSignature`, the STK's hybrid key over
 * `flagship/boot-key-binding/v2`. With `pqTrust` wired the PUT goes through the
 * critical-signature gate: a hybrid signature that is present must verify under
 * the stored STK binding, and a strict installation needs it. The GET serves it
 * beside the v1 signature while it matches the stored v1 binding.
 */
export interface BootKeyDeps {
  servers: ServerStorage;
  serverBootKeys: ServerBootKeyStorage;
  pqTrust?: PqTrustStorage;
  now?: () => number;
}

export async function handlePutBootKey(deps: BootKeyDeps, host: string, body: unknown): Promise<HandlerResponse> {
  const now = deps.now ?? (() => Date.now());
  const parsed = bootKeyBindingFromWire(body);
  if (!parsed) return malformed("malformed body");
  if (parsed.binding.serverDomain.toLowerCase() !== host.toLowerCase()) return forbidden("serverDomain / host mismatch");
  const reg = await deps.servers.get(host.toLowerCase());
  if (!reg) return notFound("unknown server");
  if (reg.revokedAt) return forbidden("server is revoked");
  const bootKeyPubHex = verifiedBootKey(body, { serverDomain: host, stkPubHex: reg.identityPubKeyHex });
  if (!bootKeyPubHex) return forbidden("the binding is not signed by this server's key");
  let hybridSignatureHex: string | null = null;
  if (deps.pqTrust) {
    const pq = await deps.pqTrust.forServer(host);
    const gated = verifiedBootKeyGated(body, {
      serverDomain: host,
      stkPubHex: reg.identityPubKeyHex,
      stkBinding: verifiedStoredStkBinding(pq.stkBinding, host, reg.identityPubKeyHex, now()),
      policy: installationPolicy(pq.policy, host),
    });
    if (!gated) return forbidden("the binding's quantum-resistant signature is missing or does not verify");
    if (gated.hybrid) hybridSignatureHex = String((body as { hybridSignature: string }).hybridSignature);
  }
  const wire = bootKeyBindingToWire(parsed.binding, parsed.signature);
  const put = await deps.serverBootKeys.putIfNewer({
    serverDomain: host.toLowerCase(),
    stkPubHex: reg.identityPubKeyHex.toLowerCase(),
    bootKeyPubHex,
    issuedAt: parsed.binding.issuedAt,
    signatureHex: wire.signature,
    storedAt: now(),
  });
  if (!put.ok) return { status: 409, body: { error: put.reason } };
  if (deps.pqTrust && hybridSignatureHex) {
    await deps.pqTrust.putBootHybrid({
      serverDomain: host.toLowerCase(),
      stkPubHex: reg.identityPubKeyHex.toLowerCase(),
      bootKeyPubHex,
      issuedAt: parsed.binding.issuedAt,
      hybridSignatureHex,
      storedAt: now(),
    });
  }
  return { status: 200, body: { ok: true } };
}

/** The stored binding in its wire shape, only while it verifies under the current STK. */
export async function currentBootKeyBinding(
  deps: Pick<BootKeyDeps, "servers" | "serverBootKeys" | "pqTrust">,
  host: string,
): Promise<{ wire: ReturnType<typeof bootKeyBindingToWire>; bootKeyPubHex: string; stkPubHex: string } | null> {
  const reg = await deps.servers.get(host.toLowerCase());
  if (!reg || reg.revokedAt) return null;
  const rec = await deps.serverBootKeys.get(host);
  if (!rec) return null;
  if (rec.stkPubHex !== reg.identityPubKeyHex.toLowerCase()) return null;
  const hy = deps.pqTrust ? await deps.pqTrust.getBootHybrid(host) : null;
  const hybridMatches = hy && hy.stkPubHex === rec.stkPubHex && hy.bootKeyPubHex === rec.bootKeyPubHex && hy.issuedAt === rec.issuedAt;
  const wire = {
    binding: { serverDomain: rec.serverDomain, bootPubHex: rec.bootKeyPubHex, issuedAt: rec.issuedAt },
    signature: rec.signatureHex,
    ...(hybridMatches ? { hybridSignature: hy.hybridSignatureHex } : {}),
  };
  const bootKeyPubHex = verifiedBootKey(wire, { serverDomain: host, stkPubHex: reg.identityPubKeyHex });
  return bootKeyPubHex ? { wire, bootKeyPubHex, stkPubHex: reg.identityPubKeyHex.toLowerCase() } : null;
}

export async function handleGetBootKey(deps: BootKeyDeps, host: string): Promise<HandlerResponse> {
  const cur = await currentBootKeyBinding(deps, host);
  if (!cur) return notFound("no boot key on file");
  return { status: 200, body: cur.wire };
}
