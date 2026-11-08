// T0/T1: browser capabilities and Opus frame sizes for both options (no network).
import fs from "node:fs";
import { openPage } from "./lib/browser.mjs";
const { browser, page } = await openPage();
const out = { caps: await page.evaluate(() => caps()) };
out.frameSizesB = await page.evaluate(() => frameSizesB(20));
out.frameSizesA_default = await page.evaluate(() => frameSizesA({ cbr: false, seconds: 12 }));
out.frameSizesA_cbr = await page.evaluate(() => frameSizesA({ cbr: true, seconds: 12 }));
await browser.close();
fs.writeFileSync("results/local-checks.json", JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
