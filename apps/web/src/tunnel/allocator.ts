/**
 * AppUserAllocator — first-come-first-served slot allocator for the
 * .services tunnel hub.
 *
 * The hub is intentionally DUMB: it doesn't decide who SHOULD own
 * what. It just runs the queue:
 *
 *   1. New pod registers → its canonicals are added (uncontested);
 *      shortened slots derivable from those canonicals are claimed
 *      ONLY if currently free (preserve existing holders).
 *   2. Pod explicitly requests transfer of a held shortened slot →
 *      atomic handover (the cert proves the requester is entitled).
 *   3. Pod's socket dies → all of its non-canonical slots are
 *      redistributed to surviving members of the same set
 *      (deterministic tie-break: longest-running socket wins).
 *
 * Every state change emits a snapshot for the affected (slug, author,
 * user) sets so connected pods receive an up-to-date picture.
 *
 * The allocator does NOT know about WebSockets or wire frames; it's a
 * pure data structure. The hub layer wraps it.
 */

export interface AppUserSetKey {
  /** Bare app slug. e.g. `messenger`, `shittygame`. */
  slug: string;
  /** Author username. For self-authored apps this equals `user`. */
  author: string;
  /** User-zone owner — the `<user>` in `<...>.<user>.flagship.services`. */
  user: string;
}

export interface SlotHolder {
  fqdn: string;
  /** Canonical pod FQDN that currently holds the slot. */
  podCanonical: string;
}

export interface AppUserSetSnapshot {
  key: AppUserSetKey;
  /** Members in deterministic order: every pod with a canonical in this set. */
  members: Array<{
    podCanonical: string;
    /** Lower-cased FQDN — the canonical that put this pod in the set. */
    canonicalForSet: string;
    /** ms epoch when this pod's tunnel was first registered (tie-break). */
    joinedAt: number;
  }>;
  /** Shortened slot → current holder. */
  slotHolders: Array<{ fqdn: string; podCanonical: string }>;
}

export interface AddPodResult {
  /** All sets touched by this register (need a fresh snapshot broadcast). */
  affectedSets: AppUserSetKey[];
  /** Slot-holdings the pod walked away with (subset of derivable shorteneds). */
  shortenedsHeld: string[];
}

export interface TransferResult {
  ok: true;
  affectedSet: AppUserSetKey;
  /** Previous holder if the slot was held. */
  previousHolder: string | null;
}

export type TransferRejection =
  | { ok: false; reason: "fqdn not derivable from any of pod's canonicals" }
  | { ok: false; reason: "pod not registered" }
  | { ok: false; reason: "fqdn not parseable" };

export interface RemovePodResult {
  /** Sets touched by the removal — need a fresh snapshot broadcast. */
  affectedSets: AppUserSetKey[];
  /**
   * Slots that were held by the dying pod and got redistributed to a
   * survivor (or freed entirely if no survivor in the set).
   */
  redistributed: Array<{ fqdn: string; from: string; to: string | null }>;
}

interface PodEntry {
  podCanonical: string;
  /** ms epoch when this pod was first registered. Survives re-registers. */
  firstRegisteredAt: number;
  canonicals: Set<string>;
  derivableShorteneds: Set<string>;
  /** Sets this pod participates in (string-encoded keys). */
  setKeys: Set<string>;
}

interface SetEntry {
  key: AppUserSetKey;
  /** podCanonical → canonicalForSet (the canonical that places the pod here). */
  members: Map<string, string>;
  /** shortened FQDN → podCanonical (current holder). */
  slotHolders: Map<string, string>;
  /**
   * Per-slot priority queue of candidates (#87).
   *
   * Active-passive failover model:
   *   - Head of the list = current active receiver (the same value
   *     stored in slotHolders).
   *   - Tail = pods that joined later and are waiting to inherit the
   *     slot if every pod ahead of them disconnects.
   *   - When the head disconnects, the next entry promotes to head
   *     (deterministic FIFO; first to claim wins). When a previously-
   *     disconnected head reconnects, it rejoins at the TAIL — it has
   *     to wait its turn again. This is the safer side of the trade-
   *     off (no flap on a pod that briefly drops) at the cost of
   *     "longest-running pod stays active" — which was the de facto
   *     behavior before #87 but wasn't strictly enforced.
   *
   * Active-active (round-robin across multiple connected pods) is
   * deferred to v2 — see hub.activeActive flag in the design notes.
   * The hook is the candidate queue: a future loadbalancer would
   * iterate it on outbound SNI lookup rather than always returning
   * head.
   */
  candidateQueue: Map<string, string[]>;
}

