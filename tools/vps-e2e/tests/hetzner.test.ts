/**
 * Unit tests for the Phase-E Hetzner additions: snapshot() +
 * destroyImage() + their pure parser/builder helpers.
 *
 * The rescue+dd plumbing tested in earlier phases stays unchanged;
 * this file covers only the new snapshot-lifecycle surface. No real
 * Hetzner calls — global `fetch` is stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildCreateImageBody,
  buildDdCommand,
  HetznerProvider,
  parseCreateImageResponse,
  parseImageStatus,
} from "../src/providers/hetzner.js";

describe("parseCreateImageResponse", () => {
  it("extracts a numeric image.id as a string", () => {
    expect(parseCreateImageResponse({ image: { id: 4242 } })).toEqual({
      imageId: "4242",
    });
  });
  it("accepts a string image.id (forward-compat with API changes)", () => {
    expect(parseCreateImageResponse({ image: { id: "abc" } })).toEqual({
      imageId: "abc",
    });
  });
  it("throws when the envelope is missing image.id", () => {
    expect(() => parseCreateImageResponse({})).toThrow(/image\.id/);
    expect(() => parseCreateImageResponse({ image: {} })).toThrow(/image\.id/);
  });
});

describe("parseImageStatus", () => {
  it("flags `available` as available, others as not", () => {
    expect(parseImageStatus({ image: { status: "available" } })).toEqual({
      status: "available",
      available: true,
    });
    expect(parseImageStatus({ image: { status: "creating" } })).toEqual({
      status: "creating",
      available: false,
    });
  });
  it("defaults to `unknown` when the field is missing", () => {
    expect(parseImageStatus({})).toEqual({ status: "unknown", available: false });
  });
});

describe("buildCreateImageBody", () => {
  it("encodes a snapshot-type image with the supplied description", () => {
    expect(buildCreateImageBody("flagship-demo-alice")).toEqual({
      type: "snapshot",
      description: "flagship-demo-alice",
    });
  });
});

describe("buildDdCommand", () => {
  // Regression: an earlier version JSON.stringify'd the multi-line
  // script. JSON encodes real newlines as the 2-character escape `\n`
  // inside a double-quoted string, which SSH delivers verbatim and
  // the remote shell's double-quote dequoting leaves as backslash-n.
  // bash -lc then sees a single physical line of gibberish and exits
  // silently with the script unrun — so the VPS sat idle in rescue
  // and never installed Flagship. Locking the fix in: the wire form
  // MUST contain actual newline characters AND MUST NOT contain the
  // 2-character `\n` escape inside its quoted script body.
  it("contains real newlines on the wire (not the JSON \\n escape)", () => {
    const cmd = buildDdCommand("https://example.com/foo.iso");
    expect(cmd).toContain("\n");
    // The quoted script body must NOT contain the literal 2-char
    // backslash-n sequence (which would mean we double-quoted).
    expect(cmd).not.toMatch(/\\n/);
  });

  it("wraps the script in single quotes (newline-preserving) and references the URL", () => {
    const cmd = buildDdCommand("https://example.com/foo.iso");
    // bash -lc 'script' shape — single quotes, not double.
    expect(cmd.startsWith("bash -lc '")).toBe(true);
    expect(cmd.endsWith("'")).toBe(true);
    // The inner single-quoted URL is rendered as the POSIX
    // close-escape-open dance `'\''URL'\''` because the outer wrapper
    // is also single quotes. shellQuote handles this correctly.
    expect(cmd).toContain("wget --no-verbose -O- '\\''https://example.com/foo.iso'\\''");
    expect(cmd).toContain("dd of=/dev/sda bs=4M");
    expect(cmd).toContain("reboot -f");
  });

  it("ends each logical instruction on its own physical line", () => {
    const cmd = buildDdCommand("https://example.com/foo.iso");
    // Strip the leading `bash -lc '` and trailing `'`, then split.
    const inner = cmd.slice(10, -1);
    const lines = inner.split("\n");
    expect(lines).toContain("set -euo pipefail");
    expect(lines).toContain("sync");
    expect(lines.some((l) => l.startsWith("wget "))).toBe(true);
    expect(lines.some((l) => l.startsWith("nohup "))).toBe(true);
  });
});

/* ─── HetznerProvider.snapshot() / destroyImage() with stubbed fetch ─── */

interface FakeCall {
  method: string;
  url: string;
  body?: string;
}

