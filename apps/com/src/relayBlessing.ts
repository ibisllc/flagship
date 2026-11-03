/**
 * `POST /api/services/relay-blessing` (docs/architecture-v2/relay-mesh.md §3.2): a relay proves it holds its key and
 * gets a short-lived RelayBlessing (30 days), the ServiceBlessing old boxes still check, and its sealed mesh keys.
 *
 *   relay → {relayId, relayKey, servicesApex, issuedAt, signature}
 *           signature = the relay key over flagship/relay-blessing-request/v1|<relayId>|<relayKey>|<servicesApex>|<issuedAt>
 *   .com  → {relayBlessing, serviceBlessing, meshKeys}
 *
 * The request carries nothing else (no stats, no box list): it is the relay's only call to `.com` (owner decision
 * 2026-11-01). It is answered only for an admitted, unretired relay under its current key (or its staged next key, which
 * the request then promotes), and never for the current key once its owner-set deadline has passed (forced rotation).
 */
import { caKeypairFromEnv, type CaIssuer } from "@flagship/control-plane";
import {
  checkRelayBlessingRequest,
  relayTunnelHost,
  signRelayBlessing,
  signServiceBlessing,
  type RelayBlessing,
  type RelayBlessingRequest,
} from "@flagship/protocol";
import { mintRelayDirectory, publishDirectory, relayRow, type RelayDirectoryEnv } from "./relayDirectory.js";
import { meshKeysFor, currentMeshEpoch, FEED_CACHE, FEED_OBJECTS, feedPut, resealMeshKeys, rotateMeshEpoch, servicesApexOf } from "./relayFeed.js";
import { pokeServingFeed } from "./servingAuthority.js";

export const RELAY_BLESSING_PATH = "/api/services/relay-blessing";

/**
 * How long a relay blessing `.com` mints lives (owner decision 2026-11-01: short-lived, about 30 days, renewed only
 * with proof of the key). Relays renew daily (RELAY_BLESSING_RENEW_MS) so a refused renewal is noticed long before
 * the blessing ends.
 */
export const RELAY_BLESSING_COM_TTL_MS = 30 * 24 * 60 * 60_000;
export const RELAY_BLESSING_RENEW_MS = 24 * 60 * 60_000;

const SENTENCES = {
  "relay-blessing-malformed": "This blessing request could not be read.",
  "relay-blessing-wrong-apex": "This request is for another services apex.",
  "relay-blessing-stale": "This relay's clock is more than a minute off. Fix its time and try again.",
  "relay-blessing-signature": "This request is not signed by the key it names.",
  "relay-not-admitted": "This relay is not admitted, or was retired.",
  "relay-key-unknown": "This key is not the relay's admitted key.",
  "relay-key-rotation-required": "This relay's key had to be replaced by its deadline. Stage a new key and restart the relay with it.",
  "relay-blessing-not-configured": "Relay blessings aren't available right now.",
} as const;
type Code = keyof typeof SENTENCES;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "private, no-store" } });
}
const refuse = (status: number, code: Code): Response => json({ error: SENTENCES[code], code }, status);

