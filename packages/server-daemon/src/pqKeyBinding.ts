/**
 * Architecture v2 milestone 1 (docs/architecture-v2/pq-suites.md §9): the box's STK binds its
 * ML-DSA-65 key, which keyd generated and holds next to the STK. Both keys sign one statement
 * (`flagship/pq-key-binding/v1`, role box-stk, subject = this server), so the binding proves
 * possession of each. `.com` stores it under the registered STK; clients verify it under the
 * STK they pinned and pin the ML-DSA key too.
 */
import { signPqKeyBinding, verifyPqKeyBinding, type HybridMsgSigner } from "@flagship/protocol";

export async function ensureStkPqBinding(args: {
  serverDomain: string;
  stkPubHex: string;
  mldsaPubHex: string;
  /** keyd's `sign.hybrid` (STK AND its ML-DSA key). */
  stkHybrid: HybridMsgSigner;
  controlPlaneBaseUrl: string;
  now?: () => number;
  fetch?: typeof fetch;
}): Promise<"ok" | "bound"> {
  const f = args.fetch ?? fetch;
  const now = (args.now ?? Date.now)();
  const domain = args.serverDomain.toLowerCase();
  const url = `${args.controlPlaneBaseUrl.replace(/\/+$/, "")}/api/server/${encodeURIComponent(domain)}/pq-key-binding`;
  const expect = { role: "box-stk" as const, subjectId: domain, ed25519PubHex: args.stkPubHex.toLowerCase(), mldsaPubHex: args.mldsaPubHex, now };
  const res = await f(url, { headers: { accept: "application/json" } });
  if (res.ok) {
    try {
      verifyPqKeyBinding(await res.json(), expect);
      return "ok";
    } catch {
      // `.com` holds none for these keys (or a broken one): sign a fresh one below.
    }
  } else if (res.status !== 404) {
    throw new Error(`pq key binding check failed: HTTP ${res.status}`);
  }
  const wire = signPqKeyBinding(
    { role: "box-stk", subjectId: domain, ed25519PubHex: expect.ed25519PubHex, mldsaPubHex: args.mldsaPubHex, issuedAt: now },
    args.stkHybrid,
  );
  const put = await f(url, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(wire) });
  if (!put.ok) throw new Error(`pq key binding refused: HTTP ${put.status}`);
  return "bound";
}
