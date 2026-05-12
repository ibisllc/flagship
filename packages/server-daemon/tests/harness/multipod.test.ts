import { describe, expect, it } from "vitest";
import {
  ed,
  signAppGrant,
  type AppGrant,
  type Bytes,
  type Keypair,
} from "@flagship/protocol";
import {
  InMemoryAppGrantState,
  MultipodHarnessImpl,
  type AppGrantEntry,
  type ApprovalAlerter,
  type MultipodChannel,
  type SiblingFabric,
  type UrlClaimer,
} from "../../src/harness/multipod.js";

function key(): Keypair {
  const priv = new Uint8Array(32);
  crypto.getRandomValues(priv);
  return { privateKey: priv, publicKey: ed.getPublicKey(priv) };
}

const ME = "home.alice.flagship.services";
const PEER = "office.alice.flagship.services";
const PEER_B = "travel.alice.flagship.services";

function makeGrant(opts: {
  irk: Keypair;
  appCanonical?: string;
  pods: Array<{ canonical: string; pubKey: Bytes }>;
  routes?: Array<{ url: string; scope: "canonical" | "non-canonical" | "subpath" }>;
  issuedAt?: number;
  expiresAt?: number;
}): AppGrantEntry {
  const issuedAt = opts.issuedAt ?? 1_000_000;
  const expiresAt = opts.expiresAt ?? issuedAt + 7 * 24 * 3600_000;
  const grant: AppGrant = {
    grantId: "00000000-0000-4000-8000-000000000001",
    username: "alice",
    appCanonical: opts.appCanonical ?? "notes@abc123def456",
    serverDomains: opts.pods.map((p) => p.canonical),
    serverIdentities: opts.pods.map((p) => p.pubKey),
    routes: opts.routes ?? [
      { url: opts.pods[0]!.canonical, scope: "canonical" as const },
    ],
    issuedAt,
    expiresAt,
  };
  return { grant, signature: signAppGrant(grant, opts.irk) };
}

class FakeFabric implements SiblingFabric {
  reachable: string[] = [];
  sent: Array<{ podCanonical: string; appId: string; message: Uint8Array }> = [];
  channels: Array<{ podCanonical: string; appId: string; ch: FakeChannel }> = [];
  subs = new Map<
    string,
    (msg: { fromPod: string; message: Uint8Array }) => void
  >();
  failNextSend = false;

  reachablePeers(_appId: string): Array<{ podCanonical: string }> {
    return this.reachable.map((p) => ({ podCanonical: p }));
  }
  async openChannel(args: {
    podCanonical: string;
    appId: string;
  }): Promise<MultipodChannel> {
    const ch = new FakeChannel();
    this.channels.push({ ...args, ch });
    return ch;
  }
  async sendOnce(args: {
    podCanonical: string;
    appId: string;
    message: Uint8Array;
  }): Promise<void> {
    if (this.failNextSend) {
      this.failNextSend = false;
      throw new Error("offline");
    }
    this.sent.push(args);
  }
  subscribe(
    appId: string,
    cb: (msg: { fromPod: string; message: Uint8Array }) => void,
  ): () => void {
    this.subs.set(appId, cb);
    return () => this.subs.delete(appId);
  }
  deliver(appId: string, fromPod: string, message: Uint8Array): void {
    const cb = this.subs.get(appId);
    if (cb) cb({ fromPod, message });
  }
}

class FakeChannel implements MultipodChannel {
  isOpen = true;
  sent: Uint8Array[] = [];
  msgListeners: Array<(m: Uint8Array) => void> = [];
  closeListeners: Array<() => void> = [];
  send(m: Uint8Array): void {
    this.sent.push(m);
  }
  close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    for (const l of this.closeListeners) l();
  }
  onMessage(cb: (m: Uint8Array) => void): () => void {
    this.msgListeners.push(cb);
    return () => {
      this.msgListeners = this.msgListeners.filter((x) => x !== cb);
    };
  }
  onClose(cb: () => void): () => void {
    this.closeListeners.push(cb);
    return () => {
      this.closeListeners = this.closeListeners.filter((x) => x !== cb);
    };
  }
  deliver(m: Uint8Array): void {
    for (const l of this.msgListeners) l(m);
  }
}

