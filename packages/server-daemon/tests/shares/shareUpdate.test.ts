/**
 * A co-manager moves the server to an endorsed release
 * (docs/share-a-server.md §5.6): only at manage level, only while the owner's
 * grant stands, signed with the share's own key, and only through the same
 * replay, base and endorsement gates as the owner's update order.
 */
import { describe, expect, it } from "vitest";
import {
  deriveIRK,
  deriveShareMemberKey,
  signServerShareAccept,
  signServerShareGrant,
  signServerShareSession,
  signServerShareUpdate,
  verifyServerShareGrant,
  verifyServerShareRevoke,
  type Keypair,
  type ServerShareGrant,
  type ServerShareUpdate,
} from "@flagship/protocol";
import { authorizeSensitiveOrder } from "../../src/adminAuthorityLocal.js";
import type { HttpRequest, HttpResponse } from "../../src/runtime.js";
import { ActivityLog } from "../../src/shares/activityLog.js";
import { ShareStore } from "../../src/shares/shareStore.js";
import { ShareSessionStore, buildShares } from "../../src/shares/sharesHttp.js";
import { buildShareUpdate, type ShareUpdateAnswer } from "../../src/shares/shareUpdate.js";
import {
  applyEndorsedUpdate,
  type PendingVerifyMarker,
  type PendingVerifyStore,
  type UpdateCommandRunner,
  type UpdateConsumeOutcome,
  type UsedNonceStore,
} from "../../src/updateConsumer.js";
import type { UpdateOutcomeRecord } from "../../src/updateOutcome.js";

const BOX = "home.harry.flagship.services";
const CURRENT = "1".repeat(40);
const TARGET = "2".repeat(40);
const UNENDORSED = "3".repeat(40);
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const owner = deriveIRK({ seed: new Uint8Array(32).fill(42) });
const SHARE = "ab".repeat(16);
const member = deriveShareMemberKey({ seed: new Uint8Array(32).fill(22) }, SHARE);
const OTHER_SHARE = "cd".repeat(16);
const otherMember = deriveShareMemberKey({ seed: new Uint8Array(32).fill(23) }, OTHER_SHARE);

let clock = 1_800_000_000_000;
const now = () => clock;
let nonceSeq = 0;

function req(method: string, path: string, token: string | null, body?: unknown): HttpRequest {
  return {
    method,
    path,
    headers: token ? { "x-flagship-session": token } : {},
    body: body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body)),
  };
}
const parse = (r: HttpResponse | null) => ({ status: r!.status, body: JSON.parse(String(r!.body)) as Record<string, any> });

function memoryPending(initial: PendingVerifyMarker | null = null): PendingVerifyStore & { marker: PendingVerifyMarker | null } {
  const s = {
    marker: initial,
    async read() {
      return s.marker;
    },
    async write(m: PendingVerifyMarker) {
      s.marker = m;
    },
    async clear() {
      s.marker = null;
    },
  };
  return s;
}

function memoryNonces(): UsedNonceStore {
  const used = new Set<string>();
  return { has: async (n) => used.has(n), mark: async (n) => void used.add(n) };
}

