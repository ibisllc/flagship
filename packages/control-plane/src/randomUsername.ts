/**
 * Random username suggestion (docs/username-suggestion-queue.md).
 *
 * Account creation HANDS the user one random `<adjective>-<noun>` handle (no
 * number suffix); they accept it or regenerate. Names come from a pre-validated
 * queue (grammar + not-claimed + not a `.com` property), so the slow DNS work is
 * amortized off the request path, and regenerating is rate-limited with an
 * escalating per-device cooldown. A refused name is popped-and-gone — defeating
 * the reject-then-predict attack.
 */

import type {
  UsernameStorage,
  SuggestionQueueStorage,
  SuggestThrottleStorage,
} from "@flagship/storage";
import { validateUserLabel } from "./labels.js";
import { ok, malformed, type HandlerResponseWithHeaders } from "./types.js";

// Short (3–7 char), friendly, non-offensive building blocks. The longest handle
// is ≤ 7+1+7 = 15 chars (well under 30) and stays readable. Lists are wide
// enough that the adjective-noun space (no number) comfortably outlasts the
// first user cohort even after the `.com` exclusion thins the usable pool.
export const ADJECTIVES: readonly string[] = [
  "happy", "brave", "calm", "clever", "cosmic", "dapper", "eager", "fancy",
  "gentle", "glad", "jolly", "keen", "kind", "lively", "lucky", "merry",
  "mighty", "nifty", "noble", "plucky", "proud", "quick", "quiet", "rapid",
  "ready", "royal", "sage", "shiny", "silly", "snug", "spry", "sturdy",
  "sunny", "swift", "tidy", "vivid", "warm", "witty", "zesty", "amber",
  "azure", "coral", "crisp", "fuzzy", "golden", "ivory", "jade", "lunar",
  "misty", "olive", "rosy", "ruby", "scarlet", "silver", "solar", "teal",
  "wild", "brisk", "bold", "deft", "fleet", "frosty", "hardy", "humble",
  "mellow", "perky", "polite", "rustic", "sleek", "smart", "stout", "trusty",
  "bright", "cheery", "cozy", "dandy", "elated", "fond", "hearty", "jovial",
  "nimble", "peppy", "serene", "sweet", "upbeat", "vital", "zippy", "agile",
  "breezy", "chirpy", "clear", "cool", "dreamy", "fair", "fresh", "genial",
  "grand", "jaunty", "limber", "lush", "mild", "peachy", "placid", "prime",
  "pure", "quirky", "robust", "snappy", "suave", "tender", "balmy", "comfy",
  "daring", "frank", "hale", "jazzy", "lofty", "spruce", "true", "wise",
];

export const NOUNS: readonly string[] = [
  "otter", "panda", "fox", "lynx", "heron", "robin", "finch", "wren",
  "owl", "hawk", "crane", "swan", "stork", "egret", "ibis", "tern",
  "puffin", "raven", "magpie", "sparrow", "badger", "beaver", "marten",
  "stoat", "weasel", "ermine", "hare", "rabbit", "mouse", "vole", "shrew",
  "ferret", "civet", "genet", "ocelot", "serval", "caracal", "margay",
  "tapir", "okapi", "bison", "moose", "elk", "ibex", "chamois", "markhor",
  "gecko", "skink", "agama", "tuatara", "newt", "axolotl", "frog", "toad",
  "carp", "tench", "rudd", "bream", "perch", "pike", "trout", "smelt",
  "comet", "nebula", "quasar", "pulsar", "meteor", "cedar", "maple", "birch",
  "willow", "aspen", "alder", "rowan", "hazel", "spruce", "larch", "pine",
  "koala", "lemur", "dingo", "quokka", "wombat", "numbat", "possum", "gerbil",
  "corgi", "beagle", "parrot", "falcon", "osprey", "plover", "godwit", "snipe",
  "curlew", "avocet", "gannet", "fulmar", "petrel", "auklet", "murre", "wigeon",
  "opal", "pearl", "topaz", "onyx", "beryl", "garnet", "zircon", "agate",
  "jasper", "quartz", "flint", "slate", "pebble", "fern", "moss", "clover",
  "daisy", "tulip", "lotus", "poppy", "iris", "lily", "thyme", "basil",
  "mango", "guava", "lychee", "melon", "cherry", "plum", "peach", "quince",
];

/** Defensive substring denylist — guards against an unlucky pairing forming an
 *  offensive token across the word boundary. The curated lists already avoid
 *  these; this is belt-and-braces. */
const OFFENSIVE_SUBSTRINGS: readonly string[] = [
  "nazi", "rape", "slut", "cunt", "fuck", "shit", "porn", "kkk",
];

/** Uniform [0,1) from a CSPRNG (Workers + Node 20 both expose globalThis.crypto). */
function cryptoUnit(): number {
  const buf = new Uint32Array(1);
  (globalThis.crypto ?? crypto).getRandomValues(buf);
  return buf[0]! / 2 ** 32;
}

