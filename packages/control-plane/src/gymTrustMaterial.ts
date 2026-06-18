/**
 * ============================================================================
 *  GYM TEST ONLY — public throwaway key; NEVER prod.
 * ============================================================================
 *
 * The GYM (`gym.flagshipserver.com`) is a self-contained test universe. This
 * module is the gym's ENTIRE maintainer-trust ground truth, built on ONE
 * ed25519 key **K** that is BOTH:
 *
 *   - the gym maintainer AUTHORITY (the ca-track mandate's holder/successor), AND
 *   - the gym worker's CA key (the key `caKeypairFromEnv` mints attestations
 *     with, served as `caPubkey` from `GET /api/maintainer-blessing`).
 *
 * Because the gym is a test env, K is PUBLIC and committed here (both halves).
 * The gym apps therefore verify the REAL chain — no anchor bypass, no expiry
 * relaxation:
 *
 *     gym pin  →  K's self-signed root Mandate  →  currentAuthority = K
 *              →  K endorses K via a live CaEndorsement  →  that CA key (= K)
 *                 is exactly what the gym worker serves  →  trusted.
 *
 * This replaces the prior `GYM_TRUSTED_CA_PUBKEY` anchor-bypass hack in
 * `apps/web/public/webapp/lib/serverTrust.js` (deleted on this branch): the
 * real chain now verifies, so the bypass is dead.
 *
 * Everything is DETERMINISTIC: K is derived from a fixed seed and every
 * timestamp is fixed, so the committed material never drifts. Regenerate with
 *   node scripts/gen-gym-trust-material.mjs
 *
 * ── K (ed25519 keypair) ────────────────────────────────────────────────────
 *   K public  hex: 2e6585d75f992a0fc097e05ee6e11e8ccc31e229394d3aec238e68a81b7ba930
 *   K private hex: 6779796d7472757374746573746b6579676d7472757374746573746b65793030
 *   (seed = ASCII "gymtrusttestkeygmtrusttestkey001" truncated to 32 bytes)
 *
 * ── gym pin (mandatePinHash of the root Mandate = sha256hex(canonicalMandate)) ─
 *   87f5ae60cd1cfc0629fdf10ab97a547d33bca68bf3a1426614096a3054d57ae7
 *   This is the value baked into every gym app surface (the gym-branch
 *   MAINTAINER_PINNED_MANDATE_HASH / BAKED_PIN / Swift+Kotlin pinnedMandateHash).
 *
 * ── gym root Mandate JSON (self-signed by K; K is its own successor/authority) ─
 *   {
 *     "kind": "Mandate",
 *     "version": 1,
 *     "mandateId": "gym00000-0000-4000-8000-000000000001",
 *     "track": "ca",
 *     "holder": "2e6585d75f992a0fc097e05ee6e11e8ccc31e229394d3aec238e68a81b7ba930",
 *     "issuedAt": "2026-01-01T00:00:00.000Z",
 *     "expiresAt": "2125-01-01T00:00:00.000Z",
 *     "successors": ["2e6585d75f992a0fc097e05ee6e11e8ccc31e229394d3aec238e68a81b7ba930"],
 *     "approvalRule": { "kind": "threshold", "threshold": 1 },
 *     "minSuccessors": 1,
 *     "maxDurationSeconds": 4102444800,
 *     "defaultDurationSeconds": 8640000,
 *     "project": { "name": "flagship-gym", "contact": "gym@flagshipserver.com" },
 *     "signedBy": "2e6585d75f992a0fc097e05ee6e11e8ccc31e229394d3aec238e68a81b7ba930",
 *     "signatures": [{
 *       "pubkey": "2e6585d75f992a0fc097e05ee6e11e8ccc31e229394d3aec238e68a81b7ba930",
 *       "sig": "4726e40971dbdf57b3ffd5c0006d4afff6437debf529117fd943d9a7e611674622267f605978109b3362cb0191514cdfbd8d9554f802d58c0fdf310e7c6c3502"
 *     }]
 *   }
 *
 * ── 100-yr CaEndorsement JSON (K endorses K; live now) ──────────────────────
 *   {
 *     "kind": "CaEndorsement",
 *     "version": 1,
 *     "endorsementId": "gymca000-0000-4000-8000-000000000010",
 *     "track": "ca",
 *     "caPubkey": "2e6585d75f992a0fc097e05ee6e11e8ccc31e229394d3aec238e68a81b7ba930",
 *     "scope": "flagship/directory-attestation",
 *     "notBefore": "2024-01-01T00:00:00.000Z",
 *     "notAfter": "2124-01-01T00:00:00.000Z",
 *     "issuedAt": "2024-01-01T00:00:00.000Z",
 *     "signedBy": "2e6585d75f992a0fc097e05ee6e11e8ccc31e229394d3aec238e68a81b7ba930",
 *     "signatures": [{
 *       "pubkey": "2e6585d75f992a0fc097e05ee6e11e8ccc31e229394d3aec238e68a81b7ba930",
 *       "sig": "7bde114f964ff60554dcbcce4f859a71389a85683d711a10c41159cfd1c50c52d0d5850170e9387eea96740719970425b90d60fca051cebc0f243f118ea16904"
 *     }]
 *   }
 *
 * ── EXPIRED CaEndorsement JSON (both bounds in 2020 → authorizedCaKeys = [] now) ─
 *   {
 *     "kind": "CaEndorsement",
 *     "version": 1,
 *     "endorsementId": "gymca000-0000-4000-8000-00000000001f",
 *     "track": "ca",
 *     "caPubkey": "2e6585d75f992a0fc097e05ee6e11e8ccc31e229394d3aec238e68a81b7ba930",
 *     "scope": "flagship/directory-attestation",
 *     "notBefore": "2020-01-01T00:00:00.000Z",
 *     "notAfter": "2020-12-31T00:00:00.000Z",
 *     "issuedAt": "2020-01-01T00:00:00.000Z",
 *     "signedBy": "2e6585d75f992a0fc097e05ee6e11e8ccc31e229394d3aec238e68a81b7ba930",
 *     "signatures": [{
 *       "pubkey": "2e6585d75f992a0fc097e05ee6e11e8ccc31e229394d3aec238e68a81b7ba930",
 *       "sig": "b8534a555800eb04f61c8ff875c409b26e1247a985da562212f7905e494e0bf24409b497eb7f19d54e1aa89937372de35a15fb8890b77531ccbd6afd93904600"
 *     }]
 *   }
 * ============================================================================
 */

