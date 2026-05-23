import { describe, expect, it } from "vitest";
import {
  deriveIRK,
  deriveSWK,
  newInviteNonce,
  signInvite,
  signInviteAcceptance,
  signMembershipMutation,
  type InviteAcceptance,
  type InviteToken,
  type MembershipMutation,
} from "@flagship/protocol";
import { AppMembership } from "../src/membership.js";
import { IdentityInjector } from "../src/identityInjector.js";
import { buildDaemonHttp, type DaemonContext } from "../src/httpApi.js";

const ownerUmk = { seed: new Uint8Array(32).fill(11) };
const sarahUmk = { seed: new Uint8Array(32).fill(33) };
const ownerIrk = deriveIRK(ownerUmk);
const sarahIrk = deriveIRK(sarahUmk);
const swk = deriveSWK(ownerUmk, "srv-1");

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

function makeContext(): { ctx: DaemonContext; runtimeKey: ReturnType<typeof deriveIRK> } {
  const apps = new Map<string, AppMembership>();
  apps.set("habit-tracker", new AppMembership("habit-tracker", "harry", ownerIrk.publicKey, swk));
  const runtimeKey = deriveIRK({ seed: new Uint8Array(32).fill(0xaa) });
  const sessions = new Map<string, Uint8Array>();
  sessions.set("sarah-token", sarahIrk.publicKey);
  const injectors = new Map<string, IdentityInjector>();
  injectors.set(
    "habit-tracker",
    new IdentityInjector({
      app: apps.get("habit-tracker")!,
      resolveSession: (t) => (t ? sessions.get(t) ?? null : null),
      signer: { privateKey: runtimeKey.privateKey, publicKey: runtimeKey.publicKey },
    }),
  );
  const ctx: DaemonContext = {
    serverId: "srv-1",
    userId: "harry",
    apps,
    resolveSession: (t) => (t ? sessions.get(t) ?? null : null),
    injectors,
  };
  return { ctx, runtimeKey };
}

describe("daemon HTTP — invite redemption", () => {
  it("end-to-end: owner signs invite, accepter signs acceptance, redeem creates membership", async () => {
    const { ctx } = makeContext();
    const app = buildDaemonHttp(ctx);
    const nonce = newInviteNonce();
    const issuedAt = Date.now();
    const token: InviteToken = {
      serviceId: "habit-tracker",
      role: "parent",
      nonce,
      issuedAt,
      expiresAt: issuedAt + 60_000,
    };
    const inviteSig = signInvite(token, ownerIrk);
    const acceptance: InviteAcceptance = {
      inviteNonce: nonce,
      accepterIrkPub: sarahIrk.publicKey,
      acceptedAt: issuedAt + 1_000,
    };
    const accSig = signInviteAcceptance(acceptance, sarahIrk);

    const res = await app.inject({
      method: "POST",
      url: "/apps/habit-tracker/invites/redeem",
      payload: {
        token: {
          serviceId: "habit-tracker",
          role: "parent",
          nonce: bytesToHex(nonce),
          issuedAt,
          expiresAt: token.expiresAt,
        },
        inviteSignature: bytesToHex(inviteSig),
        acceptance: {
          inviteNonce: bytesToHex(nonce),
          accepterIrkPub: bytesToHex(sarahIrk.publicKey),
          acceptedAt: acceptance.acceptedAt,
        },
        acceptanceSignature: bytesToHex(accSig),
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.role).toBe("parent");
    expect(body.stableId).toMatch(/^[0-9a-f]{32}$/);

    // Now Sarah is a member; identity-decide for her returns allow.
    const decide = await app.inject({
      method: "POST",
      url: "/apps/habit-tracker/identity/decide",
      payload: { path: "/", sessionToken: "sarah-token" },
    });
    expect(decide.statusCode).toBe(200);
    expect(JSON.parse(decide.body).action).toBe("allow");
  });

  it("rejects invite redemption signed by attacker", async () => {
    const { ctx } = makeContext();
    const app = buildDaemonHttp(ctx);
    const attacker = deriveIRK({ seed: new Uint8Array(32).fill(99) });
    const nonce = newInviteNonce();
    const issuedAt = Date.now();
    const token: InviteToken = {
      serviceId: "habit-tracker",
      role: "admin",
      nonce,
      issuedAt,
      expiresAt: issuedAt + 60_000,
    };
    const badSig = signInvite(token, attacker);
    const acceptance: InviteAcceptance = {
      inviteNonce: nonce,
      accepterIrkPub: sarahIrk.publicKey,
      acceptedAt: issuedAt,
    };
    const accSig = signInviteAcceptance(acceptance, sarahIrk);

    const res = await app.inject({
      method: "POST",
      url: "/apps/habit-tracker/invites/redeem",
      payload: {
        token: {
          serviceId: "habit-tracker",
          role: "admin",
          nonce: bytesToHex(nonce),
          issuedAt,
          expiresAt: token.expiresAt,
        },
        inviteSignature: bytesToHex(badSig),
        acceptance: {
          inviteNonce: bytesToHex(nonce),
          accepterIrkPub: bytesToHex(sarahIrk.publicKey),
          acceptedAt: acceptance.acceptedAt,
        },
        acceptanceSignature: bytesToHex(accSig),
      },
    });
    expect(res.statusCode).toBe(403);
  });

  it("returns 404 when app not found", async () => {
    const { ctx } = makeContext();
    const app = buildDaemonHttp(ctx);
    const res = await app.inject({
      method: "POST",
      url: "/apps/no-such-app/invites/redeem",
      payload: {},
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("daemon HTTP — membership mutation", () => {
  it("applies an owner-signed remove", async () => {
    const { ctx } = makeContext();
    const httpApp = buildDaemonHttp(ctx);

    // Add Sarah first via internal-add path (we already test invite path elsewhere).
    ctx.apps.get("habit-tracker")!.members.internalAdd(sarahIrk.publicKey, "parent");

    const mutation: MembershipMutation = {
      serviceId: "habit-tracker",
      targetIrkPub: sarahIrk.publicKey,
      role: null,
      issuedAt: Date.now(),
    };
    const sig = signMembershipMutation(mutation, ownerIrk);

    const res = await httpApp.inject({
      method: "POST",
      url: "/apps/habit-tracker/membership/mutation",
      payload: {
        mutation: {
          serviceId: "habit-tracker",
          targetIrkPub: bytesToHex(sarahIrk.publicKey),
          role: null,
          issuedAt: mutation.issuedAt,
        },
        signature: bytesToHex(sig),
      },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).effect).toBe("removed");
  });
});

describe("daemon HTTP — identity decide", () => {
  it("returns deny 401 for anonymous request to private app", async () => {
    const { ctx } = makeContext();
    const app = buildDaemonHttp(ctx);
    const res = await app.inject({
      method: "POST",
      url: "/apps/habit-tracker/identity/decide",
      payload: { path: "/" },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.action).toBe("deny");
    expect(body.status).toBe(401);
  });
});

describe("daemon HTTP — health", () => {
  it("reports server identity and registered apps", async () => {
    const { ctx } = makeContext();
    const app = buildDaemonHttp(ctx);
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.serverId).toBe("srv-1");
    expect(body.apps).toContain("habit-tracker");
  });
});