function pick<T>(arr: readonly T[], rng: () => number): T {
  return arr[Math.floor(rng() * arr.length)]!;
}

/** One `<adjective>-<noun>` candidate (no number suffix). Not availability- or
 *  `.com`-checked — use {@link tryGenerateCandidate}. */
export function randomCandidate(rng: () => number = cryptoUnit): string {
  return `${pick(ADJECTIVES, rng)}-${pick(NOUNS, rng)}`;
}

// ── `.com` exclusion via DNS-over-HTTPS ────────────────────────────────────

/** A minimal fetch shape (so the DoH lookup is injectable + mockable). */
export type SuggestFetch = (
  url: string,
  init?: { headers?: Record<string, string> },
) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;

/** The `.com` forms a candidate could collide with: the literal `<name>.com`
 *  and the de-dashed `<namewithoutdashes>.com` (the common brand spelling). */
export function comFormsFor(name: string): string[] {
  const lower = name.toLowerCase();
  const forms = new Set<string>([`${lower}.com`]);
  const dedashed = lower.replace(/-/g, "");
  if (dedashed && dedashed !== lower) forms.add(`${dedashed}.com`);
  return [...forms];
}

/** True iff `<fqdn>` is a registered domain, per a DoH `NS` query (registered
 *  apexes carry NS records ⇒ Status 0 with answers; unregistered ⇒ NXDOMAIN).
 *  THROWS on a lookup/parse failure so callers can treat "unknown" as exclude. */
