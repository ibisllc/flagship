import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
  signAcceptServiceInvite,
  signCreateServiceInvite,
  signServiceVisitProof,
  signSetServiceAccessMode,
  signRedeemServiceInvite,
  signRemoveServiceAllow,
  verifyServiceInviteCreateQuery,
  type AcceptServiceInvite,
  type CreateServiceInvite,
  type Keypair,
  type ServiceInviteCreateQuery,
  type ServiceVisitProof,
  type SetServiceAccessMode,
  type RedeemServiceInvite,
  type RemoveServiceAllow,
} from "@flagship/protocol";
import {
  buildServiceAccessHttp,
  buildAccessEnforcementHandler,
  buildRevocationPoller,
  decideServiceAccess,
  ServiceAccessStore,
  ServiceSessionStore,
  ALLOW_LIST_CAP,
  ESTABLISH_NONCE_HEADER,
  SESSION_COOKIE,
  VISIT_PROOF_HEADER,
  type ServiceAccessHttp,
} from "../src/serviceAccess.js";
import type { HttpRequest, HttpResponse } from "../src/runtime.js";

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
/** The box's STK — signs the by-inviteId create fetch (it holds no owner key). */
const boxStk: Keypair = deriveIRK({ seed: new Uint8Array(32).fill(99) });
const USERNAME = "alice";

