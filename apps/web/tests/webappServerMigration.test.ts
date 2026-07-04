// Webapp client for "Migrate to new hardware" (docs/server-migration.md).
//
// Four contracts pinned here:
//   1. MIRROR BYTES — the webapp's canonical order/control builders reproduce
//      the exact pinned strings from
//      packages/protocol/tests/serverMigrationVectors.test.ts, and signatures
//      over them verify under @flagship/protocol's own verifiers (the same
//      pair `.com` runs).
//   2. TAG ROUTING — both migration tags are SENSITIVE: with an admin root
//      present they sign under it (Slice D), while the co-signed mailbox
//      auth stays on the legacy IRK signer.
//   3. DEPOSIT SHAPES — start / confirm-ready / freeze / abort POST the wire
//      bodies `.com`'s handlers parse ({auth…, order|control, signature}),
//      freeze reusing the ServerDecommission order verbatim (final backup
//      forced, session-bound STK + disposition).
//   4. SWK CONTRACT — the migration's attached new box gets the SWK of the
//      MIGRATING serverDomain (DOTS derivation), an unattached live migration
//      DEFERS the deposit, and an unrelated pod derives normally.

import { describe, expect, it } from "vitest";
import {
  ed,
  verifyServerMigrationOrder,
  verifyServerMigrationControl,
  type ServerMigrationOrder,
  type ServerMigrationControl,
} from "@flagship/protocol";
import {
  TAG_SERVER_MIGRATION,
  TAG_SERVER_MIGRATION_CONTROL,
  canonicalMigrationOrderBytes,
  canonicalMigrationControlBytes,
  buildMigrationOrder,
  startMigration,
  fetchMigration,
  confirmMigrationReady,
  freezeMigration,
  abortMigration,
  migrationSwkServerId,
  migrationSteps,
  migrationWaitCopy,
  MIGRATION_DISPOSITIONS,
  PRESEED_STUCK_MS,
} from "../public/webapp/lib/serverMigration.js";
import { SENSITIVE_TAGS, makeSensitiveSigner } from "../public/webapp/lib/adminRoot.js";

const te = (s: string) => new TextEncoder().encode(s);
const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

function makeKey(seed: number) {
  const priv = new Uint8Array(32).fill(seed);
  return { privateKey: priv, publicKey: ed.getPublicKey(priv) };
}

// The EXACT pinned cross-platform strings from
// packages/protocol/tests/serverMigrationVectors.test.ts.
const ORDER = {
  serverDomain: "home.alice.flagship.services",
  oldStkPubHex: "aa".repeat(32),
  diskDisposition: "wipe-after-handoff",
  nonce: "deadbeef",
  issuedAt: 1700,
};
const ORDER_CANONICAL =
  "flagship/server-migration/v1|home.alice.flagship.services|" +
  "aa".repeat(32) +
  "|wipe-after-handoff|deadbeef|1700";

const CONTROL = {
  serverDomain: "home.alice.flagship.services",
  action: "abort",
  nonce: "0badcafe",
  issuedAt: 1800,
};
const CONTROL_CANONICAL =
  "flagship/server-migration-control/v1|home.alice.flagship.services|abort|0badcafe|1800";

