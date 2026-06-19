import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  deriveAccountId,
  deriveHouseholdKey,
  deriveIRK,
  sealInviteBundle,
  serviceInviteId,
  serviceInviteSecretHash,
  signServiceVisitProof,
  signSetServiceAccessMode,
  signRedeemServiceInvite,
  type ServiceVisitProof,
  type SetServiceAccessMode,
  type RedeemServiceInvite,
} from "@flagship/protocol";
import {
  buildServiceAccessHttp,
  buildAccessEnforcementHandler,
  decideServiceAccess,
  ServiceAccessStore,
  VISIT_PROOF_HEADER,
} from "../src/serviceAccess.js";
import type { HttpRequest } from "../src/runtime.js";

const FQDN = "home.alice.flagship.services";
const NOW = 1_700_000_000_000;
const SERVICE = "alice-notes";

const ownerUmk = { seed: new Uint8Array(32).fill(11) };
const friendUmk = { seed: new Uint8Array(32).fill(22) };
const ownerIrk = deriveIRK(ownerUmk);
const ownerAid = deriveAccountId(ownerUmk);
const ownerDevice = deriveIRK(ownerUmk);
const friendAid = deriveAccountId(friendUmk);
const householdKey = deriveHouseholdKey(ownerUmk);

function hex(b: Uint8Array): string {
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

function tempStore(): ServiceAccessStore {
  return new ServiceAccessStore(join(mkdtempSync(join(tmpdir(), "sa-")), "service-access.json"));
}

function req(over: Partial<HttpRequest>): HttpRequest {
  return { method: "GET", path: "/", headers: { host: FQDN }, body: Buffer.alloc(0), ...over };
}

function setModeBody(mode: "open" | "restricted", at = NOW, serviceRef = SERVICE): Buffer {
  const order: SetServiceAccessMode = { serverId: FQDN, serviceRef, mode, issuedAt: at };
  const sig = signSetServiceAccessMode(order, ownerIrk);
  return Buffer.from(JSON.stringify({ request: order, signature: hex(sig) }));
}

function visitHeader(aidKeypair = friendAid, signer = friendAid, at = NOW, serviceRef = SERVICE): string {
  const proof: ServiceVisitProof = {
    serverId: FQDN,
    serviceRef,
    visitorAID: aidKeypair.publicKey,
    issuedAt: at,
  };
  const sig = signServiceVisitProof(proof, signer);
  return Buffer.from(
    JSON.stringify({
      proof: { ...proof, visitorAID: hex(proof.visitorAID) },
      sig: hex(sig),
    }),
  ).toString("base64");
}

/** A stub `.com` fetch that returns a redeem result for a known secretHash. */
function comFetch(opts: { status?: number; serviceRef?: string; boundAID?: string; firstBind?: boolean } = {}) {
  return async (_url: string | URL, _init?: RequestInit): Promise<Response> => {
    const status = opts.status ?? 200;
    if (status !== 200) return new Response("", { status });
    return new Response(
      JSON.stringify({
        redeemed: true,
        firstBind: opts.firstBind ?? true,
        serviceRef: opts.serviceRef ?? SERVICE,
        boundAID: opts.boundAID ?? hex(friendAid.publicKey),
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
}

function build(opts: {
  store?: ServiceAccessStore;
  fetchImpl?: typeof fetch;
  installed?: Set<string>;
  household?: boolean;
} = {}) {
  const store = opts.store ?? tempStore();
  const installed = opts.installed ?? new Set([SERVICE]);
  const access = buildServiceAccessHttp({
    serverId: FQDN,
    ownerIrkPub: ownerIrk.publicKey,
    store,
    serviceInstalled: (ref) => installed.has(ref),
    controlPlaneBaseUrl: "https://flagshipserver.com",
    fetchImpl: opts.fetchImpl ?? (comFetch() as unknown as typeof fetch),
    householdKey: opts.household ? householdKey : undefined,
    now: () => NOW,
  });
  return { access, store, installed };
}

describe("ServiceAccessStore", () => {
  it("defaults to open for a service with no row", () => {
    const store = tempStore();
    expect(store.mode("anything")).toBe("open");
    expect(store.isAllowed("anything", hex(friendAid.publicKey))).toBe(false);
  });

  it("persists mode + allow-list across a reload", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "sa-")), "service-access.json");
    const a = new ServiceAccessStore(path);
    await a.load();
    await a.setMode(SERVICE, "restricted");
    await a.addAllowed(SERVICE, hex(friendAid.publicKey));
    const b = new ServiceAccessStore(path);
    await b.load();
    expect(b.mode(SERVICE)).toBe("restricted");
    expect(b.isAllowed(SERVICE, hex(friendAid.publicKey))).toBe(true);
  });

  it("addAllowed is idempotent; removeAllowed drops the AID", async () => {
    const store = tempStore();
    expect(await store.addAllowed(SERVICE, hex(friendAid.publicKey))).toBe(true);
    expect(await store.addAllowed(SERVICE, hex(friendAid.publicKey))).toBe(false);
    expect(await store.removeAllowed(SERVICE, hex(friendAid.publicKey))).toBe(true);
    expect(store.isAllowed(SERVICE, hex(friendAid.publicKey))).toBe(false);
  });

  it("the on-disk file is mode-0600 JSON", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "sa-")), "service-access.json");
    const store = new ServiceAccessStore(path);
    await store.load();
    await store.setMode(SERVICE, "restricted");
    const raw = JSON.parse(readFileSync(path, "utf8"));
    expect(raw[SERVICE].mode).toBe("restricted");
  });
});

