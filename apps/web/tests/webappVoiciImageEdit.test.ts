/**
 * The page-photo editor in the webapp: the editor's rules (lib/voiciImageEdit.js) against
 * packages/protocol/test-vectors/voici-image-edit (iOS and Android replay the same file), the encoder taking the
 * editor's map (lib/voiciImage.js encodeEditedAvatar), one sentence per failure, and the page editor's flow
 * (source → editor → encode).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cropOf, displaySize, flip, newEdit, orientMatrix, outputMatrix, pan, rotate, setZoom } from "../public/webapp/lib/voiciImageEdit.js";
import { decodeForEditing, encodeEditedAvatar, VoiciImageError } from "../public/webapp/lib/voiciImage.js";

const ROOT = join(__dirname, "..", "..", "..");
const V = JSON.parse(readFileSync(join(ROOT, "packages/protocol/test-vectors/voici-image-edit/vectors.json"), "utf8"));
const WEBAPP = join(__dirname, "..", "public", "webapp");
const PAGE_EDITOR = readFileSync(join(WEBAPP, "views", "page-editor.js"), "utf8");
const PHOTO_EDITOR = readFileSync(join(WEBAPP, "views", "photo-editor.js"), "utf8");
const CONTROL = readFileSync(join(WEBAPP, "lib", "voiciPageControl.js"), "utf8");

describe("voici-image-edit vectors in the webapp", () => {
  for (const c of V.cases) {
    it(c.name, () => {
      let e = newEdit(c.width, c.height);
      for (const op of c.ops) {
        if (op[0] === "rotate") e = rotate(e);
        else if (op[0] === "flip") e = flip(e);
        else if (op[0] === "zoom") e = setZoom(e, op[1]);
        else e = pan(e, op[1], op[2], op[3]);
      }
      const x = c.expect;
      expect(e.turns).toBe(x.turns);
      expect(e.flipped).toBe(x.flipped);
      expect(e.zoom).toBeCloseTo(x.zoom, 6);
      expect(displaySize(e)).toEqual([x.displayWidth, x.displayHeight]);
      const crop = cropOf(e);
      for (const k of ["x", "y", "side"] as const) expect(crop[k]).toBeCloseTo(x.crop[k], 6);
      orientMatrix(e).forEach((v: number, i: number) => expect(v).toBeCloseTo(x.orient[i], 6));
      outputMatrix(e, 512).forEach((v: number, i: number) => expect(v).toBeCloseTo(x.output512[i], 6));
    });
  }

  it("keeps the crop inside the picture whatever the gestures do", () => {
    let e = newEdit(1000, 700);
    for (let i = 0; i < 200; i++) {
      e = i % 7 === 0 ? rotate(e) : i % 11 === 0 ? flip(e) : setZoom(pan(e, (i * 37) % 300 - 150, (i * 53) % 300 - 150, 320), 1 + (i % 9));
      const [dw, dh] = displaySize(e);
      const c = cropOf(e);
      expect(c.x).toBeGreaterThanOrEqual(-1e-9);
      expect(c.y).toBeGreaterThanOrEqual(-1e-9);
      expect(c.x + c.side).toBeLessThanOrEqual(dw + 1e-9);
      expect(c.y + c.side).toBeLessThanOrEqual(dh + 1e-9);
    }
  });
});

describe("the edited page photo", () => {
  const jpeg = (n: number) => Uint8Array.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x04, 0, 0, 0xff, 0xda, ...new Array(n).fill(0)]);
  const img = { width: 1000, height: 500, source: {} };

  it("draws through the editor's map at 512 and steps quality down until it fits", async () => {
    const e = rotate(setZoom(newEdit(1000, 500), 2));
    const seen: number[][] = [];
    const bytes = await encodeEditedAvatar(img, e, {
      encode: async (_s: unknown, m: number[], size: number, q: number) => {
        expect(size).toBe(512);
        seen.push(m);
        return jpeg(q > 0.7 ? 200 * 1024 : 50 * 1024);
      },
    });
    expect(bytes.length).toBeLessThanOrEqual(150 * 1024);
    expect(seen).toHaveLength(3);
    expect(seen[0]).toEqual(outputMatrix(e, 512));
  });

  it("tries a smaller square when the full size never fits, and a smaller one when the encoder fails", async () => {
    const sizes: number[] = [];
    const bytes = await encodeEditedAvatar(img, newEdit(1000, 500), {
      encode: async (_s: unknown, m: number[], size: number) => {
        sizes.push(size);
        expect(m).toEqual(outputMatrix(newEdit(1000, 500), size));
        return jpeg(size > 400 ? 300 * 1024 : 100 * 1024);
      },
    });
    expect(bytes.length).toBeLessThanOrEqual(150 * 1024);
    expect(sizes.at(-1)).toBe(328);
    let calls = 0;
    const again = await encodeEditedAvatar(img, newEdit(1000, 500), {
      encode: async (_s: unknown, _m: number[], size: number) => {
        calls++;
        if (size === 512) throw new Error("no");
        return jpeg(10 * 1024);
      },
    });
    expect(again.length).toBeGreaterThan(0);
    expect(calls).toBe(2);
  });

  it("names each failure", async () => {
    await expect(decodeForEditing(new Blob([]), { decode: async () => { throw new Error("no"); } })).rejects.toMatchObject({ code: "unreadable" });
    await expect(decodeForEditing(new Blob([]), { decode: async () => ({ width: 0, height: 0, source: {} }) })).rejects.toMatchObject({ code: "unreadable" });
    await expect(encodeEditedAvatar(img, newEdit(1000, 500), { encode: async () => { throw new Error("no"); } })).rejects.toMatchObject({ code: "encode-failed" });
    await expect(encodeEditedAvatar(img, newEdit(1000, 500), { encode: async () => jpeg(300 * 1024) })).rejects.toBeInstanceOf(VoiciImageError);
    await expect(encodeEditedAvatar(img, newEdit(1000, 500), { encode: async () => jpeg(300 * 1024) })).rejects.toMatchObject({ code: "too-large" });
    // Three codes, three sentences.
    for (const code of ["too-large", "encode-failed", "unreadable"]) expect(CONTROL).toContain(code === "unreadable" ? 'tr("That file couldn\'t be read as a photo. Try another one.")' : `e?.code === "${code}"`);
  });
});

describe("the page editor's photo flow", () => {
  it("decodes, opens the editor, and encodes only on Use", () => {
    expect(PAGE_EDITOR).toContain("await decodeForEditing(file)");
    expect(PAGE_EDITOR).toContain("await openPhotoEditor(img)");
    expect(PAGE_EDITOR).toMatch(/if \(!edit\) return;\s+const \{ sha, bytes \} = await useEditedAvatar\(img, edit\)/);
    expect(PAGE_EDITOR).toContain('capture="user"');
    expect(PAGE_EDITOR).toContain('tr("Take photo")');
  });

  it("offers rotate, flip, zoom, cancel and use, and draws with the encoder's map", () => {
    for (const id of ["photo-edit-rotate", "photo-edit-flip", "photo-edit-zoom", "photo-edit-cancel", "photo-edit-use"]) expect(PHOTO_EDITOR).toContain(`id="${id}"`);
    expect(PHOTO_EDITOR).toContain("drawEdited(g, img.source, outputMatrix(edit, px), px)");
    expect(PHOTO_EDITOR).toContain('"pointerdown"');
  });
});