describe("server-migration canonical bytes (webapp mirror)", () => {
  it("order bytes match the pinned cross-platform string", () => {
    expect(new TextDecoder().decode(canonicalMigrationOrderBytes(ORDER))).toBe(ORDER_CANONICAL);
  });

  it("control bytes match the pinned cross-platform string", () => {
    expect(new TextDecoder().decode(canonicalMigrationControlBytes(CONTROL))).toBe(
      CONTROL_CANONICAL,
    );
  });

  it("lowercases serverDomain + oldStk + nonce into the bytes", () => {
    const upper = {
      ...ORDER,
      serverDomain: "HOME.Alice.Flagship.Services",
      oldStkPubHex: "AA".repeat(32),
      nonce: "DEADBEEF",
    };
    expect(new TextDecoder().decode(canonicalMigrationOrderBytes(upper))).toBe(ORDER_CANONICAL);
  });

  it("a webapp-built signature verifies under @flagship/protocol's verifier", () => {
    const admin = makeKey(7);
    const sig = ed.sign(canonicalMigrationOrderBytes(ORDER), admin.privateKey);
    expect(
      verifyServerMigrationOrder(ORDER as ServerMigrationOrder, sig, admin.publicKey),
    ).toBe(true);
    const csig = ed.sign(canonicalMigrationControlBytes(CONTROL), admin.privateKey);
    expect(
      verifyServerMigrationControl(CONTROL as ServerMigrationControl, csig, admin.publicKey),
    ).toBe(true);
  });

  it("buildMigrationOrder mints a 32-byte nonce and lowercases the STK", () => {
    const o = buildMigrationOrder({
      serverDomain: "home.alice.flagship.services",
      oldStkPubHex: "AA".repeat(32),
      disposition: "keep",
      now: () => 1700,
    });
    expect(o.nonce).toMatch(/^[0-9a-f]{64}$/);
    expect(o.oldStkPubHex).toBe("aa".repeat(32));
    expect(o.issuedAt).toBe(1700);
  });

  it("migration dispositions exclude wipe-now (invariant 1)", () => {
    expect(MIGRATION_DISPOSITIONS).toEqual(["keep", "wipe-after-handoff"]);
  });
});

describe("server-migration tags are SENSITIVE (Slice D tag routing)", () => {
  it("both tags are in SENSITIVE_TAGS", () => {
    expect(SENSITIVE_TAGS.has(TAG_SERVER_MIGRATION)).toBe(true);
    expect(SENSITIVE_TAGS.has(TAG_SERVER_MIGRATION_CONTROL)).toBe(true);
  });

  it("order/control route to the admin root; mailbox auth stays legacy", async () => {
    const calls: string[] = [];
    const adminSeed = new Uint8Array(32).fill(1);
    const signer = makeSensitiveSigner(
      adminSeed,
      async () => {
        calls.push("legacy");
        return new Uint8Array(64);
      },
      {
        signWithAdminRoot: async () => {
          calls.push("admin");
          return new Uint8Array(64);
        },
      },
    );
    const umk = new Uint8Array(32);
    await signer(umk, te(ORDER_CANONICAL));
    await signer(umk, te(CONTROL_CANONICAL));
    await signer(umk, te("flagship/device-endpoint-claim/v1|alice|webapp|00|1|2|ff"));
    expect(calls).toEqual(["admin", "admin", "legacy"]);
  });
});

// A signer that routes exactly like production (tag-gated) but with real keys,
// so we can verify the wire signatures under the right pubkeys.
function realSigner(adminKey: ReturnType<typeof makeKey>, irkKey: ReturnType<typeof makeKey>) {
  return makeSensitiveSigner(
    adminKey.privateKey,
    async (_umk: Uint8Array, bytes: Uint8Array) => ed.sign(bytes, irkKey.privateKey),
    {
      signWithAdminRoot: async (_seed: Uint8Array, bytes: Uint8Array) =>
        ed.sign(bytes, adminKey.privateKey),
    },
  );
}

function captureFetch(responses: Record<string, unknown> = {}) {
  const calls: Array<{ url: string; body: any }> = [];
  const fetchImpl = async (url: string, init?: { body?: string }) => {
    calls.push({ url, body: init?.body ? JSON.parse(init.body) : null });
    return {
      ok: true,
      status: 200,
      json: async () => responses[url] ?? { ok: true },
    };
  };
  return { calls, fetchImpl };
}

const SERVER = "home.alice.flagship.services";
const ADMIN = makeKey(7);
const IRK = makeKey(9);
const baseArgs = () => ({
  serverDomain: SERVER,
  username: "alice",
  umk: new Uint8Array(32).fill(3),
  irkPubHex: toHex(IRK.publicKey),
  signWithIrk: realSigner(ADMIN, IRK),
});

