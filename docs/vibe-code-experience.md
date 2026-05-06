# Vibe-coding on Flagship — the experience

What vibe-coding *feels* like on Flagship. Not a build spec — `lifecycle-spec.md §7` and `build-tasks.md §C.2/§H` cover engineering. This is for the people deciding which words to use and what to never surface.

Audience: not a developer. iPhone, a box plugged in at home, has used ChatGPT once. Has never seen a Dockerfile and should not see one here.

---

## 1. Mental model

The promise the phone makes:

> Tell me what you want; ninety seconds later it's at your URL.

That is the entire contract. Manifest, data-layer provisioning, docker build, migrations, cert, proxy — plumbing the user is allowed to ignore forever.

The ritual is three steps: **describe** (free text), **approve** (one Face ID on a permissions summary), **use** (open the URL with a real green padlock). Anything fancier is something the user *grew into*, not something they were asked to learn upfront.

### What each minute feels like

**T+0:00.** User taps **+ Vibe-code a new app** on `[Apps]`. Screen is `design-system.md §10.3`: big textarea, caret blinking, four preset chips (Habit tracker / Family list / Inventory / Sleep journal), one button that reads **Build it** with subline *about 90 seconds*. Not *Generate AI App*. Not *Compile*. **Build it**, because that's what will happen.

**T+0:21.** Tap. Transition to `[Generating]`. Top: status pill `Thinking · Anthropic Claude`. Below: three empty cards labeled `Manifest`, `Code`, `Database`, each with its own status pill. They fill in order.

**T+0:25 → 0:55.** Each card flips `Pending → Writing → Done` with one plain-English line as it goes:

- Manifest: *"Naming it `plants`. It'll get a Postgres table for plants and a place to store one photo per plant."*
- Code: *"Wrote `src/index.js`. Wrote `src/index.html`. Wrote `Dockerfile`."*
- Database: *"Setting up the `plants` table with name, last-watered, photo path."*

Raw JSON / source / SQL is *not* on screen. A `Show what's being written` accordion exists for the curious; collapsed by default.

**T+1:00.** A new card slides in: **Permissions**. Plain English: *"A Postgres table, just for this app. An object store bucket for photos. Push notifications."* Button changes from disabled to **Approve & deploy**, subline *"Face ID. About 30 more seconds."*

**T+1:05 → 1:30.** Face ID. Card flips through `Building image → Starting → Getting TLS cert`. A linear progress bar; each phase 5–15s.

**T+1:30.** The success-pulse from `design-system.md §10.1`. Card reads:

> **plants** is live.
> `plants.harry.flagship.services`
> [ Open it ]   [ Make a change ]   [ Done for now ]

One screen of typing, one Face ID, one URL.

---

## 2. Three full conversation transcripts

What the LLM sees, what it emits, how the phone narrates it. Format: `[system] / [user] / [assistant]` for the wire-level exchange; phone rendering follows.

### 2.1 "shopping list with the family"

**[system]** *(rendered by `buildUserContext`)*: full `SYSTEM_PROMPT_V1` + session context: user `harry`, server `home.harry.flagship.services`, tier `hobby`, providers `anthropic, openai`, existing apps `notes [postgres]`, `plants [postgres, objects]`.

**[user]**: *"shopping list with the family"*

**[assistant]**:

```
=== flagship.app.json ===
{
  "schema_version": 1,
  "name": "shopping",
  "version": "0.1.0",
  "description": "A shared shopping list for the household.",
  "runtime": { "image": "flagship/shopping:0.1.0", "port": 8080 },
  "data": { "stores": { "postgres": true } },
  "network": { "subdomain": "shopping" },
  "access": { "enabled": true, "default_role": "member", "public_routes": [] },
  "migration": { "verification": "standard" }
}
=== Dockerfile ===
FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY src ./src
EXPOSE 8080
CMD ["node", "src/index.js"]
=== src/index.js ===
// HTTP server: 403 on anonymous, GET /api/items, POST /api/items.
// Reads x-flagship-user header for authorship; pg.Pool against FLAGSHIP_PG_URL.
=== migrations/0001_init.sql ===
create table items (
  id        bigserial primary key,
  label     text not null,
  done      boolean not null default false,
  added_by  text not null,
  added_at  timestamptz not null default now()
);
=== END ===
```

