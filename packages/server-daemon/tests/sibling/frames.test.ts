import { describe, expect, it } from "vitest";
import {
  decodeSiblingFrame,
  encodeSiblingFrame,
  FRAME_SIBLING_APP_MESSAGE,
  FRAME_SIBLING_HELLO,
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
        liveSiblings: ["office.alice.flagship.services", "garage.alice.flagship.services"],
      },
    };
    expect(roundTrip(frame)).toEqual(frame);
  });

  it("sibling-hello without optional liveSiblings", () => {
    const frame: SiblingFrame = {
      type: FRAME_SIBLING_HELLO,
      payload: {
        protocolVersion: 1,
        serverId: "home.alice.flagship.services",
        challenge: "ab".repeat(32),
      },
    };
    expect(roundTrip(frame)).toEqual(frame);
  });

  it("sibling-app-message", () => {
    const frame: SiblingFrame = {
      type: FRAME_SIBLING_APP_MESSAGE,
      payload: {
        serviceId: "notes",
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
    // 0x02 was a takeover frame in earlier drafts; now stripped.
    // Apps that need takeover semantics build them on FRAME_SIBLING_APP_MESSAGE.
    const r = decodeSiblingFrame(new Uint8Array([0x02, 0x7b, 0x7d]));
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

  it("rejects a hello whose liveSiblings entry is not a string", () => {
    const buf = new Uint8Array([
      FRAME_SIBLING_HELLO,
      ...new TextEncoder().encode(JSON.stringify({
        protocolVersion: 1,
        serverId: "x.alice.flagship.services",
        challenge: "ab".repeat(32),
        liveSiblings: [42],
      })),
    ]);
    const r = decodeSiblingFrame(buf);
    expect(r.kind).toBe("error");
  });

  it("rejects an app-message missing payloadHex", () => {
    const buf = new Uint8Array([
      FRAME_SIBLING_APP_MESSAGE,
      ...new TextEncoder().encode(JSON.stringify({
        serviceId: "notes",
        fromSiblingId: "a",
        toSiblingId: "b",
      })),
    ]);
    const r = decodeSiblingFrame(buf);
    expect(r.kind).toBe("error");
  });
});