describe("startMigration deposit", () => {
  it("POSTs {auth…, order, signature} with an admin-verifiable order + IRK mailbox auth", async () => {
    const { calls, fetchImpl } = captureFetch();
    const out = await startMigration(
      { ...baseArgs(), oldStkPubHex: "AA".repeat(32), disposition: "wipe-after-handoff" },
      { fetch: fetchImpl, origin: "https://c.example", now: () => 1700 },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`https://c.example/api/server/${SERVER}/migration`);
    const body = calls[0]!.body;
    // Wire shape `.com` parses: mailbox auth + order + signature.
    expect(body.auth.username).toBe("alice");
    expect(body.auth.endpointLabel).toBe("webapp");
    expect(body.authSignature).toMatch(/^[0-9a-f]{128}$/);
    expect(body.order.serverDomain).toBe(SERVER);
    expect(body.order.oldStkPubHex).toBe("aa".repeat(32));
    expect(body.order.diskDisposition).toBe("wipe-after-handoff");
    expect(body.order.nonce).toMatch(/^[0-9a-f]{64}$/);
    // The order verifies under the ADMIN root (tag-routed), not the IRK.
    const sig = Uint8Array.from(
      (body.signature as string).match(/../g)!.map((h: string) => parseInt(h, 16)),
    );
    expect(verifyServerMigrationOrder(body.order, sig, ADMIN.publicKey)).toBe(true);
    expect(verifyServerMigrationOrder(body.order, sig, IRK.publicKey)).toBe(false);
    expect(out.ok).toBe(true);
  });

  it("rejects a wipe-now disposition (never authorized by a migration)", async () => {
    await expect(
      startMigration(
        { ...baseArgs(), oldStkPubHex: "aa".repeat(32), disposition: "wipe-now" },
        { fetch: captureFetch().fetchImpl },
      ),
    ).rejects.toThrow(/disposition/);
  });
});

describe("confirm-ready / abort control deposits", () => {
  it("confirm-ready POSTs an admin-verifiable control body", async () => {
    const { calls, fetchImpl } = captureFetch();
    await confirmMigrationReady(baseArgs(), {
      fetch: fetchImpl,
      origin: "https://c.example",
      now: () => 1800,
    });
    expect(calls[0]!.url).toBe(`https://c.example/api/server/${SERVER}/migration/confirm-ready`);
    const body = calls[0]!.body;
    expect(body.control.action).toBe("confirm-ready");
    expect(body.control.nonce).toMatch(/^[0-9a-f]{64}$/);
    const sig = Uint8Array.from(
      (body.signature as string).match(/../g)!.map((h: string) => parseInt(h, 16)),
    );
    expect(verifyServerMigrationControl(body.control, sig, ADMIN.publicKey)).toBe(true);
  });

  it("abort POSTs to /migration/abort with action=abort", async () => {
    const { calls, fetchImpl } = captureFetch();
    await abortMigration(baseArgs(), { fetch: fetchImpl, origin: "https://c.example" });
    expect(calls[0]!.url).toBe(`https://c.example/api/server/${SERVER}/migration/abort`);
    expect(calls[0]!.body.control.action).toBe("abort");
  });
});

describe("freezeMigration — the decommission deposit, session-validated", () => {
  it("reuses the ServerDecommission order: session STK, final backup forced, matching disposition", async () => {
    const { calls, fetchImpl } = captureFetch();
    const session = {
      oldStkPubHex: "AA".repeat(32),
      disposition: "wipe-after-handoff",
    };
    await freezeMigration(
      { ...baseArgs(), session },
      { fetch: fetchImpl, origin: "https://c.example", now: () => 1900 },
    );
    expect(calls[0]!.url).toBe(`https://c.example/api/server/${SERVER}/migration/freeze`);
    const body = calls[0]!.body;
    expect(body.order.podCanonical).toBe(SERVER);
    expect(body.order.retiredStkPubHex).toBe("aa".repeat(32));
    expect(body.order.finalBackup).toBe(true); // the final delta IS the point
    expect(body.order.diskDisposition).toBe("wipe-after-handoff");
    expect(body.auth.username).toBe("alice");
    expect(body.signature).toMatch(/^[0-9a-f]{128}$/);
  });

  it("keep-disposition session freezes with finalBackup still true", async () => {
    const { calls, fetchImpl } = captureFetch();
    await freezeMigration(
      { ...baseArgs(), session: { oldStkPubHex: "bb".repeat(32), disposition: "keep" } },
      { fetch: fetchImpl, origin: "https://c.example" },
    );
    expect(calls[0]!.body.order.finalBackup).toBe(true);
    expect(calls[0]!.body.order.diskDisposition).toBe("keep");
  });
});

