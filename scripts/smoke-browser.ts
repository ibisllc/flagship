/**
 * Live smoke for the pod-resident browser feature.
 *
 *   npx tsx scripts/smoke-browser.ts
 *
 * Assumes `installer/data-services/init.sh` has brought up the
 * data-services compose stack (specifically the chromium container
 * exposing CDP on 127.0.0.1:9222). Exercises the daemon-side
 * BrowserManager against the live Chromium and the full
 * apiHandlers stack against an in-memory ServicePlatform with two
 * tenants so isolation is exercised end-to-end on real CDP.
 *
 * Prints OK / FAIL per check. Non-zero exit on any failure.
 */

import { ed } from "@flagship/protocol";
import { BrowserManager } from "../packages/server-daemon/src/browser/browserManager.js";
import { TabRegistry } from "../packages/server-daemon/src/browser/tabRegistry.js";
import { DomainGate } from "../packages/server-daemon/src/browser/domainGate.js";
import { PhonePipe } from "../packages/server-daemon/src/browser/phonePipe.js";
import { buildBrowserApiHandlers } from "../packages/server-daemon/src/browser/apiHandlers.js";
import { InMemoryAlertInbox } from "../packages/server-daemon/src/alertInbox.js";
import { InMemoryAppAuthTokens } from "../packages/server-daemon/src/serviceAuthToken.js";
import type { HttpRequest } from "../packages/server-daemon/src/runtime.js";

const ENDPOINT = process.env.FLAGSHIP_CHROMIUM_CDP ?? "http://127.0.0.1:9222";

let pass = 0;
let fail = 0;
function ok(label: string): void {
  console.log(`[smoke] ${label}: OK`);
  pass++;
}
function bad(label: string, why: unknown): void {
  console.error(`[smoke] ${label}: FAIL — ${why instanceof Error ? why.message : String(why)}`);
  fail++;
}

