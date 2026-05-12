/**
 * BFF endpoint test: GET /api/screens/release-status.
 *
 * Confirms:
 *   - gated by paired-session (401 without a valid token)
 *   - returns an empty verdict when no provider is wired
 *   - returns the verifier's verdict reshaped to the wire type when the
 *     provider is wired
 */

import { describe, expect, it } from "vitest";
import { buildScreensHttp, type ScreensHttpDeps } from "../../src/screens/screensHttp.js";
import type { ReleaseStatus } from "../../src/releaseVerifier.js";
import type { ReleaseStatusResponse } from "../../src/screens/types.js";
import type { HttpRequest } from "../../src/runtime.js";

function req(over: Partial<HttpRequest>): HttpRequest {
  return {
    method: "GET",
    path: "/",
    headers: {},
    body: Buffer.alloc(0),
    ...over,
  };
}

function gate(token = "tok-good") {
  return {
    has: (t: string) => t === token,
    check: (r: HttpRequest) => {
      const hdr = r.headers["x-flagship-session"];
      if (hdr === token) return null;
      return {
        status: 401,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ error: "unauthorized" }),
      };
    },
  };
}

function makeDeps(over: Partial<ScreensHttpDeps> = {}): ScreensHttpDeps {
  return {
    gate: gate(),
    serverFqdn: "home.alice.flagship.services",
    username: "alice",
    daemonVersion: "0.0.1-test",
    startedAt: 100,
    ...over,
  };
}

describe("GET /api/screens/release-status", () => {
  it("returns 401 without a paired-session token", async () => {
    const handle = buildScreensHttp(makeDeps());
    const res = await handle(req({ path: "/api/screens/release-status" }));
    expect(res?.status).toBe(401);
  });

  it("returns an empty verdict when no releaseStatus provider is wired", async () => {
    const handle = buildScreensHttp(makeDeps());
    const res = await handle(
      req({
        path: "/api/screens/release-status",
        headers: { "x-flagship-session": "tok-good" },
      }),
    );
    expect(res?.status).toBe(200);
    const body = JSON.parse(res!.body!) as ReleaseStatusResponse;
    expect(body.rootPolicyPresent).toBe(false);
    expect(body.tracks).toEqual([]);
    expect(body.currentRelease).toBe(null);
    expect(body.validEndorsements).toEqual([]);
    expect(body.pendingTakeoverAlarm).toBe(null);
  });

  it("returns the provider's verdict reshaped to the wire type", async () => {
    const fakeStatus: ReleaseStatus = {
      rootDir: "/some/path/.maintainers",
      rootPolicyPresent: true,
      tracks: [
        {
          track: "release",
          hasPolicy: true,
          totalMandates: 1,
          validMandates: 1,
          currentHolder: "ab".repeat(32),
          currentMandateExpiresAt: "2026-07-10T00:00:00.000Z",
          successors: ["cd".repeat(32)],
          lastExpiredHolder: null,
          rejections: [],
        },
      ],
      currentRelease: {
        kind: "ReleaseEndorsement",
        version: 1,
        releaseId: "11111111-1111-4111-8111-111111111111",
        semverTag: "v0.1.0",
        commitHash: "f".repeat(40),
        previousReleaseId: null,
        previousCommitHash: null,
        intermediateCommits: ["f".repeat(40)],
        intermediateMerkleRoot: "deadbeef".repeat(8),
        endorsedNotes: null,
        issuedAt: "2026-05-12T00:00:00.000Z",
        signedBy: "ab".repeat(32),
        signatures: [],
      },
      validEndorsements: [],
      endorsementErrors: [],
      pendingTakeoverAlarm: null,
    };
    fakeStatus.validEndorsements = [fakeStatus.currentRelease!];

    const handle = buildScreensHttp(
      makeDeps({
        releaseStatus: { status: () => fakeStatus },
      }),
    );
    const res = await handle(
      req({
        path: "/api/screens/release-status",
        headers: { "x-flagship-session": "tok-good" },
      }),
    );
    expect(res?.status).toBe(200);
    const body = JSON.parse(res!.body!) as ReleaseStatusResponse;
    expect(body.rootPolicyPresent).toBe(true);
    expect(body.tracks).toHaveLength(1);
    expect(body.tracks[0]?.track).toBe("release");
    expect(body.tracks[0]?.currentHolderPubkey).toBe("ab".repeat(32));
    expect(body.tracks[0]?.successorPubkeyPrefixes).toEqual(["cdcdcdcdcdcd"]);
    expect(body.validEndorsements).toHaveLength(1);
    expect(body.validEndorsements[0]?.commitHash).toBe("f".repeat(40));
    expect(body.currentRelease?.semverTag).toBe("v0.1.0");
  });

  it("surfaces provider exceptions as 502", async () => {
    const handle = buildScreensHttp(
      makeDeps({
        releaseStatus: {
          status: () => {
            throw new Error("disk gone");
          },
        },
      }),
    );
    const res = await handle(
      req({
        path: "/api/screens/release-status",
        headers: { "x-flagship-session": "tok-good" },
      }),
    );
    expect(res?.status).toBe(502);
    const body = JSON.parse(res!.body!);
    expect(body.error).toMatch(/disk gone/);
  });
});
