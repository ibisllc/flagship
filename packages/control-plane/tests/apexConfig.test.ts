import { describe, expect, it } from "vitest";
import {
  ed,
  signAuthCode,
  signRegisterRck,
  signReleaseServerName,
  type AuthCode,
  type Keypair,
} from "@flagship/protocol";
import {
  InMemoryAuthCodeStorage,
  InMemoryRoutingStorage,
  InMemoryServerStorage,
  InMemoryUsernameStorage,
} from "@flagship/storage";
import { handleAuthCodeIssue } from "../src/authCode.js";
import { handleServerReleaseName } from "../src/serverRevoke.js";
import { handleRegisterRck } from "../src/routing.js";

// G1 (docs/ui-test-gym.md §12-G1): the data-plane apex is a CONFIG VARIABLE
// threaded through serverDomain validation, the user-zone CAA anchor, the
// release-name guard, and the RCK subdomain guard. Its DEFAULT is the prod
// literal `flagship.services`, so prod behavior (incl. every signed-domain
// validation) is byte-identical; only the `gym.` test env sets it. These
// tests prove BOTH halves: the default preserves prod, and an explicit
// `gym.flagship.services` apex accepts gym names and rejects prod ones.

const PROD_APEX = "flagship.services";
const GYM_APEX = "gym.flagship.services";

function makeKey(): Keypair {
  const priv = new Uint8Array(32);
  crypto.getRandomValues(priv);
  return { privateKey: priv, publicKey: ed.getPublicKey(priv) };
}
function hex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

async function withUser(username: string): Promise<{ usernames: InMemoryUsernameStorage; irk: Keypair }> {
  const usernames = new InMemoryUsernameStorage();
  const irk = makeKey();
  await usernames.put({ username, irkPubHex: hex(irk.publicKey), claimedAt: 1_000 });
  return { usernames, irk };
}

/** A fully-signed auth-code issue body for a given server domain. */
function authCodeIssueBody(args: {
  username: string;
  serverName: string;
  serverDomain: string;
  irk: Keypair;
  issuedAt: number;
}): unknown {
  const issued: AuthCode = {
    version: 1,
    serial: "abcd1234",
    username: args.username,
    serverName: args.serverName,
    serverDomain: args.serverDomain,
    delegatedPubKey: makeKey().publicKey,
    userPubKey: args.irk.publicKey,
    issuedAt: args.issuedAt,
    expiresAt: args.issuedAt + 60 * 60_000,
  };
  const sig = signAuthCode(issued, args.irk);
  return {
    code: {
      ...issued,
      delegatedPubKey: hex(issued.delegatedPubKey),
      userPubKey: hex(issued.userPubKey),
    },
    signature: hex(sig),
  };
}

