// T2: does Chrome send SNI (and ALPN, key-share groups) to a turns: server, and does it check the certificate?
// Also records the ClientHello of a wss:// connection (option B) for comparison.
import fs from "node:fs";
import * as env from "./lib/env.mjs";
import { openPage } from "./lib/browser.mjs";
const out = {};
try {
  await env.link({ delayMs: 5 });
  await env.phoneB();
  for (const cert of ["leaf", "wrong"]) {
    await env.coturn(cert);
    await env.relay("127.0.0.1:5349");
    const { browser, page } = await openPage({ resolve: env.RESOLVE });
    await page.evaluate(() => aSetup({ iceServers: [{ urls: "turns:alice.calls.test:443?transport=tcp", username: "spike", credential: "spike" }], policy: "relay", role: "caller", encrypt: false }));
    await page.evaluate(() => aOffer());
    const c = await page.evaluate(() => aCollect().cands);
    out[`turns_${cert}`] = {
      cert: cert === "leaf" ? "right name, CA trusted by the test browser (NSS)" : "wrong name, self-signed (untrusted)",
      relayCandidates: c.filter((x) => / typ relay /.test(x.candidate)).length,
      helloAtRelay: env.jsonLines("relay").filter((x) => x.ev === "hello"),
    };
    await browser.close();
  }
  await env.relay("127.0.0.1:7443");
  env.clearLines("relay");
  for (const ignore of [false, true]) {
    const { browser, page } = await openPage({ resolve: env.RESOLVE, ignoreHTTPSErrors: ignore });
    const r = await page.evaluate(() => new Promise((res) => { const w = new WebSocket("wss://alice.calls.test/api/phone/call?run=hello"); w.onopen = () => { w.close(); res("open"); }; w.onerror = () => res("error"); setTimeout(() => res("timeout"), 5000); }));
    out[`wss_ignoreCertErrors_${ignore}`] = { result: r };
    await browser.close();
  }
  out.wssHelloAtRelay = env.jsonLines("relay").filter((x) => x.ev === "hello")[0];
  out.wssTlsAtPhone = env.jsonLines("phoneb").filter((x) => x.ev === "tls").slice(-1)[0];
} finally { env.stopAll(); }
fs.writeFileSync("results/turns-check.json", JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
process.exit(0);
