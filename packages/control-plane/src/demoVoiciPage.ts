/**
 * The example voi.ci page of a sample (demo) account (docs/sample-users.md "Example voi.ci page", docs/voici-and-messages.md
 * §3.4): `POST /api/dev/sample-user/<u>/voici-example-page`, operator only (x-admin-secret at the route).
 *
 * A device that opens a sample account holds none of its keys (the admin root, IRK and UMK are derived from DEMO_IRK_KEK
 * on `.com`), so it can't sign a page, and anyone may hold the shared store-review login. So the page is published here,
 * with FIXED content from this file: nothing from the request reaches it but `remove: true`. It goes through the same
 * handlers a device's publish does (piece upload and its signature, handleVoiciPublish's checks and seq ladder, R2), and
 * `remove: true` through handleVoiciRemove (flagship/voici-page-remove/v1). Re-running publishes the same content at
 * the next seq.
 */
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import {
  b64Decode,
  canonicalJsonBytes,
  deriveVoiciInboxKey,
  deriveVoiciOwnerSignKey,
  sha256Hex,
  signVoiciPageIndex,
  signVoiciPageRemove,
  signVoiciPieceUpload,
  type VoiciPieceRef,
  type VoiciPost,
  type VoiciProfile,
} from "@flagship/protocol";
import type { DemoUsersStorage } from "@flagship/storage";
import { deriveDemoAdminRoot, deriveDemoUmk, deriveDemoUserIrk } from "./demoIdentity.js";
import { DEMO_EXAMPLE_AVATAR_JPEG_B64 } from "./demoVoiciExampleAvatar.js";
import { bytesToHex } from "./hex.js";
import type { HandlerResponseWithHeaders } from "./types.js";
import { handleVoiciPieceUpload, handleVoiciPublish, handleVoiciRemove, voiciSensitiveKey, type VoiciPagesDeps } from "./voiciPages.js";

export interface DemoVoiciExamplePageDeps extends VoiciPagesDeps {
  demos: Pick<DemoUsersStorage, "get">;
  demoIrkKek: Uint8Array;
}

const USERNAME = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const INBOX_EPOCH = 1;

/** The example avatar's bytes. */
export function demoExampleAvatar(): Uint8Array {
  const bytes = b64Decode(DEMO_EXAMPLE_AVATAR_JPEG_B64);
  if (!bytes) throw new Error("demo example avatar: bad base64");
  return bytes;
}

/** The page's fixed content. English only: it is page content (what a person would write), not the apps' text. */
export function demoExamplePageContent(username: string): { profile: VoiciProfile; posts: VoiciPost[] } {
  const u = username.toLowerCase();
  return {
    profile: {
      v: 1,
      displayName: u,
      bio: "This is an example page. It belongs to a sample account, so you can see what a voi.ci page looks like.",
      avatar: sha256Hex(demoExampleAvatar()),
      theme: "classic",
      links: [
        { url: "https://flagshipserver.com/", label: "Flagship", site: null },
        { url: "https://flagshipserver.com/studio", label: "Flagship Studio", site: null },
      ],
    },
    posts: [
      {
        id: "de300000000000000000000000000001",
        createdAt: Date.UTC(2026, 10, 1, 12, 0, 0),
        editedAt: null,
        text: "Hello! This is an example post on a sample account's page.",
        links: [],
      },
      {
        id: "de300000000000000000000000000002",
        createdAt: Date.UTC(2026, 10, 3, 12, 0, 0),
        editedAt: null,
        text: "A voi.ci page can show a photo, a few words, links and short posts. Its owner chooses whether visitors can send messages.",
        links: [],
      },
    ],
  };
}

/** The page id a sample account's first example page takes (later ones keep the stored one). */
export function demoExamplePageId(umk: Uint8Array): string {
  return bytesToHex(hkdf(sha256, umk, new Uint8Array(0), new TextEncoder().encode("flagship/demo-example-page-id/v1"), 16));
}

const refuse = (status: number, code: string, error: string): HandlerResponseWithHeaders => ({
  status,
  body: { error, code },
  headers: { "cache-control": "private, no-store" },
});

