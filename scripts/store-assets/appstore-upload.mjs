// App Store part of store-upload.mjs (docs/runbooks/post-0.4-store-listing.md §1, §4).
//
//   node scripts/store-assets/store-upload.mjs appstore [--apply] [--images <pack-dir>]
//
// Key: ~/.appstoreconnect/flagship-listing.p8.asc (encrypted to the owner's YubiKey; decrypted into memory only,
// so the key must be unlocked: `gpg -d <file> > /dev/null` once in a terminal) or a plain .p8 under
// ~/.appstoreconnect/private_keys/, plus ~/.appstoreconnect/flagship.json {keyId, issuerId}. Role: App Manager.
//
// Texts: name and subtitle go on the editable app info, description / keywords / whatsNew / promotionalText on the
// editable version ("Prepare for Submission"). With no editable version only promotionalText is written (it can change
// on a live version without review). Screenshots replace each set per locale. Nothing is ever submitted for review.

import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BUNDLE_ID = "com.flagshipserver.app";
const API = "https://api.appstoreconnect.apple.com";
const LOCALES = { en: ["en-US"], es: ["es-ES", "es-MX"], fr: ["fr-FR"], de: ["de-DE"], "pt-BR": ["pt-BR"], ja: ["ja"], "zh-Hans": ["zh-Hans"] };
const PACK_DIR_FOR = { "es-MX": "es-ES" };
const DISPLAY_TYPE = { "iphone-6.9": "APP_IPHONE_67", "ipad-13": "APP_IPAD_PRO_3GEN_129", "watch-ultra": "APP_WATCH_ULTRA" };
const EDITABLE = new Set(["PREPARE_FOR_SUBMISSION", "DEVELOPER_REJECTED", "REJECTED", "METADATA_REJECTED", "INVALID_BINARY"]);

function privateKey() {
  const dir = path.join(os.homedir(), ".appstoreconnect");
  const asc = path.join(dir, "flagship-listing.p8.asc");
  if (fs.existsSync(asc)) {
    try { return execFileSync("gpg", ["--batch", "-q", "--decrypt", asc], { stdio: ["ignore", "pipe", "pipe"] }).toString(); }
    catch { throw new Error(`could not open ${asc}: unlock the YubiKey first (in a terminal: gpg -d ${asc} > /dev/null)`); }
  }
  const plain = fs.readdirSync(path.join(dir, "private_keys")).find((n) => n.endsWith(".p8"));
  return fs.readFileSync(path.join(dir, "private_keys", plain), "utf8");
}

