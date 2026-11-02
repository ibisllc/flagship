#!/usr/bin/env node
// Renders the built site against the dev server and saves screenshots at phone and desktop widths, in light and
// dark: the three page variants, the sign-in sheet, a signed-in thread (a session made in the page with the vector
// keys, the way an app would), the report sheet and the error states. Also fails on any CSP violation or console
// error, which is the check that the strict CSP and the no-inline rule hold in a real browser.
//
//   node apps/voici-site/build.mjs && node apps/voici-site/dev/screenshots.mjs [outDir]
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import { M } from "./fixture.mjs";
import { startDevServer } from "./serve.mjs";

const out = process.argv[2] ?? join(process.cwd(), "voici-screenshots");
mkdirSync(out, { recursive: true });
const port = 4300 + Math.floor(Math.random() * 500);

const browser = await chromium.launch();

// Real JPEGs for the avatar and a link card, drawn in the browser (the apps re-encode from pixels the same way).
const painter = await browser.newPage();
const jpeg = async (w, h, kind) =>
  Buffer.from(
    await painter.evaluate(
      async ({ w, h, kind }) => {
        const c = new OffscreenCanvas(w, h);
        const g = c.getContext("2d");
        if (kind === "avatar") {
          const bg = g.createLinearGradient(0, 0, w, h);
          bg.addColorStop(0, "#e9dcc4");
          bg.addColorStop(1, "#c9b48f");
          g.fillStyle = bg;
          g.fillRect(0, 0, w, h);
          g.fillStyle = "#6f8f5a";
          g.beginPath();
          g.ellipse(w * 0.5, h * 1.02, w * 0.42, h * 0.36, 0, 0, Math.PI * 2);
          g.fill();
          g.fillStyle = "#e6b98f";
          g.beginPath();
          g.arc(w * 0.5, h * 0.42, w * 0.19, 0, Math.PI * 2);
          g.fill();
          g.fillStyle = "#3b2a1f";
          g.beginPath();
          g.ellipse(w * 0.5, h * 0.33, w * 0.21, h * 0.13, 0, Math.PI, Math.PI * 2);
          g.fill();
          g.fillStyle = "#d9a441";
          g.beginPath();
          g.ellipse(w * 0.5, h * 0.24, w * 0.3, h * 0.05, 0, 0, Math.PI * 2);
          g.fill();
        } else {
          const sky = g.createLinearGradient(0, 0, 0, h);
          sky.addColorStop(0, "#cfe3d6");
          sky.addColorStop(1, "#f3ecd9");
          g.fillStyle = sky;
          g.fillRect(0, 0, w, h);
          for (let i = 0; i < 9; i++) {
            g.fillStyle = i % 2 ? "#5d7f4a" : "#7a9b5c";
            g.beginPath();
            g.ellipse(30 + i * 44, h * 0.8, 26, 60, 0, 0, Math.PI * 2);
            g.fill();
          }
          g.fillStyle = "#c2552d";
          for (let i = 0; i < 9; i++) {
            g.beginPath();
            g.arc(30 + i * 44, h * 0.55, 9, 0, Math.PI * 2);
            g.fill();
          }
        }
        const b = await c.convertToBlob({ type: "image/jpeg", quality: 0.82 });
        return [...new Uint8Array(await b.arrayBuffer())];
      },
      { w, h, kind },
    ),
  );
const images = { avatar: await jpeg(512, 512, "avatar"), card: await jpeg(400, 210, "card") };
await painter.close();

const dev = await startDevServer({ port, images });
const problems = [];
const sizes = { phone: { width: 390, height: 844 }, desktop: { width: 1280, height: 860 } };

