import { describe, expect, it } from "vitest";
import {
  decodeSiblingFrame,
  encodeSiblingFrame,
  FRAME_SIBLING_APP_MESSAGE,
  FRAME_SIBLING_HELLO,
  FRAME_SIBLING_SYNC_COMPLETE,
  FRAME_SIBLING_SYNC_FRAME,
  FRAME_SIBLING_TAKEOVER_ACK,
  FRAME_SIBLING_TAKEOVER_REQUEST,
  type SiblingFrame,
} from "../../src/sibling/frames.js";

function roundTrip(frame: SiblingFrame): SiblingFrame {
  const buf = encodeSiblingFrame(frame);
  const r = decodeSiblingFrame(buf);
  if (r.kind === "error") throw new Error(r.reason);
  return r.frame;
}

describe("sibling-frame encode/decode round-trip", () => {
  it("sibling-hello with all fields", () => {
    const frame: SiblingFrame = {
      type: FRAME_SIBLING_HELLO,
      payload: {
        protocolVersion: 1,
        serverId: "home.alice.flagship.services",
        challenge: "ab".repeat(32),
        challengeResponseSignature: "cd".repeat(64),
        resumeToken: "tok-1",
      },
    };
    expect(roundTrip(frame)).toEqual(frame);
  });

  it("sibling-takeover-request with embedded capability", () => {
    const frame: SiblingFrame = {
      type: FRAME_SIBLING_TAKEOVER_REQUEST,
      payload: {
        requestId: "req-1",
        fqdn: "notes.alice.flagship.services",
        capability: {
          username: "alice",
          appId: "notes",
          siblingId: "home.alice.flagship.services",
          fqdn: "notes.alice.flagship.services",
          issuedAt: 1_000,
          expiresAt: 2_000,
        },
        capabilitySignatureHex: "ef".repeat(64),
      },
    };
    expect(roundTrip(frame)).toEqual(frame);
  });

  it("sibling-sync-frame with opaque payload", () => {
    const frame: SiblingFrame = {
      type: FRAME_SIBLING_SYNC_FRAME,
      payload: { requestId: "req-1", payloadHex: "deadbeef" },
    };
    expect(roundTrip(frame)).toEqual(frame);
  });

  it("sibling-takeover-ack ok", () => {
    const frame: SiblingFrame = {
      type: FRAME_SIBLING_TAKEOVER_ACK,
      payload: { requestId: "req-1", ok: true },
    };
    expect(roundTrip(frame)).toEqual(frame);
  });

  it("sibling-takeover-ack with rejection reason", () => {
    const frame: SiblingFrame = {
      type: FRAME_SIBLING_TAKEOVER_ACK,
      payload: { requestId: "req-1", ok: false, reason: "capability expired" },
    };
    expect(roundTrip(frame)).toEqual(frame);
  });

  it("sibling-sync-complete", () => {
    const frame: SiblingFrame = {
      type: FRAME_SIBLING_SYNC_COMPLETE,
      payload: { requestId: "req-1" },
    };
    expect(roundTrip(frame)).toEqual(frame);
  });

  it("sibling-app-message", () => {
    const frame: SiblingFrame = {
      type: FRAME_SIBLING_APP_MESSAGE,
      payload: {
        appId: "notes",
        fromSiblingId: "home.alice.flagship.services",
        toSiblingId: "office.alice.flagship.services",
        payloadHex: "0011aabb",
      },
    };
    expect(roundTrip(frame)).toEqual(frame);
  });
});

describe("sibling-frame decode error handling", () => {
  it("rejects an empty buffer", () => {
    const r = decodeSiblingFrame(new Uint8Array(0));
    expect(r.kind).toBe("error");
  });

  it("rejects an unknown frame type byte", () => {
    const r = decodeSiblingFrame(new Uint8Array([0x99, 0x7b, 0x7d])); // 0x99 + "{}"
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.reason).toMatch(/unknown frame type/);
  });

  it("rejects a non-JSON payload", () => {
    const buf = new Uint8Array([FRAME_SIBLING_HELLO, ...new TextEncoder().encode("not json")]);
    const r = decodeSiblingFrame(buf);
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.reason).toMatch(/JSON/);
  });

  it("rejects a hello with a malformed challenge hex", () => {
    const buf = new Uint8Array([
      FRAME_SIBLING_HELLO,
      ...new TextEncoder().encode(JSON.stringify({
        protocolVersion: 1,
        serverId: "x.alice.flagship.services",
        challenge: "not-hex",
      })),
    ]);
    const r = decodeSiblingFrame(buf);
    expect(r.kind).toBe("error");
  });

  it("rejects a takeover-request missing capability", () => {
    const buf = new Uint8Array([
      FRAME_SIBLING_TAKEOVER_REQUEST,
      ...new TextEncoder().encode(JSON.stringify({
        requestId: "r",
        fqdn: "x.alice.flagship.services",
        capabilitySignatureHex: "00".repeat(64),
      })),
    ]);
    const r = decodeSiblingFrame(buf);
    expect(r.kind).toBe("error");
  });
});
