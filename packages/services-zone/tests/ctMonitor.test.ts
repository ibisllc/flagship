import { describe, expect, it } from "vitest";
import { expectedCertSans } from "../src/caaPin.js";
import {
  checkCtEntry,
  findUnexpectedCerts,
  monitorUserZone,
  type CtLogEntry,
} from "../src/ctMonitor.js";

const APEX = "flagship.services";
const EXPECTED = expectedCertSans("alice", APEX); // [alice.flagship.services, *.alice.flagship.services]

describe("checkCtEntry", () => {
  it("passes a legit cert whose SANs are exactly the expected set", () => {
    const entry: CtLogEntry = {
      sans: ["alice.flagship.services", "*.alice.flagship.services"],
      notAfter: 1_900_000_000_000,
      issuer: "Let's Encrypt",
    };
    expect(checkCtEntry(entry, EXPECTED)).toEqual({ ok: true });
  });

  it("passes a cert covering only a subset of the expected SANs", () => {
    // A cert for just the apex (no wildcard) is still wholly within the
    // expected namespace — nothing unaccounted-for, so no alarm.
    expect(checkCtEntry({ sans: ["alice.flagship.services"] }, EXPECTED)).toEqual({ ok: true });
  });

  it("passes an entry with no SANs (covers nothing → nothing to alarm)", () => {
    expect(checkCtEntry({ sans: [] }, EXPECTED)).toEqual({ ok: true });
  });

  it("alarms on a foreign SAN and lists exactly the foreign name", () => {
    const entry: CtLogEntry = { sans: ["attacker.example.com"] };
    expect(checkCtEntry(entry, EXPECTED)).toEqual({
      ok: false,
      unexpectedSans: ["attacker.example.com"],
    });
  });

  it("alarms when a legit SAN is paired with a foreign one (strict: all-or-alarm)", () => {
    // The attacker bundles a real SAN to look benign; the foreign SAN must
    // still trip the alarm — we report only the offending name.
    const entry: CtLogEntry = {
      sans: ["*.alice.flagship.services", "evil.example"],
    };
    expect(checkCtEntry(entry, EXPECTED)).toEqual({
      ok: false,
      unexpectedSans: ["evil.example"],
    });
  });

  it("alarms on a two-label-deep SAN inside the user's own zone", () => {
    // `*.box.alice.flagship.services` is NOT covered by `*.alice.flagship.services`
    // (a wildcard matches one label only) and is not in the expected set —
    // this is the deprecated topology-in-URL shape and must alarm.
    const entry: CtLogEntry = { sans: ["*.box.alice.flagship.services"] };
    expect(checkCtEntry(entry, EXPECTED)).toEqual({
      ok: false,
      unexpectedSans: ["*.box.alice.flagship.services"],
    });
  });

  it("alarms on a bare two-label-deep host (e.g. app.box.alice.<apex>)", () => {
    const entry: CtLogEntry = { sans: ["app.box.alice.flagship.services"] };
    expect(checkCtEntry(entry, EXPECTED)).toEqual({
      ok: false,
      unexpectedSans: ["app.box.alice.flagship.services"],
    });
  });

  it("is case-insensitive: mixed-case expected SANs do NOT alarm (RFC 4343)", () => {
    const entry: CtLogEntry = {
      sans: ["Alice.Flagship.Services", "*.ALICE.flagship.SERVICES"],
    };
    expect(checkCtEntry(entry, EXPECTED)).toEqual({ ok: true });
  });

  it("is case-insensitive against a mixed-case expected set too", () => {
    const entry: CtLogEntry = { sans: ["alice.flagship.services"] };
    expect(
      checkCtEntry(entry, ["ALICE.FLAGSHIP.SERVICES", "*.ALICE.FLAGSHIP.SERVICES"]),
    ).toEqual({ ok: true });
  });

  it("preserves the logged casing of an unexpected SAN in the alarm", () => {
    const entry: CtLogEntry = { sans: ["EVIL.Example.COM"] };
    expect(checkCtEntry(entry, EXPECTED)).toEqual({
      ok: false,
      unexpectedSans: ["EVIL.Example.COM"],
    });
  });

  it("de-duplicates a repeated unexpected SAN in the alarm list", () => {
    const entry: CtLogEntry = { sans: ["evil.example", "EVIL.EXAMPLE", "evil.example"] };
    expect(checkCtEntry(entry, EXPECTED)).toEqual({
      ok: false,
      unexpectedSans: ["evil.example"],
    });
  });

  it("does not flag a different user's legit-looking namespace as ours", () => {
    // bob's cert is foreign to alice's monitor — both SANs are unexpected.
    const entry: CtLogEntry = {
      sans: ["bob.flagship.services", "*.bob.flagship.services"],
    };
    expect(checkCtEntry(entry, EXPECTED)).toEqual({
      ok: false,
      unexpectedSans: ["bob.flagship.services", "*.bob.flagship.services"],
    });
  });
});

