/**
 * UX-B — humanError.js maps statuses / thrown errors to plain-language
 * copy and NEVER leaks a raw `HTTP <code>` or a stack message.
 */

import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

async function load() {
  const p = resolve(__dirname, "..", "public", "webapp", "lib", "humanError.js");
  return await import(pathToFileURL(p).href);
}

describe("humanError — status mapping", () => {
  it("5xx → 'briefly unavailable'", async () => {
    const { humanError } = await load();
    for (const s of [500, 502, 503, 504]) {
      expect(humanError(s)).toMatch(/briefly unavailable/i);
    }
  });

  it("generic 4xx → 'check your connection'", async () => {
    const { humanError } = await load();
    expect(humanError(400)).toMatch(/didn't work/i);
    expect(humanError(404)).toMatch(/didn't work/i);
    expect(humanError(429)).toMatch(/didn't work/i);
  });

  it("401/403 fall to generic unless signExpired is set", async () => {
    const { humanError } = await load();
    expect(humanError(401)).toMatch(/that didn't work/i);
    expect(humanError(403)).toMatch(/that didn't work/i);
    expect(humanError(401, { signExpired: true })).toMatch(/session expired/i);
    expect(humanError(403, { signExpired: true })).toMatch(/session expired/i);
  });

  it("status 0 (no round-trip) → network copy", async () => {
    const { humanError } = await load();
    expect(humanError(0)).toMatch(/internet connection/i);
  });
});

describe("humanError — thrown-error mapping", () => {
  it("reads .status off a thrown Error (api.js / totp.js shape)", async () => {
    const { humanError } = await load();
    const e = Object.assign(new Error("HTTP 503"), { status: 503 });
    expect(humanError(e)).toMatch(/briefly unavailable/i);
  });

  it("reads a stringified status off .code (CompanionRelayError shape)", async () => {
    const { humanError } = await load();
    expect(humanError({ code: "500", message: "request-write failed: HTTP 500" })).toMatch(
      /briefly unavailable/i,
    );
  });

  it("symbolic code=network → network copy", async () => {
    const { humanError } = await load();
    expect(humanError({ code: "network", message: "network: offline" })).toMatch(
      /internet connection/i,
    );
  });

  it("a fetch TypeError (offline) → network copy", async () => {
    const { humanError } = await load();
    expect(humanError(new TypeError("Failed to fetch"))).toMatch(/internet connection/i);
  });

  it("an unknown thrown thing → generic copy, NEVER the raw message", async () => {
    const { humanError } = await load();
    const out = humanError(new Error("HTTP 418 teapot stack trace"));
    expect(out).toMatch(/try again/i);
    expect(out).not.toMatch(/HTTP/);
    expect(out).not.toMatch(/teapot/);
  });

  it("NEVER returns a string containing a raw HTTP status token", async () => {
    const { humanError } = await load();
    for (const input of [500, 404, 401, 0, new Error("HTTP 503"), { code: "503" }]) {
      expect(humanError(input)).not.toMatch(/HTTP \d/);
    }
  });
});

describe("humanError — messages that carry no status", () => {
  it("a dropped connection reads as dropped, not the raw text", async () => {
    const { humanError } = await load();
    for (const m of ["connection closed", "Connection reset by peer", "read ECONNRESET", "socket hang up", "unexpected end of stream"]) {
      const out = humanError(new Error(m));
      expect(out).toMatch(/connection dropped/i);
      expect(out).not.toContain(m);
    }
  });

  it("a timeout reads as taking too long", async () => {
    const { humanError } = await load();
    expect(humanError(new Error("request timed out"))).toMatch(/took too long/i);
    expect(humanError(Object.assign(new Error("aborted"), { name: "TimeoutError" }))).toMatch(/took too long/i);
    expect(humanError(408)).toMatch(/took too long/i);
  });

  it("'HTTP 503: error code: 1102' reads as a temporary problem", async () => {
    const { humanError } = await load();
    for (const m of ["HTTP 503: error code: 1102", "HTTP 502", "error code: 1102", "Worker exceeded resources. error code: 1102"]) {
      const out = humanError(new Error(m));
      expect(out).toMatch(/briefly unavailable/i);
      expect(out).not.toMatch(/HTTP|1102/);
    }
  });

  it("a status spelled in a message ('release failed (409): …') counts as a refusal", async () => {
    const { humanError } = await load();
    const out = humanError(new Error("release failed (409): subdomain already controlled by a different RCK"));
    expect(out).toMatch(/didn't work/i);
    expect(out).not.toMatch(/RCK|409/);
  });
});

describe("boxErrorText — known .com reasons", () => {
  it("rewrites developer reasons into sentences", async () => {
    const { boxErrorText, knownReasonText } = await load();
    const e = Object.assign(new Error("register failed"), {
      status: 409,
      body: { error: "subdomain already controlled by a different RCK" },
    });
    expect(boxErrorText(e)).toBe(
      "That name is still held by an earlier, unfinished order. Cancel that order from Home, or choose another name.",
    );
    expect(knownReasonText("stale request")).toMatch(/clock/i);
    expect(knownReasonText("invalid signature")).toMatch(/account key/i);
    expect(knownReasonText("something else")).toBeNull();
  });

  it("a reason already written as a sentence passes through", async () => {
    const { boxErrorText } = await load();
    const e = Object.assign(new Error("x"), { status: 403, body: { error: "Only an admin device of this account can add servers." } });
    expect(boxErrorText(e)).toBe("Only an admin device of this account can add servers.");
  });
});
