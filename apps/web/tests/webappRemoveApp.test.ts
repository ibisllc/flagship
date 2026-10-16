// "Remove app" on the app page: the owner's signed uninstall
// (flagship/uninstall-service/v1) to the box the page reads, the same order
// iOS's Remove service sends, and it removes the app's only copy too.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ed25519 } from "@noble/curves/ed25519.js";
// @ts-expect-error — plain-JS webapp module, no types
import { ScreensError } from "../public/webapp/lib/api.js";

const load = () =>
  import(pathToFileURL(resolve(__dirname, "..", "public", "webapp", "lib", "appPlacement.js")).href);
const VIEW = readFileSync(resolve(__dirname, "..", "public", "webapp", "views", "service-detail.js"), "utf8");
const VECTORS = JSON.parse(
  readFileSync(resolve(__dirname, "..", "..", "..", "test-vectors", "canonical-bytes.json"), "utf8"),
);
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

describe("Remove app — the signed uninstall", () => {
  it("signs the shared vector's bytes and DELETEs the app on the page's server", async () => {
    const { removeAppFromServer } = await load();
    const v = VECTORS.vectors.find((x: { name: string }) => x.name === "uninstall-service");
    expect(v).toBeDefined();
    const priv = ed25519.utils.randomSecretKey();
    const calls: Array<{ fqdn: string; path: string; init: { method: string; body: string } }> = [];
    await removeAppFromServer({
      serverFqdn: v.input.serverId,
      serviceId: `${v.input.creator}--${v.input.slug}`,
      umk: new Uint8Array(32),
      signWithIrk: async (_umk: Uint8Array, bytes: Uint8Array) => {
        expect(hex(bytes)).toBe(v.canonicalHex);
        return ed25519.sign(bytes, priv);
      },
      now: () => v.input.issuedAt,
      clientFor: (fqdn: string) => ({
        fetch: async (path: string, init: { method: string; body: string }) => {
          calls.push({ fqdn, path, init });
          return { ok: true };
        },
      }),
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ fqdn: v.input.serverId, path: "/api/services/harry--notes-app", init: { method: "DELETE" } });
    const body = JSON.parse(calls[0]!.init.body);
    expect(body.request).toEqual(v.input);
    const bytes = new TextEncoder().encode(
      ["flagship/uninstall-service/v1", v.input.serverId, v.input.creator, v.input.slug, v.input.issuedAt].join("|"),
    );
    expect(ed25519.verify(Uint8Array.from(Buffer.from(body.signature, "hex")), bytes, ed25519.getPublicKey(priv))).toBe(true);
  });

  it("refuses without an unlocked session", async () => {
    const { removeAppFromServer } = await load();
    await expect(
      removeAppFromServer({ serverFqdn: "a.b.flagship.services", serviceId: "b--x", umk: null, signWithIrk: async () => new Uint8Array(64) }),
    ).rejects.toThrow(/unlock/);
  });

  it("says what goes, where, and what the other servers keep", async () => {
    const { removeAppMessage } = await load();
    expect(removeAppMessage({ slug: "notes", server: "home.alice.flagship.services" })).toBe(
      "This uninstalls notes from home.alice.flagship.services and deletes its data there. This can't be undone.",
    );
    expect(removeAppMessage({ slug: "notes", server: "h", otherCopies: 1 })).toMatch(/Your other server keeps its copy\.$/);
    expect(removeAppMessage({ slug: "notes", server: "h", otherCopies: 2 })).toMatch(/Your other 2 servers keep their copies\.$/);
  });

  it("puts a refusal in the owner's words", async () => {
    const { removeAppErrorMessage } = await load();
    expect(removeAppErrorMessage(new ScreensError("x", 0, {}))).toMatch(/isn't paired/);
    expect(removeAppErrorMessage(new ScreensError("x", 403, {}))).toMatch(/clock/);
    expect(removeAppErrorMessage(new ScreensError("x", 404, { error: "app not installed" }))).toBe("app not installed");
  });
});

describe("Remove app — the app page", () => {
  it("offers the button (iOS's service-detail-remove-btn) to admin devices and demo accounts, says why to others", async () => {
    const { renderRemoveAppControl } = await import(pathToFileURL(resolve(__dirname, "..", "public", "webapp", "views", "service-detail.js")).href);
    expect(renderRemoveAppControl({ companion: false, adminOnly: false })).toContain('id="service-detail-remove-btn"');
    const locked: string = renderRemoveAppControl({ companion: false, adminOnly: true });
    expect(locked).not.toContain("service-detail-remove-btn");
    expect(locked).toContain("Only an admin device can remove an app.");
    expect(renderRemoveAppControl({ companion: true, adminOnly: false })).toBe("");
    expect(VIEW).toContain("${renderRemoveAppControl()}");
  });

  it("uses the add-server rule (admin root, or a demo account) for every admin-only order", async () => {
    const gate = await import(pathToFileURL(resolve(__dirname, "..", "public", "webapp", "lib", "addServerGate.js")).href);
    expect(gate.canSignAdminOrders({ adminRootSeed: new Uint8Array(32) }, null)).toBe(true);
    expect(gate.canSignAdminOrders({}, { demoServer: "demo.flagship.services" })).toBe(true);
    expect(gate.canSignAdminOrders({}, {})).toBe(false);
  });

  it("locks Runs on (copies and uninstalls) on a device that can't sign admin orders, saying why", () => {
    expect(VIEW).toContain("const adminOnly = !canSignAdminOrders();");
    expect(VIEW).toContain("runsOnModel(state.rows, { companion: companion || adminOnly,");
  });

  it("asks first, then signs with the sensitive-order key", () => {
    const fn = VIEW.slice(VIEW.indexOf("async function removeAppHere"));
    const body = fn.slice(0, fn.indexOf("\n}\n"));
    expect(body.indexOf("inlineConfirm(")).toBeGreaterThan(-1);
    expect(body.indexOf("inlineConfirm(")).toBeLessThan(body.indexOf("removeAppFromServer("));
    expect(body).toContain("signWithIrk: sensitiveSigner()");
    expect(body).toContain("danger: true");
  });
});
