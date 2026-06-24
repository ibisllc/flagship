/**
 * Direct lead-read from a box.
 *
 * GET https://<podFqdn>/api/leads  (unauthenticated, CORS-enabled — same
 * surface as /api/services which the front-page picker already reads).
 *
 * Response contract (built in parallel with the box endpoint):
 *   { asOf: <ms>, self: "<fqdn>", gossipActive: <bool>,
 *     leads: { "<slug>": { leaderFqdn: "<fqdn>", leaderStkHex: "<hex>", live: <bool> } } }
 *
 * Returns the parsed leads map on success, or null when:
 *   - the box is not reachable (network error)
 *   - the endpoint doesn't exist yet (404 — un-burned box)
 *   - gossipActive is false (gossip not running; stale data would be misleading)
 *   - any other non-2xx response
 *
 * Best-effort only — callers must handle null and fall back to the relay.
 *
 * @param {string} podFqdn  lower-cased FQDN (e.g. "home.alice.flagship.services")
 * @param {{ fetch?: typeof fetch }} [deps]
 * @returns {Promise<Record<string, { leaderFqdn: string, leaderStkHex: string, live: boolean }> | null>}
 */
export async function fetchLeads(podFqdn, deps = {}) {
  if (!podFqdn || typeof podFqdn !== "string") return null;
  const f = deps.fetch || fetch;
  try {
    const r = await f(`https://${podFqdn}/api/leads`);
    if (!r.ok) return null; // 404 (un-burned box), 5xx, etc.
    const body = await r.json();
    // Reject if gossip isn't running — the data isn't live enough to prefer
    // over the relay's ~5-min snapshot.
    if (!body || body.gossipActive !== true) return null;
    const leads = body.leads;
    if (!leads || typeof leads !== "object") return null;
    return leads;
  } catch {
    // Network error / CORS / JSON parse failure — all treated as "not reachable".
    return null;
  }
}

/**
 * Invert the global leads map from the box's /api/leads response into the
 * same per-pod model that the relay uses: for each pod FQDN, the set of
 * service slugs it currently leads.
 *
 * Box gives:  { "<slug>": { leaderFqdn: "<fqdn>", … }, … }
 * UI reads:   pod.leadsServices = ["<slug>", ...]   (via leadsOf())
 *
 * So we invert: slug → leaderFqdn becomes leaderFqdn → [slug, ...].
 *
 * @param {Record<string, { leaderFqdn: string, leaderStkHex: string, live: boolean }>} leadsMap
 * @returns {Map<string, string[]>}  lower-cased FQDN → sorted slug[]
 */
export function invertLeadsMap(leadsMap) {
  /** @type {Map<string, string[]>} */
  const out = new Map();
  if (!leadsMap || typeof leadsMap !== "object") return out;
  for (const [slug, entry] of Object.entries(leadsMap)) {
    const slugStr = String(slug ?? "").trim();
    if (!slugStr) continue;
    const fqdn = String(entry?.leaderFqdn ?? "").toLowerCase().trim();
    if (!fqdn) continue;
    if (!out.has(fqdn)) out.set(fqdn, []);
    out.get(fqdn).push(slugStr);
  }
  // Sort each pod's slug list for determinism (consistent with how relay data
  // surfaces — order shouldn't matter for the pill but helps tests).
  for (const [fqdn, slugs] of out) {
    out.set(fqdn, slugs.slice().sort());
  }
  return out;
}
