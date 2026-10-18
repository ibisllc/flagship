import { describe, expect, it } from "vitest";
import { challengeShieldFor } from "../src/challengeShield.js";

const RELAY = { servicesIpv4: "203.0.113.5", servicesIpv6: "2001:db8::5" };

describe("DNS-01 challenge shield switch", () => {
  it("is off by default: a challenge TXT is written alone", () => {
    expect(challengeShieldFor({}, RELAY)).toEqual({});
    expect(challengeShieldFor({ DNS_CHALLENGE_SHIELD: "0" }, RELAY)).toEqual({});
    expect(challengeShieldFor({ DNS_CHALLENGE_SHIELD: "true" }, RELAY)).toEqual({});
  });
  it("comes back only for an explicit \"1\" and a relay address", () => {
    expect(challengeShieldFor({ DNS_CHALLENGE_SHIELD: "1" }, RELAY)).toEqual({ shield: RELAY });
    expect(challengeShieldFor({ DNS_CHALLENGE_SHIELD: "1" }, undefined)).toEqual({});
  });
});