function randomHex(bytes: number): string {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export async function handleRelayBlessing(
  request: Request,
  env: RelayDirectoryEnv,
  deps: { now?: () => number; ca?: CaIssuer; waitUntil?: (p: Promise<unknown>) => void } = {},
): Promise<Response> {
  if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
  const db = env.DB;
  if (!db) return refuse(503, "relay-blessing-not-configured");
  const now = (deps.now ?? Date.now)();
  const apex = servicesApexOf(env);
  let body: Record<string, unknown> | null;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    body = null;
  }
  if (!body || typeof body !== "object") return refuse(400, "relay-blessing-malformed");
  const req = { relayId: body.relayId, relayKey: body.relayKey, servicesApex: body.servicesApex, issuedAt: body.issuedAt } as RelayBlessingRequest;
  const check = checkRelayBlessingRequest(req, typeof body.signature === "string" ? body.signature : "", apex, now);
  if (!check.ok) {
    const code: Code =
      check.reason === "malformed" ? "relay-blessing-malformed" : check.reason === "wrong-apex" ? "relay-blessing-wrong-apex" : check.reason === "stale" ? "relay-blessing-stale" : "relay-blessing-signature";
    return refuse(check.reason === "bad-signature" ? 401 : 400, code);
  }
  let row = await relayRow(db, req.relayId);
  if (!row || row.retired_at != null) return refuse(403, "relay-not-admitted");
  const ca = deps.ca ?? caKeypairFromEnv({ FLAGSHIP_CA_PRIV_HEX: env.FLAGSHIP_CA_PRIV_HEX, FLAGSHIP_CA_ISSUER: env.FLAGSHIP_CA_ISSUER });
  let promoted = false;
  if (req.relayKey === row.next_relay_key) {
    // The staged key proved itself: it replaces the old one (new directory version; the old key's blessing is no
    // longer the directory's key, so peers refuse it at once). A new mesh-key epoch, sealed only to current keys,
    // keeps whoever holds the old key from reading anything written from now on (as retiring a relay does).
    const r = await db
      .prepare(
        "UPDATE relays SET relay_key = next_relay_key, next_relay_key = NULL, key_deadline = NULL, blessing_json = NULL, mesh_keys_json = NULL " +
          "WHERE relay_id = ? AND next_relay_key = ? AND retired_at IS NULL",
      )
      .bind(row.relay_id, req.relayKey)
      .run();
    if (!r.meta?.changes) return refuse(409, "relay-key-unknown");
    if (env.RELAY_MESH_KEY_SEED) {
      await rotateMeshEpoch(db, `promote key ${row.relay_id}`, now);
      await resealMeshKeys(env, db, now);
    }
    row = (await relayRow(db, req.relayId))!;
    promoted = true;
  } else if (req.relayKey !== row.relay_key) {
    return refuse(403, "relay-key-unknown");
  } else if (row.key_deadline != null && now > row.key_deadline) {
    return refuse(403, "relay-key-rotation-required");
  }

  const expiresAt = now + RELAY_BLESSING_COM_TTL_MS;
  const relayBlessing: RelayBlessing = signRelayBlessing(
    {
      relayId: row.relay_id,
      relayKey: row.relay_key,
      servicesApex: apex,
      tunnelHost: relayTunnelHost(row.relay_id, apex),
      relayKind: row.kind,
      nonce: randomHex(16),
      issuedAt: now,
      expiresAt,
    },
    ca.keypair,
  );
  // Old boxes' observe-mode check reads a ServiceBlessing over the hub key: the relay key, for as long as the relay's.
  const serviceBlessing = signServiceBlessing({ hubKeyPub: row.relay_key, hubHost: apex, nonce: randomHex(16), issuedAt: now, expiresAt }, ca.keypair);

  let meshKeys: unknown = null;
  if (env.RELAY_MESH_KEY_SEED) {
    const epoch = await currentMeshEpoch(db);
    let doc = row.mesh_keys_json ? (JSON.parse(row.mesh_keys_json) as { current?: number; relayKey?: string }) : null;
    if (!doc || doc.current !== epoch || doc.relayKey !== row.relay_key) {
      doc = meshKeysFor(env.RELAY_MESH_KEY_SEED, apex, row.relay_id, row.relay_key, epoch);
      await db.prepare("UPDATE relays SET mesh_keys_json = ? WHERE relay_id = ? AND relay_key = ?").bind(JSON.stringify(doc), row.relay_id, row.relay_key).run();
      if (env.RELAY_FEED) await feedPut(env.RELAY_FEED, FEED_OBJECTS.keys(row.relay_id), doc, FEED_CACHE.keys);
    }
    meshKeys = doc;
  }

  await db
    .prepare("UPDATE relays SET blessing_json = ?, blessed_at = ? WHERE relay_id = ? AND relay_key = ?")
    .bind(JSON.stringify(relayBlessing), now, row.relay_id, row.relay_key)
    .run();
  // A promoted key is in the directory before the relay can use its blessing with peers.
  if (promoted) await mintRelayDirectory(env, db, ca, now);
  const publish = (async () => {
    await publishDirectory(env, db);
    if (promoted) await pokeServingFeed(env, { type: "relay-feed", ...(env.RELAY_MESH_KEY_SEED ? { force: "tail" as const } : {}) });
  })().catch((e) => console.error(JSON.stringify({ event: "relay-directory-publish-failed", error: String(e) })));
  if (deps.waitUntil) deps.waitUntil(publish);
  else await publish;
  return json({ relayBlessing, serviceBlessing, meshKeys });
}
