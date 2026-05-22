// Phase 2 — open-account decoupled from server provisioning.
//
// Pins the webapp side of "an account is an identity, not a server"
// (docs/login-and-account-redesign.md, principle 1 + Phase 2):
//   - openAccount() does the STANDALONE, idempotent username claim
//     (`flagship/claim-username/v1`) bound to this device's IRK, persists
//     the identity locally, and opens the app shell — with NO server.
//   - The claim is the same canonical-bytes shape that used to live
//     buried inside create-server.js's mintInstallBlobBundle; here it
//     runs at OPEN-ACCOUNT time instead.
//   - A 409 ("already claimed") is success (idempotent retry / legacy
//     create-path).
//   - isValidUsername() enforces the bare-handle login rule.
//
// Server creation is a separate, later, repeatable concern — not
// exercised here (that's create-server.js, which now SKIPS the claim
// when the account is already open).

import { describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

async function loadLib() {
  const path = resolve(
    __dirname,
    "..",
    "public",
    "webapp",
    "lib",
    "openAccount.js",
  );
  return import(pathToFileURL(path).href);
}

function jsonResponse(status: number, body: unknown = "") {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A fake unlocked session: a 32-byte UMK + an IRK with a known pubkey. */
function fakeSession() {
  return {
    umk: new Uint8Array(32).fill(9),
    irk: { publicKey: new Uint8Array(32).fill(2) },
  };
}

const toHex = (b: Uint8Array) =>
  Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");

describe("webapp isValidUsername — bare account handle rule", () => {
  it("accepts lowercase letters/digits, rejects dots/hyphens/specials/empty/uppercase", async () => {
    const { isValidUsername } = await loadLib();
    expect(isValidUsername("alice")).toBe(true);
    expect(isValidUsername("alice42")).toBe(true);
    expect(isValidUsername("alice.reviewer")).toBe(false);
    expect(isValidUsername("demo-alice")).toBe(false);
    expect(isValidUsername("Alice")).toBe(false);
    expect(isValidUsername("")).toBe(false);
    expect(isValidUsername(undefined as any)).toBe(false);
  });
});

describe("webapp claimUsername — standalone idempotent claim", () => {
  it("POSTs the canonical claim to /api/username/claim with a signature", async () => {
    const { claimUsername } = await loadLib();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200));
    const sign = vi.fn(async () => new Uint8Array(64).fill(5));
    const irkPub = new Uint8Array(32).fill(2);

    const out = await claimUsername("alice", irkPub, sign, {
      fetch: fetchMock as any,
      bytesToHex: toHex,
    });

    expect(out).toEqual({ status: 200, alreadyClaimed: false });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/username/claim");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body);
    expect(body.request.username).toBe("alice");
    expect(body.request.irkPub).toBe(toHex(irkPub));
    expect(typeof body.request.issuedAt).toBe("number");
    expect(body.signature).toBe(toHex(new Uint8Array(64).fill(5)));

    // The signed canonical-bytes are flagship/claim-username/v1 | user |
    // irkPubHex | issuedAt — pin the tag + leading fields.
    const signedBytes: Uint8Array = sign.mock.calls[0]![0];
    const signedStr = new TextDecoder().decode(signedBytes);
    const parts = signedStr.split("|");
    expect(parts[0]).toBe("flagship/claim-username/v1");
    expect(parts[1]).toBe("alice");
    expect(parts[2]).toBe(toHex(irkPub));
  });

  it("treats a 409 as success (idempotent — already claimed by this IRK)", async () => {
    const { claimUsername } = await loadLib();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(409, "already claimed"));
    const out = await claimUsername("alice", new Uint8Array(32), async () => new Uint8Array(64), {
      fetch: fetchMock as any,
      bytesToHex: toHex,
    });
    expect(out).toEqual({ status: 409, alreadyClaimed: true });
  });

  it("throws on a non-409 failure (e.g. 400 bad signature)", async () => {
    const { claimUsername } = await loadLib();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(400, "bad signature"));
    await expect(
      claimUsername("alice", new Uint8Array(32), async () => new Uint8Array(64), {
        fetch: fetchMock as any,
        bytesToHex: toHex,
      }),
    ).rejects.toThrow(/claim failed \(400\)/);
  });
});