async function dohRegistered(fqdn: string, fetchImpl: SuggestFetch): Promise<boolean> {
  const url = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(fqdn)}&type=NS`;
  const res = await fetchImpl(url, { headers: { accept: "application/dns-json" } });
  if (!res.ok) throw new Error(`DoH ${fqdn} status ${"unknown"}`);
  const body = (await res.json()) as { Status?: number; Answer?: unknown };
  if (typeof body?.Status !== "number") throw new Error(`DoH ${fqdn} malformed`);
  return body.Status === 0 && Array.isArray(body.Answer) && body.Answer.length > 0;
}

/** True iff the candidate name already exists as a registered `.com` property
 *  (either dashed or de-dashed form). Propagates DoH failures (caller excludes). */
export async function comDomainExists(name: string, fetchImpl: SuggestFetch): Promise<boolean> {
  for (const fqdn of comFormsFor(name)) {
    if (await dohRegistered(fqdn, fetchImpl)) return true;
  }
  return false;
}

// ── Candidate generation ───────────────────────────────────────────────────

export interface GenerateDeps {
  rng?: () => number;
  /** True iff the name is unavailable (claimed, queued, or batch-local dup). */
  isTaken: (name: string) => boolean | Promise<boolean>;
  /** Optional `.com` filter; omit to skip DNS (the inline fallback path). */
  comExists?: (name: string) => Promise<boolean>;
  maxAttempts?: number;
}

/** Generate one available, grammar-valid, non-`.com` candidate, or null after
 *  `maxAttempts`. A `comExists` THROW is treated as "exclude" (skip). */
export async function tryGenerateCandidate(deps: GenerateDeps): Promise<string | null> {
  const rng = deps.rng ?? cryptoUnit;
  const maxAttempts = deps.maxAttempts ?? 40;
  for (let i = 0; i < maxAttempts; i += 1) {
    const cand = randomCandidate(rng);
    if (!validateUserLabel(cand).ok) continue; // grammar + reserved
    if (OFFENSIVE_SUBSTRINGS.some((s) => cand.includes(s))) continue;
    if (await deps.isTaken(cand)) continue;
    if (deps.comExists) {
      try {
        if (await deps.comExists(cand)) continue;
      } catch {
        continue; // DNS unknown → exclude
      }
    }
    return cand;
  }
  return null;
}

// ── Queue replenishment + pop ──────────────────────────────────────────────

/** Steady-state warm pool size for the suggestion queue. */
export const SUGGESTION_QUEUE_TARGET = 64;
const REPLENISH_ATTEMPT_CAP = 256;

export interface ReplenishDeps {
  queue: SuggestionQueueStorage;
  usernames: UsernameStorage;
  /** `.com` filter; omit to skip DNS (e.g. tests / DNS outage). */
  comExists?: (name: string) => Promise<boolean>;
  rng?: () => number;
  now: number;
  target?: number;
  attemptCap?: number;
}

/** Top the queue up to `target`. Returns how many NEW names were enqueued. */
export async function replenishSuggestionQueue(deps: ReplenishDeps): Promise<number> {
  const target = deps.target ?? SUGGESTION_QUEUE_TARGET;
  const attemptCap = deps.attemptCap ?? REPLENISH_ATTEMPT_CAP;
  const have = await deps.queue.count();
  if (have >= target) return 0;
  const existing = new Set(await deps.queue.list());
  const fresh = new Set<string>();
  let attempts = 0;
  while (have + fresh.size < target && attempts < attemptCap) {
    attempts += 1;
    const cand = await tryGenerateCandidate({
      rng: deps.rng,
      maxAttempts: 1,
      isTaken: async (n) =>
        fresh.has(n) || existing.has(n) || (await deps.usernames.get(n)) != null,
      comExists: deps.comExists,
    });
    if (cand) fresh.add(cand);
  }
  if (fresh.size === 0) return 0;
  return deps.queue.enqueue([...fresh], deps.now);
}

/** Pop the oldest queued name, skipping any that got claimed since enqueue.
 *  Returns null when the queue is empty (or only holds now-claimed names). */
export async function popSuggestion(deps: {
  queue: SuggestionQueueStorage;
  usernames: UsernameStorage;
}): Promise<string | null> {
  for (let i = 0; i < 64; i += 1) {
    const name = await deps.queue.popOldest();
    if (name == null) return null;
    if ((await deps.usernames.get(name)) != null) continue; // claimed since enqueue → drop
    return name;
  }
  return null;
}

// ── Escalating per-device throttle ─────────────────────────────────────────

/** Idle gap after which a device's regenerate count resets to a fresh window. */
export const THROTTLE_WINDOW_RESET_MS = 10 * 60_000;
const MAX_DEVICE_KEY_LEN = 128;

/** Cooldown (ms) until the NEXT suggest, indexed by how many suggests this
 *  window (1 = first/auto, free-but-arms-2s; grows to a 30s cap). */
const COOLDOWN_SCHEDULE_MS: readonly number[] = [0, 2_000, 5_000, 10_000, 20_000, 30_000];

function cooldownFor(count: number): number {
  const i = Math.min(Math.max(count, 1), COOLDOWN_SCHEDULE_MS.length - 1);
  return COOLDOWN_SCHEDULE_MS[i]!;
}

export interface ThrottleDecision {
  allowed: boolean;
  /** If allowed: ms until the next regenerate is permitted. If denied: ms left. */
  retryAfterMs: number;
}

/** Check the per-device cooldown AND, when allowed, record the suggest (consume
 *  a slot + arm the next cooldown). Denied requests record nothing. */
export async function checkSuggestThrottle(
  throttle: SuggestThrottleStorage,
  deviceKey: string,
  now: number,
): Promise<ThrottleDecision> {
  const existing = await throttle.get(deviceKey);
  const stale = !existing || now - existing.lastAt > THROTTLE_WINDOW_RESET_MS;
  if (existing && !stale && now < existing.nextAllowedAt) {
    return { allowed: false, retryAfterMs: existing.nextAllowedAt - now };
  }
  const count = stale ? 1 : existing!.count + 1;
  const nextAllowedAt = now + cooldownFor(count);
  await throttle.upsert({
    deviceKey,
    count,
    windowStart: stale ? now : existing!.windowStart,
    lastAt: now,
    nextAllowedAt,
  });
  return { allowed: true, retryAfterMs: nextAllowedAt - now };
}

// ── Handler ────────────────────────────────────────────────────────────────

export interface SuggestUsernameDeps {
  queue: SuggestionQueueStorage;
  usernames: UsernameStorage;
  throttle: SuggestThrottleStorage;
  now?: number;
  rng?: () => number;
}

/**
 * `POST /api/username/suggest` — body `{ deviceKey }`. Throttle the device,
 * then pop one pre-validated name (inline fallback generation on an empty
 * queue, so sign-up never blocks). 200 carries `retryAfterMs` (until the next
 * regenerate is allowed); a too-fast request is 429.
 */
export async function handleSuggestUsername(
  deps: SuggestUsernameDeps,
  body: { deviceKey?: unknown } | undefined,
): Promise<HandlerResponseWithHeaders> {
  const now = deps.now ?? Date.now();
  const deviceKey = typeof body?.deviceKey === "string" ? body.deviceKey.trim() : "";
  if (!deviceKey || deviceKey.length > MAX_DEVICE_KEY_LEN) {
    return malformed("deviceKey required (≤128 chars)");
  }
  const decision = await checkSuggestThrottle(deps.throttle, deviceKey, now);
  if (!decision.allowed) {
    return { status: 429, body: { error: "regenerating too fast", retryAfterMs: decision.retryAfterMs } };
  }
  let name = await popSuggestion({ queue: deps.queue, usernames: deps.usernames });
  if (name == null) {
    // Empty queue (cold start / drained): generate inline WITHOUT DNS so a slow
    // or down resolver can never block sign-up. The cron-warmed queue is what
    // normally carries the `.com` exclusion.
    name = await tryGenerateCandidate({
      rng: deps.rng,
      maxAttempts: 80,
      isTaken: async (n) => (await deps.usernames.get(n)) != null,
    });
  }
  if (name == null) {
    return { status: 503, body: { error: "no name available" } };
  }
  return ok({ name, retryAfterMs: decision.retryAfterMs });
}