interface Setup {
  irk: Keypair;
  myKey: Keypair;
  peerKey: Keypair;
  peerKeyB: Keypair;
  grants: InMemoryAppGrantState;
  fabric: FakeFabric;
  alerts: Array<{
    kind: "needs-url-approval";
    appId: string;
    requestedUrl: string;
  }>;
  claimed: string[];
  alerter: ApprovalAlerter;
  claimer: UrlClaimer;
}

function setup(): Setup {
  const irk = key();
  const myKey = key();
  const peerKey = key();
  const peerKeyB = key();
  const grants = new InMemoryAppGrantState();
  const fabric = new FakeFabric();
  const alerts: Setup["alerts"] = [];
  const claimed: string[] = [];
  const alerter: ApprovalAlerter = (a) => alerts.push(a);
  const claimer: UrlClaimer = {
    async claim(f: string) {
      claimed.push(f);
    },
  };
  return {
    irk,
    myKey,
    peerKey,
    peerKeyB,
    grants,
    fabric,
    alerts,
    claimed,
    alerter,
    claimer,
  };
}

function makeHarness(s: Setup) {
  return new MultipodHarnessImpl({
    myPodCanonical: ME,
    myPodPubKey: s.myKey.publicKey,
    grants: s.grants,
    fabric: s.fabric,
    urlClaimer: s.claimer,
    alerter: s.alerter,
    now: () => 1_500_000,
  });
}