export class AppUserAllocator {
  private readonly pods = new Map<string, PodEntry>();
  private readonly sets = new Map<string, SetEntry>();
  private readonly now: () => number;
  /**
   * The data-plane apex these FQDNs live under — `flagship.services` in
   * prod, `gym.flagship.services` in the test env (docs/ui-test-gym.md
   * §6.5). Threaded into the apex-RELATIVE parsers so a deeper apex never
   * misparses the username. Defaults to the prod literal.
   */
  private readonly apex: string;

  constructor(opts: { now?: () => number; apex?: string } = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.apex = opts.apex ?? DEFAULT_APEX;
  }

  /**
   * Register or refresh a pod. `canonicals` are the FQDNs the pod is
   * entitled to serve (validated by the caller against the pod's
   * ServiceEntitlement cert). The pod's own root canonical comes through
   * the same list.
   */
  addPod(args: {
    podCanonical: string;
    canonicals: string[];
  }): AddPodResult {
    const podCanonical = args.podCanonical.toLowerCase();
    // Defense-in-depth for A′ wildcard claims: the hub validates +
    // consumes `*.<podCanonical>` before register (routing rides the
    // registry's one-label-strip fallback), so a literal `*` reaching
    // here is either redundant or hostile — never index it.
    const canonicals = new Set<string>();
    for (const c of args.canonicals) {
      const lower = c.toLowerCase();
      if (lower.includes("*")) continue;
      canonicals.add(lower);
    }
    canonicals.add(podCanonical); // root canonical always implicit

    const existing = this.pods.get(podCanonical);
    const firstRegisteredAt = existing?.firstRegisteredAt ?? this.now();
    const entry: PodEntry = {
      podCanonical,
      firstRegisteredAt,
      canonicals,
      derivableShorteneds: new Set(),
      setKeys: new Set(),
    };
    // Compute derivable shorteneds from each canonical.
    for (const canonical of canonicals) {
      for (const sh of derivableShorteneds(canonical, this.apex)) {
        entry.derivableShorteneds.add(sh);
      }
    }
    this.pods.set(podCanonical, entry);

    const affected = new Set<string>();
    const shortenedsHeld: string[] = [];

    // Add this pod to every (slug, author, user) set it has a canonical in.
    for (const canonical of canonicals) {
      const key = parseSetKey(canonical, this.apex);
      if (!key) continue;
      const setKeyStr = encodeSetKey(key);
      let set = this.sets.get(setKeyStr);
      if (!set) {
        set = {
          key,
          members: new Map(),
          slotHolders: new Map(),
          candidateQueue: new Map(),
        };
        this.sets.set(setKeyStr, set);
      }
      // members[podCanonical] = the canonical that placed this pod here.
      // If multiple canonicals map to the same set, first one wins.
      if (!set.members.has(podCanonical)) {
        set.members.set(podCanonical, canonical);
      }
      entry.setKeys.add(setKeyStr);
      affected.add(setKeyStr);
      // Per-SNI candidate queue: the pod's own canonical IS a slot
      // (the pod's root URL); track its entry so a future failover
      // off the root canonical promotes the next-registered pod that
      // happens to also serve this set. The pod-root canonical is
      // additionally the slot the SNI router walks for direct pod
      // URLs (no shortening).
      enqueueCandidate(set, canonical, podCanonical);
    }

    // Try to allocate any free derivable shortened. The shortened may
    // live in a set DIFFERENT from any of the pod's canonicals
    // (cross-creator pods derive both the `<slug>-<author>` and
    // bare-`<slug>` shortened forms, which live in different sets).
    // Implicit membership: a pod joins any set it has a derivable
    // claim into so it gets broadcasts + is eligible for
    // socket-death redistribution.
    for (const shortened of entry.derivableShorteneds) {
      const key = parseSetKey(shortened, this.apex);
      if (!key) continue;
      const setKeyStr = encodeSetKey(key);
      let set = this.sets.get(setKeyStr);
      if (!set) {
        set = {
          key,
          members: new Map(),
          slotHolders: new Map(),
          candidateQueue: new Map(),
        };
        this.sets.set(setKeyStr, set);
      }
      if (!set.members.has(podCanonical)) {
        set.members.set(podCanonical, shortened);
      }
      entry.setKeys.add(setKeyStr);
      // Append to the slot's candidate queue. The slot's HEAD is the
      // current holder; we only promote on holder-disconnect, so a
      // new pod joining never preempts the head — it goes to the tail
      // and waits.
      enqueueCandidate(set, shortened, podCanonical);
      if (!set.slotHolders.has(shortened)) {
        set.slotHolders.set(shortened, podCanonical);
        shortenedsHeld.push(shortened);
      }
      affected.add(setKeyStr);
    }

    const affectedSets: AppUserSetKey[] = [];
    for (const k of affected) {
      const s = this.sets.get(k);
      if (s) affectedSets.push(s.key);
    }
    return { affectedSets, shortenedsHeld };
  }

