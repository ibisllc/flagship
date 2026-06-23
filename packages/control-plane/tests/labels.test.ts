import { describe, expect, it } from "vitest";
import {
  validateServerLabel,
  validateUserLabel,
  _labelInternal,
} from "../src/labels.js";

// Two DISTINCT rules, enforced here as the authoritative source of truth:
//
//   - USERNAME (strict): /^[a-z0-9]{3,30}$/ + reserved-word check. No
//     hyphens — usernames compose into the app id `<creator>-<slug>`, so
//     a hyphen inside one would make the split ambiguous.
//   - SERVER NAME (loose): RFC-1123 DNS label /^[a-z0-9]([a-z0-9-]{0,61}
//     [a-z0-9])?$/ + a small reserved set. Interior hyphens are SAFE here
//     (server names never mix with app-names), so `media-server` is fine.

describe("validateUserLabel — strict, 3–30, dashless", () => {
  it("accepts lowercase alphanumeric handles in range", () => {
    expect(validateUserLabel("harry").ok).toBe(true);
    expect(validateUserLabel("abc").ok).toBe(true); // min length 3
    expect(validateUserLabel("media2").ok).toBe(true);
    expect(validateUserLabel("a".repeat(30)).ok).toBe(true); // max length 30
  });

  it("normalizes case to lowercase", () => {
    const r = validateUserLabel("Harry");
    if (r.ok) expect(r.label).toBe("harry");
    else throw new Error(r.reason);
  });

  it("rejects too-short labels (< 3)", () => {
    expect(validateUserLabel("").ok).toBe(false);
    expect(validateUserLabel("a").ok).toBe(false);
    expect(validateUserLabel("ab").ok).toBe(false);
  });

  it("rejects too-long labels (> 30)", () => {
    expect(validateUserLabel("a".repeat(31)).ok).toBe(false);
    expect(validateUserLabel("a".repeat(63)).ok).toBe(false);
  });

  it("accepts interior single dashes; rejects leading/trailing and `--`", () => {
    expect(validateUserLabel("my-name").ok).toBe(true);
    expect(validateUserLabel("a-b-c").ok).toBe(true);
    expect(validateUserLabel("happy-otter-4821").ok).toBe(true);
    expect(validateUserLabel("-name").ok).toBe(false); // leading dash
    expect(validateUserLabel("name-").ok).toBe(false); // trailing dash
    expect(validateUserLabel("a--b").ok).toBe(false); // `--` is the slug-creator delimiter
  });

  it("rejects uppercase that doesn't normalize, dots, underscores, spaces", () => {
    expect(validateUserLabel("na.me").ok).toBe(false);
    expect(validateUserLabel("na_me").ok).toBe(false);
    expect(validateUserLabel("na me").ok).toBe(false);
    expect(validateUserLabel("name!").ok).toBe(false);
  });

  it("rejects reserved usernames", () => {
    for (const name of _labelInternal.RESERVED_USER_LABELS) {
      // Some reserved words contain a hyphen (e.g. control-plane) and so
      // are rejected on shape too — either way they must not be ok.
      expect(validateUserLabel(name).ok).toBe(false);
    }
    expect(validateUserLabel("admin").ok).toBe(false);
    expect(validateUserLabel("flagship").ok).toBe(false);
    expect(validateUserLabel("support").ok).toBe(false);
  });

  it("bans the test-environment apex labels (docs/ui-test-gym.md §6.5)", () => {
    // `gym` is the load-bearing one: banning it as a username is what makes
    // sharing the prod zones with the `gym.` test env safe — no prod user can
    // ever own the `gym` apex label (closes the CT-monitor false-positive and
    // the gym.flagshipserver.com identity collision). The rest harden the set.
    // ALL must be rejected and ALL must be in the authoritative set; the
    // ≥3-char ones (`gym`/`test`/`staging`) are rejected specifically as
    // RESERVED (the 2-char `e2e`/`qa`/`ci` fail the length shape first — still
    // banned, just via a different gate).
    for (const reserved of ["gym", "test", "e2e", "qa", "ci", "staging"]) {
      expect(validateUserLabel(reserved).ok).toBe(false);
      expect(_labelInternal.RESERVED_USER_LABELS.has(reserved)).toBe(true);
    }
    for (const reserved of ["gym", "test", "e2e", "staging"]) {
      const r = validateUserLabel(reserved);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/reserved/);
    }
  });
});

describe("validateServerLabel — loose RFC-1123 DNS label", () => {
  it("accepts plain lowercase labels (single char too)", () => {
    expect(validateServerLabel("home").ok).toBe(true);
    expect(validateServerLabel("media2").ok).toBe(true);
    expect(validateServerLabel("h").ok).toBe(true); // 1-char allowed
    expect(validateServerLabel("a".repeat(63)).ok).toBe(true); // 63 cap
  });

  it("accepts internal hyphens (the whole point of the looser rule)", () => {
    expect(validateServerLabel("media-server").ok).toBe(true);
    expect(validateServerLabel("a-b-c").ok).toBe(true);
    expect(validateServerLabel("home-1").ok).toBe(true);
  });

  it("normalizes case to lowercase", () => {
    const r = validateServerLabel("Media-Server");
    if (r.ok) expect(r.label).toBe("media-server");
    else throw new Error(r.reason);
  });

  it("rejects leading and trailing hyphens", () => {
    expect(validateServerLabel("-home").ok).toBe(false);
    expect(validateServerLabel("home-").ok).toBe(false);
    expect(validateServerLabel("-").ok).toBe(false);
  });

  it("rejects dots, underscores, spaces, and other punctuation", () => {
    expect(validateServerLabel("ho.me").ok).toBe(false);
    expect(validateServerLabel("ho_me").ok).toBe(false);
    expect(validateServerLabel("home server").ok).toBe(false);
    expect(validateServerLabel("home!").ok).toBe(false);
  });

  it("rejects empty and over-63-char labels", () => {
    expect(validateServerLabel("").ok).toBe(false);
    expect(validateServerLabel("a".repeat(64)).ok).toBe(false);
  });

  it("rejects reserved server labels", () => {
    for (const name of _labelInternal.RESERVED_SERVER_LABELS) {
      expect(validateServerLabel(name).ok).toBe(false);
    }
    expect(validateServerLabel("www").ok).toBe(false);
    expect(validateServerLabel("api").ok).toBe(false);
    expect(validateServerLabel("flagship").ok).toBe(false);
  });
});

describe("the two rules diverge on purpose", () => {
  it("interior dashes are now OK for BOTH (the rules converged on dashes)", () => {
    // The username rule used to forbid dashes; with the `--` composite delimiter
    // it allows interior single dashes, like the server rule. They still diverge
    // on length (server min 1 / username min 3) and the reserved set, below.
    expect(validateServerLabel("media-server").ok).toBe(true);
    expect(validateUserLabel("media-server").ok).toBe(true);
  });

  it("a single-char name is OK as a server but NOT as a username (min 3)", () => {
    expect(validateServerLabel("h").ok).toBe(true);
    expect(validateUserLabel("h").ok).toBe(false);
  });

  it("a word reserved for usernames can still be a server name", () => {
    // e.g. "blog"/"docs" shadow flagshipserver.com apex routes (reserved
    // for usernames) but are harmless one label deeper under a user.
    expect(validateUserLabel("blog").ok).toBe(false);
    expect(validateServerLabel("blog").ok).toBe(true);
    expect(validateUserLabel("docs").ok).toBe(false);
    expect(validateServerLabel("docs").ok).toBe(true);
  });
});
