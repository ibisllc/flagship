/**
 * Adapter contract tests.
 *
 * We stub `fetch` so the static adapter behaves deterministically and
 * verify the read/write flows. The GitHub OAuth path is exercised by
 * counting the PUT calls and inspecting their bodies. The ZIP fallback
 * is checked by snapshotting the magic bytes of the returned Blob.
 *
 * No real network. No real WebAuthn. No DOM.
 */

import { describe, expect, it } from "vitest";
import { generateKeypair, type Envelope } from "@maintainers/protocol";
import {
  serverAdapter,
  staticAdapter,
  type AdapterClient,
} from "../src/adapter.js";
import {
  buildGenesisMandate,
  buildKeyFile,
  makeGenesisPolicy,
  makeTrackPolicy,
  pathForKeyFile,
  pathForMandate,
  pathForTrackPolicy,
  PATH_ROOT_POLICY,
  serializeEnvelope,
  serializeJson,
} from "../src/envelopes.js";

function kp(seedByte: number) {
  const seed = new Uint8Array(32);
  seed[0] = seedByte;
  return generateKeypair(seed);
}

function genesisBundle() {
  const alice = kp(1);
  const now = new Date("2026-05-11T00:00:00Z");
  const policy = makeGenesisPolicy("demo", ["release"]);
  const trackPolicy = makeTrackPolicy("release", 60);
  const mandate = buildGenesisMandate({
    holderPub: alice.pubKey,
    holderPriv: alice.privKey,
    holderDisplayName: "Alice",
    holderEmail: "alice@example.com",
    successors: [],
    track: "release",
    now,
    durationDays: 60,
  });
  const keyfile = buildKeyFile({
    pub: alice.pubKey,
    priv: alice.privKey,
    displayName: "Alice",
    email: "alice@example.com",
    introductionMandate: mandate.mandateId,
  });
  return [
    { path: PATH_ROOT_POLICY, envelope: keyfile as Envelope, bytes: serializeJson(policy) },
    { path: pathForTrackPolicy("release"), envelope: keyfile as Envelope, bytes: serializeJson(trackPolicy) },
    { path: pathForMandate("release", mandate.issuedAt, "genesis"), envelope: mandate as Envelope, bytes: serializeEnvelope(mandate) },
    { path: pathForKeyFile("alice@example.com"), envelope: keyfile as Envelope, bytes: serializeEnvelope(keyfile) },
  ];
}

describe("staticAdapter loadProject", () => {
  it("fetches raw URLs from the github provider", async () => {
    const seen: string[] = [];
    const fakeFetch = (async (url: string | Request | URL): Promise<Response> => {
      const u = url.toString();
      seen.push(u);
      if (u.endsWith("/policy.json")) {
        return new Response(JSON.stringify({ schemaVersion: 1, project: { name: "demo" }, tracks: ["release"] }), { status: 200 });
      }
      return new Response("", { status: 404 });
    }) as unknown as typeof fetch;
    const adapter = staticAdapter({ fetchImpl: fakeFetch });
    const result = await adapter.loadProject("github.com/foo/bar");
    expect(result.ref.canonical).toBe("github.com/foo/bar");
    expect(result.folder.rootPolicy?.project.name).toBe("demo");
    expect(seen.some((u) => u.includes("raw.githubusercontent.com/foo/bar/main/.maintainers/policy.json"))).toBe(true);
  });

  it("uses knownPaths if provided to avoid the tree API", async () => {
    let called = 0;
    const fakeFetch = (async (url: string | Request | URL): Promise<Response> => {
      called++;
      const u = url.toString();
      if (u.includes("api.github.com")) {
        // tree API should NOT be consulted when knownPaths is set
        throw new Error("tree API should not have been called");
      }
      if (u.endsWith("/policy.json")) {
        return new Response(JSON.stringify({ schemaVersion: 1, project: { name: "x" }, tracks: [] }), { status: 200 });
      }
      return new Response("", { status: 404 });
    }) as unknown as typeof fetch;
    const adapter = staticAdapter({ fetchImpl: fakeFetch, knownPaths: ["policy.json"] });
    await adapter.loadProject("github.com/a/b");
    expect(called).toBeGreaterThan(0);
  });

  it("reports exists=false when the folder is empty", async () => {
    const fakeFetch = (async () => new Response("", { status: 404 })) as unknown as typeof fetch;
    const adapter = staticAdapter({ fetchImpl: fakeFetch, knownPaths: ["policy.json"] });
    const result = await adapter.loadProject("github.com/empty/repo");
    expect(result.exists).toBe(false);
  });
});