describe("set-mode endpoint (owner-IRK)", () => {
  it("flips a service to restricted with a valid signature", async () => {
    const { access, store } = build();
    const res = await access.handle(
      req({ method: "POST", path: "/api/service-access", body: setModeBody("restricted") }),
    );
    expect(res!.status).toBe(200);
    expect(store.mode(SERVICE)).toBe("restricted");
  });

  it("rejects a bad signature (403)", async () => {
    const { access } = build();
    const order: SetServiceAccessMode = { serverId: FQDN, serviceRef: SERVICE, mode: "restricted", issuedAt: NOW };
    const body = Buffer.from(JSON.stringify({ request: order, signature: "00".repeat(64) }));
    const res = await access.handle(req({ method: "POST", path: "/api/service-access", body }));
    expect(res!.status).toBe(403);
  });

  it("422 for an uninstalled service", async () => {
    const { access } = build({ installed: new Set() });
    const res = await access.handle(
      req({ method: "POST", path: "/api/service-access", body: setModeBody("restricted") }),
    );
    expect(res!.status).toBe(422);
  });

  it("rejects a stale request (403)", async () => {
    const { access } = build();
    const res = await access.handle(
      req({ method: "POST", path: "/api/service-access", body: setModeBody("restricted", NOW - 10 * 60_000) }),
    );
    expect(res!.status).toBe(403);
  });
});

