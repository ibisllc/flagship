/**
 * V01 adversarial integration: cross-account and cross-app identity linkage (owner rule "A visitor's
 * identity is per app", docs/service-access-gating.md "Per-app identity", docs/app-apis.md §5).
 *
 *   AT-LNK-01  per-app visitor key: unrelated across apps and accounts, same for every inviter of one app
 *   AT-LNK-02  app refs that could inject a separator or alias another derivation are refused
 *   AT-LNK-03  the stable id an app sees is per app, per box secret, and carries nothing of the key
 *   AT-LNK-04  the app proxy strips every client-supplied identity header and gives anonymous no id/rank
 *   AT-LNK-05  a cross-origin unsafe request carries no member identity (sibling-app CSRF)
 *   AT-LNK-06  one app's sign-in cookie is never a session in another app
 *   AT-LNK-07  the same member reaches two apps under two unrelated ids
 *   AT-LNK-08  visit and knock proofs are bound to server, app and page: no replay elsewhere
 *   AT-LNK-09  chat carrier: a frame for app A is refused at app B, replays and own-account frames refused
 *   AT-LNK-10  share acceptance: the key the joining account presents is per share and matches nothing .com serves by name
 */
import { describe, expect, it } from "vitest";
import {
  deriveAccountId,
  deriveAppAccountId,
  deriveContactAccountId,
  deriveIRK,
  deriveServiceMemberStableId,
  deriveServiceSecret,
  deriveShareAdminKey,
  ed,
  parseShareAcceptAdminProof,
  signServerShareAcceptAdmin,
  signShareKeyAttestationRequest,
  generateUMK,
  signChatWire,
  chatWireBodySha256,
  signKnockAuthorization,
  signServiceVisitProof,
  verifyKnockAuthorization,
  verifyServiceVisitProof,
  type KnockAuthorization,
  type ServiceVisitProof,
} from "../../../packages/protocol/src/index.js";
import { prepareAppRequest, type SessionInfo } from "../../../packages/server-daemon/src/serviceProxy.js";
import { buildAppSessionResolver } from "../../../packages/server-daemon/src/appMemberSession.js";
import { buildWireReceiver, chatAppHost, CHAT_WIRE_PATH } from "../../../packages/server-daemon/src/chat/wire.js";
import { boxSigner } from "../../../packages/server-daemon/tests/helpers/keyCustody.js";
import { handleUsernameLookup } from "../../../packages/control-plane/src/usernameClaim.js";
import { handleShareKeyAttestation } from "../../../packages/control-plane/src/pubkeyCert.js";
import { checkShareAcceptAdmin } from "../../../packages/server-daemon/src/shares/acceptAdmin.js";
import { InMemoryStorage } from "../../../packages/storage/src/index.js";
import type { InstalledService } from "../../../packages/server-daemon/src/servicePlatform.js";
import type { HttpRequest } from "../../../packages/server-daemon/src/runtime.js";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const APEX = "flagship.services";

describe("per-app visitor identity", () => {
  it("AT-LNK-01 one person's key toward app A, app B, their account id, IRK and contact id are all different; another person's key toward A differs; derivation is deterministic (catches: a shared long-lived id across apps)", () => {
    const umk = generateUMK();
    const other = generateUMK();
    const a = hex(deriveAppAccountId(umk, "alice--chess").publicKey);
    const b = hex(deriveAppAccountId(umk, "alice--notes").publicKey);
    const sameAppOtherServerOwner = hex(deriveAppAccountId(umk, "carol--chess").publicKey);
    const keys = [a, b, sameAppOtherServerOwner, hex(deriveAccountId(umk).publicKey), hex(deriveIRK(umk).publicKey), hex(deriveContactAccountId(umk, deriveAccountId(other).publicKey).publicKey), hex(deriveAppAccountId(other, "alice--chess").publicKey)];
    expect(new Set(keys).size).toBe(keys.length);
    // Whoever invited them, the person presents the same key to one app (owner rule: the owner may link two grants of ONE app).
    expect(hex(deriveAppAccountId(umk, "alice--chess").publicKey)).toBe(a);
  });

  it("AT-LNK-02 an app ref with a separator, upper case, spaces or empty is refused before derivation (catches: info-string injection aliasing another app's key)", () => {
    const umk = generateUMK();
    for (const bad of ["alice--chess|x", "ALICE--CHESS", "alice chess", "", "-alice", "alice--chess-", "a".repeat(200), "alice--chess\n"]) {
      expect(() => deriveAppAccountId(umk, bad), JSON.stringify(bad)).toThrow();
    }
  });

  it("AT-LNK-03 the stable id an app sees is 16 bytes of HKDF under the app's own secret: different per app and per server secret, and never contains the member key (catches: X-Flagship-User linkable across apps or leaking the AID)", () => {
    const swk1 = new Uint8Array(32).fill(7);
    const swk2 = new Uint8Array(32).fill(8);
    const member = ed.getPublicKey(new Uint8Array(32).fill(9));
    const ids = [
      deriveServiceMemberStableId(deriveServiceSecret(swk1, "alice--chess"), member),
      deriveServiceMemberStableId(deriveServiceSecret(swk1, "alice--notes"), member),
      deriveServiceMemberStableId(deriveServiceSecret(swk2, "alice--chess"), member),
    ];
    expect(new Set(ids).size).toBe(3);
    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-f]{32}$/);
      expect(hex(member)).not.toContain(id);
    }
  });
});