export async function appstore({ root, apply, imagesAt }) {
  const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".appstoreconnect/flagship.json"), "utf8"));
  const pem = privateKey();
  const b = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b({ alg: "ES256", kid: cfg.keyId, typ: "JWT" })}.${b({ iss: cfg.issuerId, iat: now, exp: now + 1150, aud: "appstoreconnect-v1" })}`;
  const jwt = `${unsigned}.${crypto.sign("sha256", Buffer.from(unsigned), { key: pem, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;

  async function call(method, p, body) {
    let r, text;
    for (let attempt = 0; ; attempt++) { // retry only reads and idempotent writes: a repeated POST would reserve twice
      r = await fetch(p.startsWith("http") ? p : API + p, { method, headers: { authorization: `Bearer ${jwt}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
      text = await r.text();
      if (method === "POST" || (r.status !== 429 && r.status < 500) || attempt === 4) break;
      await new Promise((ok) => setTimeout(ok, 2000 * 2 ** attempt));
    }
    if (!r.ok) throw new Error(`${method} ${p}: ${r.status} ${text.slice(0, 600)}`);
    return text ? JSON.parse(text) : {};
  }
  const all = async (p) => { const out = []; for (let u = p; u; ) { const j = await call("GET", u); out.push(...j.data); u = j.links?.next; } return out; };

  const app = (await call("GET", `/v1/apps?filter[bundleId]=${BUNDLE_ID}`)).data[0];
  if (!app) throw new Error(`no app ${BUNDLE_ID} for this key`);
  const versions = (await all(`/v1/apps/${app.id}/appStoreVersions?filter[platform]=IOS&limit=20`));
  const state = (v) => v.attributes.appVersionState ?? v.attributes.appStoreState;
  const editable = versions.find((v) => EDITABLE.has(state(v)));
  const live = versions.find((v) => ["READY_FOR_DISTRIBUTION", "READY_FOR_SALE"].includes(state(v)));
  const infos = await all(`/v1/apps/${app.id}/appInfos`);
  const info = infos.find((i) => !["READY_FOR_DISTRIBUTION", "READY_FOR_SALE"].includes(i.attributes.appStoreState ?? i.attributes.state)) ?? null;
  console.log(`App Store: ${app.attributes.name} (${app.id}); versions: ${versions.map((v) => `${v.attributes.versionString} ${state(v)}`).join(", ")}`);
  console.log(editable ? `editable version: ${editable.attributes.versionString}` : "no editable version: only promotional text can change (create the next version in App Store Connect for the rest)");
  console.log(info ? "editable app info: name and subtitle can change\n" : "app info is live: name and subtitle can change only with the next version\n");

  const target = editable ?? live;
  const vLocs = Object.fromEntries((await all(`/v1/appStoreVersions/${target.id}/appStoreVersionLocalizations`)).map((l) => [l.attributes.locale, l]));
  const iLocs = info ? Object.fromEntries((await all(`/v1/appInfos/${info.id}/appInfoLocalizations`)).map((l) => [l.attributes.locale, l])) : {};
  let changes = 0;

  for (const [lang, locs] of Object.entries(LOCALES)) {
    const a = JSON.parse(fs.readFileSync(path.join(root, "store/listings", `${lang}.json`), "utf8")).appstore;
    for (const loc of locs) {
      const vWant = editable ? { description: a.description, keywords: a.keywords, promotionalText: a.promotionalText, ...(a.whatsNew ? { whatsNew: a.whatsNew } : {}) } : { promotionalText: a.promotionalText };
      if (!vLocs[loc] && !editable) { console.log(`${loc}: not on the live version; added with the next version`); continue; }
      const have = vLocs[loc]?.attributes ?? {};
      const diff = Object.keys(vWant).filter((k) => (have[k] ?? "") !== vWant[k]);
      if (diff.length) {
        changes++;
        console.log(`${loc}: version ${vLocs[loc] ? "update" : "NEW locale"}: ${diff.map((k) => `${k} ${(have[k] ?? "").length}->${vWant[k].length}`).join(", ")}`);
        if (apply) {
          if (vLocs[loc]) await call("PATCH", `/v1/appStoreVersionLocalizations/${vLocs[loc].id}`, { data: { type: "appStoreVersionLocalizations", id: vLocs[loc].id, attributes: Object.fromEntries(diff.map((k) => [k, vWant[k]])) } });
          else if (editable) vLocs[loc] = (await call("POST", "/v1/appStoreVersionLocalizations", { data: { type: "appStoreVersionLocalizations", attributes: { locale: loc, ...vWant }, relationships: { appStoreVersion: { data: { type: "appStoreVersions", id: editable.id } } } } })).data;
        }
      } else console.log(`${loc}: version texts unchanged`);
      if (info) {
        const iWant = { name: a.name, subtitle: a.subtitle };
        const ih = iLocs[loc]?.attributes ?? {};
        const idiff = Object.keys(iWant).filter((k) => (ih[k] ?? "") !== iWant[k]);
        if (idiff.length) {
          changes++;
          console.log(`${loc}: app info: ${idiff.map((k) => `${k} ${JSON.stringify(ih[k] ?? "")} -> ${JSON.stringify(iWant[k])}`).join(", ")}`);
          if (apply) {
            if (iLocs[loc]) await call("PATCH", `/v1/appInfoLocalizations/${iLocs[loc].id}`, { data: { type: "appInfoLocalizations", id: iLocs[loc].id, attributes: Object.fromEntries(idiff.map((k) => [k, iWant[k]])) } });
            else await call("POST", "/v1/appInfoLocalizations", { data: { type: "appInfoLocalizations", attributes: { locale: loc, ...iWant }, relationships: { appInfo: { data: { type: "appInfos", id: info.id } } } } });
          }
        }
      }
    }
  }

  if (imagesAt) {
    if (!editable) throw new Error("screenshots need an editable version: create the next version in App Store Connect first");
    const missing = Object.keys(DISPLAY_TYPE).flatMap((cls) => Object.values(LOCALES).flat().map((loc) => path.join(imagesAt, "appstore", cls, PACK_DIR_FOR[loc] ?? loc)))
      .filter((d) => !fs.existsSync(d) || !fs.readdirSync(d).some((n) => n.endsWith(".png")));
    if (missing.length) throw new Error(`the pack is incomplete, nothing uploaded:\n  ${missing.join("\n  ")}`);
    for (const loc of Object.values(LOCALES).flat()) {
      const vl = vLocs[loc];
      if (!vl) { console.log(`  ${loc}: no version localization yet (run once with --apply for the texts first)`); continue; }
      const sets = Object.fromEntries((await all(`/v1/appStoreVersionLocalizations/${vl.id}/appScreenshotSets`)).map((s) => [s.attributes.screenshotDisplayType, s]));
      for (const [cls, type] of Object.entries(DISPLAY_TYPE)) {
        const dir = path.join(imagesAt, "appstore", cls, PACK_DIR_FOR[loc] ?? loc);
        const pngs = fs.readdirSync(dir).filter((n) => n.endsWith(".png")).sort();
        const want = pngs.map((n) => crypto.createHash("md5").update(fs.readFileSync(path.join(dir, n))).digest("hex"));
        const shots = sets[type] ? await all(`/v1/appScreenshotSets/${sets[type].id}/appScreenshots`) : [];
        if (shots.map((s) => s.attributes.sourceFileChecksum).join() === want.join()) { console.log(`  ${cls}/${loc}: unchanged`); continue; }
        changes++;
        console.log(`  ${cls}/${loc}: replace ${shots.length} with ${pngs.length} (${type})`);
        if (!apply) continue;
        for (const s of shots) await call("DELETE", `/v1/appScreenshots/${s.id}`);
        const set = sets[type] ?? (await call("POST", "/v1/appScreenshotSets", { data: { type: "appScreenshotSets", attributes: { screenshotDisplayType: type }, relationships: { appStoreVersionLocalization: { data: { type: "appStoreVersionLocalizations", id: vl.id } } } } })).data;
        for (const [i, n] of pngs.entries()) {
          const bytes = fs.readFileSync(path.join(dir, n));
          const res = (await call("POST", "/v1/appScreenshots", { data: { type: "appScreenshots", attributes: { fileName: `${String(i + 1).padStart(2, "0")}-${n}`, fileSize: bytes.length }, relationships: { appScreenshotSet: { data: { type: "appScreenshotSets", id: set.id } } } } })).data;
          for (const op of res.attributes.uploadOperations) {
            const r = await fetch(op.url, { method: op.method, headers: Object.fromEntries(op.requestHeaders.map((h) => [h.name, h.value])), body: bytes.subarray(op.offset, op.offset + op.length) });
            if (!r.ok) throw new Error(`upload ${n}: ${r.status}`);
          }
          await call("PATCH", `/v1/appScreenshots/${res.id}`, { data: { type: "appScreenshots", id: res.id, attributes: { uploaded: true, sourceFileChecksum: want[i] } } });
        }
      }
    }
  }

  console.log(apply ? `\nwrote ${changes} change(s). Nothing was submitted: the owner submits the version for review in App Store Connect.` : `\ndry run: ${changes} change(s); nothing written. Run again with --apply.`);
}
