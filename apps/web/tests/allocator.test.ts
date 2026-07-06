import { describe, expect, it } from "vitest";
import {
  AppUserAllocator,
  derivableShorteneds,
  parseSetKey,
} from "../src/tunnel/allocator.js";

const KITCHEN = "kitchen.john.flagship.services";
const WOODSHED = "woodshed.john.flagship.services";

describe("parseSetKey", () => {
  it("self-authored canonical", () => {
    expect(parseSetKey("messenger.kitchen.john.flagship.services")).toEqual({
      slug: "messenger",
      author: "john",
      user: "john",
    });
  });

  it("cross-creator canonical", () => {
    expect(parseSetKey("messenger-facebook.kitchen.john.flagship.services")).toEqual({
      slug: "messenger",
      author: "facebook",
      user: "john",
    });
  });

  it("self-authored shortened (drops host)", () => {
    expect(parseSetKey("messenger.john.flagship.services")).toEqual({
      slug: "messenger",
      author: "john",
      user: "john",
    });
  });

  it("cross-creator shortened (drops host, keeps author)", () => {
    expect(parseSetKey("messenger-facebook.john.flagship.services")).toEqual({
      slug: "messenger",
      author: "facebook",
      user: "john",
    });
  });

  it("rejects FQDNs outside the apex", () => {
    expect(parseSetKey("messenger.john.flagship.com")).toBeNull();
    expect(parseSetKey("messenger.example.com")).toBeNull();
  });

  it("rejects wildcard labels anywhere (A′ claims never index as literals)", () => {
    expect(parseSetKey("*.john.flagship.services")).toBeNull();
    expect(parseSetKey("*.kitchen.john.flagship.services")).toBeNull();
    expect(parseSetKey("messenger.*.john.flagship.services")).toBeNull();
  });
});

// G1 (docs/ui-test-gym.md §12-G1): the apex is a CONFIG VARIABLE, defaulting
// to the prod literal, and the parse is apex-RELATIVE — strip the configured
// apex suffix, THEN take the username as the last remaining label. This also
// fixes the latent fixed-depth misparse: a deeper apex used to slide the
// username one label to the right.
describe("parseSetKey — apex-relative (the gym-env fix)", () => {
  it("default apex is byte-identical to the old fixed literal", () => {
    // No apex arg → DEFAULT_APEX = flagship.services. The username is the
    // last label before the apex; a pod canonical parses host→slug, user→user.
    expect(parseSetKey("home.alice.flagship.services")).toEqual({
      slug: "home",
      author: "alice",
      user: "alice",
    });
    // Passing the literal explicitly must match the default exactly.
    expect(parseSetKey("home.alice.flagship.services", "flagship.services")).toEqual(
      parseSetKey("home.alice.flagship.services"),
    );
  });

  it("a deeper apex parses username=alice, NOT the apex's own label", () => {
    // The whole point: under apex=gym.flagship.services the username is `alice`.
    expect(
      parseSetKey("home.alice.gym.flagship.services", "gym.flagship.services"),
    ).toEqual({ slug: "home", author: "alice", user: "alice" });
    // A real app FQDN under the gym apex likewise resolves the right user.
    expect(
      parseSetKey("messenger-facebook.kitchen.alice.gym.flagship.services", "gym.flagship.services"),
    ).toEqual({ slug: "messenger", author: "facebook", user: "alice" });
  });

  it("demonstrates the latent bug the fix closes: a deeper FQDN misparses under the DEFAULT apex", () => {
    // With the prod default apex, `…gym.flagship.services` strips only
    // `.flagship.services`, leaving `home.alice.gym` → user=`gym` (the bug).
    // Reserving `gym` as a username is the other half of the defense; here we
    // simply pin that the relative parse under the CORRECT apex yields `alice`,
    // never `gym`.
    expect(parseSetKey("home.alice.gym.flagship.services")?.user).toBe("gym");
    expect(
      parseSetKey("home.alice.gym.flagship.services", "gym.flagship.services")?.user,
    ).toBe("alice");
  });

  it("a gym-apex allocator routes by the apex-relative set key end-to-end", () => {
    const gym = new AppUserAllocator({ apex: "gym.flagship.services" });
    gym.addPod({
      podCanonical: "kitchen.alice.gym.flagship.services",
      canonicals: ["notes.kitchen.alice.gym.flagship.services"],
    });
    // The pod holds the shortened `notes.alice.gym.flagship.services` slot —
    // proof the allocator computed the right (slug, author, user) under the
    // deeper apex (user=alice, not gym).
    expect(gym.findHolderByFqdn("notes.alice.gym.flagship.services")).toBe(
      "kitchen.alice.gym.flagship.services",
    );
  });

  it("derivableShorteneds is apex-relative too", () => {
    // Default: drops the host, keeps the literal prod apex.
    expect(derivableShorteneds("notes.kitchen.alice.flagship.services")).toContain(
      "notes.alice.flagship.services",
    );
    // Gym apex: same shape under the deeper apex, user still alice.
    expect(
      derivableShorteneds("notes.kitchen.alice.gym.flagship.services", "gym.flagship.services"),
    ).toContain("notes.alice.gym.flagship.services");
  });
});

