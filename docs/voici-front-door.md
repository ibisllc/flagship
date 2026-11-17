# voi.ci's front door (0.4)

Status: built on `0.4/voici-front` (2026-11-17), not deployed. Owner request: "think about a placeholder or redirect
on voi.ci for people who start from there (maybe market it to French-speaking audiences as a twitter clone)".

A voi.ci page belongs to a Flagship owner (`docs/voici-and-messages.md`, made from the app's Social tab:
`docs/social-tab.md`). Until now nobody could start *from* voi.ci: the root and every unknown name answered the
same 404 shell, "There's no page here. Check the address and try again." (live check 2026-11-17: `GET https://voi.ci/`
→ 404). The front door is what someone who types `voi.ci`, or who wants a page like the one they just visited, sees.

## 1. Audience

French-speaking first. `.ci` is Côte d'Ivoire's domain, and "voici" is everyday French ("here is"), so the name reads
naturally to a French speaker and looks local in Abidjan. Natural fits: Côte d'Ivoire, Senegal, Mali, Burkina Faso,
Cameroon, the two Congos, Benin, Togo, Guinea, Niger, Madagascar, the Maghreb, Haiti, France. Most of these
audiences are phone-first and often Android-first on modest devices, so the page must be light (no script at all, one
stylesheet, one font) and lead with the store buttons. The other shipped languages get the same page in their
language; nothing else is region-specific.

## 2. Positioning

"Your own page, your posts, people can message and call you, and nobody reads it but you": a calm alternative to the
big public feeds. User copy never names a competitor. What it says, and why each claim is true:

- **Your own page, your posts.** One page at `voi.ci/<account name>`, short posts newest first, links. No algorithm
  picks who sees a post (there is no feed at all).
- **People can message you and call you.** "Send me a message" and "Call" on the page (calls need `VOICI_CALLS`; see
  §9).
- **Nobody reads it but you.** Said of messages and calls only, never of the page: the page is public. Messages are
  sealed to the owner's inbox key (§7 of the main spec), calls are end to end. A report tells Flagship which account
  sent a message and shows its text only if the reporter chooses to (§9.2), and the page says exactly that.
- **Quiet by design.** No ads, no follower counts, no endless feed.

The tone is calm and plain: short sentences, no exclamation marks, no growth language ("join millions"). The French is
written for the audience, not translated: "vous" (the site already uses it), "Une page bien à vous", "on peut vous
écrire et vous appeler", French typography (non-breaking space before `:` and `»`, narrow before `?`).

## 3. The page

`https://voi.ci/` (also `www.voi.ci/`, gym `https://gym.voi.ci/`), top to bottom:

1. **Bar**: the `voi.ci` wordmark (teal dot) and "Made with Flagship" (to the apex).
2. **Hero**: eyebrow "Your page on voi.ci", the headline "A page of your own.", one sentence of promise, the two store
   buttons (App Store in ink, Google Play outlined), "Or use Flagship in your browser", and "Flagship is free. There's
   no account to create here: your page is made in the app." Beside it (below it on a phone) a sample page drawn in
   HTML and CSS: Aya, a photographer in Abidjan, her "Send me a message" and "Call" buttons and a post about the
   markets of Treichville. Decorative (`aria-hidden`), not a link, no image file.
3. **What your page does**: four short blocks (posts in order, private messages, calls, quiet by design).
4. **Make your page in three steps**: get the app, open the Social tab, turn on Public ("Publique" in French, the
   app's own word). Then "Open Flagship" → `https://<apex>/app/page-editor` (the app link that opens the page editor
   on iOS, Android and the webapp, and the open-in-app page with the store buttons when the app is not installed).
5. **What we can see**: the page is public and checked against the owner's signature; messages and calls are not
   public; what a report reveals.
6. **"Your page, your words."** and the store buttons again.
7. **Footer**: Terms, Report abuse, About voi.ci, and every shipped language as a plain link (`/?lang=<code>`).

The look is the one the voi.ci UI pass gave the pages (warm paper canvas, hairlines instead of shadows, Geist with
Geist Mono for labels, one teal accent; the same tokens, so dark mode follows the visitor). All styles are in the
site's `style.css` under "the front door" (`fd-` classes), served with SRI.

## 4. Signup path

There is no account creation on voi.ci. The only ways forward are:

- **App Store** and **Google Play**: the URLs come from `apps/web/public/app-stores.js` (the one place they live);
  `build.mjs` reads them at build time (`storeLinks()`, which fails the build if either is missing).
- **The webapp**: `https://webapp.<apex>/`.
- **Already have the app**: `https://<apex>/app/page-editor`.

Inside the app the person creates an account (its name becomes the page address), opens Social, fills the page and
turns on Public. The front door never says "sign up here" and has no form.

## 5. From an existing page

Every voi.ci page's footer, and the footer of voi.ci's own states (unknown name, removed link, "couldn't load",
about), now has **"Make your own page ↗"** (`.make-own`, `page.js` `footer()`), linking to `https://<this voi.ci>/`.
It is a plain same-tab link to the front door, not to the stores: a visitor first learns what a page is.

## 6. Search and indexing

- The front door is indexable: `<meta name="robots" content="index, follow">`, a title and description per language,
  Open Graph tags (no `og:image` yet: §9), `rel=canonical` to `https://voi.ci/?lang=<served language>`, and
  `hreflang` alternates for every shipped language plus `x-default` → `https://voi.ci/`.
