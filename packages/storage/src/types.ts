/**
 * Pure interfaces for the .com control-plane stores. Two implementations:
 *   - InMemory (this package), used by tests and for dev runs.
 *   - D1 (this package), used in production by the Cloudflare Worker.
 *
 * The shapes mirror the in-memory record types previously defined in the
 * apps/web routes; they're hoisted here so both runtimes can share them
 * without depending on Fastify, Workers, or any HTTP framework.
 */

export interface UsernameRecord {
  username: string;
  irkPubHex: string;
  claimedAt: number;
}

export type AuthCodeStatus = "active" | "used" | "revoked";

export interface AuthCodeRecord {
  serial: string;
  username: string;
  serverName: string;
  serverDomain: string;
  delegatedPubKeyHex: string;
  userPubKeyHex: string;
  userSignatureHex: string;
  issuedAt: number;
  expiresAt: number;
  status: AuthCodeStatus;
  recordedAt: number;
  usedAt?: number;
  revokedAt?: number;
}

export type BuildTicketStatus = "active" | "redeemed" | "revoked";

export interface BuildTicketRecord {
  code: string;
  /** The signed InstallBlob serialized as JSON. Stored opaquely; readers
   *  parse it with @flagship/iso-personalizer's installBlobFromJson. */
  blobJson: string;
  blobSignatureHex: string;
  username: string;
  serverDomain: string;
  createdAt: number;
  expiresAt: number;
  status: BuildTicketStatus;
  redeemedAt?: number;
  redemptions: number;
}

export interface ServerRecord {
  serverDomain: string;
  username: string;
  identityPubKeyHex: string;
  registeredAt: number;
  revokedAt?: number;
  revocationReason?: string;
}

export interface RoutingRecord {
  subdomain: string;
  username: string;
  rckPubKeyHex: string;
  /** The server identity currently receiving traffic for this subdomain.
   *  Empty string until the first server registers. */
  currentTargetHex: string;
  registeredAt: number;
  lastTargetUpdate: number;
  /** Highest nonce seen in a SetRoutingTarget — replay protection. */
  lastTargetNonce: string;
}

export type Result<T = void> =
  | ({ ok: true } & ({} extends T ? unknown : { value: T }))
  | { ok: false; reason: string };

export interface UsernameStorage {
  put(rec: UsernameRecord): Promise<{ ok: true } | { ok: false; reason: string }>;
  get(username: string): Promise<UsernameRecord | undefined>;
  list(): Promise<UsernameRecord[]>;
}

export interface AuthCodeStorage {
  put(rec: AuthCodeRecord): Promise<{ ok: true } | { ok: false; reason: string }>;
  get(serial: string): Promise<AuthCodeRecord | undefined>;
  /** Atomic active+now<=expiresAt → used. Returns the post-state. */
  markUsed(serial: string, now: number): Promise<{ ok: true } | { ok: false; reason: string }>;
  markRevoked(serial: string, now: number): Promise<{ ok: true } | { ok: false; reason: string }>;
}

export interface BuildTicketStorage {
  put(rec: BuildTicketRecord): Promise<{ ok: true } | { ok: false; reason: string }>;
  get(code: string): Promise<BuildTicketRecord | undefined>;
  refresh(code: string, expiresAt: number): Promise<{ ok: true } | { ok: false; reason: string }>;
  /** Increment redemption count and stamp redeemedAt; idempotent for the same now. */
  markRedeemed(code: string, now: number): Promise<void>;
}

export interface ServerStorage {
  put(rec: ServerRecord): Promise<void>;
  get(serverDomain: string): Promise<ServerRecord | undefined>;
  listForUser(username: string): Promise<ServerRecord[]>;
  revoke(serverDomain: string, reason: string, at: number): Promise<boolean>;
}

export interface InstallEvent {
  serial: string;
  seq: number;
  eventName: string;
  detail: string;
  postedAt: number;
}

export interface InstallEventStorage {
  /** Append a new event. Implementations cap the per-serial history at
   *  `maxPerSerial` (default 100); older events get dropped. */
  put(rec: Omit<InstallEvent, "seq">): Promise<{ ok: true; seq: number } | { ok: false; reason: string }>;
  list(serial: string, sinceSeq?: number): Promise<InstallEvent[]>;
}

export interface RoutingStorage {
  /** Register a fresh RCK for a subdomain. Errors if the subdomain is taken
   *  by a different RCK; idempotent for the same RCK pubkey. */
  register(rec: RoutingRecord): Promise<{ ok: true } | { ok: false; reason: string }>;
  get(subdomain: string): Promise<RoutingRecord | undefined>;
  setTarget(
    subdomain: string,
    newTargetHex: string,
    nonce: string,
    at: number,
  ): Promise<{ ok: true } | { ok: false; reason: string }>;
}

export interface SealedLuksKeyRecord {
  serverDomain: string;
  sealedKeyHex: string;
  sealedAt: number;
}

export interface UnlockKeyDeposit {
  serverDomain: string;
  unlockKeyHex: string;
  depositedAt: number;
  expiresAt: number;
}

export interface LuksKeyStorage {
  /** Server stores its sealed LUKS root key (sealed-with-BAK). Idempotent overwrite. */
  putSealed(rec: SealedLuksKeyRecord): Promise<void>;
  /** Public read of the sealed blob (useless without the phone). */
  getSealed(serverDomain: string): Promise<SealedLuksKeyRecord | undefined>;
  /** Phone deposits the unsealed key. Replaces any prior pending deposit. */
  putUnlock(rec: UnlockKeyDeposit): Promise<void>;
  /**
   * Boot stage fetches and atomically clears the deposit. Returns
   * undefined if no deposit is pending or the deposit has expired.
   */
  consumeUnlock(serverDomain: string, now: number): Promise<UnlockKeyDeposit | undefined>;
}

export interface Storage {
  usernames: UsernameStorage;
  authCodes: AuthCodeStorage;
  buildTickets: BuildTicketStorage;
  servers: ServerStorage;
  routing: RoutingStorage;
  installEvents: InstallEventStorage;
  luksKeys: LuksKeyStorage;
}