describe("derivableShorteneds", () => {
  it("self-authored canonical → user-zone shortened", () => {
    expect(derivableShorteneds("messenger.kitchen.john.flagship.services")).toEqual([
      "messenger.john.flagship.services",
    ]);
  });

  it("cross-creator canonical → both -author and bare-slug shorteneds", () => {
    const out = derivableShorteneds("messenger-facebook.kitchen.john.flagship.services");
    expect(out.sort()).toEqual([
      "messenger-facebook.john.flagship.services",
      "messenger.john.flagship.services",
      "messenger.kitchen.john.flagship.services",
    ].sort());
  });

  it("pod-root canonical yields no shortened (only 2 labels before apex)", () => {
    expect(derivableShorteneds(KITCHEN)).toEqual([]);
  });

  it("wildcard claims derive nothing", () => {
    expect(derivableShorteneds("*.kitchen.john.flagship.services")).toEqual([]);
    expect(derivableShorteneds("*.john.flagship.services")).toEqual([]);
  });
});

describe("AppUserAllocator — A′ wildcard claims stay inert", () => {
  it("a literal wildcard canonical never becomes a member, slot, or holder", () => {
    const a = new AppUserAllocator({ now: () => 1_000 });
    const r = a.addPod({
      podCanonical: KITCHEN,
      canonicals: [KITCHEN, "*.kitchen.john.flagship.services"],
    });
    expect(r.shortenedsHeld).toEqual([]);
    expect(a.findHolderByFqdn("*.kitchen.john.flagship.services")).toBeUndefined();
  });

  it("a hostile user-zone wildcard cannot capture another pod's slot or canonical", () => {
    const a = new AppUserAllocator({ now: () => 1_000 });
    a.addPod({
      podCanonical: KITCHEN,
      canonicals: ["messenger.kitchen.john.flagship.services"],
    });
    a.addPod({
      podCanonical: WOODSHED,
      canonicals: [WOODSHED, "*.john.flagship.services"],
    });
    expect(a.findHolderByFqdn("messenger.john.flagship.services")).toBe(KITCHEN);
    expect(a.findHolderByFqdn(KITCHEN)).toBe(KITCHEN);
  });
});

