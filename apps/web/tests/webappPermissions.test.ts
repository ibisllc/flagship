import { describe, expect, it } from "vitest";
// @ts-expect-error plain browser module
import { PERMISSIONS_COPY, fetchPermissions, renderPermissions, revokeOutcomeText, revokePermission } from "../public/webapp/lib/permissions.js";

const data = {
  grants: [
    { id: "k1", kind: "app-api-key", capability: "read", issuedAt: 1, expiresAt: null, secretAccess: false, openWork: [] },
    { id: "k2", kind: "mcp-key", capability: "ide", issuedAt: 1, expiresAt: 1_800_000_000_000, secretAccess: true, openWork: ["a download"] },
  ],
  pendingOperations: [{ id: "o", kind: "server-update", state: "authorized" }],
};

describe("webapp access and permissions", () => {
  it("shows every grant with its work, and an end-all button only when there is more than one", () => {
    const html = renderPermissions(data);
    expect(html).toContain('data-permission="k1"');
    expect(html).toContain("Running: a download");
    expect(html).toContain("can read secrets");
    expect(html).toContain("data-permission-revoke-all");
    expect(renderPermissions({ grants: [data.grants[0]], pendingOperations: [] })).not.toContain("data-permission-revoke-all");
  });

  it("says plainly when nothing holds access, and shows nothing for a box without the page", () => {
    expect(renderPermissions({ grants: [] })).toContain(PERMISSIONS_COPY.none);
    expect(renderPermissions(null)).toBe("");
  });

  it("escapes what the box sends", () => {
    expect(renderPermissions({ grants: [{ ...data.grants[0], capability: "<img onerror=x>" }] })).not.toContain("<img");
  });

  it("revokes one grant or all, and a missing page reads as null", async () => {
    const sent: { path: string; init: { body: string } }[] = [];
    const fetchJson = async (path: string, init: { body: string }) => { sent.push({ path, init }); return { ok: true }; };
    await revokePermission("alice--chess", "k2", fetchJson);
    await revokePermission("alice--chess", null, fetchJson);
    expect(sent[0]!.path).toBe("/api/screens/services/alice--chess/permissions/revoke");
    expect(JSON.parse(sent[0]!.init.body)).toEqual({ grantId: "k2" });
    expect(JSON.parse(sent[1]!.init.body)).toEqual({});
    expect(await fetchPermissions("x", async () => { throw Object.assign(new Error("nf"), { status: 404 }); })).toBeNull();
  });

  it("names work that did not stop", () => {
    expect(revokeOutcomeText({ revoked: 1, stuckWork: [] })).toBe("Access ended.");
    expect(revokeOutcomeText({ revoked: 2, stuckWork: ["a build"] })).toContain("a build");
  });
});