**Phone narration** (the *only* thing the user sees):

| Card | Plain-English line |
|---|---|
| Manifest | "Naming it `shopping`. Just a Postgres table — no photos, no logins." |
| Code | "Writing the server, the page, and a small bit of JavaScript that ticks items off." |
| Database | "One table: items, who added them, whether they're done." |
| Permissions | "A Postgres table, just for this app. That's it." |

### 2.2 "a private wiki for my D&D campaign"

This is the **clarifying-question** path. *"Private"* is ambiguous (just the user, or the household?), and a wiki implies multi-user editing. The model pauses.

**[assistant]**:

```
=== QUESTION ===
Will your players need to read and edit it, or is this just for you to plan?
=== END ===
```

The phone replaces the three cards with one chat bubble:

> *Will your players need to read and edit it, or is this just for you to plan?*
>
> [ Just me ]  [ My players too ]  [ Type a different answer ]

User taps `My players too`. The session resumes:

**[user]** (continuing): *"they should be able to read and edit. about 5 of them."*

**[assistant]** (manifest + Dockerfile + sources + migration; key fields shown):

```
=== flagship.app.json ===
{
  "schema_version": 1,
  "name": "campaign-wiki",
  "version": "0.1.0",
  "description": "A private collaborative wiki for a tabletop RPG campaign.",
  "runtime": { "image": "flagship/campaign-wiki:0.1.0", "port": 8080 },
  "data": { "stores": { "postgres": true, "objects": true } },
  "network": { "subdomain": "campaign" },
  "access": {
    "enabled": true, "default_role": "member",
    "custom_roles": ["dm"], "public_routes": []
  },
  "migration": { "verification": "standard" }
}
=== Dockerfile === (node:20-alpine, exposes 8080)
=== src/index.js ===
// Server reads X-Flagship-Role to gate `dm`-only edits on session notes;
// members edit pages, viewers read.
=== migrations/0001_init.sql ===
create table pages (
  id bigserial primary key, slug text unique not null,
  title text not null, body text not null default '',
  is_secret boolean not null default false,
  updated_by text not null,
  updated_at timestamptz not null default now()
);
create table revisions (
  id bigserial primary key,
  page_id bigint not null references pages(id) on delete cascade,
  body text not null, author text not null,
  created_at timestamptz not null default now()
);
create index on revisions(page_id, created_at desc);
=== END ===
```

**Phone:** *"Calling it `campaign`. Members can read and write; you'll be the DM with extra permissions. Two tables: pages and revisions. Postgres + an object store (for maps and handouts)."* The new app's `[Members]` tab opens with `harry — DM (you)` and a `+ Invite` button preset to role `Member`. One QR per player.

### 2.3 "Pomodoro timer with mood tracking"

No ambiguity — single-user, simple schema, no browser, no objects.

**[assistant]**:

```
=== flagship.app.json ===
{
  "schema_version": 1, "name": "focus", "version": "0.1.0",
  "description": "Pomodoro timer that logs how each session felt.",
  "runtime": { "image": "flagship/focus:0.1.0", "port": 8080 },
  "data": { "stores": { "postgres": true, "kv": true } },
  "network": { "subdomain": "focus" },
  "access": { "enabled": true, "default_role": "owner", "public_routes": [] },
  "migration": { "verification": "standard" }
}
=== Dockerfile === (node:20-alpine, exposes 8080)
=== src/index.js ===
// One-page timer: POST /api/sessions inserts {start, end, mood:1..5, note};
// GET /api/stats returns weekly aggregates; FLAGSHIP_REDIS_URL holds the
// currently-running timer so it survives a browser refresh.
=== migrations/0001_init.sql ===
create table sessions (
  id bigserial primary key,
  started_at timestamptz not null, ended_at timestamptz not null,
  duration_seconds int not null,
  mood int not null check (mood between 1 and 5),
  note text, user_id text not null
);
create index on sessions(user_id, started_at desc);
=== END ===
```