describe("webapp openAccount — open without provisioning a server", () => {
  it("claims the username, persists identity, and opens the app shell — NO server", async () => {
    const { openAccount } = await loadLib();
    const session = fakeSession();
    const calls: Record<string, any> = {};
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200));

    const out = await openAccount("alice", {
      session,
      signWithIrk: vi.fn(async (_umk: Uint8Array, _bytes: Uint8Array) => new Uint8Array(64).fill(1)),
      bytesToHex: toHex,
      fetch: fetchMock as any,
      setUsername: vi.fn((u: string) => { calls.username = u; }),
      addProfile: vi.fn((p: object) => { calls.profile = p; }),
      dispatchInitialView: vi.fn(async () => { calls.dispatched = true; }),
    });

    // Exactly ONE network call — the standalone claim. No auth-code, no
    // RCK, no server registration: server provisioning is decoupled.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/username/claim");

    // Identity bound locally.
    expect(calls.username).toBe("alice");
    expect(calls.profile.cloudName).toBe("alice");
    expect(calls.profile.cloudRootPubHex).toBe(toHex(session.irk.publicKey));
    // Server-less profile — no demoServer, no deviceCapability.
    expect(calls.profile.demoServer).toBeNull();
    expect(calls.profile.deviceCapability).toBeNull();

    // App shell opened (zero servers — Home shows the empty-state CTA).
    expect(calls.dispatched).toBe(true);
    expect(out).toEqual({ username: "alice", alreadyClaimed: false });
  });

  it("signs the claim with the SESSION umk (binds the name to this device's key)", async () => {
    const { openAccount } = await loadLib();
    const session = fakeSession();
    const signWithIrk = vi.fn(async () => new Uint8Array(64).fill(1));
    await openAccount("bob", {
      session,
      signWithIrk,
      bytesToHex: toHex,
      fetch: vi.fn().mockResolvedValue(jsonResponse(200)) as any,
    });
    // The signer received the session UMK as the first argument.
    expect(signWithIrk.mock.calls[0]![0]).toBe(session.umk);
  });

  it("is idempotent on retry — a 409 still opens the account", async () => {
    const { openAccount } = await loadLib();
    const session = fakeSession();
    const out = await openAccount("carol", {
      session,
      signWithIrk: vi.fn(async () => new Uint8Array(64)),
      bytesToHex: toHex,
      fetch: vi.fn().mockResolvedValue(jsonResponse(409, "already claimed")) as any,
      dispatchInitialView: vi.fn(),
    });
    expect(out).toEqual({ username: "carol", alreadyClaimed: true });
  });

  it("rejects an invalid username before touching the network", async () => {
    const { openAccount } = await loadLib();
    const fetchMock = vi.fn();
    await expect(
      openAccount("alice.reviewer", {
        session: fakeSession(),
        signWithIrk: vi.fn(),
        bytesToHex: toHex,
        fetch: fetchMock as any,
      }),
    ).rejects.toThrow(/lowercase letters and digits/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses to open without a device key (umk/irk missing)", async () => {
    const { openAccount } = await loadLib();
    const fetchMock = vi.fn();
    await expect(
      openAccount("alice", {
        session: { umk: null, irk: null } as any,
        signWithIrk: vi.fn(),
        bytesToHex: toHex,
        fetch: fetchMock as any,
      }),
    ).rejects.toThrow(/device key/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("works without optional collaborators (setUsername/addProfile/dispatch)", async () => {
    const { openAccount } = await loadLib();
    const out = await openAccount("dave", {
      session: fakeSession(),
      signWithIrk: vi.fn(async () => new Uint8Array(64)),
      bytesToHex: toHex,
      fetch: vi.fn().mockResolvedValue(jsonResponse(200)) as any,
    });
    expect(out.username).toBe("dave");
  });
});
