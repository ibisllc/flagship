/**
 * Pre-rotation endpoint: phone-paired-session-gated route that mints
 * a fresh Ed25519 server-identity keypair and writes the priv to
 * `<dataDir>/identity/identity.pending.priv.hex`. The phone reads the
 * returned pubkey and signs a `rotate-server-identity` PhoneOrder
 * carrying it; on dispatch the daemon swaps active = pending and
 * exits so OpenRC respawns with the new key.
 *
 * Two-step instead of one-step because the rotate order is canonical-
 * bytes-signed by PSK at the time of issue — the phone needs to know
 * the new pubkey BEFORE it signs. Pre-rotation isolates "generate the
 * pending keypair" from "commit to it"; if the phone changes its mind
 * after generation, the next call replaces the pending file (no
 * cleanup needed).
 *
 * Mounted as an `additionalHandler`. Returns null for non-matching
 * paths so the runtime falls through to other handlers / the default.
 */

import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ed } from "@flagship/protocol";
import type { PairedSessionGate } from "./alertInboxHttp.js";
import type { HttpRequest, HttpResponse } from "./runtime.js";

const J = { "content-type": "application/json" } as const;

export interface IdentityRotateHttpDeps {
  gate: PairedSessionGate;
  /** Path the rotate handler reads at order time. */
  pendingPath: string;
}

export function buildIdentityRotateHandlers(deps: IdentityRotateHttpDeps) {
  return async function handle(req: HttpRequest): Promise<HttpResponse | null> {
    if (req.path !== "/api/identity/pending") return null;
    if (req.method !== "POST") {
      return {
        status: 405,
        headers: J,
        body: JSON.stringify({ error: "method not allowed" }),
      };
    }
    const denied = deps.gate.check(req);
    if (denied) return denied;

    const priv = new Uint8Array(32);
    crypto.getRandomValues(priv);
    const pub = ed.getPublicKey(priv);
    const privHex = bytesToHex(priv);

    await mkdir(dirname(deps.pendingPath), { recursive: true, mode: 0o700 });
    const tmp = `${deps.pendingPath}.tmp`;
    await writeFile(tmp, privHex + "\n", { mode: 0o600 });
    await rename(tmp, deps.pendingPath);

    return {
      status: 200,
      headers: J,
      body: JSON.stringify({
        pubKeyHex: bytesToHex(pub),
      }),
    };
  };
}

export function defaultPendingIdentityPath(dataDir: string): string {
  return join(dataDir, "identity", "identity.pending.priv.hex");
}

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}