function setup(opts: { pending?: PendingVerifyMarker | null; endorsed?: string[] } = {}) {
  const auth = { ownerIrkPub: owner.publicKey, username: "harry" };
  const verifyOwnerGrant = (g: ServerShareGrant, sig: Uint8Array) =>
    authorizeSensitiveOrder({ ...auth, order: g, signature: sig, verify: verifyServerShareGrant });
  const store = new ShareStore(null, { serverDomain: BOX, verifyOwnerGrant, now });
  const sessions = new ShareSessionStore(null, now);
  const activity = new ActivityLog(null, now);
  const pendingStore = memoryPending(opts.pending ?? null);
  const outcomes: UpdateOutcomeRecord[] = [];
  const commands: string[] = [];
  const runner: UpdateCommandRunner = async (cmd, args) => {
    commands.push([cmd, ...args].join(" "));
    if (cmd === "git" && args.includes("HEAD")) return { stdout: `${CURRENT}\n` };
    if (cmd === "git" && args.includes("--is-shallow-repository")) return { stdout: "false\n" };
    return { stdout: "" };
  };
  const endorsed = new Set(opts.endorsed ?? [TARGET]);
  let exited = 0;
  const answers: ShareUpdateAnswer[] = [];
  const order = buildShareUpdate({
    gate: { serverDomain: BOX, repoPath: "/opt/flagship", runner, usedNonceStore: memoryNonces(), now },
    pendingStore,
    verifyOwnerGrant,
    apply: (from, target, why) =>
      applyEndorsedUpdate(
        {
          repoPath: "/opt/flagship",
          releaseGate: {
            assertCommitEndorsed: (c) => {
              if (!endorsed.has(c)) throw new Error(`${c} is not endorsed`);
            },
          },
          runner,
          pendingStore,
          requestExit: () => void exited++,
        },
        from,
        target,
        why,
      ),
    outcomeStore: { write: async (r) => void outcomes.push(r), readSync: () => outcomes.at(-1) ?? null },
    activity,
    now,
    log: () => {},
  });
  const serverUpdate: typeof order = async (caller, body) => {
    const a = await order(caller, body);
    answers.push(a);
    return a;
  };
  const verifyOwnerRevoke = (r: Parameters<typeof verifyServerShareRevoke>[0], sig: Uint8Array) =>
    authorizeSensitiveOrder({ ...auth, order: r, signature: sig, verify: verifyServerShareRevoke });
  const shares = buildShares({ serverDomain: BOX, store, sessions, activity, verifyOwnerRevoke, serverUpdate, now, log: () => {} });
  return {
    store,
    shares,
    activity,
    pendingStore,
    outcomes,
    commands,
    answers,
    exited: () => exited,
    async lastApply(): Promise<UpdateConsumeOutcome | undefined> {
      return answers.at(-1)?.done;
    },
  };
}

type Setup = ReturnType<typeof setup>;

async function grant(x: Setup, level: "view" | "manage", k: Keypair = member, shareId = SHARE) {
  const g: ServerShareGrant = {
    serverDomain: BOX,
    shareId,
    memberPubHex: hex(k.publicKey),
    level,
    unlockAtBoot: false,
    seeAppData: false,
    label: "Sam",
    issuedAt: clock++,
  };
  const accept = { serverDomain: BOX, shareId, memberPubHex: hex(k.publicKey), acceptedAt: clock };
  const r = await x.store.put(g, hex(signServerShareGrant(g, owner)), accept, hex(signServerShareAccept(accept, k)));
  expect(r.ok).toBe(true);
}

async function signIn(x: Setup, k: Keypair = member, shareId = SHARE): Promise<string> {
  const n = parse(await x.shares.handlePublic(req("GET", "/api/shares/nonce", null)));
  const session = { serverDomain: BOX, shareId, memberPubHex: hex(k.publicKey), nonceHex: n.body.nonce as string, issuedAt: clock };
  const r = parse(await x.shares.handlePublic(req("POST", "/api/shares/session", null, { session, signature: hex(signServerShareSession(session, k)) })));
  expect(r.status).toBe(200);
  return r.body.token as string;
}

function updateOf(o: Partial<ServerShareUpdate> = {}, k: Keypair = member, shareId = SHARE): ServerShareUpdate {
  return {
    serverDomain: BOX,
    shareId,
    memberPubHex: hex(k.publicKey),
    targetCommit: TARGET,
    fromCommit: CURRENT,
    nonce: (++nonceSeq).toString(16).padStart(64, "0"),
    issuedAt: clock,
    ...o,
  };
}

async function order(x: Setup, token: string | null, u: ServerShareUpdate, signer: Keypair = member) {
  return parse(await x.shares.handlePublic(req("POST", "/api/shares/update", token, { update: u, signature: hex(signServerShareUpdate(u, signer)) })));
}

