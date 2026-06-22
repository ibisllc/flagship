/**
 * Random username generation (docs/naming-recovery-and-name-change.md §4).
 *
 * Account creation assigns a RANDOM, free, unsquattable handle. Names are
 * DASHLESS (§3 — the `<slug>-<creator>` app-URL parser in @flagship/services-zone
 * requires dashless usernames), so we CONCATENATE short curated words + a 4-digit
 * suffix: `<adjective><noun><NNNN>` (e.g. `happyotter4821`). Every candidate is
 * passed through `validateUserLabel` (grammar + reserved) and checked for
 * availability, so a returned name is always claimable.
 */

import type { UsernameStorage } from "@flagship/storage";
import { validateUserLabel } from "./labels.js";
import { ok, type HandlerResponseWithHeaders } from "./types.js";

// Short (3–7 char), friendly, non-offensive building blocks. Concatenated with a
// 4-digit suffix the longest handle is ≤ 7+7+4 = 18 chars (well under 30) and
// stays readable.
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

/**
 * One `<adjective><noun><NNNN>` candidate (CONCATENATED, dashless). Not
 * availability-checked — use {@link generateAvailable} for that.
 */
export function randomCandidate(rng: () => number = cryptoUnit): string {
  const adj = pick(ADJECTIVES, rng);
  const noun = pick(NOUNS, rng);
  const num = String(Math.floor(rng() * 10_000)).padStart(4, "0");
  return `${adj}${noun}${num}`;
}

export interface GenerateAvailableOpts {
  /** True iff the candidate is already taken. */
  isTaken: (name: string) => boolean | Promise<boolean>;
  /** How many distinct available candidates to return. Default 5. */
  count?: number;
  /** Injected RNG (tests). Default CSPRNG. */
  rng?: () => number;
  /** Bound the retry loop so a near-exhausted namespace can't spin. */
  maxAttempts?: number;
}

/**
 * Return `count` distinct, grammar-valid, non-reserved, AVAILABLE handles. Every
 * candidate is run through `validateUserLabel` (so reserved/grammar can never
 * leak through) and `isTaken`. Bounded attempts; may return fewer than `count`
 * only in the (practically impossible) near-exhaustion case.
 */
export async function generateAvailable(opts: GenerateAvailableOpts): Promise<string[]> {
  const count = opts.count ?? 5;
  const rng = opts.rng ?? cryptoUnit;
  const maxAttempts = opts.maxAttempts ?? count * 40;
  const out = new Set<string>();
  let attempts = 0;
  while (out.size < count && attempts < maxAttempts) {
    attempts += 1;
    const cand = randomCandidate(rng);
    if (out.has(cand)) continue;
    if (!validateUserLabel(cand).ok) continue; // grammar + reserved guard
    if (await opts.isTaken(cand)) continue;
    out.add(cand);
  }
  return [...out];
}

/**
 * `GET /api/username/random` — suggest available random handles for the
 * sign-up "shuffle". Availability is the same `usernames.get` the claim uses.
 */
export async function handleRandomUsername(
  storage: UsernameStorage,
  count = 5,
): Promise<HandlerResponseWithHeaders> {
  const candidates = await generateAvailable({
    isTaken: async (name) => (await storage.get(name)) != null,
    count,
  });
  return ok({ candidates });
}