  /**
   * Pod explicitly asks the hub to transfer ownership of `fqdn` to
   * itself. Validates: (a) pod is registered, (b) fqdn is parseable,
   * (c) fqdn is derivable from at least one of the pod's canonicals.
   * Atomically reassigns within the corresponding set.
   */
  requestTransfer(args: {
    podCanonical: string;
    fqdn: string;
  }): TransferResult | TransferRejection {
    const podCanonical = args.podCanonical.toLowerCase();
    const fqdn = args.fqdn.toLowerCase();
    const pod = this.pods.get(podCanonical);
    if (!pod) return { ok: false, reason: "pod not registered" };
    const key = parseSetKey(fqdn, this.apex);
    if (!key) return { ok: false, reason: "fqdn not parseable" };
    if (!pod.derivableShorteneds.has(fqdn) && !pod.canonicals.has(fqdn)) {
      return { ok: false, reason: "fqdn not derivable from any of pod's canonicals" };
    }
    const setKeyStr = encodeSetKey(key);
    const set = this.sets.get(setKeyStr);
    if (!set) {
      return { ok: false, reason: "fqdn not parseable" };
    }
    const previousHolder = set.slotHolders.get(fqdn) ?? null;
    // Explicit transfer: move the requesting pod to the HEAD of the
    // slot's candidate queue. This is a phone-authorized takeover and
    // is the ONE place where the new arrival preempts the head.
    promoteToHead(set, fqdn, podCanonical);
    set.slotHolders.set(fqdn, podCanonical);
    return { ok: true, affectedSet: key, previousHolder };
  }