describe("a co-manager's update order", () => {
  it("applies an endorsed release through the owner's gates", async () => {
    const x = setup();
    await grant(x, "manage");
    const token = await signIn(x);
    const me = parse(await x.shares.handlePublic(req("GET", "/api/shares/me", token)));
    expect(me.body.canUpdate).toBe(true);

    const r = await order(x, token, updateOf());
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({ ok: true, accepted: true, targetCommit: TARGET });
    expect(await x.lastApply()).toEqual({ applied: true, previousCommit: CURRENT, targetCommit: TARGET });
    expect(x.commands).toContain(`git -C /opt/flagship checkout ${TARGET}`);
    expect(x.pendingStore.marker).toMatchObject({ previousCommit: CURRENT, targetCommit: TARGET, stage: "staged" });
    expect(x.exited()).toBe(1);
    expect(x.activity.recent(5)[0]).toMatchObject({
      actor: { kind: "share", shareId: SHARE, label: "Sam" },
      action: "server.update",
      target: TARGET,
      ok: true,
    });
  });

  it("is refused at view level", async () => {
    const x = setup();
    await grant(x, "view");
    const token = await signIn(x);
    const me = parse(await x.shares.handlePublic(req("GET", "/api/shares/me", token)));
    expect(me.body.canUpdate).toBe(false);
    const r = await order(x, token, updateOf());
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("manage-only");
    expect(x.answers).toHaveLength(0);
    expect(x.commands).toHaveLength(0);
  });

  it("is refused once the share is revoked, even with the old caller in hand", async () => {
    const x = setup();
    await grant(x, "manage");
    const token = await signIn(x);
    const caller = x.shares.resolve(req("GET", "/api/shares/me", token))!;
    expect(await x.shares.endShare(SHARE, "revoked", { kind: "owner" })).toBe(true);

    const r = await order(x, token, updateOf());
    expect(r.status).toBe(401);
    expect(x.commands).toHaveLength(0);

    // A grant the owner never signed (or one replaced by a forgery) never chains.
    const direct = buildShareUpdate({
      gate: { serverDomain: BOX, repoPath: "/opt/flagship", runner: async () => ({ stdout: CURRENT }), usedNonceStore: memoryNonces(), now },
      pendingStore: memoryPending(),
      verifyOwnerGrant: () => false,
      apply: async () => {
        throw new Error("must not apply");
      },
      now,
      log: () => {},
    });
    const u = updateOf();
    const a = await direct(caller, { update: u, signature: hex(signServerShareUpdate(u, member)) });
    expect(a.status).toBe(403);
    expect(a.done).toBeUndefined();
  });

  it("refuses a target the maintainers haven't endorsed, without checking it out", async () => {
    const x = setup({ endorsed: [TARGET] });
    await grant(x, "manage");
    const token = await signIn(x);
    const r = await order(x, token, updateOf({ targetCommit: UNENDORSED }));
    expect(r.status).toBe(202);
    expect(await x.lastApply()).toEqual({ applied: false, reason: "unendorsed" });
    expect(x.commands.some((c) => c.includes("checkout"))).toBe(false);
    expect(x.pendingStore.marker).toBeNull();
    expect(x.exited()).toBe(0);
    expect(x.outcomes).toEqual([expect.objectContaining({ outcome: "refused", reason: "unendorsed" })]);
  });

  it("refuses an order signed by any key but this share's", async () => {
    const x = setup();
    await grant(x, "manage");
    await grant(x, "manage", otherMember, OTHER_SHARE);
    const token = await signIn(x);
    expect((await order(x, token, updateOf(), owner)).status).toBe(403);
    expect((await order(x, token, updateOf(), otherMember)).status).toBe(403);
    const forOther = await order(x, token, updateOf({}, otherMember, OTHER_SHARE), otherMember);
    expect(forOther.status).toBe(403);
    expect(forOther.body.code).toBe("not-this-share");
    expect(x.commands).toHaveLength(0);
  });

  it("takes the owner's replay and base gates", async () => {
    const x = setup();
    await grant(x, "manage");
    const token = await signIn(x);
    expect((await order(x, token, updateOf({ fromCommit: "4".repeat(40) }))).body.code).toBe("from-commit-mismatch");
    expect((await order(x, token, updateOf({ serverDomain: "media.harry.flagship.services" }))).body.code).toBe("wrong-domain");
    expect((await order(x, token, updateOf({ issuedAt: clock - 30 * 24 * 3600_000 }))).body.code).toBe("stale");
    const u = updateOf();
    expect((await order(x, token, u)).status).toBe(202);
    await x.lastApply();
    x.pendingStore.marker = null;
    const replay = await order(x, token, u);
    expect(replay.status).toBe(409);
    expect(replay.body.code).toBe("replayed-nonce");
  });

  it("never stacks on an update waiting for its verdict", async () => {
    const x = setup({ pending: { previousCommit: CURRENT, targetCommit: TARGET, bootAttempts: 0, stage: "staged" } });
    await grant(x, "manage");
    const token = await signIn(x);
    const r = await order(x, token, updateOf());
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("pending-verify");
    expect(x.commands).toHaveLength(0);
  });
});
