import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
const { chromium } = createRequire(import.meta.url)("playwright");
const here = path.dirname(new URL(import.meta.url).pathname);
export const ARGS = ["--autoplay-policy=no-user-gesture-required", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--no-proxy-server"];
export async function openPage({ netns, resolve, ignoreHTTPSErrors = false, extraArgs = [] } = {}) {
  const args = [...ARGS, ...extraArgs];
  if (resolve) args.push(`--host-resolver-rules=${resolve}`);
  let executablePath;
  if (netns) {
    const real = chromium.executablePath();
    const wrap = path.join(here, `../results/.chrome-in-${netns}.sh`);
    fs.writeFileSync(wrap, `#!/bin/sh\nexec ip netns exec ${netns} "${real}" "$@"\n`, { mode: 0o755 });
    executablePath = wrap;
  }
  const browser = await chromium.launch({ args, executablePath, headless: true });
  const ctx = await browser.newContext({ ignoreHTTPSErrors });
  const page = await ctx.newPage();
  page.on("console", (m) => { if (m.type() === "error") console.error("[page]", m.text()); });
  const js = fs.readFileSync(path.join(here, "page.js"), "utf8");
  await page.route("http://localhost/**", (r) => r.fulfill({ contentType: "text/html", body: `<!doctype html><meta charset=utf-8><script>${js}</script>` }));
  await page.goto("http://localhost/");
  return { browser, page };
}