**Phone narration** highlights the **omitted-permission honesty**:

> "Calling it `focus`. Just for you — a private timer that remembers how each Pomodoro felt. One sessions table. A small bit of Redis to keep track of the running timer. **We didn't ask for push notifications — you can add those later if you want.**"

When the LLM omits something the user mentioned, the phone *says so* rather than silently dropping it. The user can reply *"actually, add push"* and the iteration loop kicks in.

---

## 3. Streaming UX rules

What the user sees during streaming is **not** the model's tokens. It's a phase narration.

### 3.1 Phases

| Phase | Status pill | Body line |
|---|---|---|
| Connecting | `Thinking` | (just the pulsing dot) |
| Manifest writing | `Writing` | One sentence: name + scopes as decided |
| Code writing | `Writing` | One line per emitted file |
| Migration writing | `Writing` | Plain-English schema summary |
| Permissions ready | `Ready to approve` | Permissions card slides in |
| Building image | `Building image` | "Packaging the app — about 30 seconds." |
| Starting | `Starting` | "Bringing it up." |
| Cert | `Getting TLS` | "Asking Let's Encrypt for a certificate." |
| Done | `Online` | URL + Open button |

The raw output is available via a `Show what's being written` toggle. Hidden by default. Reveals a monospace pane showing the current file with a typewriter effect — power users will love it; everyone else will never tap it.

### 3.2 Can the user edit mid-stream?

**No.** A streaming phase is atomic. They can `Cancel` (aborts and discards the partial response) but not edit. Reasons: (1) coherence collapses if you splice in *"wait, also..."* mid-manifest; (2) immediately after the response lands, before approval, a `Revise` button appears alongside `Approve` — that re-opens the textarea for one more turn; (3) post-approval changes go through the iterate loop (§4).

### 3.3 Where the user sits

Phone: they put it down. Screen idle-locks at 30s. Local notification when permissions are ready, another when the app is online.

Desktop (paired browser): same `[Generating]` panel takes the right two-thirds. Left third is the user's prompt — read-only on the current turn, editable for the next.

### 3.4 Deploy progress

Linear bar with three labels: **Packaging** (~15s docker build), **Starting** (~5s container up + healthcheck), **Cert** (only on a brand-new subdomain — wildcard cert means most deploys skip this). If a phase stalls past 60s the bar flips amber with a `Show details` link that reveals docker output. Power users opt in; nobody else sees a build log.

---

## 4. Edit-and-iterate loop

The success card has three buttons: **Open it**, **Make a change**, **Done for now**. `Make a change` re-opens the LLM session in a chat-style UI; the prompt placeholder reads *"What would you like to change?"*

### 4.1 "make the buttons bigger"

The harness checks out the app's Forgejo repo on a new branch `vibe/<sessionId>-<turn>`, sends the LLM the previous turn as assistant context plus the new user message. The model emits an updated `src/index.html` and nothing else; harness diffs, commits, rebuilds, restarts.

**Phone:**

> Updated `src/index.html`. No database change.
> [ See diff ]   [ Try it ]   [ Undo ]

`See diff` opens a phone-friendly side-by-side view; most users skip it and tap `Try it`, which reloads the live URL in a sheet. `Undo` reverts the commit, rebuilds, restarts. One tap, no confirmation — the data layer is untouched, only source.

### 4.2 "add a tag column"

The migration case. The LLM emits `migrations/0002_tags.sql` plus source updates that read/write `tag`. The harness commits but **pauses before applying**. Migrations on existing data are different from greenfield, and we don't auto-apply.

> **One database change is pending.**
> Adds a `tag` column to your shopping items. Existing items will have a blank tag.
>
> [ Apply and restart ]   [ Discard ]

`Apply and restart` runs `runMigration` with `FLAGSHIP_PG_URL` injected, restarts the container, ~5s. `Discard` drops the commit.

This is the one place where the consumer veneer parts and we deliberately surface *"this is a database change."* Live-data migrations always deserve the user's eyeball.