describe("apex config — authCode serverDomain validation", () => {
  const issuedAt = 2_000;
  const now = () => issuedAt;

  it("DEFAULT apex (unset) accepts the prod serverDomain — byte-identical to before", async () => {
    const { usernames, irk } = await withUser("alice");
    const storage = new InMemoryAuthCodeStorage();
    const res = await handleAuthCodeIssue(
      { storage, usernames, now },
      authCodeIssueBody({
        username: "alice",
        serverName: "home",
        serverDomain: "home.alice.flagship.services",
        irk,
        issuedAt,
      }),
    );
    expect(res.status).toBe(200);
  });

  it("DEFAULT apex REJECTS a gym serverDomain (prod doesn't know `gym.`)", async () => {
    const { usernames, irk } = await withUser("alice");
    const storage = new InMemoryAuthCodeStorage();
    const res = await handleAuthCodeIssue(
      { storage, usernames, now },
      authCodeIssueBody({
        username: "alice",
        serverName: "home",
        serverDomain: "home.alice.gym.flagship.services",
        irk,
        issuedAt,
      }),
    );
    expect(res.status).toBe(400);
  });

  it("gym apex accepts the gym serverDomain and rejects the prod one", async () => {
    const { usernames, irk } = await withUser("alice");
    const ok = await handleAuthCodeIssue(
      { storage: new InMemoryAuthCodeStorage(), usernames, apex: GYM_APEX, now },
      authCodeIssueBody({
        username: "alice",
        serverName: "home",
        serverDomain: "home.alice.gym.flagship.services",
        irk,
        issuedAt,
      }),
    );
    expect(ok.status).toBe(200);

    const bad = await handleAuthCodeIssue(
      { storage: new InMemoryAuthCodeStorage(), usernames, apex: GYM_APEX, now },
      authCodeIssueBody({
        username: "alice",
        serverName: "home",
        serverDomain: "home.alice.flagship.services",
        irk,
        issuedAt,
      }),
    );
    expect(bad.status).toBe(400);
  });

  it("explicit prod apex matches the default exactly", async () => {
    const { usernames, irk } = await withUser("alice");
    const body = authCodeIssueBody({
      username: "alice",
      serverName: "home",
      serverDomain: "home.alice.flagship.services",
      irk,
      issuedAt,
    });
    const def = await handleAuthCodeIssue(
      { storage: new InMemoryAuthCodeStorage(), usernames, now },
      body,
    );
    const expl = await handleAuthCodeIssue(
      { storage: new InMemoryAuthCodeStorage(), usernames, apex: PROD_APEX, now },
      body,
    );
    expect(def.status).toBe(200);
    expect(expl.status).toBe(def.status);
  });
});

describe("apex config — release-name namespace guard", () => {
  const issuedAt = 5_000;
  const now = () => issuedAt;

  async function release(apex: string | undefined, serverDomain: string) {
    const { usernames, irk } = await withUser("alice");
    const claim = { username: "alice", serverDomain, issuedAt };
    const sig = signReleaseServerName(claim, irk);
    return handleServerReleaseName(
      {
        usernames,
        routing: new InMemoryRoutingStorage(),
        authCodes: new InMemoryAuthCodeStorage(),
        servers: new InMemoryServerStorage(),
        ...(apex ? { apex } : {}),
        now,
      },
      { request: claim, signature: hex(sig) },
    );
  }

  it("DEFAULT accepts a prod name, rejects a gym name", async () => {
    expect((await release(undefined, "home.alice.flagship.services")).status).toBe(200);
    expect((await release(undefined, "home.alice.gym.flagship.services")).status).toBe(400);
  });

  it("gym apex accepts a gym name, rejects a prod name", async () => {
    expect((await release(GYM_APEX, "home.alice.gym.flagship.services")).status).toBe(200);
    expect((await release(GYM_APEX, "home.alice.flagship.services")).status).toBe(400);
  });
});

describe("apex config — RCK subdomain namespace guard", () => {
  const issuedAt = 7_000;
  const now = () => issuedAt;

  async function registerRck(apex: string | undefined, subdomain: string) {
    const { usernames, irk } = await withUser("alice");
    const rck = makeKey();
    const claim = { username: "alice", subdomain, rckPubKey: rck.publicKey, issuedAt };
    const sig = signRegisterRck(claim, irk);
    return handleRegisterRck(
      { routing: new InMemoryRoutingStorage(), usernames, ...(apex ? { apex } : {}), now },
      {
        request: {
          username: "alice",
          subdomain,
          rckPubKey: hex(rck.publicKey),
          issuedAt,
        },
        signature: hex(sig),
      },
    );
  }

  it("DEFAULT accepts a prod subdomain, rejects a gym subdomain", async () => {
    expect((await registerRck(undefined, "home.alice.flagship.services")).status).toBe(200);
    expect((await registerRck(undefined, "home.alice.gym.flagship.services")).status).toBe(400);
  });

  it("gym apex accepts a gym subdomain, rejects a prod subdomain", async () => {
    expect((await registerRck(GYM_APEX, "home.alice.gym.flagship.services")).status).toBe(200);
    expect((await registerRck(GYM_APEX, "home.alice.flagship.services")).status).toBe(400);
  });
});
