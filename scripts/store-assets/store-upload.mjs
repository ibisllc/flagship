#!/usr/bin/env node
// Store listings by API (docs/runbooks/post-0.4-store-listing.md §1, §4). Google Play here; App Store in
// appstore-upload.mjs (`store-upload.mjs appstore ...`).
//
//   node scripts/store-assets/store-upload.mjs play [--apply] [--images <pack-dir>]
//
// Without --apply it opens a Play edit, prints every text change against what the listing holds now, and deletes
// the edit (nothing is staged). With --apply it writes the texts (and, with --images, replaces each image type per
// language from an upload-pack.mjs folder) and commits the edit. Managed publishing must be on: the commit only
// stages the changes; the owner sends them for review and publishes in the console.
//
// Key: ~/.config/flagship/play-service-account.json (View app information + Manage store presence only).

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PACKAGE = "com.flagshipserver.app";
const API = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PACKAGE}`;
const UPLOAD = `https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications/${PACKAGE}`;
const PLAY_LOCALE = { en: "en-US", es: "es-ES", fr: "fr-FR", de: "de-DE", "pt-BR": "pt-BR", ja: "ja-JP", "zh-Hans": "zh-CN" };
const PLAY_ALSO = { es: ["es-419"] }; // filled only if the listing already has it
const IMAGE_TYPE = { phone: "phoneScreenshots", "tablet-7": "sevenInchScreenshots", "tablet-10": "tenInchScreenshots", wear: "wearScreenshots", feature: "featureGraphic" };
const PACK_DIR_FOR = { "es-419": "es-ES" }; // the pack has no es-419 folder: it takes the es-ES images

const [store, ...rest] = process.argv.slice(2);
const apply = rest.includes("--apply");
const imagesAt = rest.includes("--images") ? rest[rest.indexOf("--images") + 1] : null;
if (store === "appstore") {
  const { appstore } = await import("./appstore-upload.mjs");
  const createVersion = rest.includes("--create-version") ? rest[rest.indexOf("--create-version") + 1] : undefined;
  if (createVersion !== undefined && !/^\d+\.\d+(\.\d+)?$/.test(createVersion ?? "")) { console.error("--create-version needs a version like 1.4"); process.exit(2); }
  const prune = rest.includes("--prune") ? (rest[rest.indexOf("--prune") + 1] ?? "").split(",").filter(Boolean) : [];
  if (prune.some((t) => !/^APP_[A-Z0-9_]+$/.test(t))) { console.error("--prune needs display types like APP_IPHONE_61"); process.exit(2); }
  await appstore({ root: ROOT, apply, imagesAt, createVersion, prune });
  process.exit(0);
}
if (store !== "play") { console.error("usage: store-upload.mjs play|appstore [--apply] [--images <pack-dir>] [--create-version <x.y>] [--prune <APP_TYPE,...>] (appstore)"); process.exit(2); }

if (imagesAt) { // a pack missing any class or language is refused whole, before anything on Play is touched
  const missing = Object.keys(IMAGE_TYPE).flatMap((cls) => Object.values(PLAY_LOCALE).map((loc) => path.join(imagesAt, "playstore", cls, loc)))
    .filter((d) => !fs.existsSync(d) || !fs.readdirSync(d).some((n) => n.endsWith(".png")));
  if (missing.length) { console.error(`the pack is incomplete, nothing uploaded:\n  ${missing.join("\n  ")}`); process.exit(1); }
}

const b64url = (b) => Buffer.from(b).toString("base64url");

async function token() {
  const key = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config/flagship/play-service-account.json"), "utf8"));
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({ iss: key.client_email, scope: "https://www.googleapis.com/auth/androidpublisher", aud: key.token_uri, iat: now, exp: now + 3600 }));
  const sig = crypto.sign("RSA-SHA256", Buffer.from(`${head}.${claims}`), key.private_key).toString("base64url");
  const r = await fetch(key.token_uri, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${head}.${claims}.${sig}` }) });
  const j = await r.json();
  if (!r.ok) throw new Error(`token: ${r.status} ${JSON.stringify(j)}`);
  return j.access_token;
}

const auth = await token();
async function call(method, url, body, type = "application/json") {
  let r, text;
  for (let attempt = 0; ; attempt++) { // Play answers 429/5xx now and then; a repeated POST could upload an image twice
    r = await fetch(url, { method, headers: { authorization: `Bearer ${auth}`, ...(body !== undefined ? { "content-type": type } : {}) }, body: body === undefined ? undefined : type === "application/json" ? JSON.stringify(body) : body });
    text = await r.text();
    if (method === "POST" || (r.status !== 429 && r.status < 500) || attempt === 4) break;
    await new Promise((ok) => setTimeout(ok, 2000 * 2 ** attempt));
  }
  if (!r.ok) { const e = new Error(`${method} ${url.replace(API, "").replace(UPLOAD, "")}: ${r.status} ${text}`); e.status = r.status; e.body = text; throw e; }
  return text ? JSON.parse(text) : {};
}