  /**
   * Pod's socket died. Drop it from every set; redistribute its slots
   * using the per-slot candidate queue (#87): pop the dying pod from
   * every queue it was in, then if it was the head of any slot,
   * promote the next entry.
   *
   * Atomicity: the whole operation runs synchronously within this
   * method. A concurrent disconnect of the newly-promoted head
   * cannot interleave — Node's single-threaded event loop guarantees
   * the next `removePod` runs only after this one completes. The
   * candidate-queue mutation + slotHolder reassignment are paired
   * inside the same tick.
   */
  removePod(podCanonical: string): RemovePodResult {
    const pc = podCanonical.toLowerCase();
    const pod = this.pods.get(pc);
    if (!pod) return { affectedSets: [], redistributed: [] };
    const affected = new Set<string>();
    const redistributed: Array<{ fqdn: string; from: string; to: string | null }> = [];

    for (const setKeyStr of pod.setKeys) {
      const set = this.sets.get(setKeyStr);
      if (!set) continue;
      set.members.delete(pc);
      affected.add(setKeyStr);
      // Drop this pod from every per-slot candidate queue first.
      // This is the priority-list maintenance step (#87): regardless
      // of whether the pod was head, tail, or somewhere in between,
      // its entry is removed so future promotions skip it.
      for (const [slot, queue] of [...set.candidateQueue.entries()]) {
        const next = queue.filter((p) => p !== pc);
        if (next.length === 0) set.candidateQueue.delete(slot);
        else set.candidateQueue.set(slot, next);
      }
      // Redistribute every slot this pod HELD (was head of).
      for (const [slot, holder] of [...set.slotHolders.entries()]) {
        if (holder !== pc) continue;
        const heir = this.pickHeir(set, slot);
        if (heir) {
          set.slotHolders.set(slot, heir);
          redistributed.push({ fqdn: slot, from: pc, to: heir });
        } else {
          set.slotHolders.delete(slot);
          redistributed.push({ fqdn: slot, from: pc, to: null });
        }
      }
      // Drop empty sets to keep memory tidy.
      if (set.members.size === 0 && set.slotHolders.size === 0) {
        this.sets.delete(setKeyStr);
      }
    }
    this.pods.delete(pc);
    const affectedSets: AppUserSetKey[] = [];
    for (const k of affected) {
      const s = this.sets.get(k);
      if (s) affectedSets.push(s.key);
    }
    return { affectedSets, redistributed };
  }

  /**
   * SNI lookup. Exact match on a slot's holder canonical FQDN; falls
   * back to canonical-FQDN-of-pod for direct pod URL hits. Wildcard
   * matching is OUTSIDE the allocator's concern (it's per-pod cert
   * scope) — the hub's caller handles it.
   */
  findHolderByFqdn(fqdn: string): string | undefined {
    const lower = fqdn.toLowerCase();
    // Direct pod canonical?
    if (this.pods.has(lower)) return lower;
    // Slot lookup — walk every set the FQDN could belong to.
    const key = parseSetKey(lower, this.apex);
    if (!key) return undefined;
    const setKeyStr = encodeSetKey(key);
    const set = this.sets.get(setKeyStr);
    return set?.slotHolders.get(lower);
  }

  /**
   * Snapshot the full state of every set the named pod participates
   * in. Used by the hub to push fresh pictures to a pod after a
   * change affecting it.
   */
  snapshotForPod(podCanonical: string): AppUserSetSnapshot[] {
    const pc = podCanonical.toLowerCase();
    const pod = this.pods.get(pc);
    if (!pod) return [];
    const out: AppUserSetSnapshot[] = [];
    for (const setKeyStr of pod.setKeys) {
      const set = this.sets.get(setKeyStr);
      if (!set) continue;
      out.push(this.snapshotSet(set));
    }
    return out;
  }

  /** Snapshot a single set. */
  snapshotByKey(key: AppUserSetKey): AppUserSetSnapshot | null {
    const set = this.sets.get(encodeSetKey(key));
    return set ? this.snapshotSet(set) : null;
  }

  /** All pods (canonical FQDNs) that are members of the given set. */
  membersOf(key: AppUserSetKey): string[] {
    const set = this.sets.get(encodeSetKey(key));
    return set ? [...set.members.keys()] : [];
  }

  /** Test/observability seam. */
  podCount(): number {
    return this.pods.size;
  }
  setCount(): number {
    return this.sets.size;
  }

  private snapshotSet(set: SetEntry): AppUserSetSnapshot {
    const members: AppUserSetSnapshot["members"] = [];
    for (const [canonical, canonicalForSet] of set.members) {
      const pod = this.pods.get(canonical);
      members.push({
        podCanonical: canonical,
        canonicalForSet,
        joinedAt: pod?.firstRegisteredAt ?? 0,
      });
    }
    members.sort((a, b) => a.joinedAt - b.joinedAt || a.podCanonical.localeCompare(b.podCanonical));
    const slotHolders: AppUserSetSnapshot["slotHolders"] = [];
    for (const [fqdn, podCanonical] of set.slotHolders) {
      slotHolders.push({ fqdn, podCanonical });
    }
    slotHolders.sort((a, b) => a.fqdn.localeCompare(b.fqdn));
    return { key: set.key, members, slotHolders };
  }

