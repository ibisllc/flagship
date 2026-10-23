import { describe, expect, it } from "vitest";
import { buildAppSessionResolver } from "../src/appMemberSession.js";

const aid = "ab".repeat(32);
const app = { serviceId: "alice--chess", manifest: { access: { default_role: "member" } }, membership: { stableIdFor: () => "stable", members: { getRole: () => null } } } as never;
const req = { method: "GET", path: "/", headers: { cookie: "Flagship-App-Session=tok" }, body: Buffer.alloc(0) };

function resolver(principal: unknown) {
  return buildAppSessionResolver({
    sessions: { lookup: () => ({ serviceRef: "alice--chess", aid }) } as never,
    access: { isAllowed: () => true, principal: () => principal, accountRank: () => "manager", roleOf: () => "member", appIdentityKey: () => aid } as never,
  });
}

describe("which sessions need a freshness checkpoint", () => {
  it("an invited person and a co-manager are external; a device of the owner's account is not", () => {
    expect(resolver(null)(req, app)?.external).toBe(true);
    expect(resolver({ kind: "co-manager", pub: aid, shareId: "s", label: "x", level: "manage" })(req, app)?.external).toBe(true);
    expect(resolver({ kind: "device", pub: aid, deviceId: null, tier: "admin", legacy: false })(req, app)?.external).toBeUndefined();
  });
});