const listingFiles = Object.keys(PLAY_LOCALE).map((lang) => JSON.parse(fs.readFileSync(path.join(ROOT, "store/listings", `${lang}.json`), "utf8")));
const edit = await call("POST", `${API}/edits`, {});
const E = `${API}/edits/${edit.id}`;
let committed = false;
try {
  const current = Object.fromEntries(((await call("GET", `${E}/listings`)).listings ?? []).map((l) => [l.language, l]));
  console.log(`Play listing languages now: ${Object.keys(current).sort().join(", ") || "(none)"}\n`);
  let changes = 0;
  for (const f of listingFiles) {
    const p = f.playstore;
    const want = { title: p.title, shortDescription: p.shortDescription, fullDescription: p.fullDescription };
    for (const loc of [PLAY_LOCALE[f.lang], ...(PLAY_ALSO[f.lang] ?? []).filter((l) => current[l])]) {
      const have = current[loc] ?? {};
      const diff = Object.keys(want).filter((k) => (have[k] ?? "") !== want[k]);
      if (!diff.length) { console.log(`${loc}: texts unchanged`); continue; }
      changes++;
      console.log(`${loc}: ${current[loc] ? "update" : "NEW language"}: ${diff.join(", ")}`);
      for (const k of diff) {
        if (k === "fullDescription") console.log(`   fullDescription: ${(have[k] ?? "").length} -> ${want[k].length} chars`);
        else console.log(`   ${k}: ${JSON.stringify(have[k] ?? "")} -> ${JSON.stringify(want[k])}`);
      }
      if (apply) await call("PUT", `${E}/listings/${loc}`, { language: loc, ...want });
    }
  }
  const unmanaged = Object.keys(current).filter((l) => !Object.values(PLAY_LOCALE).includes(l) && !Object.values(PLAY_ALSO).flat().includes(l));
  if (unmanaged.length) console.log(`\nleft as they are (no source file): ${unmanaged.join(", ")}`);

  console.log("\nimages on the listing now:");
  for (const loc of Object.values(PLAY_LOCALE)) {
    if (!current[loc]) continue;
    const counts = [];
    for (const t of [...Object.values(IMAGE_TYPE), "icon"]) counts.push(`${t} ${(await call("GET", `${E}/listings/${loc}/${t}`)).images?.length ?? 0}`);
    console.log(`  ${loc}: ${counts.join(", ")}`);
  }

  if (imagesAt) {
    const locs = [...Object.values(PLAY_LOCALE), ...Object.values(PLAY_ALSO).flat().filter((l) => current[l])];
    for (const [cls, type] of Object.entries(IMAGE_TYPE)) for (const loc of locs) {
      const dir = path.join(imagesAt, "playstore", cls, PACK_DIR_FOR[loc] ?? loc);
      const pngs = fs.readdirSync(dir).filter((n) => n.endsWith(".png")).sort();
      const have = ((await call("GET", `${E}/listings/${loc}/${type}`)).images ?? []).map((i) => i.sha256);
      const want = pngs.map((n) => crypto.createHash("sha256").update(fs.readFileSync(path.join(dir, n))).digest("hex"));
      if (have.join() === want.join()) { console.log(`  ${cls}/${loc}: ${type} unchanged`); continue; }
      changes++;
      console.log(`  ${cls}/${loc}: replace ${type} with ${pngs.length} images`);
      if (!apply) continue;
      await call("DELETE", `${E}/listings/${loc}/${type}`);
      for (const n of pngs) await call("POST", `${UPLOAD}/edits/${edit.id}/listings/${loc}/${type}?uploadType=media`, fs.readFileSync(path.join(dir, n)), "image/png");
    }
  }

  if (!apply) { console.log(`\ndry run: ${changes} change(s); nothing staged. Run again with --apply.`); }
  else if (!changes) { console.log("\nnothing to change"); }
  else {
    await call("POST", `${E}:validate`);
    try { await call("POST", `${E}:commit`); }
    catch (e) { if (!/changesNotSentForReview/.test(e.body ?? "")) throw e; await call("POST", `${E}:commit?changesNotSentForReview=true`); }
    committed = true;
    console.log(`\ncommitted ${changes} change(s). Play Console -> Publishing overview: send for review, then publish.`);
  }
} finally {
  if (!committed) await call("DELETE", E).catch(() => {});
}