describe("fetchMigration", () => {
  it("returns null on 404 (no session), the body otherwise", async () => {
    const f404 = async () => ({ ok: false, status: 404, json: async () => ({}) });
    expect(await fetchMigration(SERVER, { fetch: f404 as any, origin: "https://c" })).toBeNull();
    const fOk = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ phase: "initiated" }),
    });
    expect(await fetchMigration(SERVER, { fetch: fOk as any, origin: "https://c" })).toEqual({
      phase: "initiated",
    });
  });
});

describe("SWK contract — migrationSwkServerId", () => {
  const MIGRATING = "home.alice.flagship.services";
  const NEWPOD = "attic.alice.flagship.services";

  it("the attached new box derives the MIGRATING domain's SWK", async () => {
    const out = await migrationSwkServerId(
      { podDomain: NEWPOD.toUpperCase(), holds: [MIGRATING] },
      {
        fetchSession: async () => ({ phase: "provisioned", newServerDomain: NEWPOD }),
      },
    );
    expect(out).toEqual({ serverId: MIGRATING });
  });

  it("a live-but-unattached migration DEFERS the deposit", async () => {
    const out = await migrationSwkServerId(
      { podDomain: NEWPOD, holds: [MIGRATING] },
      { fetchSession: async () => ({ phase: "initiated", newServerDomain: null }) },
    );
    expect(out).toEqual({ defer: true });
  });

  it("an unrelated pod (a different box attached) derives normally", async () => {
    const out = await migrationSwkServerId(
      { podDomain: "other.alice.flagship.services", holds: [MIGRATING] },
      {
        fetchSession: async () => ({ phase: "provisioned", newServerDomain: NEWPOD }),
      },
    );
    expect(out).toBeNull();
  });

  it("the migrating box itself and a no-holds account derive normally", async () => {
    expect(
      await migrationSwkServerId({ podDomain: MIGRATING, holds: [MIGRATING] }, {}),
    ).toBeNull();
    expect(await migrationSwkServerId({ podDomain: NEWPOD, holds: [] }, {})).toBeNull();
  });

  it("an unreachable .com defers (never risks a wrong-name SWK)", async () => {
    const out = await migrationSwkServerId(
      { podDomain: NEWPOD, holds: [MIGRATING] },
      {
        fetchSession: async () => {
          throw new Error("offline");
        },
      },
    );
    expect(out).toEqual({ defer: true });
  });
});

describe("timeline mapping (the spec's 8 steps)", () => {
  const base = {
    phase: "provisioned",
    initiatedAt: 1000,
    attachedAt: 2000,
    preSeededAt: null,
    readyAt: null,
    freezeAt: null,
    finalDeltaAt: null,
    takenOverAt: null,
    abortedAt: null,
    oldClosedOutAt: null,
    done: false,
  };

  it("stamps map to done/active/pending in order", () => {
    const steps = migrationSteps(base, 3000);
    expect(steps.map((s: any) => s.state)).toEqual([
      "done",
      "done",
      "active",
      "pending",
      "pending",
      "pending",
      "pending",
      "pending",
    ]);
  });

  it("aborted sessions show no active step", () => {
    const steps = migrationSteps({ ...base, abortedAt: 2500 }, 3000);
    expect(steps.some((s: any) => s.state === "active")).toBe(false);
  });

  it("surfaces the enable-backup hint when pre-seed is stuck", () => {
    const stuck = migrationWaitCopy(base, base.attachedAt + PRESEED_STUCK_MS + 1);
    expect(stuck).toMatch(/enable backup/i);
    const fresh = migrationWaitCopy(base, base.attachedAt + 1000);
    expect(fresh).not.toMatch(/enable backup/i);
  });

  it("abort copy is honest — the old server stays active with its data", () => {
    expect(migrationWaitCopy({ ...base, abortedAt: 1 }, 2)).toMatch(
      /old server stays active with all its data/i,
    );
  });
});
