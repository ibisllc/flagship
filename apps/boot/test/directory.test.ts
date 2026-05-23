import { describe, it, expect } from "vitest";
import { HttpDirectoryClient, usernameFromServerDomain } from "../src/directory.js";

describe("usernameFromServerDomain", () => {
  it("derives the user label from <server>.<user>.<apex>", () => {
    expect(usernameFromServerDomain("kitchen.alice.flagship.services", "flagship.services")).toBe("alice");
  });
  it("works for a custom apex (cloneable)", () => {
    expect(usernameFromServerDomain("nas.bob.boxes.acme.example", "boxes.acme.example")).toBe("bob");
  });
  it("returns null when the domain isn't under the apex", () => {
    expect(usernameFromServerDomain("kitchen.alice.elsewhere.test", "flagship.services")).toBeNull();
  });
  it("returns null without a <server>.<user> prefix", () => {
    expect(usernameFromServerDomain("alice.flagship.services", "flagship.services")).toBeNull();
  });
});

describe("HttpDirectoryClient — mocked identity plane (no network)", () => {
  const apex = "flagship.services";
  const base = "https://id.example";
  const SERVER = "kitchen.alice.flagship.services";
  const boxStk = "ab".repeat(32);
  const ownerIrk = "cd".repeat(32);

  function fetchStub(routes: Record<string, unknown>): typeof fetch {
    return (async (input: RequestInfo | URL) => {
      const u = String(input);
      const path = new URL(u).pathname;
      if (path in routes) {
        return new Response(JSON.stringify(routes[path]), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;
  }

  it("resolves the box STK from /pods (matching serverDomain)", async () => {
    const dir = new HttpDirectoryClient({
      identityPlaneUrl: base,
      apex,
      fetchImpl: fetchStub({
        "/api/users/alice/pods": { pods: [{ serverDomain: SERVER, identityPubKey: boxStk }] },
      }),
    });
    expect(await dir.boxStkForDomain(SERVER)).toBe(boxStk);
  });

  it("returns null for a revoked pod", async () => {
    const dir = new HttpDirectoryClient({
      identityPlaneUrl: base,
      apex,
      fetchImpl: fetchStub({
        "/api/users/alice/pods": { pods: [{ serverDomain: SERVER, identityPubKey: boxStk, revokedAt: 123 }] },
      }),
    });
    expect(await dir.boxStkForDomain(SERVER)).toBeNull();
  });

  it("resolves the owner IRK from /pubkey-cert (only when the server exists)", async () => {
    const dir = new HttpDirectoryClient({
      identityPlaneUrl: base,
      apex,
      fetchImpl: fetchStub({
        "/api/users/alice/pods": { pods: [{ serverDomain: SERVER, identityPubKey: boxStk }] },
        "/api/users/alice/pubkey-cert": { binding: { pubKey: ownerIrk }, signature: "00" },
      }),
    });
    expect(await dir.ownerIrkForDomain(SERVER)).toBe(ownerIrk);
  });

  it("returns null for the owner IRK when the server isn't registered", async () => {
    const dir = new HttpDirectoryClient({
      identityPlaneUrl: base,
      apex,
      fetchImpl: fetchStub({
        "/api/users/alice/pubkey-cert": { binding: { pubKey: ownerIrk } },
        // no /pods row → server unknown
      }),
    });
    expect(await dir.ownerIrkForDomain(SERVER)).toBeNull();
  });

  it("returns null when /pods has no matching serverDomain", async () => {
    const dir = new HttpDirectoryClient({
      identityPlaneUrl: base,
      apex,
      fetchImpl: fetchStub({
        "/api/users/alice/pods": { pods: [{ serverDomain: "other.alice.flagship.services", identityPubKey: boxStk }] },
      }),
    });
    expect(await dir.boxStkForDomain(SERVER)).toBeNull();
  });
});