function stubFetch(scripted: Array<{ status: number; json: unknown }>) {
  const calls: FakeCall[] = [];
  let i = 0;
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({
      method: (init?.method as string) ?? "GET",
      url,
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    const r = scripted[i++];
    if (!r) throw new Error(`stub fetch ran out of responses at call ${i}`);
    const text = JSON.stringify(r.json);
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      text: async () => text,
    } as unknown as Response;
  });
  return { fn, calls };
}

describe("HetznerProvider.snapshot()", () => {
  let origFetch: typeof globalThis.fetch;
  beforeEach(() => {
    origFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it("creates an image, polls until available, returns the id", async () => {
    const { fn, calls } = stubFetch([
      // POST create_image → image.id=99 (status=creating in envelope)
      { status: 201, json: { image: { id: 99, status: "creating" } } },
      // GET /images/99 → still creating
      { status: 200, json: { image: { id: 99, status: "creating" } } },
      // GET /images/99 → available
      { status: 200, json: { image: { id: 99, status: "available" } } },
    ]);
    globalThis.fetch = fn as unknown as typeof globalThis.fetch;
    const p = new HetznerProvider({
      token: "tok",
      sshKeyPath: "/dev/null",
      bootPollIntervalMs: 1,
      bootPollMaxAttempts: 4,
    });
    const out = await p.snapshot("srv-1", "flagship-demo-alice");
    expect(out).toEqual({ snapshotId: "99" });
    expect(calls).toHaveLength(3);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toContain("/servers/srv-1/actions/create_image");
    expect(calls[0]!.body).toBe(
      JSON.stringify({ type: "snapshot", description: "flagship-demo-alice" }),
    );
    expect(calls[1]!.method).toBe("GET");
    expect(calls[1]!.url).toContain("/images/99");
  });

  it("throws if the snapshot enters a terminal failure state", async () => {
    const { fn } = stubFetch([
      { status: 201, json: { image: { id: 7 } } },
      { status: 200, json: { image: { id: 7, status: "failed" } } },
    ]);
    globalThis.fetch = fn as unknown as typeof globalThis.fetch;
    const p = new HetznerProvider({
      token: "tok",
      sshKeyPath: "/dev/null",
      bootPollIntervalMs: 1,
      bootPollMaxAttempts: 3,
    });
    await expect(p.snapshot("srv-x", "d")).rejects.toThrow(/terminal status failed/);
  });

  it("throws if the snapshot never becomes available before pollMax", async () => {
    const { fn } = stubFetch([
      { status: 201, json: { image: { id: 8 } } },
      { status: 200, json: { image: { id: 8, status: "creating" } } },
      { status: 200, json: { image: { id: 8, status: "creating" } } },
    ]);
    globalThis.fetch = fn as unknown as typeof globalThis.fetch;
    const p = new HetznerProvider({
      token: "tok",
      sshKeyPath: "/dev/null",
      bootPollIntervalMs: 1,
      bootPollMaxAttempts: 2,
    });
    await expect(p.snapshot("srv-y", "d")).rejects.toThrow(/did not become available/);
  });
});

describe("HetznerProvider.destroyImage()", () => {
  let origFetch: typeof globalThis.fetch;
  beforeEach(() => {
    origFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it("DELETE /images/{id} on the happy path", async () => {
    const { fn, calls } = stubFetch([{ status: 204, json: {} }]);
    globalThis.fetch = fn as unknown as typeof globalThis.fetch;
    const p = new HetznerProvider({ token: "tok", sshKeyPath: "/dev/null" });
    await p.destroyImage("123");
    expect(calls[0]!.method).toBe("DELETE");
    expect(calls[0]!.url).toContain("/images/123");
  });

  it("swallows 404 (idempotent) but propagates other errors", async () => {
    const stub404 = stubFetch([{ status: 404, json: { error: "not found" } }]);
    globalThis.fetch = stub404.fn as unknown as typeof globalThis.fetch;
    const p = new HetznerProvider({ token: "tok", sshKeyPath: "/dev/null" });
    await expect(p.destroyImage("missing")).resolves.toBeUndefined();

    const stub500 = stubFetch([{ status: 500, json: { error: "boom" } }]);
    globalThis.fetch = stub500.fn as unknown as typeof globalThis.fetch;
    await expect(p.destroyImage("123")).rejects.toThrow(/HTTP 500/);
  });
});
