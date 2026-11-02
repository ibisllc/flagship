/**
 * Wires the box's relay-mesh state (relayMesh.ts) into the tunnel supervisor (relay-mesh.md §9): the CA keys come from
 * the box's own checkout (the maintainer chain anchored at the baked pin, as for share acceptance), the directory from
 * the public feed, signatures from the custodian (keyd purpose `flagship/relay-attachment/v1`), and moves and refused
 * hints become Activity entries.
 */
import { join } from "node:path";
import { relayMeshCaKeys, type Bytes } from "@flagship/protocol";
import { caTrustChainFromFolder } from "../releaseVerifier.js";
import { servicesApexOf } from "../relayTrustVerifier.js";
import { trustedNow } from "../trustedClock.js";
import {
  RELAY_MOVED_KIND,
  RELAY_MOVE_REFUSED_KIND,
  RelayMeshBox,
  movedLine,
  refusedLine,
  relayFeedBaseUrl,
  type HintRefusal,
} from "./relayMesh.js";
import type { SupervisorMeshOptions, TunnelMeshOptions } from "./tunnelClient.js";

/** A refused hint is written to Activity at most once an hour per reason, so a noisy relay can't flood it. */
export const REFUSED_NOTE_INTERVAL_MS = 60 * 60_000;

export interface RelayMeshWiringOptions {
  dataDir: string;
  serverFqdn: string;
  controlPlaneBaseUrl: string;
  boxPub: string;
  regGen: () => number;
  sign: (msg: Bytes) => Bytes | Promise<Bytes>;
  note: (kind: string, detail: string, ok: boolean) => void;
  /** Test seams. */
  caKeys?: () => Promise<readonly string[]>;
  fetchDirectory?: () => Promise<unknown>;
  fetchImpl?: typeof fetch;
  now?: () => number;
  log?: (m: string) => void;
}

export interface RelayMeshWiring {
  box: RelayMeshBox;
  client: TunnelMeshOptions;
  supervisor: SupervisorMeshOptions;
}

export async function buildRelayMeshBox(o: RelayMeshWiringOptions): Promise<RelayMeshWiring> {
  const now = o.now ?? trustedNow;
  const log = o.log ?? ((m: string) => console.log(m));
  const feed = relayFeedBaseUrl(o.controlPlaneBaseUrl);
  const fetchImpl = o.fetchImpl ?? fetch;
  const box = new RelayMeshBox({
    serverFqdn: o.serverFqdn.toLowerCase(),
    servicesApex: servicesApexOf(o.serverFqdn),
    boxPub: o.boxPub,
    regGen: o.regGen,
    sign: o.sign,
    caKeys:
      o.caKeys ??
      (async () => relayMeshCaKeys(caTrustChainFromFolder({ gitRepoPath: process.env.FLAGSHIP_SELF_REPO ?? "/opt/flagship" }), now())),
    fetchDirectory:
      o.fetchDirectory ??
      (async () => {
        const r = await fetchImpl(`${feed}/directory.json`, { signal: AbortSignal.timeout(15_000) });
        if (!r.ok) throw new Error(`directory.json answered ${r.status}`);
        return r.json();
      }),
    statePath: join(o.dataDir, "relay-mesh.json"),
    now,
    log,
  });
  await box.load();
  const lastRefusedNote = new Map<string, number>();
  const client: TunnelMeshOptions = {
    verifyAck: (e) => box.verifyAck(e),
    signAttachment: (relay, attachedAt) => box.signAttachment(relay, attachedAt),
    log,
  };
  const supervisor: SupervisorMeshOptions = {
    checkHint: async (p, current) => {
      const r = await box.checkHint(p, current);
      return r.ok ? { ok: true, target: r.target } : { ok: false, reason: r.reason, toRelayId: r.toRelayId };
    },
    checkRelay: (current) => box.checkRelay(current),
    recordMove: (reason) => box.recordMove(reason),
    recordFailed: (relayId) => box.recordFailed(relayId),
    onMoved: (e) => {
      const line = movedLine(e.from, e.to ?? "", e.reason, e.why);
      log(`[relay-mesh] ${line}`);
      o.note(RELAY_MOVED_KIND, line, true);
    },
    onRefused: (e) => {
      const line = refusedLine(e.from, e.to, e.reason as HintRefusal | "dial-failed");
      log(`[relay-mesh] ${line} (${e.reason})`);
      const t = now();
      const last = lastRefusedNote.get(e.reason);
      if (last !== undefined && t - last < REFUSED_NOTE_INTERVAL_MS) return;
      lastRefusedNote.set(e.reason, t);
      o.note(RELAY_MOVE_REFUSED_KIND, line, false);
    },
  };
  return { box, client, supervisor };
}
