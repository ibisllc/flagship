import { describe, expect, it } from "vitest";
import { InMemoryNameRegistry } from "../src/registry.js";

const irkA = new Uint8Array(32).fill(1);
const irkB = new Uint8Array(32).fill(2);

describe("InMemoryNameRegistry", () => {
  it("claim returns ok for a fresh username", () => {
    const reg = new InMemoryNameRegistry();
    expect(reg.claim({ username: "harry", irkPub: irkA, claimedAt: 1 }).ok).toBe(true);
    expect(reg.ownerOf("harry")?.irkPub).toEqual(irkA);
  });

  it("rejects a different IRK trying to claim a taken name", () => {
    const reg = new InMemoryNameRegistry();
    reg.claim({ username: "harry", irkPub: irkA, claimedAt: 1 });
    const r = reg.claim({ username: "harry", irkPub: irkB, claimedAt: 2 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/already claimed/);
  });

  it("re-claim by the same IRK is idempotent (image-rebuild flow)", () => {
    const reg = new InMemoryNameRegistry();
    reg.claim({ username: "harry", irkPub: irkA, claimedAt: 1 });
    expect(reg.claim({ username: "harry", irkPub: irkA, claimedAt: 100 }).ok).toBe(true);
    expect(reg.ownerOf("harry")?.claimedAt).toBe(100);
  });

  it("rejects invalid usernames at the claim boundary", () => {
    const reg = new InMemoryNameRegistry();
    expect(reg.claim({ username: "API", irkPub: irkA, claimedAt: 1 }).ok).toBe(false);
    expect(reg.claim({ username: "-bad", irkPub: irkA, claimedAt: 1 }).ok).toBe(false);
  });

  it("normalizes case so 'Harry' and 'harry' map to the same slot", () => {
    const reg = new InMemoryNameRegistry();
    reg.claim({ username: "Harry", irkPub: irkA, claimedAt: 1 });
    expect(reg.ownerOf("HARRY")?.username).toBe("harry");
  });

  it("release removes the claim", () => {
    const reg = new InMemoryNameRegistry();
    reg.claim({ username: "harry", irkPub: irkA, claimedAt: 1 });
    expect(reg.release("harry")).toBe(true);
    expect(reg.ownerOf("harry")).toBeUndefined();
  });

  it("ownerOf returns a copy of the IRK pubkey (caller mutation cannot poison the registry)", () => {
    const reg = new InMemoryNameRegistry();
    reg.claim({ username: "harry", irkPub: irkA, claimedAt: 1 });
    const out = reg.ownerOf("harry")!;
    out.irkPub[0] = 0xff;
    expect(reg.ownerOf("harry")!.irkPub[0]).toBe(1);
  });
});