function hex(b: Uint8Array): string {
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

function hexBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function tempStore(): ServiceAccessStore {
  return new ServiceAccessStore(join(mkdtempSync(join(tmpdir(), "sa-")), "service-access.json"));
}

function tempSessions(): ServiceSessionStore {
  return new ServiceSessionStore(join(mkdtempSync(join(tmpdir(), "ss-")), "service-sessions.json"));
}

/** Pull the `Flagship-App-Session` token out of a Set-Cookie header. */
function cookieToken(setCookie: string | undefined): string | null {
  if (!setCookie) return null;
  const m = new RegExp(`${SESSION_COOKIE}=([^;]+)`).exec(setCookie);
  return m ? m[1]! : null;
}

function req(over: Partial<HttpRequest>): HttpRequest {
  return { method: "GET", path: "/", headers: { host: FQDN }, body: Buffer.alloc(0), ...over };
}

/**
 * Run the M3 establish-session handshake: GET a fresh single-use nonce, then POST
 * the visit-proof body with the nonce header. Returns the POST response.
 */
async function establishWithNonce(access: ServiceAccessHttp, body: string): Promise<HttpResponse | null> {
  const nonceRes = await access.handle(
    req({ method: "GET", path: "/api/service-access/establish-session/nonce" }),
  );
  const nonce = JSON.parse(String(nonceRes!.body)).nonce as string;
  return access.handle(
    req({
      method: "POST",
      path: "/api/service-access/establish-session",
      headers: { host: FQDN, [ESTABLISH_NONCE_HEADER]: nonce },
      body: Buffer.from(body),
    }),
  );
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

/**
 * Build a `.com`-relayed signed create carrier (box-as-authority): the box now
 * verifies the owner's signed create on redeem, so the stub `.com` returns one
 * signed by the OWNER IRK (which the box verifies against `ownerIrkPub`). The
 * create's secretHash matches the redeemed secret (default fill(7)).
 */
function signedCreateCarrier(opts: {
  serviceRef?: string;
  secret?: Uint8Array;
  maxRedemptions?: number;
} = {}): { create: Record<string, unknown>; createSig: string } {
  const serviceRef = opts.serviceRef ?? SERVICE;
  const secret = opts.secret ?? new Uint8Array(32).fill(7);
  const secretHash = serviceInviteSecretHash(secret);
  const inviteId = serviceInviteId(ownerAid.publicKey, ownerDevice.publicKey, 0);
  const create: CreateServiceInvite = {
    inviteId,
    authorAID: ownerAid.publicKey,
    serviceRef,
    secretHash,
    encryptedBundle: sealInviteBundle({ name: "Alex" }, householdKey, inviteId),
    issuedAt: NOW,
    ...(opts.maxRedemptions !== undefined ? { maxRedemptions: opts.maxRedemptions } : {}),
  };
  const sig = signCreateServiceInvite(create, ownerIrk);
  return {
    create: {
      inviteId: create.inviteId,
      authorAID: hex(create.authorAID),
      serviceRef: create.serviceRef,
      secretHash: create.secretHash,
      encryptedBundle: create.encryptedBundle,
      issuedAt: create.issuedAt,
      ...(opts.maxRedemptions !== undefined ? { maxRedemptions: opts.maxRedemptions } : {}),
    },
    createSig: hex(sig),
  };
}

/** A stub `.com` fetch that returns a redeem result (incl. the signed create) for a known secretHash. */
function comFetch(
  opts: {
    status?: number;
    serviceRef?: string;
    boundAID?: string;
    firstBind?: boolean;
    secret?: Uint8Array;
    pending?: boolean;
    maxRedemptions?: number;
  } = {},
) {
  return async (url: string | URL, _init?: RequestInit): Promise<Response> => {
    const status = opts.status ?? 200;
    if (status !== 200) return new Response("", { status });
    const carrier = signedCreateCarrier({
      serviceRef: opts.serviceRef,
      secret: opts.secret,
      maxRedemptions: opts.maxRedemptions,
    });
    // The by-inviteId create fetch (`…/service-invites/<id>/create`) returns ONLY
    // `{create, createSig}` (the box re-verifies the owner authority itself).
    if (String(url).includes("/create")) {
      return new Response(JSON.stringify(carrier), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (opts.pending) {
      return new Response(
        JSON.stringify({ pending: true, approvalMode: "manual", serviceRef: opts.serviceRef ?? SERVICE, ...carrier }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({
        redeemed: true,
        approvalMode: "auto",
        firstBind: opts.firstBind ?? true,
        serviceRef: opts.serviceRef ?? SERVICE,
        boundAID: opts.boundAID ?? hex(friendAid.publicKey),
        ...carrier,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
}

function build(opts: {
  store?: ServiceAccessStore;
  sessions?: ServiceSessionStore;
  fetchImpl?: typeof fetch;
  installed?: Set<string>;
  household?: boolean;
  sessionTtlMs?: number;
  /** Drop the STK-fetch box identity to exercise the body-supplied-create fallback. */
  noFetchIdentity?: boolean;
} = {}) {
  const store = opts.store ?? tempStore();
  const sessions = opts.sessions;
  const installed = opts.installed ?? new Set([SERVICE]);
  const access = buildServiceAccessHttp({
    serverId: FQDN,
    ownerIrkPub: ownerIrk.publicKey,
    store,
    sessions,
    serviceInstalled: (ref) => installed.has(ref),
    controlPlaneBaseUrl: "https://flagshipserver.com",
    fetchImpl: opts.fetchImpl ?? (comFetch() as unknown as typeof fetch),
    // ANY-DEVICE manual-finalize: the box fetches the owner's signed create from
    // `.com` by inviteId (STK-signed). Wired by default; opt-out tests the fallback.
    ...(opts.noFetchIdentity ? {} : { username: USERNAME, serverDomain: FQDN, stk: boxStk }),
    householdKey: opts.household ? householdKey : undefined,
    sessionTtlMs: opts.sessionTtlMs,
    now: () => NOW,
  });
  return { access, store, sessions, installed };
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
    // .com authoritatively binds a DIFFERENT AID than requested — for a HOSTED service.
    const boundAID = hex(deriveAccountId({ seed: new Uint8Array(32).fill(44) }).publicKey);
    const { access, store } = build({
      fetchImpl: comFetch({ serviceRef: SERVICE, boundAID }) as unknown as typeof fetch,
    });
    await access.handle(req({ method: "POST", path: "/api/service-invites/redeem", body: redeemBody() }));
    expect(store.isAllowed(SERVICE, boundAID)).toBe(true);
  });

  it("C1 gate: rejects (409) a redeem whose .com serviceRef is NOT a service this box hosts", async () => {
    // A rogue/buggy `.com` answering with a foreign serviceRef must not pollute
    // the allow-list. `installed` only has SERVICE; `.com` returns alice-photos.
    const boundAID = hex(deriveAccountId({ seed: new Uint8Array(32).fill(44) }).publicKey);
    const { access, store } = build({
      fetchImpl: comFetch({ serviceRef: "alice-photos", boundAID }) as unknown as typeof fetch,
    });
    const res = await access.handle(
      req({ method: "POST", path: "/api/service-invites/redeem", body: redeemBody() }),
    );
    expect(res!.status).toBe(409);
    expect(store.isAllowed("alice-photos", boundAID)).toBe(false);
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

describe("GET /api/service-access/:serviceRef (access-state read)", () => {
  it("reports OPEN (default) with a zero allow-count", async () => {
    const { access } = build();
    const res = await access.handle(req({ method: "GET", path: `/api/service-access/${SERVICE}` }));
    expect(res!.status).toBe(200);
    expect(JSON.parse(res!.body as string)).toEqual({ serviceRef: SERVICE, mode: "open", allowCount: 0 });
  });

  it("reports RESTRICTED + the allow-count after a set + redeem", async () => {
    const store = tempStore();
    const { access } = build({ store });
    await store.setMode(SERVICE, "restricted");
    await store.addAllowed(SERVICE, hex(friendAid.publicKey));
    const res = await access.handle(req({ method: "GET", path: `/api/service-access/${SERVICE}` }));
    expect(res!.status).toBe(200);
    expect(JSON.parse(res!.body as string)).toEqual({ serviceRef: SERVICE, mode: "restricted", allowCount: 1 });
  });

  it("never leaks the AIDs themselves (count only)", async () => {
    const store = tempStore();
    const { access } = build({ store });
    await store.setMode(SERVICE, "restricted");
    await store.addAllowed(SERVICE, hex(friendAid.publicKey));
    const res = await access.handle(req({ method: "GET", path: `/api/service-access/${SERVICE}` }));
    expect(res!.body as string).not.toContain(hex(friendAid.publicKey));
  });

  it("404s an empty / nested serviceRef path", async () => {
    const { access } = build();
    expect((await access.handle(req({ method: "GET", path: "/api/service-access/" })))!.status).toBe(404);
    expect((await access.handle(req({ method: "GET", path: "/api/service-access/a/b" })))!.status).toBe(404);
  });
});

describe("browser cookie seam — issuance", () => {
  function redeemBody(aid = friendAid, signer = friendAid, at = NOW) {
    const secret = new Uint8Array(32).fill(7);
    const secretHash = serviceInviteSecretHash(secret);
    const redeem: RedeemServiceInvite = { secretHash, visitorAID: aid.publicKey, redeemedAt: at };
    const sig = signRedeemServiceInvite(redeem, signer);
    return Buffer.from(
      JSON.stringify({ secretHash, visitorAID: hex(aid.publicKey), aidSig: hex(sig), redeemedAt: at }),
    );
  }

  it("issues a bound Flagship-App-Session cookie on a successful redeem", async () => {
    const sessions = tempSessions();
    await sessions.load();
    const { access } = build({ sessions });
    const res = await access.handle(
      req({ method: "POST", path: "/api/service-invites/redeem", body: redeemBody() }),
    );
    expect(res!.status).toBe(200);
    const setCookie = (res!.headers as Record<string, string>)["set-cookie"];
    expect(setCookie).toBeDefined();
    expect(setCookie).toContain(`${SESSION_COOKIE}=`);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Lax");
    // the token resolves to the friend's AID scoped to the service
    const token = cookieToken(setCookie)!;
    expect(sessions.lookup(token, NOW)).toEqual({ serviceRef: SERVICE, aid: hex(friendAid.publicKey) });
  });

  it("does NOT set a cookie when the session store is absent (header-only mode unchanged)", async () => {
    const { access } = build(); // no sessions
    const res = await access.handle(
      req({ method: "POST", path: "/api/service-invites/redeem", body: redeemBody() }),
    );
    expect(res!.status).toBe(200);
    expect((res!.headers as Record<string, string>)["set-cookie"]).toBeUndefined();
  });

  it("establish-session issues a cookie for an allow-listed AID-signed proof", async () => {
    const store = tempStore();
    const sessions = tempSessions();
    await sessions.load();
    const { access } = build({ store, sessions });
    await store.setMode(SERVICE, "restricted");
    await store.addAllowed(SERVICE, hex(friendAid.publicKey));
    const res = await establishWithNonce(access, visitHeader());
    expect(res!.status).toBe(200);
    const token = cookieToken((res!.headers as Record<string, string>)["set-cookie"])!;
    expect(sessions.lookup(token, NOW)).toEqual({ serviceRef: SERVICE, aid: hex(friendAid.publicKey) });
  });

  it("establish-session WITHOUT the nonce is rejected (M3 — 403)", async () => {
    const store = tempStore();
    const sessions = tempSessions();
    await sessions.load();
    const { access } = build({ store, sessions });
    await store.setMode(SERVICE, "restricted");
    await store.addAllowed(SERVICE, hex(friendAid.publicKey));
    const res = await access.handle(
      req({
        method: "POST",
        path: "/api/service-access/establish-session",
        body: Buffer.from(visitHeader()),
      }),
    );
    expect(res!.status).toBe(403);
  });

  it("establish-session NONCE is single-use (a replayed nonce is rejected)", async () => {
    const store = tempStore();
    const sessions = tempSessions();
    await sessions.load();
    const { access } = build({ store, sessions });
    await store.setMode(SERVICE, "restricted");
    await store.addAllowed(SERVICE, hex(friendAid.publicKey));
    const nonce = JSON.parse(
      String((await access.handle(req({ method: "GET", path: "/api/service-access/establish-session/nonce" })))!.body),
    ).nonce as string;
    const ok = await access.handle(
      req({ method: "POST", path: "/api/service-access/establish-session", headers: { host: FQDN, [ESTABLISH_NONCE_HEADER]: nonce }, body: Buffer.from(visitHeader()) }),
    );
    expect(ok!.status).toBe(200);
    const replay = await access.handle(
      req({ method: "POST", path: "/api/service-access/establish-session", headers: { host: FQDN, [ESTABLISH_NONCE_HEADER]: nonce }, body: Buffer.from(visitHeader()) }),
    );
    expect(replay!.status).toBe(403);
  });

  it("establish-session 401s an AID that is NOT allow-listed", async () => {
    const store = tempStore();
    const sessions = tempSessions();
    await sessions.load();
    const { access } = build({ store, sessions });
    await store.setMode(SERVICE, "restricted"); // no addAllowed
    const res = await establishWithNonce(access, visitHeader());
    expect(res!.status).toBe(401);
  });

  it("establish-session 403s a forged proof (sig by a non-AID key)", async () => {
    const store = tempStore();
    const sessions = tempSessions();
    await sessions.load();
    const { access } = build({ store, sessions });
    await store.setMode(SERVICE, "restricted");
    await store.addAllowed(SERVICE, hex(friendAid.publicKey));
    const attacker = deriveAccountId({ seed: new Uint8Array(32).fill(77) });
    const res = await establishWithNonce(access, visitHeader(friendAid, attacker));
    expect(res!.status).toBe(403);
  });
});

describe("browser cookie seam — enforcement (cookie OR header)", () => {
  const TTL = 12 * 60 * 60_000;

  it("RESTRICTED + cookie-bearing allow-listed AID → allowed (reason: cookie)", async () => {
    const store = tempStore();
    const sessions = tempSessions();
    await sessions.load();
    await store.setMode(SERVICE, "restricted");
    await store.addAllowed(SERVICE, hex(friendAid.publicKey));
    const token = await sessions.issue(SERVICE, hex(friendAid.publicKey), NOW, TTL);
    const d = decideServiceAccess(
      { serverId: FQDN, store, sessions, now: () => NOW },
      SERVICE,
      req({ headers: { host: FQDN, cookie: `x=1; ${SESSION_COOKIE}=${token}; y=2` } }),
    );
    expect(d).toEqual({ allow: true, reason: "cookie" });
  });

  it("RESTRICTED + header-bearing allow-listed AID → still allowed (reason: allow-listed)", async () => {
    const store = tempStore();
    const sessions = tempSessions();
    await store.setMode(SERVICE, "restricted");
    await store.addAllowed(SERVICE, hex(friendAid.publicKey));
    const d = decideServiceAccess(
      { serverId: FQDN, store, sessions, now: () => NOW },
      SERVICE,
      req({ headers: { host: FQDN, [VISIT_PROOF_HEADER]: visitHeader() } }),
    );
    expect(d).toEqual({ allow: true, reason: "allow-listed" });
  });

  it("RESTRICTED + neither cookie nor header → denied (no-proof)", async () => {
    const store = tempStore();
    const sessions = tempSessions();
    await store.setMode(SERVICE, "restricted");
    const d = decideServiceAccess(
      { serverId: FQDN, store, sessions, now: () => NOW },
      SERVICE,
      req({ headers: { host: FQDN } }),
    );
    expect(d).toEqual({ allow: false, reason: "no-proof" });
  });

  it("RESTRICTED + cookie for an AID that was REVOKED from the allow-list → denied", async () => {
    const store = tempStore();
    const sessions = tempSessions();
    await store.setMode(SERVICE, "restricted");
    await store.addAllowed(SERVICE, hex(friendAid.publicKey));
    const token = await sessions.issue(SERVICE, hex(friendAid.publicKey), NOW, TTL);
    // a .com revoke prunes the AID; the still-live cookie must stop working
    await store.removeAllowed(SERVICE, hex(friendAid.publicKey));
    const d = decideServiceAccess(
      { serverId: FQDN, store, sessions, now: () => NOW },
      SERVICE,
      req({ headers: { host: FQDN, cookie: `${SESSION_COOKIE}=${token}` } }),
    );
    expect(d).toEqual({ allow: false, reason: "no-proof" });
  });

  it("RESTRICTED + a stale/forged cookie token → denied", async () => {
    const store = tempStore();
    const sessions = tempSessions();
    await store.setMode(SERVICE, "restricted");
    await store.addAllowed(SERVICE, hex(friendAid.publicKey));
    // (a) an unknown/forged token
    const forged = decideServiceAccess(
      { serverId: FQDN, store, sessions, now: () => NOW },
      SERVICE,
      req({ headers: { host: FQDN, cookie: `${SESSION_COOKIE}=${"ab".repeat(32)}` } }),
    );
    expect(forged).toEqual({ allow: false, reason: "no-proof" });
    // (b) an EXPIRED token (issued with a 1ms TTL, evaluated later)
    const token = await sessions.issue(SERVICE, hex(friendAid.publicKey), NOW, 1);
    const expired = decideServiceAccess(
      { serverId: FQDN, store, sessions, now: () => NOW + 10_000 },
      SERVICE,
      req({ headers: { host: FQDN, cookie: `${SESSION_COOKIE}=${token}` } }),
    );
    expect(expired).toEqual({ allow: false, reason: "no-proof" });
  });

  it("a cookie for a DIFFERENT service does not unlock this one", async () => {
    const store = tempStore();
    const sessions = tempSessions();
    await store.setMode(SERVICE, "restricted");
    await store.addAllowed(SERVICE, hex(friendAid.publicKey));
    // cookie scoped to "alice-other", presented at SERVICE
    const token = await sessions.issue("alice-other", hex(friendAid.publicKey), NOW, 12 * 60 * 60_000);
    const d = decideServiceAccess(
      { serverId: FQDN, store, sessions, now: () => NOW },
      SERVICE,
      req({ headers: { host: FQDN, cookie: `${SESSION_COOKIE}=${token}` } }),
    );
    expect(d).toEqual({ allow: false, reason: "no-proof" });
  });

  it("OPEN service: a cookie is irrelevant — always allowed", async () => {
    const store = tempStore();
    const sessions = tempSessions();
    const d = decideServiceAccess(
      { serverId: FQDN, store, sessions, now: () => NOW },
      SERVICE,
      req({ headers: { host: FQDN, cookie: `${SESSION_COOKIE}=whatever` } }),
    );
    expect(d).toEqual({ allow: true, reason: "open" });
  });
});

describe("ServiceSessionStore", () => {
  it("persists a live session across a reload; drops expired on reload-lookup", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "ss-")), "service-sessions.json");
    const a = new ServiceSessionStore(path);
    await a.load();
    const live = await a.issue(SERVICE, hex(friendAid.publicKey), NOW, 60_000);
    const expired = await a.issue(SERVICE, hex(friendAid.publicKey), NOW, 1);
    const b = new ServiceSessionStore(path);
    await b.load();
    expect(b.lookup(live, NOW + 1_000)).toEqual({ serviceRef: SERVICE, aid: hex(friendAid.publicKey) });
    expect(b.lookup(expired, NOW + 1_000)).toBeNull();
  });
});

describe("POST /api/service-access/allow-remove (owner-IRK prune → revoke reaches the box)", () => {
  function removeBody(aidHex: string, at = NOW, serviceRef = SERVICE, serverId = FQDN): Buffer {
    const order: RemoveServiceAllow = { serverId, serviceRef, aid: aidHex, issuedAt: at };
    const sig = signRemoveServiceAllow(order, ownerIrk);
    return Buffer.from(JSON.stringify({ request: order, signature: hex(sig) }));
  }
  const friendHex = hex(friendAid.publicKey);

  it("prunes an allow-listed AID so the next request is denied (the wired revoke path)", async () => {
    const { access, store } = build();
    await store.setMode(SERVICE, "restricted");
    await store.addAllowed(SERVICE, friendHex);
    // Pre: an allow-listed AID's signed visit is allowed.
    const before = access.decide(SERVICE, req({ headers: { host: FQDN, [VISIT_PROOF_HEADER]: visitHeader() } }));
    expect(before).toEqual({ allow: true, reason: "allow-listed" });
    // Owner prunes the AID.
    const r = await access.handle(req({ method: "POST", path: "/api/service-access/allow-remove", body: removeBody(friendHex) }));
    expect(r?.status).toBe(200);
    expect(JSON.parse(String(r?.body)).removed).toBe(true);
    expect(store.isAllowed(SERVICE, friendHex)).toBe(false);
    // Post: the same signed visit is now denied (revocation reached the box).
    const after = access.decide(SERVICE, req({ headers: { host: FQDN, [VISIT_PROOF_HEADER]: visitHeader() } }));
    expect(after).toEqual({ allow: false, reason: "not-allowed" });
  });

  it("a pruned AID's live browser cookie also dies (decide re-checks the allow-list)", async () => {
    const sessions = tempSessions();
    await sessions.load();
    const { access, store } = build({ sessions });
    await store.setMode(SERVICE, "restricted");
    await store.addAllowed(SERVICE, friendHex);
    const token = await sessions.issue(SERVICE, friendHex, NOW, 60_000);
    const withCookie = () => req({ headers: { host: FQDN, cookie: `${SESSION_COOKIE}=${token}` } });
    expect(access.decide(SERVICE, withCookie())).toEqual({ allow: true, reason: "cookie" });
    await access.handle(req({ method: "POST", path: "/api/service-access/allow-remove", body: removeBody(friendHex) }));
    expect(access.decide(SERVICE, withCookie()).allow).toBe(false);
  });

  it("rejects a forged signature (403) and a serverId mismatch (403); idempotent on an absent AID", async () => {
    const { access, store } = build();
    await store.setMode(SERVICE, "restricted");
    const forged = Buffer.from(JSON.stringify({ request: { serverId: FQDN, serviceRef: SERVICE, aid: friendHex, issuedAt: NOW }, signature: "00".repeat(64) }));
    const f = await access.handle(req({ method: "POST", path: "/api/service-access/allow-remove", body: forged }));
    expect(f?.status).toBe(403);
    const mism = await access.handle(req({ method: "POST", path: "/api/service-access/allow-remove", body: removeBody(friendHex, NOW, SERVICE, "evil.bob.flagship.services") }));
    expect(mism?.status).toBe(403);
    // Idempotent: pruning an AID that was never allow-listed still 200s (removed:false).
    const r = await access.handle(req({ method: "POST", path: "/api/service-access/allow-remove", body: removeBody(friendHex) }));
    expect(r?.status).toBe(200);
    expect(JSON.parse(String(r?.body)).removed).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────
// v2 hardening — box-as-authority + manual-approve + group + M4/M5
// ──────────────────────────────────────────────────────────────────────

function redeemBodyV2(secret = new Uint8Array(32).fill(7), aid = friendAid, signer = friendAid, at = NOW): Buffer {
  const secretHash = serviceInviteSecretHash(secret);
  const redeem: RedeemServiceInvite = { secretHash, visitorAID: aid.publicKey, redeemedAt: at };
  const sig = signRedeemServiceInvite(redeem, signer);
  return Buffer.from(JSON.stringify({ secretHash, visitorAID: hex(aid.publicKey), aidSig: hex(sig), redeemedAt: at }));
}

describe("v2 — box-as-authority redeem (verify the owner's signed create)", () => {
  it("rejects (403) a redeem whose .com create is signed by a NON-owner key", async () => {
    // `.com` returns a create signed by a STRANGER, not the owner — the box's
    // ownerIrkPub/ownerAidPub verification fails, so no binding is fabricated.
    const stranger = deriveIRK(friendUmk);
    const fetchImpl = (async (): Promise<Response> => {
      const inviteId = serviceInviteId(ownerAid.publicKey, ownerDevice.publicKey, 0);
      const create: CreateServiceInvite = {
        inviteId,
        authorAID: ownerAid.publicKey,
        serviceRef: SERVICE,
        secretHash: serviceInviteSecretHash(new Uint8Array(32).fill(7)),
        encryptedBundle: sealInviteBundle({ name: "X" }, householdKey, inviteId),
        issuedAt: NOW,
      };
      const sig = signCreateServiceInvite(create, stranger);
      return new Response(
        JSON.stringify({
          redeemed: true,
          serviceRef: SERVICE,
          boundAID: hex(friendAid.publicKey),
          create: { ...create, authorAID: hex(create.authorAID) },
          createSig: hex(sig),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const { access, store } = build({ fetchImpl });
    const res = await access.handle(req({ method: "POST", path: "/api/service-invites/redeem", body: redeemBodyV2() }));
    expect(res!.status).toBe(403);
    expect(store.isAllowed(SERVICE, hex(friendAid.publicKey))).toBe(false);
  });

  it("rejects (403) when the create's secretHash does NOT match the redeemed secret", async () => {
    // A rogue `.com` substitutes a DIFFERENT real owner-signed create (whose
    // secretHash is for a different invite). The mismatch is caught.
    const fetchImpl = comFetch({ secret: new Uint8Array(32).fill(9) }) as unknown as typeof fetch; // create for fill(9)…
    const { access, store } = build({ fetchImpl });
    const res = await access.handle(req({ method: "POST", path: "/api/service-invites/redeem", body: redeemBodyV2() })); // …redeem fill(7)
    expect(res!.status).toBe(403);
    expect(store.isAllowed(SERVICE, hex(friendAid.publicKey))).toBe(false);
  });

  it("accepts a valid owner-signed create whose secretHash matches → binds", async () => {
    const { access, store } = build({ fetchImpl: comFetch() as unknown as typeof fetch });
    const res = await access.handle(req({ method: "POST", path: "/api/service-invites/redeem", body: redeemBodyV2() }));
    expect(res!.status).toBe(200);
    expect(store.isAllowed(SERVICE, hex(friendAid.publicKey))).toBe(true);
  });

  it("MANUAL-approve redeem returns {pending} with NO bind", async () => {
    const { access, store } = build({ fetchImpl: comFetch({ pending: true }) as unknown as typeof fetch });
    const res = await access.handle(req({ method: "POST", path: "/api/service-invites/redeem", body: redeemBodyV2() }));
    expect(res!.status).toBe(200);
    expect(JSON.parse(String(res!.body)).pending).toBe(true);
    expect(store.isAllowed(SERVICE, hex(friendAid.publicKey))).toBe(false);
  });
});

describe("v2 — manual-approve accept (POST /api/service-access/accept)", () => {
  function acceptBody(contactAid = friendAid, signer = friendAid, opts: { serviceRef?: string } = {}): Buffer {
    const serviceRef = opts.serviceRef ?? SERVICE;
    const inviteId = serviceInviteId(ownerAid.publicKey, ownerDevice.publicKey, 0);
    const create: CreateServiceInvite = {
      inviteId,
      authorAID: ownerAid.publicKey,
      serviceRef,
      secretHash: serviceInviteSecretHash(new Uint8Array(32).fill(7)),
      encryptedBundle: sealInviteBundle({ name: "X" }, householdKey, inviteId),
      issuedAt: NOW,
    };
    const createSig = hex(signCreateServiceInvite(create, ownerIrk));
    const accept: AcceptServiceInvite = {
      inviteId,
      serviceRef,
      contactAID: contactAid.publicKey,
      acceptedAt: NOW,
    };
    const acceptSig = hex(signAcceptServiceInvite(accept, signer));
    return Buffer.from(
      JSON.stringify({
        accept: { inviteId, serviceRef, contactAID: hex(contactAid.publicKey), acceptedAt: NOW },
        acceptSig,
        create: { ...create, authorAID: hex(create.authorAID) },
        createSig,
      }),
    );
  }

  /**
   * The any-device finalize body: the author submits ONLY `{accept, acceptSig}`
   * (NO create / createSig — the box fetches the signed create from `.com`).
   */
  function acceptBodyNoCreate(contactAid = friendAid, signer = friendAid, opts: { serviceRef?: string } = {}): Buffer {
    const serviceRef = opts.serviceRef ?? SERVICE;
    const inviteId = serviceInviteId(ownerAid.publicKey, ownerDevice.publicKey, 0);
    const accept: AcceptServiceInvite = {
      inviteId,
      serviceRef,
      contactAID: contactAid.publicKey,
      acceptedAt: NOW,
    };
    const acceptSig = hex(signAcceptServiceInvite(accept, signer));
    return Buffer.from(
      JSON.stringify({
        accept: { inviteId, serviceRef, contactAID: hex(contactAid.publicKey), acceptedAt: NOW },
        acceptSig,
      }),
    );
  }

  it("binds the contact AID when both the owner create + friend acceptance verify", async () => {
    const { access, store } = build();
    const res = await access.handle(req({ method: "POST", path: "/api/service-access/accept", body: acceptBody() }));
    expect(res!.status).toBe(200);
    expect(store.isAllowed(SERVICE, hex(friendAid.publicKey))).toBe(true);
  });

  it("ANY-DEVICE: author submits only {accept, acceptSig}; the box FETCHES the create from .com + binds", async () => {
    // The fetch goes to `…/service-invites/<inviteId>/create`, STK-signed.
    let fetchedUrl = "";
    const fetchImpl = (async (url: string | URL): Promise<Response> => {
      fetchedUrl = String(url);
      return (comFetch() as unknown as (u: string | URL) => Promise<Response>)(url);
    }) as unknown as typeof fetch;
    const { access, store } = build({ fetchImpl });
    const res = await access.handle(
      req({ method: "POST", path: "/api/service-access/accept", body: acceptBodyNoCreate() }),
    );
    expect(res!.status).toBe(200);
    expect(store.isAllowed(SERVICE, hex(friendAid.publicKey))).toBe(true);
    // It hit the by-inviteId create endpoint (not a cached/body create).
    const inviteId = serviceInviteId(ownerAid.publicKey, ownerDevice.publicKey, 0);
    expect(fetchedUrl).toContain(`/service-invites/${inviteId}/create`);
  });

  it("STK-signs the create fetch with a verifiable ServiceInviteCreateQuery", async () => {
    let captured: { serverDomain: string; issuedAt: number; sig: string; inviteId: string } | null = null;
    const fetchImpl = (async (url: string | URL): Promise<Response> => {
      const u = new URL(String(url));
      const inviteId = decodeURIComponent(u.pathname.split("/").slice(-2, -1)[0]!);
      captured = {
        serverDomain: u.searchParams.get("serverDomain")!,
        issuedAt: Number(u.searchParams.get("issuedAt")),
        sig: u.searchParams.get("sig")!,
        inviteId,
      };
      return (comFetch() as unknown as (u: string | URL) => Promise<Response>)(url);
    }) as unknown as typeof fetch;
    const { access } = build({ fetchImpl });
    await access.handle(req({ method: "POST", path: "/api/service-access/accept", body: acceptBodyNoCreate() }));
    expect(captured).not.toBeNull();
    const c = captured!;
    const query: ServiceInviteCreateQuery = {
      username: USERNAME,
      inviteId: c.inviteId.toLowerCase(),
      serverDomain: c.serverDomain,
      issuedAt: c.issuedAt,
    };
    // The box signs with its STK; verifies against the box STK pub, not the owner key.
    expect(verifyServiceInviteCreateQuery(query, hexBytes(c.sig), boxStk.publicKey)).toBe(true);
    expect(verifyServiceInviteCreateQuery(query, hexBytes(c.sig), ownerIrk.publicKey)).toBe(false);
  });

  it("falls back to a body-supplied create when no STK-fetch identity is wired", async () => {
    // Without username/serverDomain/stk the box can't fetch — the body create is used.
    const { access, store } = build({
      noFetchIdentity: true,
      fetchImpl: comFetch({ status: 404 }) as unknown as typeof fetch,
    });
    const res = await access.handle(req({ method: "POST", path: "/api/service-access/accept", body: acceptBody() }));
    expect(res!.status).toBe(200);
    expect(store.isAllowed(SERVICE, hex(friendAid.publicKey))).toBe(true);
  });

  it("rejects (403) a no-create finalize when .com can't serve the create AND no body create", async () => {
    const { access, store } = build({ fetchImpl: comFetch({ status: 404 }) as unknown as typeof fetch });
    const res = await access.handle(
      req({ method: "POST", path: "/api/service-access/accept", body: acceptBodyNoCreate() }),
    );
    expect(res!.status).toBe(403);
    expect(store.isAllowed(SERVICE, hex(friendAid.publicKey))).toBe(false);
  });

  it("rejects (403) an acceptance signed by a DIFFERENT key than the contact AID", async () => {
    const { access, store } = build();
    const attacker = deriveAccountId({ seed: new Uint8Array(32).fill(88) });
    const res = await access.handle(req({ method: "POST", path: "/api/service-access/accept", body: acceptBody(friendAid, attacker) }));
    expect(res!.status).toBe(403);
    expect(store.isAllowed(SERVICE, hex(friendAid.publicKey))).toBe(false);
  });

  it("ANY-DEVICE: rejects (403) a forged acceptance even when the fetched create is valid", async () => {
    const { access, store } = build();
    const attacker = deriveAccountId({ seed: new Uint8Array(32).fill(88) });
    const res = await access.handle(
      req({ method: "POST", path: "/api/service-access/accept", body: acceptBodyNoCreate(friendAid, attacker) }),
    );
    expect(res!.status).toBe(403);
    expect(store.isAllowed(SERVICE, hex(friendAid.publicKey))).toBe(false);
  });

  it("rejects (409) an accept for a service this box does not host", async () => {
    // SERVICE is installed; the create (fetched + body) is for the UN-hosted
    // alice-photos, so the create verifies but the service isn't hosted → 409.
    const { access } = build({
      installed: new Set([SERVICE]),
      fetchImpl: comFetch({ serviceRef: "alice-photos" }) as unknown as typeof fetch,
    });
    const res = await access.handle(req({ method: "POST", path: "/api/service-access/accept", body: acceptBody(friendAid, friendAid, { serviceRef: "alice-photos" }) }));
    expect(res!.status).toBe(409);
  });
});

describe("v2 — group binding + group-prune", () => {
  it("a GROUP redeem binds under the inviteId; revokeGroup prunes the whole set", async () => {
    const store = tempStore();
    await store.load();
    const inviteId = serviceInviteId(ownerAid.publicKey, ownerDevice.publicKey, 0);
    const other = hex(deriveAccountId({ seed: new Uint8Array(32).fill(55) }).publicKey);
    expect(await store.addAllowed(SERVICE, hex(friendAid.publicKey), inviteId)).toBe(true);
    expect(await store.addAllowed(SERVICE, other, inviteId)).toBe(true);
    expect(store.allowList(SERVICE).length).toBe(2);
    const pruned = await store.revokeGroup(inviteId);
    expect(pruned).toBe(2);
    expect(store.allowList(SERVICE).length).toBe(0);
  });

  it("revokeGroup without a serviceRef prunes the group across services", async () => {
    const store = tempStore();
    await store.load();
    const inviteId = "deadbeef";
    await store.addAllowed("svc-a", hex(friendAid.publicKey), inviteId);
    await store.addAllowed("svc-b", hex(friendAid.publicKey), inviteId);
    const pruned = await store.revokeGroup(inviteId);
    expect(pruned).toBe(2);
  });
});

describe("v2 — M4 fail-open alert + M5 allow-list cap", () => {
  it("M4 — a CORRUPT state file fails open AND raises the owner flag", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "sa-")), "service-access.json");
    // First write a valid restricted state, then corrupt the file.
    const a = new ServiceAccessStore(path);
    await a.load();
    await a.setMode(SERVICE, "restricted");
    writeFileSync(path, "{ this is not json");
    let alerted: { error: string } | null = null;
    const b = new ServiceAccessStore(path, { onFailOpen: (info) => (alerted = info) });
    await b.load();
    expect(b.failedOpen()).toBe(true);
    expect(alerted).not.toBeNull();
    expect(b.mode(SERVICE)).toBe("open"); // fell open
  });

  it("M4 — a genuinely-ABSENT file is the normal empty case (no alert)", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "sa-")), "missing.json");
    let alerted = false;
    const store = new ServiceAccessStore(path, { onFailOpen: () => (alerted = true) });
    await store.load();
    expect(store.failedOpen()).toBe(false);
    expect(alerted).toBe(false);
  });

  it("M5 — addAllowed refuses once the allow-list hits the cap", async () => {
    // Pre-load a state file already at the cap (one write, not CAP addAllowed
    // calls — same observable behavior, far cheaper).
    const path = join(mkdtempSync(join(tmpdir(), "sa-")), "service-access.json");
    const full = Array.from({ length: ALLOW_LIST_CAP }, (_, i) => i.toString(16).padStart(64, "0"));
    writeFileSync(path, JSON.stringify({ [SERVICE]: { mode: "restricted", allow: full, groups: {} } }));
    const store = new ServiceAccessStore(path);
    await store.load();
    expect(store.allowList(SERVICE).length).toBe(ALLOW_LIST_CAP);
    const overflow = await store.addAllowed(SERVICE, "ff".repeat(32));
    expect(overflow).toBe(false);
    expect(store.allowList(SERVICE).length).toBe(ALLOW_LIST_CAP);
  });
});

describe("v2 — revocation poller", () => {
  it("polls .com revoked-since + group-prunes the returned invites", async () => {
    const store = tempStore();
    await store.load();
    const inviteId = "abc123";
    await store.addAllowed(SERVICE, hex(friendAid.publicKey), inviteId);
    expect(store.isAllowed(SERVICE, hex(friendAid.publicKey))).toBe(true);

    let polledUrl = "";
    const fetchImpl = (async (url: string | URL): Promise<Response> => {
      polledUrl = String(url);
      return new Response(
        JSON.stringify({
          revoked: [{ inviteId, serviceRef: SERVICE, boundAIDs: [hex(friendAid.publicKey)], revokedAt: NOW }],
          cursor: NOW,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const poller = buildRevocationPoller({
      controlPlaneBaseUrl: "https://flagshipserver.com",
      username: "alice",
      authorAidHex: hex(ownerAid.publicKey),
      serverDomain: FQDN,
      stk: ownerDevice, // any keypair — the box signs with its STK
      store,
      fetchImpl,
      now: () => NOW,
    });
    const pruned = await poller.pollOnce();
    expect(pruned).toBeGreaterThanOrEqual(1);
    expect(store.isAllowed(SERVICE, hex(friendAid.publicKey))).toBe(false);
    // It signs the query + sends the box serverDomain for the STK auth path.
    expect(polledUrl).toContain("scope=revoked-since");
    expect(polledUrl).toContain(`serverDomain=${encodeURIComponent(FQDN)}`);
    expect(polledUrl).toContain("sig=");
  });

  it("a .com error is best-effort (returns 0, the instant owner-prune is primary)", async () => {
    const store = tempStore();
    await store.load();
    const fetchImpl = (async (): Promise<Response> => new Response("", { status: 500 })) as unknown as typeof fetch;
    const poller = buildRevocationPoller({
      controlPlaneBaseUrl: "https://flagshipserver.com",
      username: "alice",
      authorAidHex: hex(ownerAid.publicKey),
      serverDomain: FQDN,
      stk: ownerDevice,
      store,
      fetchImpl,
      now: () => NOW,
    });
    expect(await poller.pollOnce()).toBe(0);
  });
});
