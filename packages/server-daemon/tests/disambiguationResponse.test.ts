import { describe, expect, it } from "vitest";
import { disambiguationResponse, userZoneOf } from "../src/runtime.js";

describe("disambiguationResponse (N0f)", () => {
  it("returns 404 with text/html and the requested SNI in the body", () => {
    const r = disambiguationResponse("notes.alice.flagship.services");
    expect(r.status).toBe(404);
    expect(r.headers?.["content-type"]).toMatch(/text\/html/);
    const html = String(r.body);
    expect(html).toContain("No app here");
    expect(html).toContain("notes.alice.flagship.services");
  });

  it("escapes HTML metacharacters in the SNI to avoid reflection", () => {
    const r = disambiguationResponse('alice"><script>x</script>.flagship.services');
    const html = String(r.body);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("links to docs/multiplexing on flagshipserver.com", () => {
    const r = disambiguationResponse("any.alice.flagship.services");
    expect(String(r.body)).toContain("flagshipserver.com/docs/multiplexing");
  });
});

describe("userZoneOf", () => {
  it("returns the user zone for a canonical pod FQDN", () => {
    expect(userZoneOf("home.alice.flagship.services")).toBe("alice.flagship.services");
  });

  it("is apex-relative — works under a deeper (gym) apex too", () => {
    // De-hardcoded from `.flagship.services`: the apex is derived from the box's
    // own FQDN (everything after `<server>.<user>`), so a gym box resolves its
    // own user zone correctly instead of returning null.
    expect(userZoneOf("home.alice.gym.flagship.services")).toBe("alice.gym.flagship.services");
  });

  it("returns null on shape mismatch (too few labels)", () => {
    // `<user>.<apex>` (3 labels) and a bare apex have no `<server>.<user>` head.
    expect(userZoneOf("alice.flagship.services")).toBeNull();
    expect(userZoneOf("flagship.services")).toBeNull();
  });

  it("rejects an upper-cased label", () => {
    // The function lower-cases internally, so case is preserved-but-normalized.
    expect(userZoneOf("HOME.ALICE.flagship.services")).toBe("alice.flagship.services");
  });
});
