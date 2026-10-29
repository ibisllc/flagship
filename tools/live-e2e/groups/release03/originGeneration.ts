// N11 origin generations (0.3): a browser navigating an app address it has no current generation cookie
// for goes once through `/__flagship/generation` (which drops that address's stored data) and lands on
// the path it asked for; a navigation that holds the cookie goes straight to the app. API calls (no
// navigation) are never redirected.
import { request as httpsRequest } from "node:https";
import { assert, http, short, tryHttp } from "../../lib/harness.js";
import { installWhoami } from "../gating.js";
import type { Group } from "../types.js";
import { uninstall, until } from "./util.js";

const COOKIE = "__Host-Flagship-Generation";
/**
 * A top-level navigation as a browser sends it. Node's fetch sets `sec-fetch-mode: cors` itself and would replace the
 * header this check is about, so the request is made with node:https, which sends exactly what it is given.
 */
function navHttp(url: string, cookie?: string): Promise<{ status: number; text: string; headers: Headers; setCookies: string[] }> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(url, { method: "GET", headers: { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document", accept: "text/html", ...(cookie ? { cookie } : {}) }, timeout: 30_000 }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const headers = new Headers();
        for (const [k, v] of Object.entries(res.headers)) if (k !== "set-cookie" && v !== undefined) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
        resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8"), headers, setCookies: res.headers["set-cookie"] ?? [] });
      });
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.end();
  });
}

export const originGeneration: Group = {
  name: "origin-generation",
  title: "a fresh browser goes once through /__flagship/generation, then straight to the app",
  needs: ["A1"],
  phase: 2,
  async run({ A, rec, box }) {
    const b = box("A1");
    const slug = "genprobe";
    const base = `https://${slug}.${b.fqdn}`;
    const up = await rec.check("an open app answers", async () => {
      await installWhoami(A, b, slug, { enabled: true, public_routes: ["/*"] });
      // Not as a navigation: that is what the next check is about.
      await until("the app serving", 3 * 60_000, async () => ((await tryHttp(`${base}/`, { headers: { "sec-fetch-mode": "cors" } }, 12_000)).status === 200 ? true : undefined));
      return base;
    });
    if (!up) return;

    let cookie = "";
    await rec.check("a navigation without the cookie is a 303 to /__flagship/generation that clears storage, not every cookie", async () => {
      const r = await navHttp(`${base}/hello?x=1`);
      assert(r.status === 303, `got ${r.status}: ${short(r.text)}`);
      const loc = r.headers.get("location") ?? "";
      assert(loc.startsWith("/__flagship/generation?g=") && loc.includes(encodeURIComponent("/hello?x=1")), `location ${loc}`);
      const csd = r.headers.get("clear-site-data") ?? "";
      assert(/"storage"/.test(csd) && !/"cookies"/.test(csd), `clear-site-data ${csd}`);
      const set = await navHttp(`${base}${loc}`);
      assert(set.status === 303, `generation path ${set.status}`);
      const c = set.setCookies.find((x) => x.startsWith(`${COOKIE}=`));
      assert(c && /Secure/.test(c) && /HttpOnly/.test(c), `cookie ${short(set.setCookies)}`);
      cookie = c.split(";")[0]!;
      const back = set.headers.get("location") ?? "";
      assert(back === "/hello?x=1&__flagship_gen=1", `back to ${back}`);
      const clean = await navHttp(`${base}${back}`, cookie);
      assert(clean.status === 303 && clean.headers.get("location") === "/hello?x=1", `marker strip ${clean.status} ${clean.headers.get("location")}`);
      return "303 → set cookie → back, marker dropped";
    });
    await rec.check("with the cookie the navigation reaches the app", async () => {
      assert(cookie, "no cookie from the previous check");
      const r = await navHttp(`${base}/hello?x=1`, cookie);
      assert(r.status === 200, `got ${r.status}: ${short(r.text)}`);
      return "200";
    });
    await rec.check("an API call (not a navigation) is never redirected", async () => {
      const r = await http(`${base}/api-ish`, { headers: { "sec-fetch-mode": "cors", accept: "application/json" } });
      assert(r.status !== 303, `got a redirect: ${r.headers.get("location")}`);
      return String(r.status);
    });
    await uninstall(A, b, slug);
  },
};
