import { describe, expect, it } from "vitest";
import {
  classifyServer,
  homeServerSource,
  statusBucketForKind,
} from "../public/webapp/views/home.js";

describe("webapp demo Home server source", () => {
  it("materializes the resolved demo server without a paired session", () => {
    const now = 2_000_000_000_000;
    const source = homeServerSource(null, {
      demoServer: {
        fqdn: "home.openai-build.flagship.services",
        status: "up",
        ttlIdleMinutes: 30,
      },
    }, now);

    expect(source.kind).toBe("demo");
    if (source.kind !== "demo") throw new Error("expected demo source");
    expect(source.server.serverId).toBe("home.openai-build.flagship.services");
    expect(source.fallbackPod.lastReported).toBe(now);
    const classified = classifyServer(source.server, source.fallbackPod, { now });
    expect(classified.kind).toBe("online");
    expect(statusBucketForKind(classified.kind)).toBe("online");
  });

  it("keeps a provisioning demo visible as pending", () => {
    const now = 2_000_000_000_000;
    const source = homeServerSource(null, {
      demoServer: {
        fqdn: "home.demoalice.flagship.services",
        status: "provisioning",
        phase: "installing",
        ttlIdleMinutes: 30,
      },
    }, now);

    expect(source.kind).toBe("demo");
    if (source.kind !== "demo") throw new Error("expected demo source");
    const classified = classifyServer(source.server, source.fallbackPod, { now });
    expect(classified.kind).toBe("coming-online");
    expect(statusBucketForKind(classified.kind)).toBe("pending");
  });

  it("preserves paired and empty behavior for non-demo profiles", () => {
    expect(homeServerSource("session-1", { demoServer: null })).toEqual({
      kind: "paired",
      sessionId: "session-1",
    });
    expect(homeServerSource(null, { demoServer: null })).toEqual({ kind: "empty" });
  });
});
