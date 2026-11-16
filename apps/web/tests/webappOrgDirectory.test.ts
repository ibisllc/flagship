// The webapp's org directory console (lib/orgDirectoryConsole.js; docs/org-directory.md "Webapp hooks"):
// the mapping editor's text form, the LDAP form's rules, and opening the directory key and a member's
// slice with the seat's X-Wing key derived from the account key, as the phones do.
import { describe, expect, it } from "vitest";
import {
  buildOrgKeyRing,
  canonicalOrgKeyRing,
  deriveOrgSeatKemSeed,
  orgKemKeyPair,
  orgKeyChainId,
  sealOrgDirectorySlice,
} from "@flagship/protocol";
import * as dc from "../public/webapp/lib/orgDirectoryConsole.js";

const ORG = "0a".repeat(16);
const SEAT = "5e".repeat(16);
const UMK = new Uint8Array(32).fill(0x42);

describe("webapp org directory console", () => {
  it("round-trips the mapping editor's lines", () => {
    const m = dc.mappingFromLines(dc.defaultMapping("scim"), "Engineering = member\nOps = server-admin Home.Acme.flagship.services\nWiki team = app-admin acme--wiki\n", false);
    expect(m.groups).toEqual({
      Engineering: [{ role: "member" }],
      Ops: [{ role: "member" }, { role: "server-admin", servers: ["home.acme.flagship.services"] }],
      "Wiki team": [{ role: "member" }, { role: "service-admin", apps: ["acme--wiki"] }],
    });
    expect(m.defaultRoles).toEqual([]);
    expect(m.attributes).toEqual(dc.defaultMapping("scim").attributes);
    expect(dc.mappingFromLines(m, dc.mappingToLines(m), false)).toEqual(m);
    expect(() => dc.mappingFromLines(m, "Ops = boss", true)).toThrow();
  });

  it("takes only ldaps:// with the bind account, password and base DN", () => {
    const ok = { url: "ldaps://dc.acme.local", bindDn: "cn=svc", password: "pw", baseDn: "dc=acme" };
    expect(dc.ldapSettings(ok)).toMatchObject({ url: "ldaps://dc.acme.local", flavor: "ad", intervalMinutes: 15 });
    expect(dc.ldapSettings({ ...ok, openLdap: true }).flavor).toBe("openldap");
    expect(() => dc.ldapSettings({ ...ok, url: "ldap://dc.acme.local" })).toThrow();
    expect(() => dc.ldapSettings({ ...ok, password: "" })).toThrow();
  });

  it("opens the directory key sealed to the seat's X-Wing key (derived from the account key) and a member's slice", () => {
    const mine = orgKemKeyPair(deriveOrgSeatKemSeed(UMK, ORG));
    const fromBrowser = dc.seatKem(UMK, ORG);
    expect(Buffer.from(fromBrowser.kemPub).toString("hex")).toBe(Buffer.from(mine.kemPub).toString("hex"));
    const key = new Uint8Array(32).fill(7);
    const built = buildOrgKeyRing({
      orgId: ORG,
      kind: "directory-key",
      scope: "*",
      prev: null,
      key,
      recipients: [{ recipient: `seat:${SEAT}`, kemPub: mine.kemPub, kemKeyId: mine.kemKeyId, issuedAt: 1 }],
      retired: [],
      oarVersion: 1,
      issuedAt: 2,
    });
    expect(canonicalOrgKeyRing(built.ring).length).toBeGreaterThan(0);
    const rings = { chains: new Map([[orgKeyChainId("directory-key", "*"), [{ ...built, approvals: [] }]]]), refused: [] };
    const keys = dc.directoryKeys(rings, SEAT, fromBrowser.kemSecret);
    expect([...keys.keys()]).toEqual([built.ring.version]);
    expect(Buffer.from(keys.get(built.ring.version)!).toString("hex")).toBe(Buffer.from(key).toString("hex"));
    expect(dc.directoryKeys(rings, "77".repeat(16), fromBrowser.kemSecret).size).toBe(0);

    const slice = sealOrgDirectorySlice({ orgId: ORG, seatId: SEAT, kemPub: mine.kemPub, kemKeyId: mine.kemKeyId, content: { entries: [], servers: ["home.acme.flagship.services"] }, directoryKey: key, tagKeyVersion: built.ring.version, issuedAt: 3 });
    expect(slice.seatId).toBe(SEAT);
  });
});
