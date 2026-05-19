import { describe, expect, it } from "vitest";
import {
  deriveIRK,
  deriveSWK,
  newInviteNonce,
  signInvite,
  signInviteAcceptance,
  type InviteAcceptance,
  type InviteToken,
} from "@flagship/protocol";
import { AppMembership } from "../src/membership.js";
import {
  IdentityInjector,
  verifyIdentityHeaders,
} from "../src/identityInjector.js";

const ownerUmk = { seed: new Uint8Array(32).fill(11) };
const sarahUmk = { seed: new Uint8Array(32).fill(33) };
const strangerUmk = { seed: new Uint8Array(32).fill(99) };

const ownerIrk = deriveIRK(ownerUmk);
const sarahIrk = deriveIRK(sarahUmk);
const strangerIrk = deriveIRK(strangerUmk);
const swk = deriveSWK(ownerUmk, "srv-1");
const APP = "habit-tracker";

function makePairedApp(opts: { withSarah: boolean; publicRoutes?: string[] }) {
  const app = new AppMembership(APP, "harry", ownerIrk.publicKey, swk);
  if (opts.withSarah) {
    const nonce = newInviteNonce();
    const issuedAt = Date.now();
    const token: InviteToken = { serviceId: APP, role: "parent", nonce, issuedAt, expiresAt: issuedAt + 60_000 };
    const inviteSig = signInvite(token, ownerIrk);
    const acceptance: InviteAcceptance = {
      inviteNonce: nonce,
      accepterIrkPub: sarahIrk.publicKey,
      acceptedAt: issuedAt + 1_000,
    };
    const accSig = signInviteAcceptance(acceptance, sarahIrk);
    app.redeemInvite(token, inviteSig, acceptance, accSig);
  }
  // The server-runtime signing key — in production derived from SWK; here we
  // use a fixed Ed25519 keypair for header signatures.
  const runtimeKey = deriveIRK({ seed: new Uint8Array(32).fill(0xaa) });
  const sessions = new Map<string, Uint8Array>();
  sessions.set("sarah-token", sarahIrk.publicKey);
  sessions.set("stranger-token", strangerIrk.publicKey);

  const injector = new IdentityInjector({
    app,
    resolveSession: (tok) => (tok ? sessions.get(tok) ?? null : null),
    publicRoutes: opts.publicRoutes,
    signer: { privateKey: runtimeKey.privateKey, publicKey: runtimeKey.publicKey },
  });
  return { injector, runtimePub: runtimeKey.publicKey };
}

describe("IdentityInjector — happy paths", () => {
  it("authenticated member is allowed and gets a stable id + role + signed headers", () => {
    const { injector } = makePairedApp({ withSarah: true });
    const decision = injector.evaluate({ path: "/", sessionToken: "sarah-token" });
    expect(decision.action).toBe("allow");
    if (decision.action !== "allow") return;
    expect(decision.headers["X-Flagship-Member"]).toMatch(/^[0-9a-f]{32}$/);
    expect(decision.headers["X-Flagship-Role"]).toBe("parent");
    expect(decision.headers["X-Flagship-Signature"]).toMatch(/^[0-9a-f]{128}$/);
  });

  it("anonymous request to a public route gets allow-anonymous", () => {
    const { injector } = makePairedApp({ withSarah: false, publicRoutes: ["/", "/about"] });
    const decision = injector.evaluate({ path: "/", sessionToken: undefined });
    expect(decision.action).toBe("allow-anonymous");
  });

  it("anonymous request to a private route is denied 401", () => {
    const { injector } = makePairedApp({ withSarah: true });
    const decision = injector.evaluate({ path: "/dashboard", sessionToken: undefined });
    expect(decision.action).toBe("deny");
    if (decision.action !== "deny") return;
    expect(decision.status).toBe(401);
  });

  it("authenticated non-member is denied 403", () => {
    const { injector } = makePairedApp({ withSarah: true });
    const decision = injector.evaluate({ path: "/dashboard", sessionToken: "stranger-token" });
    expect(decision.action).toBe("deny");
    if (decision.action !== "deny") return;
    expect(decision.status).toBe(403);
  });

  it("non-member on a public route is allowed-anonymous (does not leak membership-ness)", () => {
    const { injector } = makePairedApp({ withSarah: true, publicRoutes: ["/", "/about"] });
    const decision = injector.evaluate({ path: "/about", sessionToken: "stranger-token" });
    expect(decision.action).toBe("allow-anonymous");
  });
});

describe("IdentityInjector — header signatures verify cleanly", () => {
  it("verifyIdentityHeaders accepts a freshly-signed allow decision", () => {
    const { injector, runtimePub } = makePairedApp({ withSarah: true });
    const decision = injector.evaluate({ path: "/", sessionToken: "sarah-token" });
    if (decision.action !== "allow") throw new Error("expected allow");
    const lower: Record<string, string> = {};
    for (const [k, v] of Object.entries(decision.headers)) lower[k.toLowerCase()] = v;
    const v = verifyIdentityHeaders(lower, runtimePub);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.role).toBe("parent");
  });

  it("verifyIdentityHeaders rejects tampered role", () => {
    const { injector, runtimePub } = makePairedApp({ withSarah: true });
    const decision = injector.evaluate({ path: "/", sessionToken: "sarah-token" });
    if (decision.action !== "allow") throw new Error("expected allow");
    const lower: Record<string, string> = {};
    for (const [k, v] of Object.entries(decision.headers)) lower[k.toLowerCase()] = v;
    lower["x-flagship-role"] = "admin"; // attempt privilege escalation
    expect(verifyIdentityHeaders(lower, runtimePub).ok).toBe(false);
  });

  it("verifyIdentityHeaders rejects stale headers", () => {
    const { injector, runtimePub } = makePairedApp({ withSarah: true });
    const decision = injector.evaluate({ path: "/", sessionToken: "sarah-token" });
    if (decision.action !== "allow") throw new Error("expected allow");
    const lower: Record<string, string> = {};
    for (const [k, v] of Object.entries(decision.headers)) lower[k.toLowerCase()] = v;
    const future = () => Date.now() + 60 * 60_000;
    expect(verifyIdentityHeaders(lower, runtimePub, 5 * 60_000, future).ok).toBe(false);
  });

  it("verifyIdentityHeaders rejects missing headers", () => {
    const { runtimePub } = makePairedApp({ withSarah: true });
    expect(verifyIdentityHeaders({}, runtimePub).ok).toBe(false);
  });
});

describe("IdentityInjector — public_routes glob support", () => {
  it("matches /api/* style globs", () => {
    const { injector } = makePairedApp({ withSarah: false, publicRoutes: ["/api/*"] });
    expect(injector.evaluate({ path: "/api/health" }).action).toBe("allow-anonymous");
    expect(injector.evaluate({ path: "/dashboard" }).action).toBe("deny");
  });
});