### 4.3 Branches?

Internally each iteration is a Forgejo branch. The user never sees a branch name. They see a linear timeline:

```
[App: shopping] → Updates
  Today, 3:14 PM   "make the add button bigger and green"  [ Try ] [ Undo ]
  Today, 3:08 PM   "add a tag column"                       [ Try ] [ Undo ]
  Yesterday, 9:01 PM   v0.1.0 — initial build               [ View ]
```

`Undo` rolls back to that checkpoint. `Try` reverts *temporarily*; if liked, a `Make this current` button promotes it. No branch names, no commit hashes, no merge UI.

---

## 5. Failure UX

Four ways the path fails. Each gets specific copy and one-tap recovery.

### 5.1 LLM emits unparseable output

Harness ran the regex over the response and didn't find `=== END ===`, or a JSON block was malformed, or `parseManifest` rejected. The harness retries *once*, prepending the parser's error to the next turn. If that fails too:

> **The model got a little confused.**
> We tried twice and didn't get a clean app definition back. Want to try rephrasing your idea?
>
> [ Edit and retry ]  [ Switch to GPT-4o ]  [ Cancel ]

`Switch to GPT-4o` only appears with multiple providers configured. On Free tier with promo, that slot becomes `Try again later` and surfaces the daily-call counter.

### 5.2 Build fails

`docker build` returned non-zero; harness captured stderr.

> **The build hit a snag.**
> The model wrote some code that doesn't compile. Want to ask it to fix itself?
>
> [ Auto-fix ]  [ Show what broke ]  [ Cancel ]

`Auto-fix` sends the LLM a follow-up turn with the build error pasted in. ~80% land on the first auto-fix. If a second auto-fix fails, we offer `Cancel` and an honest disclosure: *"The model is stuck. This sometimes happens with very unusual app ideas — try a simpler description?"*

### 5.3 Migration fails

The schema migration ran on a live store and threw. Most sensitive failure — there may be partial state.

> **A database change failed partway through.**
> Your existing items table looks fine; the new `tag` column wasn't added. Nothing is broken — the previous version is still running.
>
> [ Try again ]  [ Undo this change ]  [ Show the error ]

The load-bearing sentence is *"Nothing is broken — the previous version is still running."* It's true (we keep the prior container until the new one healthchecks green), and it's what the user needs to know. We run migrations transactionally where possible; `Undo this change` reverts the source commit and the data layer is already in pre-migration state.

### 5.4 Cert provisioning fails

Rare — wildcard cert covers `*.<host>.<user>.flagship.services`, so most apps inherit it.

> **Almost there.**
> Waiting on the TLS certificate. This usually takes 30–90 seconds; if it's still spinning after 5 minutes, your server may be having trouble reaching Let's Encrypt.

No retry button — ACME has its own. If the user navigates away, a push notification announces the cert when it lands.

---

## 6. Voice — sample copy

| State | Copy |
|---|---|
| Empty | *"No apps yet. The hardest part of vibe-coding is the first idea."* |
| Connecting | *"Thinking."* |
| Manifest | *"Working out what your app should be called and what it'll need."* |
| Code | *"Writing the app."* |
| Migration | *"Setting up the database."* |
| Permissions ready | *"Here's what it'll ask for."* |
| Building | *"Packaging it up. About 30 seconds."* |
| Starting | *"Bringing it up."* |
| Cert | *"Getting your TLS certificate."* |
| Done | *"`<slug>` is live."* |
| Regenerating | *"Reading what you have." / "Updating the app."* |
| Migration pending | *"One database change pending."* |
| Parser fail | *"The model got a little confused."* |
| Build fail | *"The build hit a snag."* |
| Migration fail | *"A database change failed partway through."* |
| Cert fail | *"Almost there."* |

Missing: *Sorry*, *Error*, *Failed* on its own. We say what happened and what to try, in that order. The success card is one sentence and one URL — no exclamation point, no emoji. The pulsing dot already celebrated.

---

## 7. Cost transparency

Two surfaces: the prompt screen and the post-deploy receipt.

**On `[Vibe-code]`**, above the **Build it** button, one line:

