import { describe, expect, it } from "vitest";
import {
  pickAutoPairTargets,
  autoPairPods,
  canonicalAddPairedSession,
} from "../public/webapp/lib/autoPair.js";

const DECODER = new TextDecoder();

describe("autoPair — target selection", () => {
  it("picks only LIVE pods lacking a token, de-duped", () => {
    const pods = [
      { fqdn: "a.alice.flagship.services", liveness: "live" },
      { fqdn: "b.alice.flagship.services", liveness: "unreachable" },
      { fqdn: "c.alice.flagship.services", liveness: "never" },
      { fqdn: "A.alice.flagship.services", liveness: "live" }, // dup (case-fold)
      { fqdn: "d.alice.flagship.services", liveness: "live" }, // has token
    ];
    const has = (fqdn: string) => fqdn === "d.alice.flagship.services";
    expect(pickAutoPairTargets(pods, has)).toEqual(["a.alice.flagship.services"]);
  });

  it("treats a recent lastReported as live when liveness is absent", () => {
    const pods = [
      { fqdn: "e.alice.flagship.services", lastReported: Date.now() - 1000 },
      { fqdn: "f.alice.flagship.services", lastReported: Date.now() - 60 * 60_000 },
    ];
    expect(pickAutoPairTargets(pods, () => false)).toEqual(["e.alice.flagship.services"]);
  });
});

describe("autoPair — sign + POST", () => {
  it("signs the add-paired-session order and POSTs it per live pod, storing the token", async () => {
    const stored: Record<string, string> = {};
    const legacy: Record<string, string> = {};
    const posted: Array<{ url: string; body: any }> = [];

    const out = await autoPairPods(
      [
        { fqdn: "home.alice.flagship.services", liveness: "live" },
        { fqdn: "cabin.alice.flagship.services", liveness: "unreachable" },
      ],
      {
        umk: new Uint8Array(32).fill(7),
        username: "alice",
        bytesToHex: (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join(""),
        signWithIrk: async (_umk: Uint8Array, bytes: Uint8Array) => {
          // Echo the canonical bytes back as a fake 64-byte "signature" so the
          // test can assert what was signed.
          const sig = new Uint8Array(64);
          sig.set(bytes.slice(0, 64));
          return sig;
        },
        fetch: (async (url: string, init: any) => {
          posted.push({ url, body: JSON.parse(init.body) });
          return { ok: true, status: 200, json: async () => ({}), text: async () => "" };
        }) as unknown as typeof fetch,
        hasToken: (fqdn: string) => !!stored[fqdn],
        storeToken: (fqdn: string, tok: string) => { stored[fqdn] = tok; },
        storeLegacyIfEmpty: (fqdn: string, tok: string) => { legacy[fqdn] ??= tok; },
        now: () => 1_800_000_000_000,
        inFlight: new Set<string>(),
      },
    );

    expect(out.paired).toEqual(["home.alice.flagship.services"]);
    expect(posted).toHaveLength(1);
    expect(posted[0]!.url).toBe("https://home.alice.flagship.services/api/orders-from-user");
    expect(posted[0]!.body.request.type).toBe("add-paired-session");
    expect(posted[0]!.body.request.serverId).toBe("home.alice.flagship.services");
    expect(stored["home.alice.flagship.services"]).toBe(posted[0]!.body.request.token);
    expect(legacy["home.alice.flagship.services"]).toBe(posted[0]!.body.request.token);

    // The canonical bytes signed match the pinned add-paired-session shape.
    const { serverId, token, label, issuedAt } = posted[0]!.body.request;
    const expected = DECODER.decode(canonicalAddPairedSession({ serverId, token, label, issuedAt }));
    expect(expected).toBe(
      `flagship/order/add-paired-session/v1|${serverId}|${token}|${label}|${issuedAt}`,
    );
  });

  it("no-ops with no unlocked session", async () => {
    const out = await autoPairPods([{ fqdn: "x.alice.flagship.services", liveness: "live" }], {
      // no umk → safeSession() in node returns null (no getSession state)
    });
    expect(out.paired).toEqual([]);
  });
});
