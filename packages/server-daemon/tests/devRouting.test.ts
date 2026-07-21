/**
 * `dev--` request routing (feat/dev-prod-dataspace, spec §4).
 *
 * Pins the label parse (prod byte-identical to today; dev diverts only on the
 * reserved `dev--` prefix), the cross-author interaction, and the fail-explicit
 * 409 when a dev request has no live dev dataspace (never a silent fall-through
 * to prod). Cross-leak is impossible by construction: the selector maps space →
 * principal with no path from one to the other.
 */
import { describe, expect, it } from "vitest";
import {
  parseSpaceLabel,
  isDevLabel,
  selectDataPrincipal,
} from "../src/buildmodes/devRouting.js";

describe("parseSpaceLabel", () => {
  it("prod labels are unchanged (byte-identical routing to today)", () => {
    expect(parseSpaceLabel("notes")).toEqual({ space: "prod", serviceLabel: "notes" });
    expect(parseSpaceLabel("notes--bob")).toEqual({ space: "prod", serviceLabel: "notes--bob" });
  });

  it("dev-- prefix selects the dev space and strips the marker", () => {
    expect(parseSpaceLabel("dev--notes")).toEqual({ space: "dev", serviceLabel: "notes" });
  });

  it("preserves a cross-author composite under the dev marker", () => {
    expect(parseSpaceLabel("dev--notes--bob")).toEqual({ space: "dev", serviceLabel: "notes--bob" });
  });

  it("is case-insensitive on the marker but preserves the service label case-fold", () => {
    expect(parseSpaceLabel("DEV--Notes").space).toBe("dev");
  });

  it("does not treat a bare 'dev' or 'dev-x' (single dash) label as dev-space", () => {
    expect(parseSpaceLabel("dev").space).toBe("prod");
    expect(parseSpaceLabel("dev-tools").space).toBe("prod");
    expect(parseSpaceLabel("dev--").space).toBe("prod"); // empty service label ⇒ not a valid dev address
  });

  it("isDevLabel agrees with parseSpaceLabel", () => {
    expect(isDevLabel("dev--notes")).toBe(true);
    expect(isDevLabel("notes")).toBe(false);
  });
});

describe("selectDataPrincipal", () => {
  const prod = { url: "PROD" };
  const dev = { url: "DEV" };

  it("prod request → prod principal", () => {
    expect(selectDataPrincipal({ space: "prod", prod, dev })).toEqual({ ok: true, principal: prod });
  });

  it("dev request with a live dev dataspace → dev principal", () => {
    expect(selectDataPrincipal({ space: "dev", prod, dev })).toEqual({ ok: true, principal: dev });
  });

  it("dev request with NO dev dataspace → 409 (never silently hits prod)", () => {
    const r = selectDataPrincipal({ space: "dev", prod });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(409);
      expect(r.reason).toMatch(/start a dev session/);
    }
  });

  it("a prod request never receives the dev principal", () => {
    const r = selectDataPrincipal({ space: "prod", prod, dev });
    expect(r.ok && r.principal).toBe(prod);
  });
});