function fakeApp(serviceId: string, secret: Uint8Array, publicRoutes: string[] = []): InstalledService {
  return {
    serviceId,
    urlLabel: serviceId.split("--")[1],
    containerPort: 1,
    manifest: { name: serviceId, access: { enabled: true, default_role: "member", public_routes: publicRoutes } },
    membership: { stableIdFor: (pub: Uint8Array) => deriveServiceMemberStableId(deriveServiceSecret(secret, serviceId), pub) },
  } as unknown as InstalledService;
}

const req = (path: string, headers: Record<string, string> = {}, method = "GET"): HttpRequest =>
  ({ method, path, headers: { host: "chess.alice.flagship.services", ...headers }, body: Buffer.alloc(0) }) as unknown as HttpRequest;

const box = boxSigner({ privateKey: new Uint8Array(32).fill(3) });
const SWK = new Uint8Array(32).fill(4);

describe("what an app is told about its visitor", () => {
  it("AT-LNK-04 every client-supplied X-Flagship-* header (any case, underscores) is dropped; an anonymous visitor gets visitor=anonymous with no user or role (catches: a forged rank or id reaching the app)", async () => {
    const app = fakeApp("alice--chess", SWK);
    const forged = {
      "x-flagship-user": "owner",
      "X-Flagship-Role": "master",
      x_flagship_role: "master",
      "x-flagship_user": "admin",
      "X_FLAGSHIP_VISITOR": "member",
      "x-flagship-signature": "00",
      "x-flagship-app-id": "alice--bank",
    };
    const p = await prepareAppRequest(app, req("/", forged), { injector: box, accessMode: () => "open" });
    expect(p.kind).toBe("forward");
    if (p.kind !== "forward") return;
    const h = p.headers;
    for (const k of Object.keys(h)) {
      const n = k.toLowerCase().replace(/_/g, "-");
      if (n.startsWith("x-flagship-")) expect(["x-flagship-app-id", "x-flagship-visitor", "x-flagship-timestamp", "x-flagship-signature"], k).toContain(n);
    }
    expect(h["x-flagship-visitor"]).toBe("anonymous");
    expect(h["x-flagship-user"]).toBeUndefined();
    expect(h["x-flagship-role"]).toBeUndefined();
    expect(h["x-flagship-app-id"]).toBe("alice--chess");
    expect(h["x-flagship-signature"]).not.toBe("00");
  });

  it("AT-LNK-05 a member's cross-origin POST or WebSocket upgrade from a sibling app is treated as anonymous (catches: app B driving app A with the member's session)", async () => {
    const app = fakeApp("alice--chess", SWK);
    const member = ed.getPublicKey(new Uint8Array(32).fill(11));
    const session: SessionInfo = { memberPub: member, stableId: app.membership.stableIdFor(member), role: "manager" };
    const deps = { injector: box, accessMode: () => "open" as const, resolveSession: () => session };
    const cross = await prepareAppRequest(app, req("/transfer", { origin: "https://notes.alice.flagship.services" }, "POST"), deps);
    expect(cross.kind === "forward" && cross.headers["x-flagship-visitor"]).toBe("anonymous");
    const sameSite = await prepareAppRequest(app, req("/transfer", { "sec-fetch-site": "same-site" }, "POST"), deps);
    expect(sameSite.kind === "forward" && sameSite.headers["x-flagship-visitor"]).toBe("anonymous");
    const ws = await prepareAppRequest(app, req("/ws", { origin: "https://evil.example" }), deps, { upgrade: true });
    expect(ws.kind === "forward" && ws.headers["x-flagship-visitor"]).toBe("anonymous");
    const same = await prepareAppRequest(app, req("/transfer", { origin: "https://chess.alice.flagship.services" }, "POST"), deps);
    expect(same.kind === "forward" && same.headers["x-flagship-visitor"]).toBe("member");
  });

  it("AT-LNK-06 a sign-in cookie issued for app A is no session in app B on the same box (catches: cookie tossing across sibling apps)", () => {
    const aid = hex(ed.getPublicKey(new Uint8Array(32).fill(12)));
    const resolver = buildAppSessionResolver({
      sessions: { lookup: (t: string) => (t === "tok-a" ? { serviceRef: "alice--chess", aid, expiresAt: Number.MAX_SAFE_INTEGER } : null) } as never,
      access: {
        isAllowed: () => true,
        principal: () => null,
        accountRank: () => "member",
        roleOf: () => "member",
        appIdentityKey: (a: string) => a,
      } as never,
    });
    const chess = fakeApp("alice--chess", SWK);
    const notes = fakeApp("alice--notes", SWK);
    expect(resolver(req("/", { cookie: "Flagship-App-Session=tok-a" }), chess)).not.toBeNull();
    expect(resolver(req("/", { cookie: "Flagship-App-Session=tok-a" }), notes)).toBeNull();
  });

  it("AT-LNK-07 the same member signed in to two apps is asserted under two unrelated ids, neither the AID (catches: apps colluding to link one person)", async () => {
    const member = ed.getPublicKey(new Uint8Array(32).fill(13));
    const users: string[] = [];
    for (const id of ["alice--chess", "alice--notes"]) {
      const app = fakeApp(id, SWK);
      const session: SessionInfo = { memberPub: member, stableId: app.membership.stableIdFor(member), role: "member" };
      const p = await prepareAppRequest(app, req("/"), { injector: box, accessMode: () => "members-only", resolveSession: () => session });
      expect(p.kind).toBe("forward");
      if (p.kind === "forward") users.push(p.headers["x-flagship-user"]!);
    }
    expect(users[0]).not.toBe(users[1]);
    for (const u of users) expect(u).not.toBe(hex(member));
  });
});