- voi.ci's 404 and 410 shells (unknown, reserved, unpublished, a removed link) now carry
  `<meta name="robots" content="noindex">`.
- Owner pages are unchanged (no robots meta; they are rendered by script after a signature check, so crawlers that do
  not run scripts see only the shell). Whether a page should be `noindex` by default, with an owner opt-in, is an open
  decision (§9).
- No `robots.txt` or sitemap: `/robots.txt` is a 404 (paths with a dot are never names), which crawlers read as
  "allowed".

## 7. Language

The Worker picks the language per request and sends `Content-Language` and `Vary: Accept-Language`:

1. `?lang=<code>` when it names a shipped language (the footer's links; anything else is ignored).
2. The shared rule (`test-vectors/language-negotiation.json`, `pickWebLocale`): preferences in order, English anywhere
   stops the search, an exact tag wins, same base language otherwise (`fr-CI`, `fr-SN`, `fr-CA` → French).
3. voi.ci's own step: a browser none of whose preferences ship and that never asked for English gets **French** when
   a preference names a French-speaking country (`wo-SN`, `ar-MA`, `dyu-CI`) or a language commonly read alongside
   French (Wolof, Bambara, Dioula, Baoulé, Mooré, Fula, Lingala, Kongo, Sango, Malagasy, Kinyarwanda, Kirundi,
   Haitian Creole, Breton, Occitan, Corsican). Belgium, Switzerland, Canada and Luxembourg are left out of the region
   list, because there a non-French tag (`nl-BE`, `gsw-CH`) means another language.
4. English.

The tables live once, in `apps/voici-site/src/lang.js`; the build copies them into the Worker module. Owner pages use
the same function in the browser (`navigator.languages`), so a Wolof browser also reads a page's buttons in French.
Vectors: `test-vectors/voici-front-language.json`, run against both the site and the Worker.

## 8. Failure handling

The front door is the one voi.ci answer that needs nothing but the Worker's own code:

- It is rendered at build time into `apps/com/src/voiciSiteBuild.generated.ts` (`VOICI_FRONT_DOOR`, one page per
  language). Serving it reads no D1, R2, KV or Durable Object and makes no fetch; `serveVoiciHost` answers `/` before
  it even looks at the D1 binding. Tested with storage bindings that throw on any access, and with no D1 binding.
- It runs no script, so a broken site module, a failed API call or a CSP problem cannot blank it. Without the
  stylesheet (assets layer down) it is still readable, ordered HTML with working links.
- Its links lead to places that do not depend on `.com`: the stores, and the webapp (served by the separate static
  Worker `flagship-webapp`). "Open Flagship" opens the installed app directly; only without the app does it need
  `.com`'s open-in-app page.
- `cache-control: public, max-age=300` with `Vary: Accept-Language`, so browsers keep it a few minutes.
- What it cannot survive: the `flagship-com` Worker itself not running (voi.ci is routed to it). Serving voi.ci's root
  from the static `flagship-webapp` Worker would cover that and is a possible follow-up; not worth it before traffic.
- Before `VOICI_ENABLED` is on, `/` stays the empty 404 it was.

## 9. Open decisions (owner)

- **Trademark.** "Voici" is also a well-known French celebrity magazine (Prisma Media). Check the mark in France and
  the EU (and OAPI, which covers Côte d'Ivoire and most of francophone West and Central Africa) before marketing the
  brand there.
- **Calls in the copy.** The front door promises calls, but production has `VOICI_CALLS = "off"`. Either turn calls on
  before marketing, or drop the calls block and the "call you" wording until then.
- **"Twitter clone".** The page positions voi.ci as a calm alternative without naming anyone. Calling it a clone of a
  named service in ads is a marketing and legal choice for the owner; nothing in the product says it.
- **Owner pages and search engines**: index by default, or `noindex` by default with an owner switch.
- **Social card**: an `og:image` (a static 1200×630 card per language) for links shared on messaging apps, which
  matter a lot in the target markets.
- **Tutoiement.** French uses "vous" everywhere on voi.ci. A younger, more informal "tu" voice is possible for
  marketing, but it would need to change on the pages too.
- **Native review** of the French copy (and the five others) before any campaign (`i18n/REVIEW.md`).
- **Static fallback**: serve `/` from the `flagship-webapp` static Worker (§8) if voi.ci becomes a real entry point.

## 10. Files

- `apps/voici-site/src/front.js`: the page, rendered at build time (not served as a module).
- `apps/voici-site/src/lang.js`: the language rule, used by the site and the build.
- `apps/voici-site/build.mjs`: renders the front door per language into the Worker module; noindex on 404/410 shells.
- `apps/com/src/voiciFrontDoor.ts`, `apps/com/src/voiciRoutes.ts`: language pick and serving at `/`.
- `apps/voici-site/src/page.js`, `app.js`: "Make your own page" in every footer.
- `i18n/voici-site/*.json`: the strings (`node apps/voici-site/i18n.mjs extract|build|check`).
- Tests: `apps/voici-site/tests/front.test.ts`, `render.test.ts`, `apps/com/test/voiciFrontDoor.test.ts`,
  `test-vectors/voici-front-language.json`.
- Preview: `node apps/voici-site/dev/serve.mjs` (now serves `/` and the site's `/-/` files) and
  `node apps/voici-site/dev/front-screenshots.mjs <dir>`.
