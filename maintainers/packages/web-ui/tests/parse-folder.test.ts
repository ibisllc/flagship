import { describe, expect, it } from "vitest";
import { generateKeypair } from "@maintainers/protocol";
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
import { lookupHolder, parseMaintainersFolder } from "../src/parse-folder.js";

function makeRawFolder(): Map<string, Uint8Array> {
  const seed = new Uint8Array(32);
  seed[0] = 1;
  const alice = generateKeypair(seed);
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
    mandateId: "abc-123",
  });
  const keyfile = buildKeyFile({
    pub: alice.pubKey,
    priv: alice.privKey,
    displayName: "Alice",
    email: "alice@example.com",
    introductionMandate: mandate.mandateId,
  });
  const files = new Map<string, Uint8Array>();
  files.set(PATH_ROOT_POLICY, serializeJson(policy));
  files.set(pathForTrackPolicy("release"), serializeJson(trackPolicy));
  files.set(pathForMandate("release", mandate.issuedAt, "genesis"), serializeEnvelope(mandate));
  files.set(pathForKeyFile("alice@example.com"), serializeEnvelope(keyfile));
  return files;
}

describe("parseMaintainersFolder", () => {
  it("parses a well-formed folder", () => {
    const folder = parseMaintainersFolder({ files: makeRawFolder() });
    expect(folder.rootPolicy?.project.name).toBe("demo");
    expect(folder.tracks).toHaveLength(1);
    const t = folder.tracks[0]!;
    expect(t.name).toBe("release");
    expect(t.policy?.defaultMandateDuration).toBe("P60D");
    expect(t.mandates).toHaveLength(1);
    expect(folder.keys).toHaveLength(1);
    expect(folder.keys[0]!.keyfile?.displayName).toBe("Alice");
  });

  it("surfaces malformed mandate files but keeps going", () => {
    const files = makeRawFolder();
    files.set("tracks/release/mandates/garbage.json", new TextEncoder().encode("{not json"));
    const folder = parseMaintainersFolder({ files });
    expect(folder.tracks[0]!.malformedMandates).toHaveLength(1);
    expect(folder.tracks[0]!.mandates).toHaveLength(1);
  });

  it("sorts mandates by issuedAt", () => {
    const seed = new Uint8Array(32);
    seed[0] = 1;
    const alice = generateKeypair(seed);
    const policy = makeTrackPolicy("release", 60);
    const m1 = buildGenesisMandate({
      holderPub: alice.pubKey,
      holderPriv: alice.privKey,
      holderDisplayName: "A",
      holderEmail: "a@example.com",
      successors: [],
      track: "release",
      now: new Date("2026-02-01T00:00:00Z"),
      durationDays: 60,
      mandateId: "m1",
    });
    const m2 = buildGenesisMandate({
      holderPub: alice.pubKey,
      holderPriv: alice.privKey,
      holderDisplayName: "A",
      holderEmail: "a@example.com",
      successors: [],
      track: "release",
      now: new Date("2026-01-01T00:00:00Z"),
      durationDays: 60,
      mandateId: "m2",
    });
    const files = new Map<string, Uint8Array>();
    files.set(pathForTrackPolicy("release"), serializeJson(policy));
    // Insert in reverse order to test the sort.
    files.set("tracks/release/mandates/zz.json", serializeEnvelope(m1));
    files.set("tracks/release/mandates/aa.json", serializeEnvelope(m2));
    const folder = parseMaintainersFolder({ files });
    expect(folder.tracks[0]!.mandates.map((m) => m.mandateId)).toEqual(["m2", "m1"]);
  });

  it("lookupHolder returns null for an unknown pubkey", () => {
    const folder = parseMaintainersFolder({ files: makeRawFolder() });
    expect(lookupHolder(folder, "0".repeat(64))).toBeNull();
  });

  it("lookupHolder returns name+email for a known pubkey", () => {
    const folder = parseMaintainersFolder({ files: makeRawFolder() });
    const known = folder.keys[0]!.keyfile!;
    const h = lookupHolder(folder, known.pubkey);
    expect(h?.displayName).toBe("Alice");
    expect(h?.email).toBe("alice@example.com");
  });

  it("collects unknown files instead of throwing", () => {
    const files = makeRawFolder();
    files.set("weird-thing.txt", new TextEncoder().encode("hi"));
    const folder = parseMaintainersFolder({ files });
    expect(folder.unknownFiles).toContain("weird-thing.txt");
  });
});
