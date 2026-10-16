# Changing what Flagship Inference offers

Flagship Inference's menu and allowance are server-side settings on `.com`
(`packages/control-plane/src/inferenceSettings.ts`), so a change from owner
feedback needs no deploy: turn a model on or off, change the default, a
multiplier or a menu description, or the starter, weekly and daily numbers.
Every change carries a note and is kept as history (D1 `inference_settings`,
migration 0103).

What can't be changed here is which models exist: a new model needs its
upstream ids, prices and thinking switch probed and added to
`INFERENCE_MODELS` in `inferenceModels.ts`, then a `.com` deploy
(`docs/ai-inference-costs.md` §15).

## The tool

```sh
export FLAGSHIP_ADMIN_SECRET=…          # FLAGSHIP_BASE_URL for the gym
npm run inference-settings              # what's in force
npm run inference-settings -- history   # the last 20 changes and their notes
```

Change something with `set` (or `unset` to go back to the default), always
with a `--note` saying why. Try it with `--dry-run` first: it prints the
menu and allowance the change would put in force and stores nothing.

```sh
npm run inference-settings -- set weeklyCredits=750 --note "owners run out mid-edit" --dry-run
npm run inference-settings -- set weeklyCredits=750 --note "owners run out mid-edit"
npm run inference-settings -- set high.multiplier=4 --note "High costs more per credit than it earns"
npm run inference-settings -- set low.enabled=true default=low --note "trying Low as the default again"
npm run inference-settings -- set high.descriptor="Best for big apps with many screens." --note "owners asked which to pick"
npm run inference-settings -- unset weeklyCredits --note "back to 500"
npm run inference-settings -- reset --note "back to the shipped defaults"
```

| key | meaning |
|---|---|
| `default=<id>` | the model the apps pick first; must be on |
| `<id>.enabled=true\|false` | offered in the menus; a box that still asks for an off model gets the default |
| `<id>.multiplier=<n>` | credits per weighted token, 1–20 in steps of 0.5 (unset = computed from prices) |
| `<id>.descriptor="…"` | the menu's one line, up to 120 characters |
| `starterCredits`, `weeklyCredits`, `dailyCapCredits` | 1 credit = 1,000 weighted tokens (`…Tokens` takes tokens); the daily cap is every account together |
| `inputWeight`, `outputWeight` | weighted tokens = input × in + output × out |
| `endsAt=<ISO date>\|none` | when free building stops (`none` clears an end date) |

Model ids: `low`, `medium`, `medium-vision`, `high`.

The endpoint refuses anything that would break the menu: an unknown model
or field, a number out of range, a default that is off, or no model on.

## How fast it lands

Allowance checks and usage charges read the settings at most every 30 s
per Worker isolate; the menu (`GET /api/inference/models`) is cached for
60 s on top, and the apps fetch it when a build chat opens. So a change is
everywhere within about a minute and a half. Credits already spent stay
spent: a lower multiplier doesn't refund, a higher one charges from the
next call.

## Which layer wins

1. The shipped decision in code (`INFERENCE_SETTINGS_DEFAULTS`; owner,
   2026-10-15: GLM the default, Low off at 3×) and `FREE_AI_DEFAULTS`
   (2,000 starter, 500 a week, 50,000 a day).
2. `.com`'s `AI_PROMO_*` vars, for the allowance (`docs/build-modes.md`).
3. The latest stored settings. Each `set`/`unset` stores the whole document
   again, so `history` shows exactly what was in force after each change.

A stored row that stops validating (a model since removed from the code)
is ignored, with an error in the Worker log, and the layers under it apply.

## Reading feedback into a change

- **"I ran out mid-build"**: look at `ai-promo-*` usage first. Raise
  `weeklyCredits` before `starterCredits`: the week is what returning owners
  live on.
- **"It keeps failing to build"** on one model: compare its pass rate in the
  latest `build-eval` run (`infra/inference/build-eval`); turn it off or move
  the default away from it.
- **Cost running ahead**: the daily cap is the hard ceiling; at most it costs
  `dailyCapCredits` × about $0.06 per 1,000 credits a day on today's models
  (`docs/ai-inference-costs.md` §16). Lower it, or raise a multiplier.