  /**
   * Pick the heir for a slot whose holder just left.
   *
   * Strategy (#87 — per-slot priority queue):
   *   1. Walk the slot's candidateQueue head-to-tail. The first entry
   *      that is still a registered, live member of the set wins.
   *   2. If no entry survives (queue empty or every entry has since
   *      disconnected), fall back to the legacy "longest-running
   *      socket among set members" heir-picker so we never strand a
   *      slot when there's still a willing pod.
   */
  private pickHeir(set: SetEntry, slot: string): string | null {
    const queue = set.candidateQueue.get(slot);
    if (queue) {
      for (const cand of queue) {
        if (this.pods.has(cand) && set.members.has(cand)) {
          return cand;
        }
      }
    }
    let best: { canonical: string; firstRegisteredAt: number } | null = null;
    for (const memberCanonical of set.members.keys()) {
      const pod = this.pods.get(memberCanonical);
      if (!pod) continue;
      if (!best) best = { canonical: memberCanonical, firstRegisteredAt: pod.firstRegisteredAt };
      else if (
        pod.firstRegisteredAt < best.firstRegisteredAt ||
        (pod.firstRegisteredAt === best.firstRegisteredAt &&
          memberCanonical.localeCompare(best.canonical) < 0)
      ) {
        best = { canonical: memberCanonical, firstRegisteredAt: pod.firstRegisteredAt };
      }
    }
    return best?.canonical ?? null;
  }

  /**
   * Snapshot of the per-slot candidate queue. Exported for tests +
   * future status-page wiring; the wire snapshot (`snapshotByKey`)
   * only carries the current head per slot.
   */
  candidatesFor(key: AppUserSetKey, slot: string): string[] {
    const set = this.sets.get(encodeSetKey(key));
    if (!set) return [];
    return [...(set.candidateQueue.get(slot) ?? [])];
  }
}

function enqueueCandidate(set: SetEntry, slot: string, pod: string): void {
  const cur = set.candidateQueue.get(slot);
  if (!cur) {
    set.candidateQueue.set(slot, [pod]);
    return;
  }
  if (cur.includes(pod)) return;
  cur.push(pod);
}

function promoteToHead(set: SetEntry, slot: string, pod: string): void {
  const cur = set.candidateQueue.get(slot) ?? [];
  const without = cur.filter((p) => p !== pod);
  set.candidateQueue.set(slot, [pod, ...without]);
}

// ────────────────────────────────────────────────────────────────────
// FQDN parsing helpers
// ────────────────────────────────────────────────────────────────────

/**
 * The prod data-plane apex. Every parser below takes `apex` as a
 * defaulted parameter so the test env (`gym.flagship.services`,
 * docs/ui-test-gym.md §6.5) parses apex-RELATIVE — strip the configured
 * apex suffix, THEN take the username as the last remaining label. Prod
 * (default apex) is byte-identical to the old fixed literal.
 */
const DEFAULT_APEX = "flagship.services";

/**
 * Parse an FQDN under the configured apex into its (slug, author, user)
 * key. Returns null for FQDNs that don't fit the expected shapes. Parses
 * apex-RELATIVE: the username is the last label remaining after the apex
 * suffix is stripped, so a deeper apex (`gym.flagship.services`) yields
 * `home.alice.gym.flagship.services` → user=`alice` (not `gym`).
 *
 * Shapes recognized:
 *   <slug>.<host>.<user>.flagship.services
 *     → { slug, author = user, user }
 *   <slug>-<author>.<host>.<user>.flagship.services
 *     → { slug, author, user }
 *   <slug>.<user>.flagship.services
 *     → { slug, author = user, user }   (self-authored shortened)
 *   <slug>-<author>.<user>.flagship.services
 *     → { slug, author, user }          (cross-creator shortened)
 *   <user>.flagship.services
 *     → null (no slug)
 *
 * Bare pod canonicals (`<host>.<user>.flagship.services`) parse with
 * `host` taking the slug slot, but the hub treats those specially —
 * they're always the pod's own root canonical, not part of any
 * (slug, author, user) set keyed by an app slug. Callers should
 * filter those out before calling parseSetKey, OR the parsing here
 * is fine because those FQDNs ARE in some set (the host's own root
 * set, which is harmless to track but unused for app routing).
 */
