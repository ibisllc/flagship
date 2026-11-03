/**
 * A mock `.com` for relay-mesh tests: the CA key, the log key, a signed relay log with heads and pages, a signed
 * directory and relay blessings, served as an in-memory `FeedSource` (which can be paused: the `.com` outage).
 */
import {
  accountHash as relayAccountHash,
  nameHash as relayNameHash,
  canonicalServingPolicy,
  ed,
  makeRelayLogEntry,
  RELAY_BLESSING_TTL_MS,
  RELAY_LOG_ZERO_TIP,
  relayLogEntryHash,
  relayTunnelHost,
  signRelayBlessing,
  signRelayDirectory,
  signRelayLogEntry,
  signRelayMeshRecord,
  signDeviceCapabilityGrant,
  DIRECTORY_TTL_MS,
  FEED_PAGE_ENTRIES,
  type Keypair,
  type PhoneBeginGrant,
  type RelayBlessing,
  type RelayDirectory,
  type RelayDirectoryEntry,
  type RelayKind,
  type RelayLogBody,
  type ServingPolicy,
  type SignedRelayLogEntry,
  type SignedRelayLogHead,
} from "@flagship/protocol";
import { createHash } from "node:crypto";
import type { FeedSource } from "../../src/tunnel/mesh/feed.js";

export const APEX = "flagship.services";

export function keypair(): Keypair {
  const priv = crypto.getRandomValues(new Uint8Array(32));
  return { privateKey: priv, publicKey: ed.getPublicKey(priv) };
}

export const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");
export const nonce32 = (): string => hex(crypto.getRandomValues(new Uint8Array(16)));

/** A phone's eligibility proof (relay-mesh.md §8.3): an `admin` device grant for `device`, signed by `adminRoot`. */
export function adminProof(account: string, adminRoot: Keypair, device: Keypair, o: { scopes?: string[]; grantId?: string; now?: number } = {}): PhoneBeginGrant {
  const now = o.now ?? Date.now();
  const g = { grantId: o.grantId ?? hex(crypto.getRandomValues(new Uint8Array(16))), username: account, deviceId: hex(device.publicKey).slice(0, 32), devicePubHex: hex(device.publicKey), scopes: o.scopes ?? ["admin"], issuedAt: now - 60_000, expiresAt: now + 30 * 86_400_000 };
  const sig = signDeviceCapabilityGrant({ ...g, devicePubKey: device.publicKey, scopes: g.scopes as never }, adminRoot);
  return { grant: g, signatureHex: hex(sig), signerRoot: "admin-root" };
}

export interface FixtureRelay {
  relayId: string;
  kind: RelayKind;
  region: string;
  seedHex: string;
  key: Keypair;
}

export class MeshFixture {
  readonly ca = keypair();
  readonly logKey = keypair();
  readonly entries: SignedRelayLogEntry[] = [];
  readonly relays: FixtureRelay[] = [];
  directoryVersion = 0;
  directory: RelayDirectory | null = null;
  readonly blessings = new Map<string, RelayBlessing>();
  paused = false;
  now: () => number = () => Date.now();

  get logPub(): string {
    return hex(this.logKey.publicKey);
  }

  get caPub(): string {
    return hex(this.ca.publicKey);
  }

  addRelay(relayId: string, kind: RelayKind = "full", region = "iad"): FixtureRelay {
    const seed = crypto.getRandomValues(new Uint8Array(32));
    const r = { relayId, kind, region, seedHex: hex(seed), key: { privateKey: seed, publicKey: ed.getPublicKey(seed) } };
    this.relays.push(r);
    return r;
  }

  entry(r: FixtureRelay, ipv4 = ["127.0.0.1"]): RelayDirectoryEntry {
    return { relayId: r.relayId, relayKey: hex(r.key.publicKey), tunnelHost: relayTunnelHost(r.relayId, APEX), relayKind: r.kind, region: r.region, ipv4, ipv6: [] };
  }

  /** Mint the directory (version + 1) over `relays` (default: every relay not removed) and a blessing for each. */
  mintDirectory(relays: FixtureRelay[] = this.relays): RelayDirectory {
    const now = this.now();
    this.directoryVersion++;
    this.directory = signRelayDirectory({ servicesApex: APEX, directoryVersion: this.directoryVersion, issuedAt: now, expiresAt: now + DIRECTORY_TTL_MS, relays: relays.map((r) => this.entry(r)) }, this.ca);
    for (const r of relays) this.blessings.set(r.relayId, this.bless(r));
    return this.directory;
  }

  bless(r: FixtureRelay, o: { issuedAt?: number; expiresAt?: number } = {}): RelayBlessing {
    const issuedAt = o.issuedAt ?? this.now();
    return signRelayBlessing(
      { relayId: r.relayId, relayKey: hex(r.key.publicKey), servicesApex: APEX, tunnelHost: relayTunnelHost(r.relayId, APEX), relayKind: r.kind, nonce: nonce32(), issuedAt, expiresAt: o.expiresAt ?? issuedAt + RELAY_BLESSING_TTL_MS },
      this.ca,
    );
  }

  append(body: RelayLogBody): SignedRelayLogEntry {
    const e = makeRelayLogEntry(this.entries.length + 1, this.now(), body);
    const s = { entry: e, signature: signRelayLogEntry(APEX, e, (m) => ed.sign(m, this.logKey.privateKey)) };
    this.entries.push(s);
    return s;
  }

  head(issuedAt = this.now()): SignedRelayLogHead {
    const last = this.entries[this.entries.length - 1];
    const head = { servicesApex: APEX, sequence: last?.entry.sequence ?? 0, tipSha256: last ? relayLogEntryHash(APEX, last.entry) : RELAY_LOG_ZERO_TIP, directoryVersion: this.directoryVersion, issuedAt };
    return { head, signature: signRelayMeshRecord("relay-log-head", head, (m) => ed.sign(m, this.logKey.privateKey)) };
  }

  page(n: number): { page: number; entries: SignedRelayLogEntry[] } {
    return { page: n, entries: this.entries.filter((e) => Math.floor(e.entry.sequence / FEED_PAGE_ENTRIES) === n) };
  }

  source(): FeedSource {
    return {
      head: async () => (this.paused ? null : this.head()),
      page: async (n) => (this.paused ? null : this.page(n)),
      directory: async () => (this.paused || !this.directory ? null : { directory: this.directory, blessings: [...this.blessings.values()] }),
    };
  }

  /** Register a box (`box-register`, regGen 1 unless given) under its pod name. */
  registerBox(pod: string, boxPub: string, regGen = 1): void {
    this.append({ kind: "box-register", nameHash: relayNameHash(pod), boxPub, regGen });
  }

  authority(account: string, adminRootPub: string | null, irkPub: string, authorityGen = 1): void {
    this.append({ kind: "account-authority", accountHash: relayAccountHash(account), adminRootPub, irkPub, authorityGen });
  }

  policyHead(boxPub: string, regGen: number, p: ServingPolicy): void {
    this.append({ kind: "policy-head", boxPub, regGen, policyGen: p.policyGen, policySha256: createHash("sha256").update(canonicalServingPolicy(p)).digest("hex") });
  }
}