describe("AppUserAllocator — addPod", () => {
  it("adds a pod and allocates its derivable shorteneds when free", () => {
    const a = new AppUserAllocator({ now: () => 1_000 });
    const r = a.addPod({
      podCanonical: KITCHEN,
      canonicals: ["messenger.kitchen.john.flagship.services"],
    });
    expect(r.shortenedsHeld).toContain("messenger.john.flagship.services");
    // The (messenger, john, john) set has the pod as a member.
    const snap = a.snapshotByKey({ slug: "messenger", author: "john", user: "john" })!;
    expect(snap.members.map((m) => m.podCanonical)).toEqual([KITCHEN]);
    expect(snap.slotHolders.map((s) => s.fqdn)).toContain("messenger.john.flagship.services");
  });

  it("preserves existing shortened on second pod (FCFS)", () => {
    const a = new AppUserAllocator({ now: () => 1_000 });
    a.addPod({
      podCanonical: KITCHEN,
      canonicals: ["messenger.kitchen.john.flagship.services"],
    });
    const r2 = a.addPod({
      podCanonical: WOODSHED,
      canonicals: ["messenger.woodshed.john.flagship.services"],
    });
    expect(r2.shortenedsHeld).not.toContain("messenger.john.flagship.services");
    const holder = a.findHolderByFqdn("messenger.john.flagship.services");
    expect(holder).toBe(KITCHEN); // first registrant still holds
  });

  it("claims a DIRECTLY-presented tier-2 `<svc>.<user>` canonical as a routable slot (leader-route)", () => {
    // A box that presents a short `<svc>.<user>` canonical in its
    // ServiceEntitlement (NOT derivable from its 2-label root canonical) must
    // become the SNI route holder for it — otherwise `findHolderByFqdn` returns
    // undefined and the SNI router resets the connection (the tier-2 routing
    // bug). It is held FCFS like a derived shortened.
    const a = new AppUserAllocator({ now: () => 1_000 });
    const r = a.addPod({
      podCanonical: KITCHEN, // kitchen.john.flagship.services (the pod root)
      canonicals: [KITCHEN, "blog.john.flagship.services"],
    });
    expect(r.shortenedsHeld).toContain("blog.john.flagship.services");
    expect(a.findHolderByFqdn("blog.john.flagship.services")).toBe(KITCHEN);
    // The pod's own root is still routed via the pods map, never a contended slot.
    expect(a.findHolderByFqdn(KITCHEN)).toBe(KITCHEN);
  });

  it("does NOT claim a tier-1 `<svc>.<server>.<user>` (3-label) canonical as a shared slot", () => {
    // A 3-label service-on-box canonical is box-specific (per-box wildcard +
    // one-label-strip routing); it must never become a shared leader-route slot
    // that a sibling box could inherit on failover.
    const a = new AppUserAllocator({ now: () => 1_000 });
    const r = a.addPod({
      podCanonical: KITCHEN,
      canonicals: [KITCHEN, "messenger.kitchen.john.flagship.services"],
    });
    expect(r.shortenedsHeld).not.toContain("messenger.kitchen.john.flagship.services");
    expect(a.findHolderByFqdn("messenger.kitchen.john.flagship.services")).toBeUndefined();
  });

  it("two different apps coexist in different sets", () => {
    const a = new AppUserAllocator({ now: () => 1_000 });
    a.addPod({
      podCanonical: KITCHEN,
      canonicals: [
        "messenger.kitchen.john.flagship.services",
        "shittygame.kitchen.john.flagship.services",
      ],
    });
    expect(a.setCount()).toBeGreaterThanOrEqual(2);
    expect(a.findHolderByFqdn("messenger.john.flagship.services")).toBe(KITCHEN);
    expect(a.findHolderByFqdn("shittygame.john.flagship.services")).toBe(KITCHEN);
  });

  it("cross-creator: messenger-facebook + self-authored messenger contend for the bare-slug shortened", () => {
    const a = new AppUserAllocator({ now: () => 1_000 });
    // First in: cross-creator messenger-facebook hosted on kitchen.
    const r1 = a.addPod({
      podCanonical: KITCHEN,
      canonicals: ["messenger-facebook.kitchen.john.flagship.services"],
    });
    // Holds messenger.john.flagship.services (the bare-slug shortened).
    expect(r1.shortenedsHeld).toContain("messenger.john.flagship.services");
    expect(r1.shortenedsHeld).toContain("messenger-facebook.john.flagship.services");

    // Second in: self-authored messenger on woodshed. Wants the same
    // bare-slug shortened. FCFS preserves the first holder.
    const r2 = a.addPod({
      podCanonical: WOODSHED,
      canonicals: ["messenger.woodshed.john.flagship.services"],
    });
    expect(r2.shortenedsHeld).not.toContain("messenger.john.flagship.services");
    expect(a.findHolderByFqdn("messenger.john.flagship.services")).toBe(KITCHEN);
  });
});