async function shot(name, size, scheme, path, act) {
  const ctx = await browser.newContext({ viewport: sizes[size], colorScheme: scheme, deviceScaleFactor: 2, hasTouch: size === "phone", isMobile: size === "phone" });
  const page = await ctx.newPage();
  page.on("console", (m) => {
    // Failed fetches are expected (the live ping to a real phone name, a page that doesn't exist); CSP violations and
    // script errors are not.
    if (m.type() === "error" && !m.text().startsWith("Failed to load resource")) problems.push(`${name}: console error: ${m.text()}`);
  });
  page.on("pageerror", (e) => problems.push(`${name}: ${e.message}`));
  await page.goto(dev.origin + path);
  await page.waitForSelector(".page:not([aria-busy])");
  if (act) await act(page);
  await page.waitForTimeout(250);
  const file = join(out, `${name}-${size}-${scheme}.png`);
  await page.screenshot({ path: file, fullPage: !act });
  await ctx.close();
  return file;
}

/** A session for alice's page made in the browser the way the app's answer would be, with the vector keys. */
async function signInAsVectorVisitor(page) {
  await page.evaluate(
    async ({ M }) => {
      const dir = document.querySelector('meta[name="voici-build"]').getAttribute("content").slice(0, 16);
      const W = await import(`/_/${dir}/flagship-web/index.js`);
      const P = W.protocol;
      const b = await W.createBrowserKey();
      const D = M.derivations;
      const delegation = {
        scope: "voici-messages",
        origin: "https://voi.ci",
        audience: D.pageId,
        principalPub: D.pseudonymPub,
        delegateAlg: "p256",
        delegatePub: b.delegatePub,
        issuedAt: Date.now() - 60_000,
        expiresAt: Date.now() + 86_400_000,
        nonce: "5e".repeat(16),
      };
      const store = await W.openIndexedDbStore();
      await store.put(`voici-session:${D.pageId}`, {
        v: 1,
        pageId: D.pageId,
        username: "alice",
        origin: "https://voi.ci",
        privateKey: b.privateKey,
        delegatePub: b.delegatePub,
        pseudonymPub: D.pseudonymPub,
        attestation: M.attestation.signed,
        delegation,
        delegationSig: P.signWebDelegation(delegation, P.hexToBytes(D.pseudonymSeed)),
        threadStmt: M.threadStatement.statement,
        threadSig: M.threadStatement.signature,
        threadSeed: D.threadSeed,
        savedAt: Date.now(),
      });
    },
    { M },
  );
}

const files = [];
for (const size of ["phone", "desktop"]) {
  for (const scheme of ["light", "dark"]) {
    files.push(await shot("alice-classic", size, scheme, "/alice"));
    files.push(await shot("bruno-ink", size, scheme, "/bruno"));
    files.push(await shot("cora-sea", size, scheme, "/cora"));
  }
  files.push(await shot("sign-in", size, "light", "/alice", async (p) => {
    await p.click(".message-cta .btn");
    await p.waitForSelector(".pair-code:not([hidden])", { timeout: 5000 });
  }));
  files.push(await shot("thread", size, "light", "/alice", async (p) => {
    await signInAsVectorVisitor(p);
    await p.click(".message-cta .btn");
    await p.waitForSelector(".bubble-row.theirs", { timeout: 5000 });
    await p.fill(".compose-input", "See you Saturday! I'll bring the basil cuttings.");
    await p.click(".compose .btn-primary");
    await p.waitForSelector(".bubble-row.mine:last-child .receipt", { timeout: 5000 });
  }));
  files.push(await shot("thread", size, "dark", "/alice", async (p) => {
    await signInAsVectorVisitor(p);
    await p.click(".message-cta .btn");
    await p.waitForSelector(".bubble-row.theirs", { timeout: 5000 });
  }));
  files.push(await shot("report", size, "light", "/alice", async (p) => {
    await p.click(".site-footer .btn-ghost");
    await p.waitForSelector(".report-form");
  }));
  files.push(await shot("not-found", size, "light", "/nobody"));
  files.push(await shot("about", size, "light", "/_/about"));
}
files.push(await shot("alice-french", "phone", "light", "/alice", async (p) => {
  await p.selectOption(".lang", "fr");
}));

await dev.close();
await browser.close();
console.log(files.join("\n"));
if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