async function main(): Promise<void> {
  console.log(`[smoke] target chromium: ${ENDPOINT}`);
  const browser = new BrowserManager({ endpoint: ENDPOINT });
  await browser.start();
  console.log(`[smoke] BrowserManager connected`);

  // 1. Open a tab + read DOM
  let tabId = "";
  try {
    const r = await browser.openTab(
      "data:text/html,<h1 id=h>Hello, Flagship Browser</h1>",
    );
    tabId = r.tabId;
    await new Promise((r) => setTimeout(r, 200));
    const html = await browser.readDOM(tabId, "h1#h");
    if (!html || !html.includes("Flagship Browser")) {
      throw new Error(`readDOM returned ${JSON.stringify(html)}`);
    }
    ok("openTab + readDOM");
  } catch (e) {
    bad("openTab + readDOM", e);
  }

  // 2. Screenshot returns real PNG bytes
  try {
    const png = await browser.screenshot(tabId);
    if (png.length < 100) throw new Error(`screenshot too small: ${png.length}`);
    if (!(png[0] === 0x89 && png[1] === 0x50 && png[2] === 0x4e && png[3] === 0x47)) {
      throw new Error("not a PNG (bad magic bytes)");
    }
    ok(`screenshot (${png.length} bytes, PNG magic verified)`);
  } catch (e) {
    bad("screenshot", e);
  }

  // 3. Fill + click against a synthetic form
  try {
    await browser.navigate(
      tabId,
      `data:text/html,<form><input id=email name=email><input id=submit type=submit value=Go></form><div id=after></div>`,
    );
    await new Promise((r) => setTimeout(r, 200));
    await browser.fill(tabId, "#email", "alice@example.com");
    const filled = await browser.readDOM(tabId, "#email");
    if (!filled || !filled.includes('value="alice@example.com"')) {
      // The DOM string may not contain the typed value attribute; instead
      // check via Runtime.evaluate using the manager.
      const expr = `document.querySelector('#email').value`;
      const r = (await browser.sessionSend(
        await (async () => {
          const r2 = (await browser.send("Target.attachToTarget", {
            targetId: tabId,
            flatten: true,
          })) as { sessionId: string };
          return r2.sessionId;
        })(),
        "Runtime.evaluate",
        { expression: expr, returnByValue: true },
      )) as { result: { value: string } };
      if (r.result.value !== "alice@example.com") {
        throw new Error(`expected typed value 'alice@example.com', got ${r.result.value}`);
      }
    }
    ok("fill + verify via DOM read");
  } catch (e) {
    bad("fill + verify", e);
  }

  // 4. apiHandlers smoke: two apps, isolation enforced
  try {
    const registry = new TabRegistry(browser);
    registry.start();
    const gate = new DomainGate();
    gate.setGrant("smoke-shopper", ["example.com", "*.example.com"]);
    gate.setGrant("smoke-mailer", ["other.test"]);
    const inbox = new InMemoryAlertInbox();
    const pipe = new PhonePipe({ browser, tabRegistry: registry, inbox });
    pipe.start();
    const tokens = new InMemoryAppAuthTokens();
    const shopperT = await tokens.mint("smoke-shopper");
    const mailerT = await tokens.mint("smoke-mailer");
    const handle = buildBrowserApiHandlers({
      browser,
      tabRegistry: registry,
      domainGate: gate,
      phonePipe: pipe,
      appAuthTokens: tokens,
    });

    const reqOf = (m: string, p: string, t: string, body?: unknown): HttpRequest => ({
      method: m,
      path: p,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${t}`,
      },
      body: body !== undefined ? Buffer.from(JSON.stringify(body)) : Buffer.alloc(0),
    });

    // shopper opens an example.com page (data: URLs would fail the gate
    // — gate only allows http/https). We use example.com via the
    // chromium container, which DOES need network egress. The container
    // can reach the public internet via Docker's default bridge —
    // expected to work on the dev VM. If example.com is unreachable
    // for any reason this whole step fails; that's acceptable for a
    // live smoke (it tells us the network path is broken).
    const open = await handle(
      reqOf("POST", "/api/browser/tabs", shopperT, { url: "https://example.com/" }),
    );
    if (open?.status !== 200) {
      throw new Error(`shopper openTab returned ${open?.status}: ${String(open?.body).slice(0, 200)}`);
    }
    const shopperTabId = JSON.parse(String(open.body)).tabId as string;

    // mailer opening example.com — denied by gate.
    const denied = await handle(
      reqOf("POST", "/api/browser/tabs", mailerT, { url: "https://example.com/" }),
    );
    if (denied?.status !== 403) {
      throw new Error(`mailer openTab to disallowed domain should be 403, got ${denied?.status}`);
    }

    // mailer touching shopper's tab — 404 (no existence leak).
    const cross = await handle(
      reqOf("POST", `/api/browser/tabs/${shopperTabId}/navigate`, mailerT, {
        url: "https://other.test/",
      }),
    );
    if (cross?.status !== 404) {
      throw new Error(`cross-tenant tabId access should be 404, got ${cross?.status}`);
    }

    // shopper reads DOM on its own tab.
    await new Promise((r) => setTimeout(r, 1500)); // allow page load
    const dom = await handle(
      reqOf(
        "GET",
        `/api/browser/tabs/${shopperTabId}/dom?selector=${encodeURIComponent("body")}`,
        shopperT,
      ),
    );
    if (dom?.status !== 200) {
      throw new Error(`readDOM on own tab should be 200, got ${dom?.status}`);
    }
    const outer = JSON.parse(String(dom.body)).outerHTML as string | null;
    if (!outer || !/<body/i.test(outer)) {
      throw new Error(`readDOM body is missing or unexpected: ${outer?.slice(0, 100)}`);
    }

    // shopper closes its tab.
    const del = await handle(
      reqOf("DELETE", `/api/browser/tabs/${shopperTabId}`, shopperT),
    );
    if (del?.status !== 200) {
      throw new Error(`closeTab returned ${del?.status}`);
    }

    pipe.stop();
    registry.stop();
    ok("apiHandlers two-tenant isolation (open + cross-deny + cross-404 + DOM + close)");
  } catch (e) {
    bad("apiHandlers two-tenant isolation", e);
  }

  // 5. Profile persistence sanity (cookies survive container restart) —
  //    we don't actually restart the container in this script (that's
  //    a sysadmin op), but we do verify the profile dir exists in the
  //    expected location and is non-empty.
  try {
    const { existsSync, readdirSync } = await import("node:fs");
    const dir = "/var/flagship/data/chromium/profile";
    if (!existsSync(dir)) {
      console.warn(`[smoke] profile dir ${dir} not on this host (skipping persistence check)`);
    } else {
      const entries = readdirSync(dir);
      if (entries.length === 0) {
        throw new Error(`profile dir ${dir} is empty after browsing`);
      }
      ok(`profile persistence: ${dir} populated (${entries.length} entries)`);
    }
  } catch (e) {
    bad("profile persistence", e);
  }

  await browser.stop();
  console.log("");
  console.log(`[smoke] ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(2);
  console.log(`[smoke] ✅ browser-feature integration green`);
}

main().catch((e) => {
  console.error(`[smoke] fatal: ${(e as Error).stack ?? e}`);
  process.exit(1);
});

void ed; // silence unused import in trimmed paths