describe("AppUserAllocator — requestTransfer", () => {
  it("transfers a held shortened to an entitled requester", () => {
    const a = new AppUserAllocator({ now: () => 1_000 });
    a.addPod({
      podCanonical: KITCHEN,
      canonicals: ["messenger.kitchen.john.flagship.services"],
    });
    a.addPod({
      podCanonical: WOODSHED,
      canonicals: ["messenger.woodshed.john.flagship.services"],
    });
    const r = a.requestTransfer({
      podCanonical: WOODSHED,
      fqdn: "messenger.john.flagship.services",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.previousHolder).toBe(KITCHEN);
    expect(a.findHolderByFqdn("messenger.john.flagship.services")).toBe(WOODSHED);
  });

  it("rejects transfer if requester has no derivable claim to the FQDN", () => {
    const a = new AppUserAllocator({ now: () => 1_000 });
    a.addPod({
      podCanonical: KITCHEN,
      canonicals: ["messenger.kitchen.john.flagship.services"],
    });
    a.addPod({
      podCanonical: WOODSHED,
      canonicals: ["shittygame.woodshed.john.flagship.services"],
    });
    // Woodshed only has shittygame; can't claim messenger.john.
    const r = a.requestTransfer({
      podCanonical: WOODSHED,
      fqdn: "messenger.john.flagship.services",
    });
    expect(r.ok).toBe(false);
  });

  it("rejects transfer for an unregistered pod", () => {
    const a = new AppUserAllocator({ now: () => 1_000 });
    const r = a.requestTransfer({
      podCanonical: KITCHEN,
      fqdn: "messenger.john.flagship.services",
    });
    expect(r.ok).toBe(false);
  });
});

describe("AppUserAllocator — removePod redistribution", () => {
  it("redistributes orphaned shorteneds to the longest-running surviving member", () => {
    let now = 1_000;
    const a = new AppUserAllocator({ now: () => now });
    // Kitchen joins first → joinedAt = 1000
    a.addPod({
      podCanonical: KITCHEN,
      canonicals: ["messenger.kitchen.john.flagship.services"],
    });
    expect(a.findHolderByFqdn("messenger.john.flagship.services")).toBe(KITCHEN);
    now = 2_000;
    a.addPod({
      podCanonical: WOODSHED,
      canonicals: ["messenger.woodshed.john.flagship.services"],
    });
    now = 3_000;
    // Garage joins last
    const GARAGE = "garage.john.flagship.services";
    a.addPod({
      podCanonical: GARAGE,
      canonicals: ["messenger.garage.john.flagship.services"],
    });
    // Kitchen dies. Heir should be the longest-running survivor → woodshed.
    const r = a.removePod(KITCHEN);
    const m = r.redistributed.find((x) => x.fqdn === "messenger.john.flagship.services");
    expect(m).toBeDefined();
    expect(m!.to).toBe(WOODSHED);
    expect(a.findHolderByFqdn("messenger.john.flagship.services")).toBe(WOODSHED);
  });

  it("frees the slot if no surviving member exists", () => {
    const a = new AppUserAllocator({ now: () => 1_000 });
    a.addPod({
      podCanonical: KITCHEN,
      canonicals: ["messenger.kitchen.john.flagship.services"],
    });
    a.removePod(KITCHEN);
    expect(a.findHolderByFqdn("messenger.john.flagship.services")).toBeUndefined();
  });

  it("does NOT redistribute the dead pod's own canonical (other pods can't serve it)", () => {
    const a = new AppUserAllocator({ now: () => 1_000 });
    a.addPod({
      podCanonical: KITCHEN,
      canonicals: ["messenger.kitchen.john.flagship.services"],
    });
    a.addPod({
      podCanonical: WOODSHED,
      canonicals: ["messenger.woodshed.john.flagship.services"],
    });
    a.removePod(KITCHEN);
    // Woodshed should NOT inherit messenger.kitchen.john... because woodshed
    // doesn't have a canonical for it.
    expect(a.findHolderByFqdn("messenger.kitchen.john.flagship.services")).toBeUndefined();
    // But messenger.john.flagship.services (the user-zone shortened)
    // should redistribute to woodshed since both could derive it.
    expect(a.findHolderByFqdn("messenger.john.flagship.services")).toBe(WOODSHED);
  });
});

describe("AppUserAllocator — snapshotForPod", () => {
  it("returns the current state of every set the pod participates in", () => {
    const a = new AppUserAllocator({ now: () => 1_000 });
    a.addPod({
      podCanonical: KITCHEN,
      canonicals: [
        "messenger.kitchen.john.flagship.services",
        "shittygame.kitchen.john.flagship.services",
      ],
    });
    const snaps = a.snapshotForPod(KITCHEN);
    const slugs = snaps.map((s) => s.key.slug).sort();
    // We expect two app sets PLUS possibly a host-root set; at minimum the two app sets.
    expect(slugs).toContain("messenger");
    expect(slugs).toContain("shittygame");
  });
});