describe("staticAdapter submit (ZIP fallback)", () => {
  it("returns a Blob with the ZIP signature when no OAuth token is set", async () => {
    const fakeFetch = (async () => new Response("", { status: 404 })) as unknown as typeof fetch;
    const adapter = staticAdapter({ fetchImpl: fakeFetch });
    const result = await adapter.submitBundle({
      repoUrl: "github.com/foo/bar",
      entries: genesisBundle(),
    });
    expect(result.kind).toBe("downloadable");
    if (result.kind !== "downloadable") return;
    const ab = await result.blob.arrayBuffer();
    const bytes = new Uint8Array(ab);
    // ZIP local file header signature: 50 4b 03 04
    expect(bytes[0]).toBe(0x50);
    expect(bytes[1]).toBe(0x4b);
    expect(bytes[2]).toBe(0x03);
    expect(bytes[3]).toBe(0x04);
    expect(result.filename).toMatch(/foo-bar/);
  });
});

describe("staticAdapter submit (OAuth)", () => {
  it("PUTs each entry through the GitHub contents API", async () => {
    const calls: { url: string; method: string; body: string }[] = [];
    const fakeFetch = (async (url: string | Request | URL, init?: RequestInit): Promise<Response> => {
      const u = url.toString();
      calls.push({
        url: u,
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? init.body : "",
      });
      return new Response(JSON.stringify({ content: { sha: "abc123" } }), { status: 200 });
    }) as unknown as typeof fetch;
    const adapter = staticAdapter({ fetchImpl: fakeFetch, oauthToken: "tok" });
    const entries = genesisBundle();
    const result = await adapter.submitBundle({
      repoUrl: "github.com/foo/bar",
      entries,
    });
    expect(result.kind).toBe("committed");
    if (result.kind !== "committed") return;
    expect(result.sha).toBe("abc123");
    expect(calls).toHaveLength(entries.length);
    expect(calls.every((c) => c.method === "PUT")).toBe(true);
    expect(calls.every((c) => c.url.includes("api.github.com"))).toBe(true);
    expect(calls.every((c) => c.url.includes(".maintainers/"))).toBe(true);
  });
});

describe("serverAdapter contract", () => {
  it("posts the bundle to /submitBundle", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fakeFetch = (async (url: string | Request | URL, init?: RequestInit): Promise<Response> => {
      const u = url.toString();
      calls.push({ url: u, init });
      if (u.endsWith("/submitBundle")) {
        return new Response(JSON.stringify({ kind: "committed", sha: "deadbeef" }), { status: 200 });
      }
      throw new Error("unexpected URL: " + u);
    }) as unknown as typeof fetch;
    const adapter: AdapterClient = serverAdapter({
      baseUrl: "https://example.test",
      fetchImpl: fakeFetch,
      bearer: "tok",
    });
    const result = await adapter.submitBundle({
      repoUrl: "github.com/foo/bar",
      entries: genesisBundle(),
    });
    expect(result.kind).toBe("committed");
    if (result.kind === "committed") expect(result.sha).toBe("deadbeef");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.init?.method).toBe("POST");
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer tok");
  });

  it("loadProject calls the right endpoint and decodes base64 files", async () => {
    const fileBytes = new TextEncoder().encode(
      JSON.stringify({ schemaVersion: 1, project: { name: "from-server" }, tracks: ["release"] }),
    );
    const b64 = btoa(String.fromCharCode(...fileBytes));
    const fakeFetch = (async (url: string | Request | URL): Promise<Response> => {
      const u = url.toString();
      if (u.includes("/loadProject")) {
        return new Response(
          JSON.stringify({
            ref: {
              provider: "github.com",
              owner: "foo",
              repo: "bar",
              ref: "main",
              canonical: "github.com/foo/bar",
            },
            files: { "policy.json": b64 },
            exists: true,
          }),
          { status: 200 },
        );
      }
      throw new Error("unexpected URL: " + u);
    }) as unknown as typeof fetch;
    const adapter = serverAdapter({ baseUrl: "https://example.test", fetchImpl: fakeFetch });
    const result = await adapter.loadProject("github.com/foo/bar");
    expect(result.folder.rootPolicy?.project.name).toBe("from-server");
    expect(result.exists).toBe(true);
  });
});