// Typed loosely (the control-plane package stays free of an
// `@ibisllc/maintainers` dependency in its public types — clients interpret).
export type GymMandate = Record<string, unknown>;
export type GymCaEndorsement = Record<string, unknown>;

/** K public hex — the gym maintainer authority AND the gym worker CA key. */
export const GYM_K_PUB =
  "2e6585d75f992a0fc097e05ee6e11e8ccc31e229394d3aec238e68a81b7ba930";

/** GYM pin = sha256hex(canonicalMandate(gym root Mandate)). Baked per surface. */
export const GYM_PIN =
  "87f5ae60cd1cfc0629fdf10ab97a547d33bca68bf3a1426614096a3054d57ae7";

/** The gym ca-track root Mandate (self-signed by K). */
export const GYM_ROOT_MANDATE: GymMandate = {
  kind: "Mandate",
  version: 1,
  mandateId: "gym00000-0000-4000-8000-000000000001",
  track: "ca",
  holder: GYM_K_PUB,
  issuedAt: "2026-01-01T00:00:00.000Z",
  expiresAt: "2125-01-01T00:00:00.000Z",
  successors: [GYM_K_PUB],
  approvalRule: { kind: "threshold", threshold: 1 },
  minSuccessors: 1,
  maxDurationSeconds: 4102444800,
  defaultDurationSeconds: 8640000,
  project: { name: "flagship-gym", contact: "gym@flagshipserver.com" },
  signedBy: GYM_K_PUB,
  signatures: [
    {
      pubkey: GYM_K_PUB,
      sig:
        "4726e40971dbdf57b3ffd5c0006d4afff6437debf529117fd943d9a7e611674622267f605978109b3362cb0191514cdfbd8d9554f802d58c0fdf310e7c6c3502",
    },
  ],
};

/** The 100-yr CaEndorsement — K endorses K, live now. */
export const GYM_LIVE_CA_ENDORSEMENT: GymCaEndorsement = {
  kind: "CaEndorsement",
  version: 1,
  endorsementId: "gymca000-0000-4000-8000-000000000010",
  track: "ca",
  caPubkey: GYM_K_PUB,
  scope: "flagship/directory-attestation",
  notBefore: "2024-01-01T00:00:00.000Z",
  notAfter: "2124-01-01T00:00:00.000Z",
  issuedAt: "2024-01-01T00:00:00.000Z",
  signedBy: GYM_K_PUB,
  signatures: [
    {
      pubkey: GYM_K_PUB,
      sig:
        "7bde114f964ff60554dcbcce4f859a71389a85683d711a10c41159cfd1c50c52d0d5850170e9387eea96740719970425b90d60fca051cebc0f243f118ea16904",
    },
  ],
};

/** An EXPIRED CaEndorsement (both bounds in 2020) — `authorizedCaKeys` = [] now. */
export const GYM_EXPIRED_CA_ENDORSEMENT: GymCaEndorsement = {
  kind: "CaEndorsement",
  version: 1,
  endorsementId: "gymca000-0000-4000-8000-00000000001f",
  track: "ca",
  caPubkey: GYM_K_PUB,
  scope: "flagship/directory-attestation",
  notBefore: "2020-01-01T00:00:00.000Z",
  notAfter: "2020-12-31T00:00:00.000Z",
  issuedAt: "2020-01-01T00:00:00.000Z",
  signedBy: GYM_K_PUB,
  signatures: [
    {
      pubkey: GYM_K_PUB,
      sig:
        "b8534a555800eb04f61c8ff875c409b26e1247a985da562212f7905e494e0bf24409b497eb7f19d54e1aa89937372de35a15fb8890b77531ccbd6afd93904600",
    },
  ],
};

/** The gym ca-track mandate log (oldest-first; one self-signed root). */
export const GYM_CA_TRACK_MANDATES: readonly GymMandate[] = [GYM_ROOT_MANDATE];

/** The gym committed CaEndorsement bundle (the live 100-yr lease). */
export const GYM_CA_ENDORSEMENTS: readonly GymCaEndorsement[] = [
  GYM_LIVE_CA_ENDORSEMENT,
];
