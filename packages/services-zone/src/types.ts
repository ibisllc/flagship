export type FetchLike = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string }
) => Promise<{ ok: boolean; status: number; text(): Promise<string>; json(): Promise<unknown> }>;

export interface TxtRecord {
  /** Fully-qualified record name, e.g. `_acme-challenge.harry.flagship.services`. */
  name: string;
  value: string;
  /** Provider-assigned record id; absent until creation succeeds. */
  id?: string;
  /** TTL in seconds. */
  ttl?: number;
}

export interface ZoneApi {
  createTxt(record: { name: string; value: string; ttl?: number }): Promise<TxtRecord>;
  deleteTxt(id: string): Promise<void>;
  /** Convenience for listing matching TXT records (used to clean up stale challenges). */
  listTxtByName(name: string): Promise<TxtRecord[]>;
}

export interface NameRegistration {
  username: string;
  irkPub: Uint8Array;
  claimedAt: number;
}

/**
 * Source of truth for which `<user>.flagship.services` labels are claimed
 * and by whom. Storing the user's IRK pubkey here lets the registry verify
 * subsequent claim/release requests without trusting the request body.
 */
export interface NameRegistry {
  claim(reg: NameRegistration): { ok: true } | { ok: false; reason: string };
  release(username: string): boolean;
  ownerOf(username: string): NameRegistration | undefined;
  list(): NameRegistration[];
}

export interface ZoneConfig {
  /** Apex domain owned by Flagship. Default 'flagship.services'. */
  apex: string;
}