/** Body: absent, `{}`, or `{ remove: true | false }`; anything else is refused. */
function parseBody(body: unknown): { remove: boolean } | null {
  if (body === undefined || body === null) return { remove: false };
  if (typeof body !== "object" || Array.isArray(body)) return null;
  const keys = Object.keys(body);
  if (keys.some((k) => k !== "remove")) return null;
  const r = (body as { remove?: unknown }).remove;
  if (r !== undefined && typeof r !== "boolean") return null;
  return { remove: r === true };
}

export async function handleDemoVoiciExamplePage(
  deps: DemoVoiciExamplePageDeps,
  username: string,
  body: unknown,
): Promise<HandlerResponseWithHeaders> {
  const u = username.toLowerCase();
  const parsed = parseBody(body);
  if (!USERNAME.test(u) || !parsed) return refuse(400, "malformed", "body may only carry remove: true");
  const [row, user] = await Promise.all([deps.demos.get(u), deps.usernames.get(u)]);
  if (!row || !user) return refuse(404, "not-found", "no such demo user");
  if (user.isDemo !== true) return refuse(403, "not-demo", "not a demo account");

  // The page is signed by the account's sensitive key, which for a sample account `.com` derives itself.
  const key = voiciSensitiveKey(user);
  const admin = deriveDemoAdminRoot(deps.demoIrkKek, u);
  const irk = deriveDemoUserIrk(deps.demoIrkKek, u);
  const seed =
    key.kind === "admin-root" && key.pub === bytesToHex(admin.publicKey)
      ? admin.privateKey
      : key.kind === "irk" && key.pub === bytesToHex(irk.publicKey)
        ? irk.privateKey
        : null;
  if (!seed) return refuse(409, "demo-keys-mismatch", "the account's keys are not this sample account's derived keys");

  const now = (deps.now ?? Date.now)();
  const stored = await deps.voici.getPage(u);

  if (parsed.remove) {
    if (!stored || stored.removedAt != null) {
      return { status: 200, body: { ok: true, removed: true, already: true }, headers: { "cache-control": "private, no-store" } };
    }
    const removal = signVoiciPageRemove({ username: u, pageId: stored.pageId, seq: stored.seq + 1, issuedAt: now, signerKind: key.kind }, seed);
    const r = await handleVoiciRemove(deps, u, JSON.stringify(removal));
    return r.status === 200 ? { ...r, body: { ...(r.body as object), removed: true } } : r;
  }

  const umk = deriveDemoUmk(deps.demoIrkKek, u);
  const pageId = stored?.pageId ?? demoExamplePageId(umk);
  const { profile, posts } = demoExamplePageContent(u);
  const pieces: { role: string; bytes: Uint8Array }[] = [
    { role: "profile", bytes: canonicalJsonBytes(profile) },
    { role: "avatar", bytes: demoExampleAvatar() },
    { role: "chunk-0", bytes: canonicalJsonBytes({ v: 1, chunk: 0, posts }) },
  ];
  for (const p of pieces) {
    const sha = sha256Hex(p.bytes);
    const signature = signVoiciPieceUpload({ username: u, pageId, sha256: sha, size: p.bytes.length, issuedAt: now }, seed);
    const up = await handleVoiciPieceUpload(deps, u, { pageId, issuedAt: String(now), signature }, p.bytes);
    if (up.status !== 200) return up;
  }
  const refs: VoiciPieceRef[] = pieces.map((p) => ({ role: p.role, sha256: sha256Hex(p.bytes), size: p.bytes.length }));
  const umkKey = { seed: umk };
  const index = signVoiciPageIndex(
    {
      username: u,
      pageId,
      seq: (stored?.seq ?? 0) + 1,
      issuedAt: now,
      acceptsMessages: 0,
      inboxEpoch: INBOX_EPOCH,
      inboxPub: bytesToHex(deriveVoiciInboxKey(umkKey, pageId, INBOX_EPOCH).publicKey),
      ownerSignPub: bytesToHex(deriveVoiciOwnerSignKey(umkKey, pageId, INBOX_EPOCH).publicKey),
      pieces: refs,
      signerKind: key.kind,
    },
    seed,
  );
  return handleVoiciPublish(deps, u, JSON.stringify(index));
}
