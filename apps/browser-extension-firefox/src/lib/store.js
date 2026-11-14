// What the extension keeps, in browser.storage.local, under one key:
//   boxes: { [serverDomain]: { serverDomain, username, stkPubHex, token, tokenExpiresAt, pairedAt,
//                              session: "active" | "ended", evidence: { certSha256, certValidUntil, issuedAt } | null } }
// `stkPubHex` is the server's public key as the owner's phone pinned it; `token` is the box session that reads only
// the box's signed certificate fingerprint. Nothing here can sign anything as the owner.

const KEY = "boxes";

export async function loadBoxes(storage = globalThis.browser?.storage?.local) {
  const got = await storage.get(KEY);
  const boxes = got?.[KEY];
  return boxes && typeof boxes === "object" ? boxes : {};
}

export async function saveBoxes(boxes, storage = globalThis.browser?.storage?.local) {
  await storage.set({ [KEY]: boxes });
}

/** Read-modify-write one box; `fn` returns the new box, or null to forget it. */
export async function updateBox(serverDomain, fn, storage = globalThis.browser?.storage?.local) {
  const boxes = await loadBoxes(storage);
  const nextBox = fn(boxes[serverDomain] ?? null);
  if (nextBox) boxes[serverDomain] = nextBox;
  else delete boxes[serverDomain];
  await saveBoxes(boxes, storage);
  return boxes;
}
