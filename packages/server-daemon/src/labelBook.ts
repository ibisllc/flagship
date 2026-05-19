/**
 * Per-app label books (#81).
 *
 * The "no-KYC" tenet — see `docs/policy/no-kyc.md` — says: human-readable
 * names live ONLY on the user's own devices, never on `.com` and never
 * cleartext in any plane the owner doesn't physically hold.
 *
 * The invite system (#79/#80) uses opaque 16-byte tags to identify whom
 * an invite was issued to. The mapping "tag b8…ec1 → John (work email)"
 * is the load-bearing private information; this module is the canonical
 * shape for it.
 *
 * Storage of the serialized blob is intentionally NOT this module's
 * concern. It will be persisted via the user-encrypted blob being built
 * by a different worker in #71/#78 — the encrypted-blob layer sees only
 * ciphertext. The helpers below produce a deterministic byte stream the
 * blob writer wraps; the matching deserializer reverses the process on
 * read.
 *
 * Determinism: `serialize` produces byte-identical output for two
 * label-books with the same content, so the encrypted ciphertext is
 * also stable. This matters because (a) the .com blob storage uses
 * content hashes for dedup / sync, and (b) deterministic output makes
 * the round-trip property easy to assert in tests across the boundary
 * with the encrypted-blob worker.
 *
 * Immutability: all mutators (`addLabel`, `removeLabel`) return a fresh
 * `LabelBook` rather than mutating in place. Callers either persist the
 * returned map or discard it; nothing else changes. This keeps the
 * blob-writer's job trivial — re-serialize once after a batch of
 * updates.
 */

export interface LabelEntry {
  /** Free-form display name as typed on the phone (e.g. "John (work)"). */
  displayName: string;
  /** Best-effort channel hint: how the link was shared. */
  channel: "imessage" | "whatsapp" | "telegram" | "signal" | "email" | "qr" | "airdrop" | "manual" | "other";
  /**
   * Optional free-form "where this went" — e.g. an obfuscated phone
   * number, an alias, or a memo. The phone-side UI never displays
   * this to anyone except the owner. We bound it at 280 chars.
   */
  sentTo: string;
  /** UNIX ms when the owner shared the invite. */
  sentAt: number;
  /** Optional longer notes for the owner. Bounded at 2000 chars. */
  notes: string;
}

/**
 * serviceId → opaqueTagHex → LabelEntry.
 *
 * `opaqueTag` is a 16-byte secret on the wire; we key the inner map on
 * the lowercase hex form. The outer key is the same composite serviceId the
 * server-daemon uses (`<creator>--<slug>`) so the user can keep parallel
 * label books for different apps without collision.
 *
 * We use plain `Map` so the structure is JSON-serializable through the
 * helpers below; callers must NOT carry plain `Map` objects through
 * `JSON.stringify` themselves.
 */
export type LabelBook = Map<string, Map<string, LabelEntry>>;

/** Construct an empty label book. */
export function emptyLabelBook(): LabelBook {
  return new Map();
}

/**
 * Add (or overwrite) a label for `(serviceId, opaqueTag)`. Returns a fresh
 * LabelBook — the input is not mutated.
 *
 * `opaqueTag` is hex (matches the daemon-side row schema's storage
 * format); we normalize to lowercase.
 */
export function addLabel(
  book: LabelBook,
  serviceId: string,
  opaqueTag: string,
  entry: LabelEntry,
): LabelBook {
  validateAppId(serviceId);
  const tag = normalizeTag(opaqueTag);
  const validated = validateEntry(entry);
  const next = cloneBook(book);
  let inner = next.get(serviceId);
  if (!inner) {
    inner = new Map();
    next.set(serviceId, inner);
  }
  inner.set(tag, validated);
  return next;
}

/**
 * Remove a label. Idempotent — removing a missing entry returns the
 * input book unchanged structurally (but still a fresh copy).
 */
