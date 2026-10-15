import { describe, expect, it } from "vitest";
import { buildPushForwarder } from "@flagship/control-plane";
import { buildPushUserDevices, type UserDevicesForward } from "../src/pushUserDevices.js";

const tokens = {
  async listByUser(username: string) {
    if (username !== "alice") return [];
    return [
      { tokenId: "t1", platform: "apns" as const, providerToken: "APNSTOKEN" },
      { tokenId: "t2", platform: "fcm" as const, providerToken: "FCMTOKEN" },
    ] as never;
  },
};

const webpushPayload = new TextEncoder().encode(
  JSON.stringify({ kind: "secret-request", serverFqdn: "home.alice.flagship.services", purpose: "unlock-key" }),
);

describe("buildPushUserDevices", () => {
  it("gives a secret-request wake its kind and approvals link, nothing identifying", async () => {
    const sent: UserDevicesForward[] = [];
    const push = buildPushUserDevices(tokens, async (a) => { sent.push(a); }, "gym.flagshipserver.com");
    await push("alice", "secret-request", webpushPayload);
    expect(sent).toHaveLength(1);
    const a = sent[0]!;
    expect(a.category).toBe("secret-request");
    expect(a.sealedPayloadHex).toBe("");
    expect(a.displayData).toEqual({
      kind: "secret-request",
      deepLink: "https://gym.flagshipserver.com/app/secret-requests",
    });
    expect(a.webpushPayloadBytes).toBe(webpushPayload);
  });

  it("defaults the link to the production apex", async () => {
    const sent: UserDevicesForward[] = [];
    await buildPushUserDevices(tokens, async (a) => { sent.push(a); })("alice", "secret-request");
    expect(sent[0]!.displayData?.deepLink).toBe("https://flagshipserver.com/app/secret-requests");
  });

  it("adds no display data to other categories and skips accounts without tokens", async () => {
    const sent: UserDevicesForward[] = [];
    const push = buildPushUserDevices(tokens, async (a) => { sent.push(a); });
    await push("alice", "cert-alert");
    await push("bob", "secret-request");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.displayData).toBeUndefined();
  });

  it("swallows a failing provider", async () => {
    const push = buildPushUserDevices(tokens, async () => { throw new Error("apns down"); });
    await expect(push("alice", "secret-request")).resolves.toBeUndefined();
  });

  it("reaches APNs with the alert text and a top-level link", async () => {
    const bodies: Array<{ url: string; body: string }> = [];
    const fetchImpl = async (url: string, init?: { body?: string | Uint8Array | ArrayBuffer }) => {
      bodies.push({ url, body: typeof init?.body === "string" ? init.body : "" });
      const json = url.includes("oauth2") ? { access_token: "tok", expires_in: 3600 } : {};
      return { ok: true, status: 200, text: async () => "", json: async () => json };
    };
    const forwarder = buildPushForwarder({
      apns: { keyId: "K", teamId: "T", privateKeyPem: APNS_TEST_KEY, bundleId: "com.flagship.app" },
      fetchImpl,
      now: () => 1_700_000_000_000,
    });
    await buildPushUserDevices(tokens, forwarder)("alice", "secret-request", webpushPayload);
    const apns = JSON.parse(bodies.find((b) => b.url.includes("/3/device/"))!.body);
    expect(apns.aps.category).toBe("secret-request");
    expect(apns.aps.alert).toEqual({ title: "Flagship", body: "A server is waiting for your approval." });
    expect(apns.kind).toBe("secret-request");
    expect(apns.deepLink).toBe("https://flagshipserver.com/app/secret-requests");
    expect(JSON.stringify(apns)).not.toContain("alice");
    expect(JSON.stringify(apns)).not.toContain("flagship.services");
  });
});

const APNS_TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgcVB2+bq/sRVh4a9z
XK+4vc8tAkTF5R7XlJLioNYePZehRANCAATxCC37T/vfvyrC9DWfgVwPQ21tFt1n
NCEaFHQPSliSCPNgeoIJnVCmBnBTHnJB70P222WNXY/q0LCdmx/jxPfr
-----END PRIVATE KEY-----`;
