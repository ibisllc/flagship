import { describe, expect, it } from "vitest";
import { relayRefused } from "../src/tunnel/outboundStream.js";

describe("what a box says when the hub will not open an outbound address", () => {
  it("says the address could not be reached and what to try, never that it was blocked", () => {
    const e = relayRefused("api.example.org", "forbidden-host");
    expect(e.message).toContain("api.example.org");
    expect(e.message).toMatch(/couldn't be reached/);
    expect(e.message).toMatch(/turn the relay off for this key/);
    expect(e.message).not.toMatch(/block|ban|denied|not allowed|forbidden/i);
    expect(e.refusal).toBe("forbidden-host");
  });
});