export function removeLabel(book: LabelBook, serviceId: string, opaqueTag: string): LabelBook {
  const tag = normalizeTag(opaqueTag);
  const next = cloneBook(book);
  const inner = next.get(serviceId);
  if (!inner) return next;
  inner.delete(tag);
  if (inner.size === 0) next.delete(serviceId);
  return next;
}

/**
 * Look up a label. Returns undefined when not present (or when the tag
 * is malformed — we don't throw on read, callers usually want to
 * gracefully render "unknown" in the UI).
 */
export function lookup(book: LabelBook, serviceId: string, opaqueTag: string): LabelEntry | undefined {
  if (typeof opaqueTag !== "string") return undefined;
  const tag = opaqueTag.toLowerCase();
  const inner = book.get(serviceId);
  return inner ? inner.get(tag) : undefined;
}

/** All app IDs the book carries entries for. Sorted ascending. */
export function appIds(book: LabelBook): string[] {
  return [...book.keys()].sort();
}

/** All entries for one app, sorted by tag hex. */
export function entriesForApp(
  book: LabelBook,
  serviceId: string,
): Array<{ opaqueTag: string; entry: LabelEntry }> {
  const inner = book.get(serviceId);
  if (!inner) return [];
  return [...inner.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([opaqueTag, entry]) => ({ opaqueTag, entry: { ...entry } }));
}

// ──────────────────────────────────────────────────────────────────────
// Serialization
// ──────────────────────────────────────────────────────────────────────

/**
 * Magic header so a future deserializer can detect "is this a label
 * book?" before attempting to parse, and bump the version cleanly if
 * the schema needs to grow.
 */
const MAGIC = new TextEncoder().encode("flagship/label-book/v1\n");

interface SerializedShape {
  v: 1;
  apps: Array<{
    serviceId: string;
    entries: Array<{ tag: string; entry: LabelEntry }>;
  }>;
}

/**
 * Encode a label book to a deterministic byte stream.
 *
 *  [MAGIC bytes][JSON]
 *
 * The JSON is canonicalized by:
 *   - sorting appIds ascending
 *   - within each app, sorting tags ascending
 *   - field order on every object is fixed (declared below)
 *
 * The encrypted-blob writer is expected to gzip/encrypt the result
 * separately; we don't gzip here because (a) the blob writer already
 * has its own framing/compression decisions and (b) keeping this layer
 * purely textual makes failures easier to diagnose.
 */
export function serialize(book: LabelBook): Uint8Array {
  const out: SerializedShape = {
    v: 1,
    apps: appIds(book).map((serviceId) => ({
      serviceId,
      entries: entriesForApp(book, serviceId).map(({ opaqueTag, entry }) => ({
        tag: opaqueTag,
        entry: {
          displayName: entry.displayName,
          channel: entry.channel,
          sentTo: entry.sentTo,
          sentAt: entry.sentAt,
          notes: entry.notes,
        },
      })),
    })),
  };
  // Stable stringify: object keys are written in declaration order in
  // V8, and we control declaration order here. We re-emit explicitly
  // instead of relying on JSON.stringify replacer to be safe.
  const json = JSON.stringify(out);
  const tail = new TextEncoder().encode(json);
  const combined = new Uint8Array(MAGIC.length + tail.length);
  combined.set(MAGIC, 0);
  combined.set(tail, MAGIC.length);
  return combined;
}

/**
 * Decode a label book from bytes. Returns an empty book on a corrupt
 * blob — callers that need to distinguish "missing" from "corrupt"
 * should check `book.size === 0` and re-fetch from a known-good source.
 *
 * We don't throw on field defaults: a v1 entry with a missing `notes`
 * fills in `""` so older clients that wrote partial data round-trip
 * cleanly.
 */