export function parseSetKey(fqdn: string, apex: string = DEFAULT_APEX): AppUserSetKey | null {
  const apexSuffix = "." + apex;
  const lower = fqdn.toLowerCase();
  if (!lower.endsWith(apexSuffix)) return null;
  const head = lower.slice(0, -apexSuffix.length);
  if (head.length === 0) return null;
  const parts = head.split(".");
  if (parts.length < 2) return null;
  // Every label must be a plain DNS label — wildcard claims (`*.…`)
  // are validated + consumed by the hub (A′: only `*.<podCanonical>`)
  // and must never index into sets as literals.
  if (parts.some((p) => !labelOk(p))) return null;
  const user = parts[parts.length - 1]!;
  if (!userOk(user)) return null;
  // Leftmost label may be `<slug>` or `<slug>-<author>`. The author
  // is a username (hyphen-free), so split at the LAST hyphen — the
  // slug itself may contain hyphens (`notes-app`), the author cannot.
  const leftmost = parts[0]!;
  const dashIdx = leftmost.lastIndexOf("-");
  let slug: string;
  let author: string;
  if (dashIdx > 0 && dashIdx < leftmost.length - 1) {
    slug = leftmost.slice(0, dashIdx);
    author = leftmost.slice(dashIdx + 1);
  } else {
    slug = leftmost;
    author = user; // self-authored
  }
  if (!labelOk(slug) || !userOk(author)) return null;
  return { slug, author, user };
}

/**
 * Compute every shortened FQDN derivable from a canonical.
 *
 * For `messenger-facebook.kitchen.john.flagship.services`:
 *   - `messenger-facebook.john.flagship.services` (drop host, keep author)
 *   - `messenger.john.flagship.services` (drop host AND author)
 *   - `messenger.kitchen.john.flagship.services` (drop author, keep host)
 *
 * For `messenger.kitchen.john.flagship.services`:
 *   - `messenger.john.flagship.services` (drop host)
 *
 * Pod-root canonicals (`kitchen.john.flagship.services`) yield no
 * shortened — they're already as short as they go.
 */
export function derivableShorteneds(canonical: string, apex: string = DEFAULT_APEX): string[] {
  const apexSuffix = "." + apex;
  const lower = canonical.toLowerCase();
  if (!lower.endsWith(apexSuffix)) return [];
  const head = lower.slice(0, -apexSuffix.length);
  if (head.includes("*")) return []; // wildcard claims derive nothing (A′)
  const parts = head.split(".");
  // Need at least 3 labels (slug.host.user) to have any shortened.
  if (parts.length < 3) return [];
  const leftmost = parts[0]!;
  const host = parts[parts.length - 2]!;
  const user = parts[parts.length - 1]!;
  void host;
  const out: string[] = [];
  // Always include the user-zone-level shortened (drop host).
  out.push(`${leftmost}.${user}.${apex}`);
  // If the leftmost has a `-author` suffix, also include the
  // bare-slug variants. Author is a hyphen-free username → split at
  // the LAST hyphen so a hyphenated slug stays intact.
  const dashIdx = leftmost.lastIndexOf("-");
  if (dashIdx > 0 && dashIdx < leftmost.length - 1) {
    const slug = leftmost.slice(0, dashIdx);
    out.push(`${slug}.${user}.${apex}`);
    out.push(`${slug}.${parts[parts.length - 2]}.${user}.${apex}`);
  }
  return out;
}

/** Slug / generic DNS label — hyphens allowed in the interior. */
function labelOk(s: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,62}$/.test(s);
}

/** Username (user / author). Hyphen-free — this is what makes
 *  `<slug>-<author>` and `<creator>-<slug>` parseable. Mirrors the
 *  Worker's USERNAME_RE in packages/control-plane/src/labels.ts. */
function userOk(s: string): boolean {
  return /^[a-z0-9]{1,63}$/.test(s);
}

function encodeSetKey(k: AppUserSetKey): string {
  return `${k.slug}|${k.author}|${k.user}`;
}