describe("proofs a visitor's phone signs", () => {
  it("AT-LNK-08 a visit proof or knock for app A on server S verifies only for A, S and that page (catches: replaying one app's sign-in into another app, server or browser)", () => {
    const umk = generateUMK();
    const key = deriveAppAccountId(umk, "alice--chess");
    const v: ServiceVisitProof = { serverId: "home.alice.flagship.services", serviceRef: "alice--chess", visitorAID: key.publicKey, issuedAt: 1 };
    const vs = signServiceVisitProof(v, key);
    expect(verifyServiceVisitProof(v, vs, key.publicKey)).toBe(true);
    expect(verifyServiceVisitProof({ ...v, serviceRef: "alice--notes" }, vs, key.publicKey)).toBe(false);
    expect(verifyServiceVisitProof({ ...v, serverId: "home2.alice.flagship.services" }, vs, key.publicKey)).toBe(false);
    expect(verifyServiceVisitProof({ ...v, issuedAt: 2 }, vs, key.publicKey)).toBe(false);
    // A key derived for another app never verifies this app's proof.
    expect(verifyServiceVisitProof(v, vs, deriveAppAccountId(umk, "alice--notes").publicKey)).toBe(false);
    const k: KnockAuthorization = { serverId: v.serverId, serviceRef: v.serviceRef, pageId: "p".repeat(32), visitorAID: key.publicKey, issuedAt: 1 };
    const ks = signKnockAuthorization(k, key);
    expect(verifyKnockAuthorization(k, ks, key.publicKey)).toBe(true);
    expect(verifyKnockAuthorization({ ...k, pageId: "q".repeat(32) }, ks, key.publicKey)).toBe(false);
    expect(verifyKnockAuthorization({ ...k, serviceRef: "alice--notes" }, ks, key.publicKey)).toBe(false);
    // A visit proof is not a knock (domain separation).
    expect(verifyKnockAuthorization(k, vs, key.publicKey)).toBe(false);
    // The separator cannot be smuggled through a field to make two statements alias.
    expect(() => signServiceVisitProof({ ...v, serviceRef: "alice--chess|x" }, key)).toThrow();
  });
});