describe("redeem endpoint (friend AID-signed → .com → allow-list)", () => {
  function redeemBody(aid = friendAid, signer = friendAid, at = NOW) {
    const secret = new Uint8Array(32).fill(7);
    const secretHash = serviceInviteSecretHash(secret);
    const redeem: RedeemServiceInvite = { secretHash, visitorAID: aid.publicKey, redeemedAt: at };
    const sig = signRedeemServiceInvite(redeem, signer);
    return Buffer.from(
      JSON.stringify({ secretHash, visitorAID: hex(aid.publicKey), aidSig: hex(sig), redeemedAt: at }),
    );
  }

  it("first redeem adds the friend's AID to the allow-list", async () => {
    const { access, store } = build();
    const res = await access.handle(
      req({ method: "POST", path: "/api/service-invites/redeem", body: redeemBody() }),
    );
    expect(res!.status).toBe(200);
    expect(JSON.parse(res!.body as string).firstBind).toBe(true);
    expect(store.isAllowed(SERVICE, hex(friendAid.publicKey))).toBe(true);
  });

  it("rejects a forged visitorAID (sig by a different key, 403) without calling .com", async () => {
    let comCalled = false;
    const fetchImpl = (async () => {
      comCalled = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const { access } = build({ fetchImpl });
    const attacker = deriveAccountId({ seed: new Uint8Array(32).fill(99) });
    // claim the friend's AID but sign with the attacker's
    const res = await access.handle(
      req({ method: "POST", path: "/api/service-invites/redeem", body: redeemBody(friendAid, attacker) }),
    );
    expect(res!.status).toBe(403);
    expect(comCalled).toBe(false);
  });

  it("propagates a .com 409 (already bound to another account)", async () => {
    const { access } = build({ fetchImpl: comFetch({ status: 409 }) as unknown as typeof fetch });
    const res = await access.handle(
      req({ method: "POST", path: "/api/service-invites/redeem", body: redeemBody() }),
    );
    expect(res!.status).toBe(409);
  });

  it("propagates a .com 403 (revoked)", async () => {
    const { access, store } = build({ fetchImpl: comFetch({ status: 403 }) as unknown as typeof fetch });
    const res = await access.handle(
      req({ method: "POST", path: "/api/service-invites/redeem", body: redeemBody() }),
    );
    expect(res!.status).toBe(403);
    expect(store.isAllowed(SERVICE, hex(friendAid.publicKey))).toBe(false);
  });

  it("adds the AID .com bound (not the request's claim) to the allow-list", async () => {
    // .com authoritatively binds a DIFFERENT serviceRef/AID than requested.
    const boundAID = hex(deriveAccountId({ seed: new Uint8Array(32).fill(44) }).publicKey);
    const { access, store } = build({
      fetchImpl: comFetch({ serviceRef: "alice-photos", boundAID }) as unknown as typeof fetch,
    });
    await access.handle(req({ method: "POST", path: "/api/service-invites/redeem", body: redeemBody() }));
    expect(store.isAllowed("alice-photos", boundAID)).toBe(true);
  });
});

describe("serve-path enforcement (decide)", () => {
  it("OPEN service: always allowed (no proof needed)", () => {
    const store = tempStore();
    const decision = decideServiceAccess({ serverId: FQDN, store, now: () => NOW }, SERVICE, req({}));
    expect(decision).toEqual({ allow: true, reason: "open" });
  });

  it("RESTRICTED + no proof → denied (no-proof)", async () => {
    const store = tempStore();
    await store.setMode(SERVICE, "restricted");
    const d = decideServiceAccess({ serverId: FQDN, store, now: () => NOW }, SERVICE, req({}));
    expect(d).toEqual({ allow: false, reason: "no-proof" });
  });

  it("RESTRICTED + valid allow-listed proof → allowed", async () => {
    const store = tempStore();
    await store.setMode(SERVICE, "restricted");
    await store.addAllowed(SERVICE, hex(friendAid.publicKey));
    const d = decideServiceAccess(
      { serverId: FQDN, store, now: () => NOW },
      SERVICE,
      req({ headers: { host: FQDN, [VISIT_PROOF_HEADER]: visitHeader() } }),
    );
    expect(d).toEqual({ allow: true, reason: "allow-listed" });
  });

  it("RESTRICTED + valid proof but NOT allow-listed → not-allowed", async () => {
    const store = tempStore();
    await store.setMode(SERVICE, "restricted");
    const d = decideServiceAccess(
      { serverId: FQDN, store, now: () => NOW },
      SERVICE,
      req({ headers: { host: FQDN, [VISIT_PROOF_HEADER]: visitHeader() } }),
    );
    expect(d).toEqual({ allow: false, reason: "not-allowed" });
  });

  it("RESTRICTED + forged proof (sig by a non-AID key) → bad-proof", async () => {
    const store = tempStore();
    await store.setMode(SERVICE, "restricted");
    await store.addAllowed(SERVICE, hex(friendAid.publicKey));
    const attacker = deriveAccountId({ seed: new Uint8Array(32).fill(88) });
    // claim friend's AID, sign with attacker → verify fails
    const d = decideServiceAccess(
      { serverId: FQDN, store, now: () => NOW },
      SERVICE,
      req({ headers: { host: FQDN, [VISIT_PROOF_HEADER]: visitHeader(friendAid, attacker) } }),
    );
    expect(d).toEqual({ allow: false, reason: "bad-proof" });
  });

  it("RESTRICTED + stale proof → stale-proof", async () => {
    const store = tempStore();
    await store.setMode(SERVICE, "restricted");
    await store.addAllowed(SERVICE, hex(friendAid.publicKey));
    const d = decideServiceAccess(
      { serverId: FQDN, store, now: () => NOW },
      SERVICE,
      req({ headers: { host: FQDN, [VISIT_PROOF_HEADER]: visitHeader(friendAid, friendAid, NOW - 10 * 60_000) } }),
    );
    expect(d).toEqual({ allow: false, reason: "stale-proof" });
  });

  it("RESTRICTED + proof for a DIFFERENT serviceRef → bad-proof", async () => {
    const store = tempStore();
    await store.setMode(SERVICE, "restricted");
    await store.addAllowed(SERVICE, hex(friendAid.publicKey));
    const d = decideServiceAccess(
      { serverId: FQDN, store, now: () => NOW },
      SERVICE,
      req({ headers: { host: FQDN, [VISIT_PROOF_HEADER]: visitHeader(friendAid, friendAid, NOW, "alice-other") } }),
    );
    expect(d).toEqual({ allow: false, reason: "bad-proof" });
  });
});

describe("enforcement handler (label → serviceRef)", () => {
  const resolve = (req: HttpRequest): string | null => {
    const host = (req.headers.host ?? "").split(":")[0]!.toLowerCase();
    const suffix = `.${FQDN.toLowerCase()}`;
    if (!host.endsWith(suffix) || host.length === suffix.length) return null;
    const label = host.slice(0, host.length - suffix.length);
    if (label.includes(".")) return null;
    // map url-label "notes" → service "alice-notes"
    return label === "notes" ? SERVICE : null;
  };

  it("falls through (null) for an OPEN service", async () => {
    const { access } = build();
    const handler = buildAccessEnforcementHandler(access, resolve);
    const res = await handler(req({ headers: { host: `notes.${FQDN}` } }));
    expect(res).toBeNull();
  });

  it("403s a RESTRICTED service with no proof", async () => {
    const { access, store } = build();
    await store.setMode(SERVICE, "restricted");
    const handler = buildAccessEnforcementHandler(access, resolve);
    const res = await handler(req({ headers: { host: `notes.${FQDN}` } }));
    expect(res!.status).toBe(403);
    expect(JSON.parse(res!.body as string).reason).toBe("no-proof");
  });

  it("falls through for an unrecognized host (not a service label)", async () => {
    const { access } = build();
    const handler = buildAccessEnforcementHandler(access, resolve);
    const res = await handler(req({ headers: { host: FQDN } })); // apex, no label
    expect(res).toBeNull();
  });
});

describe("end-to-end: restrict → redeem → reach → revoke → denied", () => {
  it("a redeemed friend reaches a restricted service; after a .com revoke they don't", async () => {
    const store = tempStore();
    const { access } = build({ store });

    // owner restricts
    await access.handle(req({ method: "POST", path: "/api/service-access", body: setModeBody("restricted") }));
    expect(store.mode(SERVICE)).toBe("restricted");

    // friend redeems (allow-list gets the AID)
    const secret = new Uint8Array(32).fill(7);
    const secretHash = serviceInviteSecretHash(secret);
    const redeem: RedeemServiceInvite = { secretHash, visitorAID: friendAid.publicKey, redeemedAt: NOW };
    const sig = signRedeemServiceInvite(redeem, friendAid);
    await access.handle(
      req({
        method: "POST",
        path: "/api/service-invites/redeem",
        body: Buffer.from(
          JSON.stringify({ secretHash, visitorAID: hex(friendAid.publicKey), aidSig: hex(sig), redeemedAt: NOW }),
        ),
      }),
    );

    // friend reaches it
    const reach = access.decide(
      SERVICE,
      req({ headers: { host: FQDN, [VISIT_PROOF_HEADER]: visitHeader() } }),
    );
    expect(reach.allow).toBe(true);

    // a .com revoke is reflected by removing the AID from the box allow-list
    await store.removeAllowed(SERVICE, hex(friendAid.publicKey));
    const after = access.decide(
      SERVICE,
      req({ headers: { host: FQDN, [VISIT_PROOF_HEADER]: visitHeader() } }),
    );
    expect(after).toEqual({ allow: false, reason: "not-allowed" });
  });
});

describe("household-key bundle decrypt", () => {
  const inviteId = serviceInviteId(ownerAid.publicKey, ownerDevice.publicKey, 0);

  it("decrypts the bundle when the household key is provisioned", () => {
    const { access } = build({ household: true });
    const sealed = sealInviteBundle({ name: "Alex", photo: "p" }, householdKey, inviteId);
    expect(access.decryptBundle(sealed, inviteId)).toEqual({ name: "Alex", photo: "p" });
  });

  it("returns null when no household key is provisioned", () => {
    const { access } = build({ household: false });
    const sealed = sealInviteBundle({ name: "Alex" }, householdKey, inviteId);
    expect(access.decryptBundle(sealed, inviteId)).toBeNull();
  });

  it("returns null on a bundle for the wrong inviteId", () => {
    const { access } = build({ household: true });
    const sealed = sealInviteBundle({ name: "Alex" }, householdKey, inviteId);
    const other = serviceInviteId(ownerAid.publicKey, ownerDevice.publicKey, 1);
    expect(access.decryptBundle(sealed, other)).toBeNull();
  });
});