> Today: 12 / 50 calls · this app counted as 1 call

At >80% quota the line flips amber: *"Today: 41 / 50 calls — close to your free limit. [ Use my own key ]"* — the link goes to `[Settings → AI provider]`. At 50/50: *"You've used today's free calls. They reset at midnight, or [ use your own key ] for unlimited."* We never block the build — we offer the alternative.

**BYOK users** see one line: *"Using your Anthropic key."* That's it. We don't pretend to know their cost.

**Post-deploy**, the success card has a small footer:

> Cost: 1 of 50 free calls today. ($0.04 if you'd been on your own key.)

The "had-you-been-on-BYOK" honesty number is computed from token counts and posted provider rates. It exists because we want users to know the promo is real value, not vague sponsorship — and so switching to BYOK doesn't feel like falling off a cliff.

**What we never do.** No gamification (no streaks, no "earn 10 more calls for inviting a friend"). No mid-flow upsell (the counter lives on the prompt screen and in `[Settings]`, nowhere else). No silent degradation — at quota, the **Build it** button is *disabled with a clear reason*, not hidden behind an "upgrade to continue" wall.

---

## 8. Permissions reveal

Before tap-to-approve, the user sees exactly what the app gets. Plain English, with a fixed *"this app cannot"* list as calm defense against permission fatigue.

```
+-----------------------------------------+
|  Permissions                            |
|                                         |
|   . A Postgres table — just for plants  |
|   . An object store bucket — for photos |
|   . Push notifications                  |
|                                         |
|   This app cannot:                      |
|     . See your other apps' data         |
|     . Reach websites you don't approve  |
|     . Use your phone's location, mic,   |
|       camera, or contacts               |
|     . Be reached by people you haven't  |
|       invited                           |
|                                         |
|  [   Show technical details   ]         |
+-----------------------------------------+
```

**Manifest → English mapping:**

| Manifest field | User-facing line |
|---|---|
| `data.stores.postgres: true` | *"A Postgres table — just for `<slug>`"* |
| `data.stores.objects: true` | *"An object store bucket — for photos / files"* |
| `data.stores.kv: true` | *"A small cache for keeping track of things between page loads"* |
| `browser.domains: [...]` | *"Open `<domain>` in a browser tab on your server"* (one line per domain) |
| `access.public_routes` non-empty | *"Some pages will be visible to people without an invite"* |
| `migration.verification: "elevated"` | *"Extra confirmation needed if you ever transfer this app to another box"* |

**Browser domains** get a special card because it's the highest-stakes scope:

```
This app wants to use your browser
Sites it'll open:
  . amazon.com
  . *.amazon.com
You'll be asked to log in to those sites once, on your phone.
The cookies stay in your server's browser. The app itself never
sees your password.
```

That last sentence is doing a lot of work — it's the single line that explains the entire pod-resident-browser feature. `Show technical details` expands a longer explanation; otherwise the sentence is enough.

**Show technical details** (tucked behind a link, never default-visible) reveals the literal `flagship.app.json`, the list of injected env vars, the container image base layer (`node:20-alpine`), and the file list with sizes. For the curious; same info the daemon would log.

---

## 9. Closing principles

1. **One screen, one button, one Face ID.** Anything beyond that has to earn its place. Streaming narration earns it because the alternative is a 90-second spinner. The permissions card earns it because the alternative is silent over-scoping. Almost nothing else does.
2. **The model is allowed to ask one question.** Not three. Not a wizard. One short clarifier with one-tap suggested answers. If the model can't form a useful question, it makes a reasonable guess and lets the user revise.
3. **Failure is a setback, not a fault.** Copy never blames the user. It says what failed, names what's still safe, offers one recovery. The honest sentence (*"nothing is broken — the previous version is still running"*) is a habit, not a one-off.

The success criterion isn't *"users build cool apps"* — that's downstream. It's: **a non-technical user describes an app, taps two buttons, and uses it on their own URL within two minutes.** Hold that line and vibe-coding feels like magic in the oldest sense — a mechanism the user trusts because it consistently does what it says.
