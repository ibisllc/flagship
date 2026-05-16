/**
 * Pure-logic tests for scripts/check-push-secrets.mjs (#23). The
 * wrangler shell-out is not exercised; the missing-secret logic +
 * the `wrangler secret list` JSON parse are.
 */
import { describe, expect, it } from "vitest";
// @ts-expect-error — .mjs sibling, no types
import {
  REQUIRED_APNS,
  REQUIRED_WEBPUSH,
  REQUIRED_FCM,
  missingPushSecrets,
  parseSecretNames,
} from "./check-push-secrets.mjs";

describe("missingPushSecrets", () => {
  const liveSet = [...REQUIRED_APNS, ...REQUIRED_WEBPUSH, "SERVICES_CONTROL_SECRET"];

  it("the verified-live secret set passes (apns+webpush, FCM not required)", () => {
    expect(missingPushSecrets(liveSet)).toEqual([]);
  });

  it("flags every missing APNs secret (push would silently no-op)", () => {
    expect(missingPushSecrets([...REQUIRED_WEBPUSH])).toEqual(REQUIRED_APNS);
  });

  it("FCM is only required with --require-fcm (Android-on-Play)", () => {
    expect(missingPushSecrets(liveSet)).toEqual([]);
    expect(missingPushSecrets(liveSet, { requireFcm: true })).toEqual(REQUIRED_FCM);
  });
});

describe("parseSecretNames", () => {
  it("extracts names from the wrangler JSON array", () => {
    const json = JSON.stringify([{ name: "APNS_KEY_ID" }, { name: "SERVICES_CONTROL_SECRET" }]);
    expect(parseSecretNames(json)).toEqual(["APNS_KEY_ID", "SERVICES_CONTROL_SECRET"]);
  });
  it("is robust to junk / non-array / malformed entries", () => {
    expect(parseSecretNames("not json")).toEqual([]);
    expect(parseSecretNames('{"x":1}')).toEqual([]);
    expect(parseSecretNames('[{"nope":1},{"name":"OK"}]')).toEqual(["OK"]);
  });
});
