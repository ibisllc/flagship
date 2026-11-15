/**
 * LDAP pull against a real OpenLDAP server (CI job `openldap` in .github/workflows/ci.yml runs slapd
 * as a service container). Skipped unless FLAGSHIP_TEST_LDAP_URL is set. The test adds two people
 * through the same client, then reads them with the box's LdapDirectorySource and the OpenLDAP
 * defaults (an `employeeType` of "disabled" stands in for a locked account; slapd here has no ppolicy).
 */
import { describe, expect, it } from "vitest";
import { Client } from "ldapts";
import { LdapDirectorySource, ldapConfigFrom } from "../src/directory/ldap.js";
import { collectSnapshot } from "../src/directory/source.js";

const url = process.env.FLAGSHIP_TEST_LDAP_URL;
const bindDn = process.env.FLAGSHIP_TEST_LDAP_BIND_DN ?? "";
const password = process.env.FLAGSHIP_TEST_LDAP_PASSWORD ?? "";
const base = process.env.FLAGSHIP_TEST_LDAP_BASE ?? "";

describe.skipIf(!url)("LDAP pull against OpenLDAP", () => {
  it("reads people with entryUUID, mail and cn, and sees a disabled one as inactive", async () => {
    const c = new Client({ url: url! });
    await c.bind(bindDn, password);
    const ou = `ou=people-${Date.now()},${base}`;
    await c.add(ou, { objectClass: ["organizationalUnit"], ou: ou.split(",")[0]!.slice(3) });
    await c.add(`uid=ana,${ou}`, { objectClass: ["inetOrgPerson"], uid: "ana", cn: "Ana Pérez", sn: "Pérez", mail: "ana@acme.example" });
    await c.add(`uid=old,${ou}`, { objectClass: ["inetOrgPerson"], uid: "old", cn: "Old", sn: "Old", mail: "old@acme.example", employeeType: "disabled" });
    await c.unbind();

    const cfg = ldapConfigFrom({ url: url!, bindDn, bindPassword: password, baseDn: ou, userFilter: "" }, "openldap", { disabled: "employeeType" });
    const people = await collectSnapshot(new LdapDirectorySource("c9".repeat(16), { ...cfg, allowPlaintextForTests: true }));
    const byMail = new Map(people.map((p) => [p.userName, p]));
    expect([...byMail.keys()].sort()).toEqual(["ana@acme.example", "old@acme.example"]);
    expect(byMail.get("ana@acme.example")).toMatchObject({ displayName: "Ana Pérez", active: true });
    expect(byMail.get("old@acme.example")!.active).toBe(false);
    expect(byMail.get("ana@acme.example")!.externalId).toMatch(/^[0-9a-f-]{36}$/);
  });
});