export function deserialize(bytes: Uint8Array): LabelBook {
  if (bytes.length < MAGIC.length) return emptyLabelBook();
  for (let i = 0; i < MAGIC.length; i++) {
    if (bytes[i] !== MAGIC[i]) return emptyLabelBook();
  }
  let parsed: unknown;
  try {
    const tail = new TextDecoder().decode(bytes.subarray(MAGIC.length));
    parsed = JSON.parse(tail);
  } catch {
    return emptyLabelBook();
  }
  const shape = parsed as Partial<SerializedShape> | null;
  if (!shape || shape.v !== 1 || !Array.isArray(shape.apps)) return emptyLabelBook();
  const book = emptyLabelBook();
  for (const a of shape.apps) {
    if (!a || typeof a.serviceId !== "string" || !Array.isArray(a.entries)) continue;
    if (!isValidAppId(a.serviceId)) continue;
    const inner = new Map<string, LabelEntry>();
    for (const e of a.entries) {
      if (!e || typeof e.tag !== "string") continue;
      const tag = e.tag.toLowerCase();
      if (!/^[0-9a-f]+$/.test(tag)) continue;
      const entry = e.entry;
      if (!entry || typeof entry !== "object") continue;
      const normalized: LabelEntry = {
        displayName: typeof entry.displayName === "string" ? entry.displayName.slice(0, 200) : "",
        channel: normalizeChannel(entry.channel),
        sentTo: typeof entry.sentTo === "string" ? entry.sentTo.slice(0, 280) : "",
        sentAt: typeof entry.sentAt === "number" && Number.isFinite(entry.sentAt) ? entry.sentAt : 0,
        notes: typeof entry.notes === "string" ? entry.notes.slice(0, 2000) : "",
      };
      inner.set(tag, normalized);
    }
    if (inner.size > 0) book.set(a.serviceId, inner);
  }
  return book;
}

// ──────────────────────────────────────────────────────────────────────
// Internals
// ──────────────────────────────────────────────────────────────────────

function cloneBook(book: LabelBook): LabelBook {
  const next: LabelBook = new Map();
  for (const [serviceId, inner] of book) {
    const innerCopy = new Map<string, LabelEntry>();
    for (const [tag, entry] of inner) innerCopy.set(tag, { ...entry });
    next.set(serviceId, innerCopy);
  }
  return next;
}

function normalizeTag(tag: string): string {
  if (typeof tag !== "string") throw new Error("opaqueTag must be a string");
  const lower = tag.toLowerCase();
  if (!/^[0-9a-f]+$/.test(lower)) throw new Error("opaqueTag must be hex");
  if (lower.length !== 32) throw new Error("opaqueTag must encode 16 bytes (32 hex chars)");
  return lower;
}

function validateAppId(serviceId: string): void {
  if (!isValidAppId(serviceId)) throw new Error(`invalid serviceId: ${serviceId}`);
}

function isValidAppId(serviceId: string): boolean {
  if (typeof serviceId !== "string" || serviceId.length === 0 || serviceId.length > 256) return false;
  // Daemon-side serviceId is `<creator>--<slug>`; keep the validator lax to
  // accommodate slugs with hyphens / digits but reject control chars.
  for (let i = 0; i < serviceId.length; i++) {
    const c = serviceId.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return false;
  }
  return true;
}

const VALID_CHANNELS: ReadonlySet<LabelEntry["channel"]> = new Set([
  "imessage",
  "whatsapp",
  "telegram",
  "signal",
  "email",
  "qr",
  "airdrop",
  "manual",
  "other",
]);

function normalizeChannel(c: unknown): LabelEntry["channel"] {
  if (typeof c === "string" && VALID_CHANNELS.has(c as LabelEntry["channel"])) {
    return c as LabelEntry["channel"];
  }
  return "other";
}

function validateEntry(e: LabelEntry): LabelEntry {
  if (typeof e !== "object" || e === null) throw new Error("entry must be an object");
  return {
    displayName: typeof e.displayName === "string" ? e.displayName.slice(0, 200) : "",
    channel: normalizeChannel(e.channel),
    sentTo: typeof e.sentTo === "string" ? e.sentTo.slice(0, 280) : "",
    sentAt: typeof e.sentAt === "number" && Number.isFinite(e.sentAt) ? e.sentAt : 0,
    notes: typeof e.notes === "string" ? e.notes.slice(0, 2000) : "",
  };
}
