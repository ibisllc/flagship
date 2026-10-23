import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ed, restoredAccessApproveCanonicalBytes, verifyRestoredAccessApprove } from "@flagship/protocol";
// @ts-expect-error plain browser module
import { RESTORED_COPY, approveRestoredDraft, canonicalRestoredAccessApproveBytes, fetchRestoredDraft, restoredCardHtml } from "../public/webapp/lib/restoredAccess.js";

const vectors = JSON.parse(readFileSync(new URL("../../../packages/protocol/test-vectors/restored-access-approve/vectors.json", import.meta.url), "utf8"));
const order = { serviceRef: "alice--chess", draftSha256: "ab".repeat(32), issuedAt: 77 };

describe("webapp restored permissions", () => {
  it("builds the shared vector's canonical bytes, and refuses every other order's", () => {
    expect(new TextDecoder().decode(canonicalRestoredAccessApproveBytes(vectors.order))).toBe(vectors.canonical);
    for (const c of vectors.invalid) expect(new TextDecoder().decode(canonicalRestoredAccessApproveBytes(c.order))).toBe(c.canonical);
  });

  it("builds the bytes the box verifies", () => {
    expect(Buffer.from(canonicalRestoredAccessApproveBytes(order)).toString()).toBe(Buffer.from(restoredAccessApproveCanonicalBytes(order)).toString());
    expect(() => canonicalRestoredAccessApproveBytes({ ...order, draftSha256: "xyz" })).toThrow();
    expect(() => canonicalRestoredAccessApproveBytes({ ...order, serviceRef: "a|b" })).toThrow();
  });

  it("approving signs that exact draft with the admin key and posts it to the box", async () => {
    const priv = new Uint8Array(32).fill(9);
    let sent: { url: string; body: string } | null = null;
    await approveRestoredDraft(
      { baseUrl: "https://home.alice.flagship.services", serviceRef: order.serviceRef, draftSha256: order.draftSha256, umk: new Uint8Array(32), signWithIrk: async (_u: unknown, b: Uint8Array) => ed.sign(b, priv) },
      { now: () => 77, fetch: async (url: string, init: { body: string }) => { sent = { url, body: init.body }; return { ok: true, json: async () => ({ ok: true }) }; } },
    );
    expect(sent!.url).toBe("https://home.alice.flagship.services/api/service-access/restored");
    const body = JSON.parse(sent!.body);
    expect(body.request).toEqual(order);
    expect(verifyRestoredAccessApprove(order, Uint8Array.from(Buffer.from(body.signature, "hex")), ed.getPublicKey(priv))).toBe(true);
  });

  it("finds this app's draft, and reads an older box as having none", async () => {
    const drafts = [{ serviceRef: "alice--chess", sha256: "a".repeat(64), people: 2, mode: "restricted" }, { serviceRef: "alice--other", sha256: "b".repeat(64), people: 1, mode: "open" }];
    expect((await fetchRestoredDraft("alice--chess", async () => ({ drafts })))?.people).toBe(2);
    expect(await fetchRestoredDraft("alice--none", async () => ({ drafts }))).toBeNull();
    expect(await fetchRestoredDraft("x", async () => { throw Object.assign(new Error("nf"), { status: 404 }); })).toBeNull();
  });

  it("only an admin sees the buttons, and nothing renders without a draft", () => {
    const escape = (s: string) => s;
    const d = { serviceRef: "alice--chess", sha256: "a".repeat(64), people: 1, mode: "restricted" };
    expect(restoredCardHtml(null, { admin: true, escape })).toBe("");
    expect(restoredCardHtml(d, { admin: true, escape })).toContain("sa-restored-approve");
    expect(restoredCardHtml({ ...d, mode: "open" }, { admin: true, escape })).toContain("1 person on the old list. The app was open to all.");
    const other = restoredCardHtml(d, { admin: false, escape });
    expect(other).not.toContain("sa-restored-approve");
    expect(other).toContain(RESTORED_COPY.adminOnly);
  });
});