describe("findUnexpectedCerts", () => {
  it("returns only the alarming entries, each with its unexpected SANs", () => {
    const legit: CtLogEntry = {
      sans: ["alice.flagship.services", "*.alice.flagship.services"],
    };
    const apexOnly: CtLogEntry = { sans: ["alice.flagship.services"] };
    const foreign: CtLogEntry = { sans: ["attacker.example"] };
    const deep: CtLogEntry = { sans: ["*.box.alice.flagship.services"] };

    const alarms = findUnexpectedCerts([legit, apexOnly, foreign, deep], EXPECTED);

    expect(alarms).toEqual([
      { entry: foreign, unexpectedSans: ["attacker.example"] },
      { entry: deep, unexpectedSans: ["*.box.alice.flagship.services"] },
    ]);
  });

  it("returns an empty list when every entry is legit", () => {
    const entries: CtLogEntry[] = [
      { sans: ["alice.flagship.services", "*.alice.flagship.services"] },
      { sans: ["alice.flagship.services"] },
      { sans: ["*.ALICE.flagship.services"] },
    ];
    expect(findUnexpectedCerts(entries, EXPECTED)).toEqual([]);
  });

  it("preserves input order among the alarms", () => {
    const a: CtLogEntry = { sans: ["a.example"] };
    const b: CtLogEntry = { sans: ["b.example"] };
    const alarms = findUnexpectedCerts([a, b], EXPECTED);
    expect(alarms.map((x) => x.entry)).toEqual([a, b]);
  });
});

describe("monitorUserZone", () => {
  it("wires expectedCertSans into findUnexpectedCerts (legit passes, foreign alarms)", () => {
    const legit: CtLogEntry = {
      sans: ["alice.flagship.services", "*.alice.flagship.services"],
    };
    const foreign: CtLogEntry = { sans: ["phish.alice.flagship.services.evil.example"] };

    const alarms = monitorUserZone("alice", APEX, [legit, foreign]);

    expect(alarms).toEqual([
      { entry: foreign, unexpectedSans: ["phish.alice.flagship.services.evil.example"] },
    ]);
  });

  it("uses the right user's namespace (alice's monitor alarms on bob's cert)", () => {
    const bobCert: CtLogEntry = {
      sans: ["bob.flagship.services", "*.bob.flagship.services"],
    };
    expect(monitorUserZone("alice", APEX, [bobCert])).toEqual([
      {
        entry: bobCert,
        unexpectedSans: ["bob.flagship.services", "*.bob.flagship.services"],
      },
    ]);
  });

  it("alarms on a two-label-deep SAN for the monitored user", () => {
    const deep: CtLogEntry = { sans: ["app.box.alice.flagship.services"] };
    expect(monitorUserZone("alice", APEX, [deep])).toEqual([
      { entry: deep, unexpectedSans: ["app.box.alice.flagship.services"] },
    ]);
  });

  it("treats a mixed-case legit cert as legit (no alarm)", () => {
    const entry: CtLogEntry = {
      sans: ["Alice.Flagship.Services", "*.Alice.Flagship.Services"],
    };
    expect(monitorUserZone("alice", APEX, [entry])).toEqual([]);
  });
});
