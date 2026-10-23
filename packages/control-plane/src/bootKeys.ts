import { bootKeyBindingFromWire, bootKeyBindingToWire, verifiedBootKey } from "@flagship/protocol";
import type { ServerBootKeyStorage, ServerStorage } from "@flagship/storage";
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
 */
export interface BootKeyDeps {
  servers: ServerStorage;
  serverBootKeys: ServerBootKeyStorage;
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
  const wire = bootKeyBindingToWire(parsed.binding, parsed.signature);
  const put = await deps.serverBootKeys.putIfNewer({
    serverDomain: host.toLowerCase(),
    stkPubHex: wire.binding.stkPub,
    bootKeyPubHex,
    issuedAt: parsed.binding.issuedAt,
    signatureHex: wire.signature,
    storedAt: now(),
  });
  if (!put.ok) return { status: 409, body: { error: put.reason } };
  return { status: 200, body: { ok: true } };
}

/** The stored binding in its wire shape, only while it verifies under the current STK. */
export async function currentBootKeyBinding(
  deps: Pick<BootKeyDeps, "servers" | "serverBootKeys">,
  host: string,
): Promise<{ wire: ReturnType<typeof bootKeyBindingToWire>; bootKeyPubHex: string; stkPubHex: string } | null> {
  const reg = await deps.servers.get(host.toLowerCase());
  if (!reg || reg.revokedAt) return null;
  const rec = await deps.serverBootKeys.get(host);
  if (!rec) return null;
  const wire = {
    binding: { serverDomain: rec.serverDomain, stkPub: rec.stkPubHex, bootKeyPub: rec.bootKeyPubHex, issuedAt: rec.issuedAt },
    signature: rec.signatureHex,
  };
  const bootKeyPubHex = verifiedBootKey(wire, { serverDomain: host, stkPubHex: reg.identityPubKeyHex });
  return bootKeyPubHex ? { wire, bootKeyPubHex, stkPubHex: reg.identityPubKeyHex.toLowerCase() } : null;
}

export async function handleGetBootKey(deps: BootKeyDeps, host: string): Promise<HandlerResponse> {
  const cur = await currentBootKeyBinding(deps, host);
  if (!cur) return notFound("no boot key on file");
  return { status: 200, body: cur.wire };
}
