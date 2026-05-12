/**
 * Programmatically build a `.maintainers/` fixture tree, returning a
 * URL → text map that mock-fetch can read from. We sign every envelope
 * with deterministic keypairs so tests are reproducible.
 */
import {
  generateKeypair,
  signMandate,
  signKeyFile,
  intermediateMerkleRoot,
  signReleaseEndorsement,
  type KeyFile,
  type Mandate,
  type ReleaseEndorsement,
  type RootPolicy,
  type TrackPolicy,
} from "@maintainers/protocol";

export interface Fixture {
  rawBase: (path: string) => string;
  files: Map<string, string>;
  alice: { privKey: string; pubKey: string };
  bob: { privKey: string; pubKey: string };
  carol: { privKey: string; pubKey: string };
  policy: RootPolicy;
  releasePolicy: TrackPolicy;
  caPolicy: TrackPolicy;
  mandates: { release: Mandate[]; ca: Mandate[] };
  keys: KeyFile[];
  endorsements: ReleaseEndorsement[];
}

export interface FixtureOptions {
  /**
   * Inject a takeover by Bob after Alice's release-track mandate expires.
   * If false, Alice renews continuously.
   */
  takeover?: boolean;
  /**
   * Mark Bob's key as recently rotated (yellow alarm trigger).
   */
  recentEmailRotation?: boolean;
  /**
   * Make Alice's current release mandate expire within `expiresInDays`.
   */
  expiresInDays?: number;
  /** A reproducible "now" used to compute issuedAt fields. */
  now: Date;
}

function kp(seedByte: number) {
  const seed = new Uint8Array(32);
  seed[0] = seedByte;
  return generateKeypair(seed);
}

