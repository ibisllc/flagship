/**
 * keyd's box signing list must match what the daemon really signs with the box key: a tag the
 * daemon signs but keyd refuses breaks that path on every keyd box (as app-release and the
 * peer-backup v2 tags once did), and a tag on the list that nothing signs is authority keyd
 * hands out for nothing.
 */
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BOX_SIGN_PURPOSES } from "../src/policy.js";
import { findBoxSigningSites, stripComments } from "./boxSigningSites.js";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** On the list but signed by no code on main yet; each is the box's own statement. */
const UNWIRED_BOX_PURPOSES = new Set([
  "flagship/pod-binding/v1",
  "flagship/mint-reservation/v1",
  "flagship/sibling-sync/v1",
]);

/** Signed by the owner, an admin or the account key, never by the box: keyd must refuse them. */
const NOT_BOX_PURPOSES = [
  "flagship/membership/v1",
  "flagship/service-grant/v1",
  "flagship/entitlement/v1",
  "flagship/server-order/v1",
  "flagship/app-rank/v1",
  "flagship/service-access-mode/v2",
  "flagship/update-order/v1",
  "flagship/app-copy/v1",
];

describe("box signing purposes", () => {
  const sites = findBoxSigningSites(ROOT);
  const signed = new Set(sites.flatMap((s) => s.tags));

  it("finds the daemon's box-signed messages", () => {
    for (const t of ["flagship/tunnel-hello/v2", "flagship/app-release/v1", "flagship/pb-checkin/v1", "flagship/pb-root-deposit/v1", "pb-put", "flagship/server-register/v1", "flagship/boot-auth/v1"]) {
      expect(signed, t).toContain(t);
    }
    expect(signed.size).toBeGreaterThanOrEqual(35);
  });

  it("keyd signs every tag the daemon signs with the box key", () => {
    const missing = sites.filter((s) => s.tags.some((t) => !BOX_SIGN_PURPOSES.has(t)));
    expect(missing.map((s) => `${s.file}:${s.line} ${s.tags.filter((t) => !BOX_SIGN_PURPOSES.has(t)).join(",")}`)).toEqual([]);
  });

  it("lists nothing the box does not sign", () => {
    const idle = [...BOX_SIGN_PURPOSES].filter((t) => !signed.has(t) && !UNWIRED_BOX_PURPOSES.has(t));
    expect(idle).toEqual([]);
    for (const t of NOT_BOX_PURPOSES) expect(BOX_SIGN_PURPOSES.has(t), t).toBe(false);
  });

  it("strips comments without eating strings", () => {
    expect(stripComments(`a // it's\nb "//x" /* y's */ c`)).toBe(`a \nb "//x" ${" ".repeat(9)} c`);
  });
});
