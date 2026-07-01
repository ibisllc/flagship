/**
 * Slice D — Phase 3: admin master-root recovery ROTATION
 * (docs/device-admin-tier-spec.md §5).
 *
 * Wire contract:
 *   POST /api/users/:username/admin-root-rotation   → handleApplyAdminRootRotation
 *   GET  /api/users/:username/admin-root-rotations  → handleListAdminRootRotations
 *
 * When credential recovery mints a fresh admin master root, the OLD admin root
 * signs a `flagship/admin-root-rotation/v1` proof (old → new). The apply
 * endpoint verifies that proof against the account's CURRENTLY-stored
 * `admin_root_pub_hex` — `.com`'s previous report is NEVER trusted; the pinned
 * old root is the anchor — and, on success, atomically swaps the stored root to
 * `new` AND appends the signed proof to the served rotation lane so a box that
 * was offline across the rotation can REPLAY the chain (old → … → new),
 * re-verifying each hop against the root IT pins. `.com` can relay a new
 * authority root but can never FORGE one (it holds no admin master root), which
 * is precisely what lets the box adopt a relayed new root from the stored proof.
 *
 * Idempotent: re-POSTing a rotation whose `new` is already the current root is a
 * no-op 200 (the swap already happened; the lane already holds the proof).
 *
 * Backward-compatible: an account with NO pinned admin root has nothing to
 * rotate — the apply endpoint rejects (400) and the lane is empty. Accounts that
 * never rotate are entirely unaffected.
 */

import {
  verifyAdminRootRotation,
  type AdminRootRotation,
} from "@flagship/protocol";
import type {
  AdminRootRotationStorage,
  UsernameStorage,
} from "@flagship/storage";
import { HEX64, HEX128, equalHex, hexToBytes } from "./hex.js";
import {
  conflict,
  forbidden,
  malformed,
  notFound,
  ok,
  type HandlerResponseWithHeaders,
} from "./types.js";

export interface AdminRootRotationDeps {
  usernames: UsernameStorage;
  rotations: AdminRootRotationStorage;
  now?: () => number;
}

interface ApplyBody {
  rotation?: {
    username?: string;
    oldAdminRootPub?: string;
    newAdminRootPub?: string;
    issuedAt?: number;
  };
  signatureHex?: string;
}

function publicRotation(rec: {
  seq: number;
  oldAdminRootPubHex: string;
  newAdminRootPubHex: string;
  issuedAt: number;
  signatureHex: string;
}): {
  seq: number;
  oldAdminRootPub: string;
  newAdminRootPub: string;
  issuedAt: number;
  signatureHex: string;
} {
  return {
    seq: rec.seq,
    oldAdminRootPub: rec.oldAdminRootPubHex,
    newAdminRootPub: rec.newAdminRootPubHex,
    issuedAt: rec.issuedAt,
    signatureHex: rec.signatureHex,
  };
}

// ──────────────────────────────────────────────────────────────────────
// POST /api/users/:username/admin-root-rotation
// ──────────────────────────────────────────────────────────────────────

export async function handleApplyAdminRootRotation(
  deps: AdminRootRotationDeps,
  usernameFromPath: string,
  body: ApplyBody | undefined,
): Promise<HandlerResponseWithHeaders> {
  const r = body?.rotation;
  const oldHex = typeof r?.oldAdminRootPub === "string" ? r.oldAdminRootPub.toLowerCase() : "";
  const newHex = typeof r?.newAdminRootPub === "string" ? r.newAdminRootPub.toLowerCase() : "";
  const sigHex = typeof body?.signatureHex === "string" ? body.signatureHex.toLowerCase() : "";
  if (
    !r ||
    typeof r.username !== "string" ||
    r.username.length === 0 ||
    !HEX64.test(oldHex) ||
    !HEX64.test(newHex) ||
    typeof r.issuedAt !== "number" ||
    !Number.isFinite(r.issuedAt) ||
    !HEX128.test(sigHex)
  ) {
    return malformed("malformed body");
  }

  const usernameNorm = usernameFromPath.toLowerCase();
  // The signed proof carries its own username (signature-covered); it must name
  // the account we're applying to, otherwise a proof for account A can't be
  // replayed onto account B.
  if (r.username.toLowerCase() !== usernameNorm) {
    return malformed("rotation username does not match path");
  }

  // A rotation to the same key is meaningless and would let a replayed/no-op
  // proof masquerade as progress.
  if (equalHex(oldHex, newHex)) {
    return malformed("new admin root equals old");
  }

  const userRec = await deps.usernames.get(usernameNorm);
  if (!userRec) return notFound("username not registered");

  const current = userRec.adminRootPubHex?.toLowerCase();
  if (!current) {
    // No authority anchor pinned ⇒ nothing to rotate. (A fresh admin root is
    // established at account claim, not via this endpoint.)
    return malformed("account has no admin root");
  }

  // Idempotency: the `new` root is ALREADY current ⇒ this rotation was applied
  // before (the swap happened + the lane already holds the proof). No-op 200.
  if (equalHex(newHex, current)) {
    return ok({
      ok: true,
      applied: false,
      username: usernameNorm,
      adminRootPub: current,
    });
  }

  // The proof MUST chain to the currently-pinned root: its `old` is the anchor
  // being replaced. This is the whole point — `.com` verifies against the
  // STORED root, never its own prior word.
  if (!equalHex(oldHex, current)) {
    return conflict("rotation does not chain to the current admin root");
  }

  let oldBytes: Uint8Array;
  let newBytes: Uint8Array;
  let sigBytes: Uint8Array;
  try {
    oldBytes = hexToBytes(oldHex);
    newBytes = hexToBytes(newHex);
    sigBytes = hexToBytes(sigHex);
  } catch {
    return malformed("invalid hex");
  }

  const rotation: AdminRootRotation = {
    username: usernameNorm,
    oldAdminRootPub: oldBytes,
    newAdminRootPub: newBytes,
    issuedAt: r.issuedAt,
  };
  // Verify against the pinned OLD root (== current). Only the holder of the old
  // admin master root could have produced this signature.
  if (!verifyAdminRootRotation(rotation, sigBytes, oldBytes)) {
    return forbidden("invalid rotation signature");
  }

  // Atomic-ish apply: CAS the stored root FIRST (guards a concurrent rotation),
  // then append the proof to the served lane. The CAS re-checks `current` so a
  // racing rotation that already moved the root loses here (409).
  const swapped = await deps.usernames.swapAdminRootPub(usernameNorm, current, newHex);
  if (!swapped) {
    return conflict("admin root changed concurrently");
  }

  const seq = await deps.rotations.append({
    username: usernameNorm,
    oldAdminRootPubHex: oldHex,
    newAdminRootPubHex: newHex,
    issuedAt: r.issuedAt,
    signatureHex: sigHex,
  });

  return ok({
    ok: true,
    applied: true,
    username: usernameNorm,
    adminRootPub: newHex,
    seq,
  });
}

// ──────────────────────────────────────────────────────────────────────
// GET /api/users/:username/admin-root-rotations
// ──────────────────────────────────────────────────────────────────────

export async function handleListAdminRootRotations(
  deps: AdminRootRotationDeps,
  username: string,
): Promise<HandlerResponseWithHeaders> {
  const u = username.toLowerCase();
  const chain = await deps.rotations.list(u);
  return ok({
    username: u,
    rotations: chain.map(publicRotation),
  });
}
