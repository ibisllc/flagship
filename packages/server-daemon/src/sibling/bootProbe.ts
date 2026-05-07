/**
 * Boot probe — for each FQDN this pod is entitled to claim, decide
 * whether to claim it or just learn the current incumbent and stay
 * connected.
 *
 * Per the design (final, 2026-05-07):
 *
 *   each pod just grabs all the urls it is entitled to (minus those
 *   which are already grabbed by someone — in what case, it
 *   establishes a WS connection to stay in touch). the system is
 *   happy to leave the short url in the hand of whoever has it.
 *
 * So the rule per cap:
 *   1. Try to open a sibling-WS to the FQDN.
 *   2. If a sibling answers and the handshake succeeds, the FQDN is
 *      held. Keep the WS open via the SiblingRouter; do NOT claim.
 *   3. If the connection attempt fails (DNS NXDOMAIN, TCP refused,
 *      WS upgrade rejected, handshake failure), the FQDN is vacant —
 *      claim it via the urlController.
 *
 * Active takeover (claim a held URL anyway) is a separate flow that
 * apps trigger explicitly via /api/url/claim. The boot probe is
 * conservative.
 */

import type { Keypair } from "@flagship/protocol";
import { openSiblingConnection } from "./wsClient.js";
import type { SiblingPeerLookup } from "./handshake.js";
import type { InMemorySiblingRouter } from "./router.js";
import type { UrlController } from "../runtime.js";
import type { CapabilityStore } from "../capabilityStore.js";

export interface BootProbeArgs {
  myServerId: string;
  myStk: Keypair;
  lookupPeerStk: SiblingPeerLookup;
  router: InMemorySiblingRouter;
  urlController: UrlController;
  capabilityStore: CapabilityStore;
  /** Override the connection scheme — production uses wss, tests ws. */
  scheme?: "ws" | "wss";
  /** Override the URL path. */
  path?: string;
  /** Connect timeout per cap. Default 5s. */
  connectTimeoutMs?: number;
  liveSiblings?: () => string[];
  /** Used for tests + observability. */
  onProbe?: (e: ProbeOutcome) => void;
}

export type ProbeOutcome =
  | { fqdn: string; result: "claimed" }
  | { fqdn: string; result: "incumbent"; peerServerId: string }
  | { fqdn: string; result: "error"; message: string };

/**
 * Run the boot probe over every cap currently in the capability store
 * that names THIS pod's siblingId. Returns once every cap has been
 * probed (concurrently). Errors per-cap are surfaced through
 * `onProbe` and do not abort the sweep.
 *
 * Deduplicates fqdns: a single FQDN may have multiple caps (one per
 * app that wants it); we only probe it once. The first app whose cap
 * matches wins; the rest can claim later via /api/url/claim.
 */
export async function runBootProbe(args: BootProbeArgs): Promise<ProbeOutcome[]> {
  const all = await args.capabilityStore.list();
  const seen = new Set<string>();
  const fqdns: string[] = [];
  for (const stored of all) {
    if (stored.capability.siblingId !== args.myServerId) continue;
    const fqdn = stored.capability.fqdn.toLowerCase();
    if (seen.has(fqdn)) continue;
    seen.add(fqdn);
    fqdns.push(fqdn);
  }
  const outcomes = await Promise.all(
    fqdns.map((fqdn) => probeOne(fqdn, args)),
  );
  for (const o of outcomes) args.onProbe?.(o);
  return outcomes;
}

async function probeOne(fqdn: string, args: BootProbeArgs): Promise<ProbeOutcome> {
  try {
    const { connection } = await openSiblingConnection({
      peerFqdn: fqdn,
      // peerServerId unknown — alias FQDNs route to whoever holds them.
      // Handshake binds it on first hello.
      myServerId: args.myServerId,
      myStk: args.myStk,
      lookupPeerStk: args.lookupPeerStk,
      router: args.router,
      liveSiblings: args.liveSiblings,
      scheme: args.scheme,
      path: args.path,
      connectTimeoutMs: args.connectTimeoutMs ?? 5_000,
    });
    const peerServerId = connection.getPeerServerId();
    if (!peerServerId) {
      // Handshake completed with no bound peer — defensive; shouldn't happen.
      connection.close();
      return { fqdn, result: "error", message: "handshake bound no peer" };
    }
    // The FQDN is held — register the peer in the router (the
    // wsClient's onReady hook would normally do this; we set it
    // explicitly here too in case the caller didn't pass one).
    args.router.setSibling({
      siblingId: peerServerId,
      fqdns: [fqdn],
      online: true,
      transport: null,
    });
    return { fqdn, result: "incumbent", peerServerId };
  } catch (e) {
    // Connection or handshake failed → treat as vacant and claim.
    try {
      await args.urlController.claim(fqdn);
      return { fqdn, result: "claimed" };
    } catch (claimErr) {
      const msg = claimErr instanceof Error ? claimErr.message : String(claimErr);
      return { fqdn, result: "error", message: msg };
    }
    void e;
  }
}
