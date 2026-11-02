// A start-up unlock from a server this browser already pinned reads as routine; first contact keeps
// "Is this the machine in front of you?". Mirrors iOS SecretRequestsScreen and Android ApprovalsSection.
import { describe, expect, it } from "vitest";
import { isRoutineUnlock, requestCard } from "../public/webapp/views/boot-approval.js";

const base = {
  id: "home.ada.flagship.services#ab",
  serverDomain: "home.ada.flagship.services",
  purpose: "unlock-key",
};
const pinned = { ...base, firstContact: { pinState: "pinned", refusal: null, code: "123456" } };
const firstSight = { ...base, firstContact: { pinState: "first-sight", refusal: null, code: "123456" } };

describe("webapp start-up approval wording", () => {
  it("a pinned server asking for its disk key gets the routine wording and an Unlock button", () => {
    expect(isRoutineUnlock(pinned)).toBe(true);
    const html = requestCard(pinned);
    expect(html).toContain("It's waiting for its disk key. Unlock it only if you expected it to restart.");
    expect(html).not.toContain("Is this the machine in front of you?");
    expect(html).toMatch(/data-approve-id[^>]*>\s*Unlock\s*</);
    expect(html).not.toContain("data-server-code");
  });

  it("first contact keeps the machine-in-front-of-you check", () => {
    expect(isRoutineUnlock(firstSight)).toBe(false);
    const html = requestCard(firstSight);
    expect(html).toContain("Is this the machine in front of you? Only approve if you recognise it.");
    expect(html).toContain("Yes, this is my server");
    expect(html).toContain('data-server-code="123456"');
  });

  it("a pinned server's other requests, and a refused one, are not routine", () => {
    expect(isRoutineUnlock({ ...pinned, purpose: "entitlement" })).toBe(false);
    expect(isRoutineUnlock({ ...base, firstContact: { pinState: "changed", refusal: "key-changed" } })).toBe(false);
    expect(isRoutineUnlock({ ...base, firstContact: { pinState: "awaiting-proof", refusal: null } })).toBe(false);
    expect(requestCard({ ...pinned, purpose: "entitlement" })).toContain("Yes, this is my server");
  });
});