describe("cross-owner chat carrier (N08)", () => {
  const carolSeed = new Uint8Array(32).fill(21);
  const daveSeed = new Uint8Array(32).fill(22);
  const registry: Record<string, { pubHex: string; username: string }> = {
    "home.carol.flagship.services": { pubHex: hex(ed.getPublicKey(carolSeed)), username: "carol" },
    "home.dave.flagship.services": { pubHex: hex(ed.getPublicKey(daveSeed)), username: "dave" },
    "home2.alice.flagship.services": { pubHex: hex(ed.getPublicKey(new Uint8Array(32).fill(23))), username: "alice" },
  };
  const CHESS = { author: "alice", slug: "chess" };
  const NOTES = { author: "alice", slug: "notes" };

  function receiver() {
    const delivered: Array<{ peer: string; via: string }> = [];
    const handle = buildWireReceiver({
      account: "alice",
      directory: { server: async (d) => registry[d.toLowerCase()] ?? null },
      transport: { apex: APEX, noteRoute: () => {} } as never,
      appOf: (ref) => (ref === "alice--chess" ? CHESS : ref === "alice--notes" ? NOTES : null),
      deliver: async (_f, peer, via) => void delivered.push({ peer, via: `${via.author}--${via.slug}` }),
      now: () => 1_000_000,
    });
    return { handle, delivered };
  }

  function frame(to: string, from: string, seed: Uint8Array, nonce = "a".repeat(32)) {
    const body = JSON.stringify({ kind: "start", wireId: "w".repeat(20), counter: 0, leadGeneration: 0, target: { author: "alice", slug: "chess", targetUser: "alice" }, claimedSender: { author: "carol", slug: "club" }, body: "hi" });
    const statement = { purpose: "frame" as const, fromServer: from, toServer: to, issuedAt: 1_000_000, nonce, bodySha256Hex: chatWireBodySha256(new TextEncoder().encode(body)) };
    const sigHex = hex(signChatWire(statement, (m) => ed.sign(m, seed)));
    return { method: "POST", path: CHAT_WIRE_PATH, headers: {}, body: Buffer.from(JSON.stringify({ statement, sigHex, body })) } as unknown as HttpRequest;
  }

  it("AT-LNK-09 a frame addressed to app A's host is refused at app B; a replayed nonce, an own-account sender, an unregistered or impersonated sender are refused (catches: one app's conversation delivered to another, or a forged sender account)", async () => {
    const { handle, delivered } = receiver();
    const chessHost = chatAppHost(CHESS, "alice", APEX);
    const ok = frame(chessHost, "home.carol.flagship.services", carolSeed);
    expect((await handle(ok, "alice--chess"))!.status).toBe(200);
    expect(delivered).toEqual([{ peer: "carol", via: "alice--chess" }]);
    // The same signed frame presented on app B's host.
    expect((await handle(frame(chessHost, "home.carol.flagship.services", carolSeed, "b".repeat(32)), "alice--notes"))!.status).toBe(401);
    // Replay of the accepted frame.
    expect((await handle(ok, "alice--chess"))!.status).toBe(401);
    // From one of alice's own boxes: never over the wire.
    expect((await handle(frame(chessHost, "home2.alice.flagship.services", new Uint8Array(32).fill(23), "c".repeat(32)), "alice--chess"))!.status).toBe(401);
    // Dave signs but claims to be carol's server.
    expect((await handle(frame(chessHost, "home.carol.flagship.services", daveSeed, "d".repeat(32)), "alice--chess"))!.status).toBe(401);
    // A server .com does not list.
    expect((await handle(frame(chessHost, "home.eve.flagship.services", daveSeed, "e".repeat(32)), "alice--chess"))!.status).toBe(401);
    expect(delivered).toHaveLength(1);
  });
});

