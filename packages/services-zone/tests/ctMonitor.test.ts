import { describe, expect, it } from "vitest";
import { expectedCertSans } from "../src/caaPin.js";
import {
  checkCtEntry,
  findUnexpectedCerts,
  monitorUserBoxes,
  type CtLogEntry,
} from "../src/ctMonitor.js";

const HOME = "home.alice.flagship.services";
const OFFICE = "office.alice.flagship.services";
const EXPECTED = expectedCertSans(HOME); // [home.alice.<apex>, *.home.alice.<apex>]

describe("checkCtEntry", () => {
  it("passes a legit cert whose SANs are exactly the expected set", () => {
    const entry: CtLogEntry = {
      sans: ["home.alice.flagship.services", "*.home.alice.flagship.services"],
      notAfter: 1_900_000_000_000,
      issuer: "Let's Encrypt",
    };
    expect(checkCtEntry(entry, EXPECTED)).toEqual({ ok: true });
  });

  it("passes a cert covering only a subset of the expected SANs", () => {
    // A cert for just the box apex (no wildcard) is still wholly within the
    // expected namespace — nothing unaccounted-for, so no alarm.
    expect(checkCtEntry({ sans: ["home.alice.flagship.services"] }, EXPECTED)).toEqual({
      ok: true,
    });
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
      sans: ["*.home.alice.flagship.services", "evil.example"],
    };
    expect(checkCtEntry(entry, EXPECTED)).toEqual({
      ok: false,
      unexpectedSans: ["evil.example"],
    });
  });

  it("alarms on the retired per-user wildcard shape (model C)", () => {
    // `[<user>, *.<user>]` is what every box minted under model C. No box
    // mints it under A′, so seeing it in CT means stale or rogue issuance.
    const entry: CtLogEntry = {
      sans: ["alice.flagship.services", "*.alice.flagship.services"],
    };
    expect(checkCtEntry(entry, EXPECTED)).toEqual({
      ok: false,
      unexpectedSans: ["alice.flagship.services", "*.alice.flagship.services"],
    });
  });

  it("is case-insensitive: mixed-case expected SANs do NOT alarm (RFC 4343)", () => {
    const entry: CtLogEntry = {
      sans: ["Home.Alice.Flagship.Services", "*.HOME.alice.flagship.SERVICES"],
    };
    expect(checkCtEntry(entry, EXPECTED)).toEqual({ ok: true });
  });

  it("is case-insensitive against a mixed-case expected set too", () => {
    const entry: CtLogEntry = { sans: ["home.alice.flagship.services"] };
    expect(
      checkCtEntry(entry, ["HOME.ALICE.FLAGSHIP.SERVICES", "*.HOME.ALICE.FLAGSHIP.SERVICES"]),
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

  it("does not flag a different box's legit-looking namespace as ours", () => {
    // office's cert is foreign to home's expected set — both SANs unexpected.
    const entry: CtLogEntry = {
      sans: ["office.alice.flagship.services", "*.office.alice.flagship.services"],
    };
    expect(checkCtEntry(entry, EXPECTED)).toEqual({
      ok: false,
      unexpectedSans: [
        "office.alice.flagship.services",
        "*.office.alice.flagship.services",
      ],
    });
  });
});

describe("findUnexpectedCerts", () => {
  it("returns only the alarming entries, each with its unexpected SANs", () => {
    const legit: CtLogEntry = {
      sans: ["home.alice.flagship.services", "*.home.alice.flagship.services"],
    };
    const apexOnly: CtLogEntry = { sans: ["home.alice.flagship.services"] };
    const foreign: CtLogEntry = { sans: ["attacker.example"] };
    const userShape: CtLogEntry = { sans: ["*.alice.flagship.services"] };

    const alarms = findUnexpectedCerts([legit, apexOnly, foreign, userShape], EXPECTED);

    expect(alarms).toEqual([
      { entry: foreign, unexpectedSans: ["attacker.example"] },
      { entry: userShape, unexpectedSans: ["*.alice.flagship.services"] },
    ]);
  });

  it("returns an empty list when every entry is legit", () => {
    const entries: CtLogEntry[] = [
      { sans: ["home.alice.flagship.services", "*.home.alice.flagship.services"] },
      { sans: ["home.alice.flagship.services"] },
      { sans: ["*.HOME.alice.flagship.services"] },
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

describe("monitorUserBoxes", () => {
  it("passes a per-box cert for any registered box, alarms on foreign names", () => {
    const homeCert: CtLogEntry = {
      sans: ["home.alice.flagship.services", "*.home.alice.flagship.services"],
    };
    const officeCert: CtLogEntry = {
      sans: ["office.alice.flagship.services", "*.office.alice.flagship.services"],
    };
    const foreign: CtLogEntry = { sans: ["phish.alice.flagship.services.evil.example"] };

    const alarms = monitorUserBoxes([HOME, OFFICE], [homeCert, officeCert, foreign]);

    expect(alarms).toEqual([
      { entry: foreign, unexpectedSans: ["phish.alice.flagship.services.evil.example"] },
    ]);
  });

  it("alarms on a cert mixing two boxes' SANs (no single box mints that set)", () => {
    const mixed: CtLogEntry = {
      sans: ["home.alice.flagship.services", "*.office.alice.flagship.services"],
    };
    expect(monitorUserBoxes([HOME, OFFICE], [mixed])).toEqual([
      {
        entry: mixed,
        unexpectedSans: [
          "home.alice.flagship.services",
          "*.office.alice.flagship.services",
        ],
      },
    ]);
  });

  it("alarms on the retired per-user wildcard shape", () => {
    const userShape: CtLogEntry = {
      sans: ["alice.flagship.services", "*.alice.flagship.services"],
    };
    expect(monitorUserBoxes([HOME], [userShape])).toEqual([
      {
        entry: userShape,
        unexpectedSans: ["alice.flagship.services", "*.alice.flagship.services"],
      },
    ]);
  });

  it("alarms on everything when the user has no registered boxes", () => {
    const entry: CtLogEntry = { sans: ["home.alice.flagship.services"] };
    expect(monitorUserBoxes([], [entry])).toEqual([
      { entry, unexpectedSans: ["home.alice.flagship.services"] },
    ]);
  });

  it("treats a mixed-case legit cert as legit (no alarm)", () => {
    const entry: CtLogEntry = {
      sans: ["Home.Alice.Flagship.Services", "*.Home.Alice.Flagship.Services"],
    };
    expect(monitorUserBoxes([HOME], [entry])).toEqual([]);
  });
});
