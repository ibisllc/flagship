import { describe, expect, it, vi } from "vitest";
// The webapp's Box Request Inbox channel/store (docs/box-request-inbox.md) and
// the type registry from bootApproval. Pure logic — DI'd getSession + fetch, no
// DOM, no crypto. Guards the detection tier (digest → BoxRequest[]) and that the
// registry now answers BOTH types (the webapp/mobile parity the spec requires).
import { fetchInbox, createBoxInbox } from "../public/webapp/lib/boxInbox.js";
import { BOX_REQUEST_TYPES, satisfy } from "../public/webapp/lib/bootApproval.js";

const SESSION = () => ({ username: "harry", umk: new Uint8Array(32) });

function podsResponse(pods: unknown) {
  return {
    ok: true,
    json: async () => ({ pods }),
  } as unknown as Response;
}

describe("Box Request Inbox — fetchInbox (detection tier)", () => {
  it("flatMaps each pod's pendingRequests into typed, id-stable BoxRequests", async () => {
    const fetchMock = vi.fn(async () =>
      podsResponse([
        {
          serverDomain: "ezra.harry.flagship.services",
          pendingRequests: [
            { id: "bb".repeat(32), type: "entitlement", issuedAt: 200, expiresAt: 999 },
            { id: "aa".repeat(32), type: "unlock-key", issuedAt: 100, expiresAt: 999 },
          ],
        },
        { serverDomain: "frank.harry.flagship.services", pendingRequests: [] },
      ]),
    );

    const inbox = await fetchInbox({ getSession: SESSION, fetch: fetchMock, comBase: "https://com" });

    expect(inbox).toHaveLength(2);
    // Freshest first (issuedAt DESC).
    expect(inbox[0]?.type).toBe("entitlement");
    expect(inbox[1]?.type).toBe("unlock-key");
    // id is `<domain>#<requestNonceHex>` — matches the verified-request id.
    expect(inbox[0]?.id).toBe(`ezra.harry.flagship.services#${"bb".repeat(32)}`);
    expect(inbox[1]?.serverDomain).toBe("ezra.harry.flagship.services");
  });

  it("returns [] (never throws) on a non-OK pods read or no session", async () => {
    const bad = vi.fn(async () => ({ ok: false }) as Response);
    expect(await fetchInbox({ getSession: SESSION, fetch: bad })).toEqual([]);
    expect(
      await fetchInbox({ getSession: () => ({ username: null }) as never, fetch: vi.fn() }),
    ).toEqual([]);
  });
});

describe("Box Request Inbox — store", () => {
  it("subscribe gets the snapshot, refresh updates it, markSatisfied drops one", async () => {
    let podset: unknown = [
      {
        serverDomain: "ezra.harry.flagship.services",
        pendingRequests: [{ id: "aa".repeat(32), type: "unlock-key", issuedAt: 1, expiresAt: 9 }],
      },
    ];
    const fetchMock = vi.fn(async () => podsResponse(podset));
    const store = createBoxInbox({ getSession: SESSION, fetch: fetchMock });

    const seen: number[] = [];
    store.subscribe((reqs) => seen.push(reqs.length));
    expect(seen).toEqual([0]); // immediate snapshot is empty

    await store.refresh();
    expect(store.get()).toHaveLength(1);

    const id = store.get()[0]!.id;
    store.markSatisfied(id);
    expect(store.get()).toHaveLength(0);
  });
});

describe("Box Request type registry (mobile/webapp parity)", () => {
  it("answers BOTH unlock-key and entitlement with non-empty titles", () => {
    expect(Object.keys(BOX_REQUEST_TYPES).sort()).toEqual(["entitlement", "unlock-key"]);
    for (const t of Object.values(BOX_REQUEST_TYPES)) {
      expect(typeof t.title()).toBe("string");
      expect(t.title().length).toBeGreaterThan(0);
      expect(typeof t.respond).toBe("function");
    }
  });

  it("satisfy() rejects an unknown request type", async () => {
    await expect(satisfy({ purpose: "bogus" } as never)).rejects.toThrow(/unsupported request type/);
  });

  it("unlock-key title splits first-boot (full) vs established reboot (short)", () => {
    const unlock = BOX_REQUEST_TYPES["unlock-key"];
    // First boot ⇒ the fuller copy (also authorizes serving).
    expect(unlock.title({ firstBoot: true })).toBe("Unlock device and authorize it to join your cloud");
    // Established reboot ⇒ just the disk unlock; no "…join your cloud" noise.
    expect(unlock.title({ firstBoot: false })).toBe("Unlock device");
    // Unknown (no context) ⇒ defaults to the fuller copy (today's wording).
    expect(unlock.title()).toBe("Unlock device and authorize it to join your cloud");
  });
});