describe("sharing a server with another account", () => {
  // AT-LNK-10 (fixed): the share acceptance used to carry `.com`'s attestation of the joining account's
  // admin root (or IRK), which `GET /api/username/:u` serves to anyone, so a sharing owner could confirm a
  // guessed name and two sharing owners could link one co-manager. Now the admin device derives a
  // per-share admin key from its UMK and the share id (`deriveShareAdminKey`), has `.com` attest it with a
  // request signed by the account's admin root (`handleShareKeyAttestation`), and signs #12 with it; the
  // box accepts only that kind (`checkShareAcceptAdmin`).
  const NOW = 1_800_000_000_000;
  const caSeed = new Uint8Array(32).fill(0xc7);
  const ca = { keypair: { privateKey: caSeed, publicKey: ed.getPublicKey(caSeed) }, issuer: "test-ca" };
  const chain = { authorizedCaKeys: () => [hex(ca.keypair.publicKey)] };
  const bobUmk = { seed: new Uint8Array(32).fill(33) };
  const bobAdmin = { privateKey: new Uint8Array(32).fill(31), publicKey: ed.getPublicKey(new Uint8Array(32).fill(31)) };

  async function acceptAs(shareId: string, serverDomain: string, storage: InMemoryStorage) {
    const key = deriveShareAdminKey(bobUmk, shareId);
    const request = { username: "bob", keyPubHex: hex(key.publicKey), issuedAt: NOW };
    const r = await handleShareKeyAttestation(
      { ca, usernames: storage.usernames, now: () => NOW },
      "bob",
      { request, signature: hex(signShareKeyAttestationRequest(request, bobAdmin)) },
    );
    expect(r.status).toBe(200);
    const accept = { serverDomain, shareId, memberPubHex: "cd".repeat(32), acceptedAt: NOW };
    const admit = { ...accept, keyKind: "share" as const, keyPubHex: hex(key.publicKey) };
    const proof = parseShareAcceptAdminProof({
      admit,
      signature: hex(signServerShareAcceptAdmin(admit, key)),
      attestation: (r.body as { attestation: unknown }).attestation,
    })!;
    expect(checkShareAcceptAdmin({ accept, proof, chain, now: NOW + 1 })).toMatchObject({ ok: true });
    return proof;
  }

  it("AT-LNK-10 the key a joining account presents to a sharing box cannot be matched to its name through .com's public lookup, and differs per share (catches: an 'anonymous' attestation over a publicly indexed key)", async () => {
    const storage = new InMemoryStorage();
    const irkPub = hex(ed.getPublicKey(new Uint8Array(32).fill(32)));
    await storage.usernames.put({ username: "bob", irkPubHex: irkPub, claimedAt: 1, adminRootPubHex: hex(bobAdmin.publicKey) } as never);
    const one = await acceptAs("0f".repeat(16), "home.alice.flagship.services", storage);
    const two = await acceptAs("a1".repeat(16), "home.carol.flagship.services", storage);
    const lookup = (await handleUsernameLookup(storage.usernames, "bob")).body as Record<string, unknown>;
    const served = JSON.stringify(lookup);
    for (const p of [one, two]) {
      expect(served).not.toContain(p.admit.keyPubHex);
      expect(served).not.toContain(p.attestation.keyPubHex);
      expect(JSON.stringify(p)).not.toContain(irkPub);
      expect(JSON.stringify(p)).not.toContain(hex(bobAdmin.publicKey));
      expect(JSON.stringify(p)).not.toContain("bob");
    }
    // Two sharing owners see two unrelated keys.
    expect(one.admit.keyPubHex).not.toBe(two.admit.keyPubHex);
    // A stable account key in the proof is refused by the box's parser.
    const stable = { ...one, admit: { ...one.admit, keyKind: "admin-root", keyPubHex: hex(bobAdmin.publicKey) } };
    expect(parseShareAcceptAdminProof(stable)).toBeNull();
  });
});