export function buildFixture(opts: FixtureOptions): Fixture {
  const alice = kp(11);
  const bob = kp(22);
  const carol = kp(33);

  const now = opts.now;
  const policy: RootPolicy = {
    schemaVersion: 1,
    project: { name: "fixture-project", homepage: "https://example.com" },
    tracks: ["release", "ca"],
  };
  const releasePolicy: TrackPolicy = {
    track: "release",
    description: "Signs release endorsements",
    defaultMandateDuration: "60d",
    approvalRule: { kind: "threshold", threshold: 1, of: "anyAuthorizedSigner" },
  };
  const caPolicy: TrackPolicy = {
    track: "ca",
    defaultMandateDuration: "60d",
    approvalRule: { kind: "threshold", threshold: 1, of: "anyAuthorizedSigner" },
  };

  // KeyFiles
  const aliceKey = signKeyFile(
    {
      kind: "KeyFile",
      version: 1,
      pubkey: alice.pubKey,
      displayName: "Alice",
      currentEmail: "alice@example.com",
      emailHistory: [
        { email: "alice@example.com", from: new Date(now.getTime() - 90 * 86400000).toISOString(), to: null },
      ],
      metadata: { photo: null, github: "alice", role: "release engineer" },
      introductionMandate: "00000000-0000-0000-0000-000000000000",
      signature: "" as any,
    },
    alice.privKey,
  );
  let bobKey = signKeyFile(
    {
      kind: "KeyFile",
      version: 1,
      pubkey: bob.pubKey,
      displayName: "Bob",
      currentEmail: "bob-new@example.com",
      emailHistory: [
        { email: "bob-old@example.com", from: new Date(now.getTime() - 365 * 86400000).toISOString(), to: new Date(now.getTime() - 5 * 86400000).toISOString() },
        { email: "bob-new@example.com", from: opts.recentEmailRotation ? new Date(now.getTime() - 2 * 86400000).toISOString() : new Date(now.getTime() - 60 * 86400000).toISOString(), to: null },
      ],
      metadata: { photo: null, github: "bob", role: "successor" },
      introductionMandate: "00000000-0000-0000-0000-000000000001",
      signature: "" as any,
    },
    bob.privKey,
  );
  if (!opts.recentEmailRotation) {
    // Make Bob's "new" email old enough that no banner fires
    bobKey = signKeyFile(
      {
        kind: "KeyFile",
        version: 1,
        pubkey: bob.pubKey,
        displayName: "Bob",
        currentEmail: "bob@example.com",
        emailHistory: [
          { email: "bob@example.com", from: new Date(now.getTime() - 365 * 86400000).toISOString(), to: null },
        ],
        metadata: { photo: null, github: "bob", role: "successor" },
        introductionMandate: "00000000-0000-0000-0000-000000000001",
        signature: "" as any,
      },
      bob.privKey,
    );
  }
  const carolKey = signKeyFile(
    {
      kind: "KeyFile",
      version: 1,
      pubkey: carol.pubKey,
      displayName: "Carol",
      currentEmail: "carol@example.com",
      emailHistory: [
        { email: "carol@example.com", from: new Date(now.getTime() - 200 * 86400000).toISOString(), to: null },
      ],
      metadata: { photo: null, github: "carol", role: "second successor" },
      introductionMandate: "00000000-0000-0000-0000-000000000002",
      signature: "" as any,
    },
    carol.privKey,
  );

  // Release mandates
  const releaseMandates: Mandate[] = [];
  const genesisIssuedAt = new Date(now.getTime() - 90 * 86400000).toISOString();
  const genesisExpiresAt = new Date(now.getTime() - 30 * 86400000).toISOString();
  releaseMandates.push(
    signMandate(
      {
        kind: "Mandate",
        version: 1,
        mandateId: "11111111-1111-1111-1111-111111111111",
        track: "release",
        holder: alice.pubKey,
        issuedAt: genesisIssuedAt,
        expiresAt: genesisExpiresAt,
        successors: [bob.pubKey, carol.pubKey],
        signedBy: alice.pubKey,
      },
      [{ privKey: alice.privKey }],
    ),
  );

  if (opts.takeover) {
    // Bob takes over after Alice's mandate expired
    const takeoverIssuedAt = new Date(now.getTime() - 29 * 86400000).toISOString();
    const expiresInDays = opts.expiresInDays ?? 30;
    const takeoverExpiresAt = new Date(now.getTime() + expiresInDays * 86400000).toISOString();
    releaseMandates.push(
      signMandate(
        {
          kind: "Mandate",
          version: 1,
          mandateId: "22222222-2222-2222-2222-222222222222",
          track: "release",
          holder: bob.pubKey,
          issuedAt: takeoverIssuedAt,
          expiresAt: takeoverExpiresAt,
          successors: [bob.pubKey, carol.pubKey],
          signedBy: bob.pubKey,
        },
        [{ privKey: bob.privKey }],
      ),
    );
  } else {
    // Alice renews
    const renewIssuedAt = new Date(now.getTime() - 31 * 86400000).toISOString();
    const expiresInDays = opts.expiresInDays ?? 30;
    const renewExpiresAt = new Date(now.getTime() + expiresInDays * 86400000).toISOString();
    releaseMandates.push(
      signMandate(
        {
          kind: "Mandate",
          version: 1,
          mandateId: "22222222-2222-2222-2222-222222222222",
          track: "release",
          holder: alice.pubKey,
          issuedAt: renewIssuedAt,
          expiresAt: renewExpiresAt,
          successors: [bob.pubKey, carol.pubKey],
          signedBy: alice.pubKey,
        },
        [{ privKey: alice.privKey }],
      ),
    );
  }

  // CA mandates — just Alice all the way through (active)
  const caMandates: Mandate[] = [
    signMandate(
      {
        kind: "Mandate",
        version: 1,
        mandateId: "33333333-3333-3333-3333-333333333333",
        track: "ca",
        holder: alice.pubKey,
        issuedAt: new Date(now.getTime() - 60 * 86400000).toISOString(),
        expiresAt: new Date(now.getTime() + 60 * 86400000).toISOString(),
        successors: [bob.pubKey],
        signedBy: alice.pubKey,
      },
      [{ privKey: alice.privKey }],
    ),
  ];

  // A release endorsement signed by the current release-track holder
  const intermediate = ["a".repeat(40), "b".repeat(40)];
  const root = intermediateMerkleRoot(intermediate);
  const currentReleaseHolderPriv = opts.takeover ? bob.privKey : alice.privKey;
  const currentReleaseHolderPub = opts.takeover ? bob.pubKey : alice.pubKey;
  const endorsement = signReleaseEndorsement(
    {
      kind: "ReleaseEndorsement",
      version: 1,
      releaseId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      semverTag: "v0.1.0",
      commitHash: "c".repeat(40),
      previousReleaseId: null,
      previousCommitHash: null,
      intermediateCommits: intermediate,
      intermediateMerkleRoot: root,
      endorsedNotes: "first release",
      issuedAt: new Date(now.getTime() - 1 * 86400000).toISOString(),
      signedBy: currentReleaseHolderPub,
    },
    [{ privKey: currentReleaseHolderPriv }],
  );

  // Build the index file
  const releasePath0 = ".maintainers/tracks/release/mandates/0001-genesis.json";
  const releasePath1 = ".maintainers/tracks/release/mandates/0002-renew.json";
  const caPath0 = ".maintainers/tracks/ca/mandates/0001-genesis.json";
  const aliceKeyPath = ".maintainers/keys/alice@example.com.json";
  const bobKeyPath = ".maintainers/keys/bob@example.com.json";
  const carolKeyPath = ".maintainers/keys/carol@example.com.json";
  const endorsementPath = ".maintainers/endorsements/v0.1.0.json";

  const index = {
    version: 1,
    tracks: {
      release: [releasePath0, releasePath1],
      ca: [caPath0],
    },
    keys: [aliceKeyPath, bobKeyPath, carolKeyPath],
    endorsements: [endorsementPath],
  };

  // The "raw base URL" is a deterministic prefix; tests can re-use it
  // to make assertions about what got fetched.
  const RAW_BASE = "https://raw.example.test/owner/repo/main/";
  const files = new Map<string, string>();
  files.set(RAW_BASE + ".maintainers/policy.json", JSON.stringify(policy));
  files.set(RAW_BASE + ".maintainers/index.json", JSON.stringify(index));
  files.set(RAW_BASE + ".maintainers/tracks/release/policy.json", JSON.stringify(releasePolicy));
  files.set(RAW_BASE + ".maintainers/tracks/ca/policy.json", JSON.stringify(caPolicy));
  files.set(RAW_BASE + releasePath0, JSON.stringify(releaseMandates[0]));
  files.set(RAW_BASE + releasePath1, JSON.stringify(releaseMandates[1]));
  files.set(RAW_BASE + caPath0, JSON.stringify(caMandates[0]));
  files.set(RAW_BASE + aliceKeyPath, JSON.stringify(aliceKey));
  files.set(RAW_BASE + bobKeyPath, JSON.stringify(bobKey));
  files.set(RAW_BASE + carolKeyPath, JSON.stringify(carolKey));
  files.set(RAW_BASE + endorsementPath, JSON.stringify(endorsement));

  return {
    rawBase: (path: string) => RAW_BASE + path.replace(/^\/+/, ""),
    files,
    alice,
    bob,
    carol,
    policy,
    releasePolicy,
    caPolicy,
    mandates: { release: releaseMandates, ca: caMandates },
    keys: [aliceKey, bobKey, carolKey],
    endorsements: [endorsement],
  };
}

/** A vitest-friendly fake `fetch` that serves from a Map. */
export function makeFakeFetch(files: Map<string, string>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const body = files.get(url);
    if (body === undefined) {
      return new Response("", { status: 404 });
    }
    return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

/** Tiny in-memory KV store implementing the extension's KVStore. */
export function makeMemKv(): { get(k: string): Promise<string | undefined>; set(k: string, v: string): Promise<void>; map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    async get(k) { return map.get(k); },
    async set(k, v) { map.set(k, v); },
  };
}
