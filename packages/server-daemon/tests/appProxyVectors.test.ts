// The app proxy's HTTP rules against the vectors the Rust ingress proxy runs too
// (rust/crates/flagship-ingress/tests/app_proxy_vectors.rs): the same head parses to the same
// request, the same body framing is chosen or refused, and the app receives the same headers.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { forwardRequestHeaders, isWebSocketUpgrade, parseHead, requestBodyFraming } from "../src/appConnection.js";
import { stripIdentityHeaders } from "../src/serviceProxy.js";

type Body = "none" | "chunked" | { length: number };
const V = JSON.parse(readFileSync(new URL("../test-vectors/app-proxy.json", import.meta.url), "utf8")) as {
  heads: Array<{ name: string; raw: string; expect: null | { method: string; target: string; version: string; headers: Record<string, string> } }>;
  bodies: Array<{ name: string; headers: Record<string, string>; expect: "none" | "length" | "chunked" | number }>;
  upgrades: Array<{ name: string; headers: Record<string, string>; expect: boolean }>;
  forward: Array<{ name: string; headers: Record<string, string>; set: Record<string, string>; remove: string[]; upgrade: boolean; body: Body; expect: Record<string, string> }>;
};

describe("app proxy vectors (shared with flagship-ingress)", () => {
  for (const c of V.heads) {
    it(`head: ${c.name}`, () => {
      const p = parseHead(Buffer.from(c.raw, "latin1").toString("latin1"));
      if (c.expect === null) {
        expect(p).toBeNull();
        return;
      }
      expect(p).not.toBeNull();
      expect({ method: p!.method, target: p!.path, version: p!.version, headers: { ...p!.headers } }).toEqual(c.expect);
    });
  }
  for (const c of V.bodies) {
    it(`body: ${c.name}`, () => {
      const f = requestBodyFraming(c.headers, isWebSocketUpgrade(c.headers));
      if (typeof c.expect === "number") expect("status" in f ? f.status : null).toBe(c.expect);
      else expect("kind" in f ? f.kind : null).toBe(c.expect);
    });
  }
  for (const c of V.upgrades) {
    it(`upgrade: ${c.name}`, () => expect(isWebSocketUpgrade(c.headers)).toBe(c.expect));
  }
  for (const c of V.forward) {
    it(`forward: ${c.name}`, () => {
      // As prepareAppRequest builds them, then the connection path.
      const prepared = stripIdentityHeaders(c.headers);
      for (const r of c.remove) delete prepared[r];
      Object.assign(prepared, c.set);
      const out = forwardRequestHeaders(prepared, c.upgrade);
      if (c.body === "chunked") out["transfer-encoding"] = "chunked";
      else if (typeof c.body === "object") out["content-length"] = String(c.body.length);
      expect(out).toEqual(c.expect);
    });
  }
});