describe("MultipodHarness", () => {
  it("siblings() returns peers in the grant, excluding self", async () => {
    const s = setup();
    s.grants.set(
      "notes",
      makeGrant({
        irk: s.irk,
        pods: [
          { canonical: ME, pubKey: s.myKey.publicKey },
          { canonical: PEER, pubKey: s.peerKey.publicKey },
          { canonical: PEER_B, pubKey: s.peerKeyB.publicKey },
        ],
      }),
    );
    const h = makeHarness(s);
    const sibs = await h.siblings("notes");
    expect(sibs.map((x) => x.podId).sort()).toEqual([PEER, PEER_B].sort());
    expect(sibs[0]!.canonicalUrl.startsWith("https://")).toBe(true);
  });

  it("siblings() returns empty for an app with no grant", async () => {
    const s = setup();
    const h = makeHarness(s);
    expect(await h.siblings("notes")).toEqual([]);
  });

  it("siblings() returns empty for an expired grant", async () => {
    const s = setup();
    s.grants.set(
      "notes",
      makeGrant({
        irk: s.irk,
        pods: [
          { canonical: ME, pubKey: s.myKey.publicKey },
          { canonical: PEER, pubKey: s.peerKey.publicKey },
        ],
        issuedAt: 0,
        expiresAt: 100,
      }),
    );
    const h = makeHarness(s);
    expect(await h.siblings("notes")).toEqual([]);
  });

  it("ownUrls() returns deduped routes from the grant", async () => {
    const s = setup();
    s.grants.set(
      "notes",
      makeGrant({
        irk: s.irk,
        pods: [
          { canonical: ME, pubKey: s.myKey.publicKey },
          { canonical: PEER, pubKey: s.peerKey.publicKey },
        ],
        routes: [
          { url: "notes.alice.flagship.services", scope: "canonical" },
          { url: "notes.alice.flagship.services", scope: "canonical" },
          { url: "office.alice.flagship.services", scope: "canonical" },
        ],
      }),
    );
    const h = makeHarness(s);
    expect(await h.ownUrls("notes")).toEqual(
      ["notes.alice.flagship.services", "office.alice.flagship.services"].sort(),
    );
  });

  it("sendToSibling() routes through the fabric when peer is entitled", async () => {
    const s = setup();
    s.grants.set(
      "notes",
      makeGrant({
        irk: s.irk,
        pods: [
          { canonical: ME, pubKey: s.myKey.publicKey },
          { canonical: PEER, pubKey: s.peerKey.publicKey },
        ],
      }),
    );
    const h = makeHarness(s);
    await h.sendToSibling(PEER, "notes", new Uint8Array([1, 2, 3]));
    expect(s.fabric.sent).toHaveLength(1);
    expect(s.fabric.sent[0]!.podCanonical).toBe(PEER);
    expect(s.fabric.sent[0]!.appId).toBe("notes");
    expect([...s.fabric.sent[0]!.message]).toEqual([1, 2, 3]);
  });

  it("sendToSibling() refuses peers NOT in the grant even if the fabric has them", async () => {
    const s = setup();
    s.grants.set(
      "notes",
      makeGrant({
        irk: s.irk,
        pods: [
          { canonical: ME, pubKey: s.myKey.publicKey },
          { canonical: PEER, pubKey: s.peerKey.publicKey },
        ],
      }),
    );
    s.fabric.reachable = [PEER, PEER_B]; // fabric sees more peers than the grant covers
    const h = makeHarness(s);
    await expect(
      h.sendToSibling(PEER_B, "notes", new Uint8Array([9])),
    ).rejects.toThrow(/peer not entitled/);
    expect(s.fabric.sent).toHaveLength(0);
  });

  it("sendToSibling() refuses self even with a grant", async () => {
    const s = setup();
    s.grants.set(
      "notes",
      makeGrant({
        irk: s.irk,
        pods: [
          { canonical: ME, pubKey: s.myKey.publicKey },
          { canonical: PEER, pubKey: s.peerKey.publicKey },
        ],
      }),
    );
    const h = makeHarness(s);
    await expect(
      h.sendToSibling(ME, "notes", new Uint8Array([1])),
    ).rejects.toThrow(/peer not entitled/);
  });

  it("openSiblingWs() returns a channel for entitled peers", async () => {
    const s = setup();
    s.grants.set(
      "notes",
      makeGrant({
        irk: s.irk,
        pods: [
          { canonical: ME, pubKey: s.myKey.publicKey },
          { canonical: PEER, pubKey: s.peerKey.publicKey },
        ],
      }),
    );
    const h = makeHarness(s);
    const ch = await h.openSiblingWs(PEER, "notes");
    expect(ch.isOpen).toBe(true);
    expect(s.fabric.channels).toHaveLength(1);
    expect(s.fabric.channels[0]!.podCanonical).toBe(PEER);
  });

  it("requestUrl() claims when the grant authorizes the URL", async () => {
    const s = setup();
    s.grants.set(
      "notes",
      makeGrant({
        irk: s.irk,
        pods: [
          { canonical: ME, pubKey: s.myKey.publicKey },
          { canonical: PEER, pubKey: s.peerKey.publicKey },
        ],
        routes: [
          { url: "notes.alice.flagship.services", scope: "canonical" },
        ],
      }),
    );
    const h = makeHarness(s);
    const r = await h.requestUrl("https://notes.alice.flagship.services/x", "notes");
    expect(r.ok).toBe(false); // URL not in grant routes (only the bare FQDN is)
    // Re-try with exact URL from the grant
    const r2 = await h.requestUrl("notes.alice.flagship.services", "notes");
    expect(r2).toEqual({ ok: true });
    expect(s.claimed).toEqual(["notes.alice.flagship.services"]);
    expect(s.alerts).toHaveLength(1); // first attempt produced an alert
  });

  it("requestUrl() emits a phone alert when the grant does NOT cover it", async () => {
    const s = setup();
    s.grants.set(
      "notes",
      makeGrant({
        irk: s.irk,
        pods: [
          { canonical: ME, pubKey: s.myKey.publicKey },
        ],
        routes: [{ url: "notes.alice.flagship.services", scope: "canonical" }],
      }),
    );
    const h = makeHarness(s);
    const r = await h.requestUrl("totally-other.com", "notes");
    expect(r).toEqual({ ok: false, reason: "needs-user-approval" });
    expect(s.claimed).toEqual([]);
    expect(s.alerts).toEqual([
      { kind: "needs-url-approval", appId: "notes", requestedUrl: "totally-other.com" },
    ]);
  });

  it("inbound() delivers messages from entitled peers and filters strangers", async () => {
    const s = setup();
    s.grants.set(
      "notes",
      makeGrant({
        irk: s.irk,
        pods: [
          { canonical: ME, pubKey: s.myKey.publicKey },
          { canonical: PEER, pubKey: s.peerKey.publicKey },
        ],
      }),
    );
    const h = makeHarness(s);
    const it = h.inbound("notes");
    const received: Array<{ fromPod: string; bytes: number[] }> = [];
    const drain = (async () => {
      for await (const msg of it) {
        received.push({ fromPod: msg.fromPod, bytes: [...msg.message] });
        if (received.length === 2) break;
      }
    })();
    s.fabric.deliver("notes", PEER, new Uint8Array([1]));
    s.fabric.deliver("notes", PEER_B, new Uint8Array([99])); // not in grant
    s.fabric.deliver("notes", PEER, new Uint8Array([2]));
    await drain;
    expect(received).toEqual([
      { fromPod: PEER, bytes: [1] },
      { fromPod: PEER, bytes: [2] },
    ]);
  });

  it("inbound() ends cleanly when the iterator's return() is called", async () => {
    const s = setup();
    s.grants.set(
      "notes",
      makeGrant({
        irk: s.irk,
        pods: [
          { canonical: ME, pubKey: s.myKey.publicKey },
          { canonical: PEER, pubKey: s.peerKey.publicKey },
        ],
      }),
    );
    const h = makeHarness(s);
    const it = h.inbound("notes");
    const next = it.next();
    await it.return!();
    const result = await next;
    expect(result.done).toBe(true);
    // Subsequent delivery shouldn't reopen anything
    s.fabric.deliver("notes", PEER, new Uint8Array([5]));
    const after = await it.next();
    expect(after.done).toBe(true);
  });

  it("an expired grant ALSO blocks send (defense in depth even if siblings() succeeded earlier)", async () => {
    const s = setup();
    // Plant a grant that's already expired relative to now()=1_500_000.
    s.grants.set(
      "notes",
      makeGrant({
        irk: s.irk,
        pods: [
          { canonical: ME, pubKey: s.myKey.publicKey },
          { canonical: PEER, pubKey: s.peerKey.publicKey },
        ],
        issuedAt: 0,
        expiresAt: 1_000,
      }),
    );
    const h = makeHarness(s);
    await expect(
      h.sendToSibling(PEER, "notes", new Uint8Array([1])),
    ).rejects.toThrow(/peer not entitled/);
  });

  it("a fresh grant rotating IN a new pod is observed by siblings() immediately", async () => {
    const s = setup();
    s.grants.set(
      "notes",
      makeGrant({
        irk: s.irk,
        pods: [
          { canonical: ME, pubKey: s.myKey.publicKey },
          { canonical: PEER, pubKey: s.peerKey.publicKey },
        ],
      }),
    );
    const h = makeHarness(s);
    let sibs = await h.siblings("notes");
    expect(sibs.map((x) => x.podId)).toEqual([PEER]);
    // Phone re-signs a grant adding PEER_B
    s.grants.set(
      "notes",
      makeGrant({
        irk: s.irk,
        pods: [
          { canonical: ME, pubKey: s.myKey.publicKey },
          { canonical: PEER, pubKey: s.peerKey.publicKey },
          { canonical: PEER_B, pubKey: s.peerKeyB.publicKey },
        ],
      }),
    );
    sibs = await h.siblings("notes");
    expect(sibs.map((x) => x.podId).sort()).toEqual([PEER, PEER_B].sort());
  });
});
