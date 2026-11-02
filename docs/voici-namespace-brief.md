# Brief: one namespace for people and links on voi.ci

*For outside review. Written 2026-11-02. Nothing here is built yet; the current build uses a plain collision check.*

## Context

Flagship is a personal-cloud product. Every account has a **username**: lowercase `a-z`, `0-9` and `-`, 1 to 64
characters, no leading or trailing hyphen. Generated suggestions look like `plucky-avocet` (adjective-noun).

`voi.ci` is our short domain. Until now it served only **links**, of two kinds:

- **Codes**: 6 random characters from `0-9a-z`, minted by the system for an app (for example `voi.ci/k3x9qa`).
- **Custom link names**: chosen by a person for one of their apps (for example `voi.ci/chess-club`).

The coming release adds **personal pages** at `voi.ci/<username>`: a link-in-bio page with a "Send me a message"
button, meant to be printed on business cards. So people and links now share one path segment.

## The proposal

1. **A username must start with a letter** (`a-z`). Rule for new accounts and renames.
2. **A code always starts with a digit** (`0-9`), and never contains a hyphen. Codes are machine-made, so this costs
   nothing (6 characters, first from 10 digits, the rest from 36: about 604 million codes).
3. **A future bot account** (not built yet) would start with a digit **and contain a hyphen**, so it can never equal a
   code. Human accounts start with a letter, so bots and people are told apart at a glance too.
4. **Custom link names** are chosen by people and can be anything legal, so they keep a collision check: a link name
   is refused when it equals a username (hyphens ignored in the comparison), and a username is refused when it equals
   a live or retired link name.
5. Lookup order for `voi.ci/<x>`: a custom link name or code first (its redirect), else a username with a published
   page, else not found. With rules 1 to 4 at most one can match.

Why: the first character alone tells people from codes, with no lookup and no special cases; a business card's
`voi.ci/<username>` can never be taken by a code minted later.

## What it would invalidate today (checked on the production database, read-only)

| Data | Count | Affected by the rule |
|---|---|---|
| Usernames | 15 | 0 start with a digit (all are adjective-noun, all contain a hyphen) |
| Username aliases (old names after a rename) | 0 | none |
| Codes (`voi.ci/<code>`) | 0 | none |
| Custom link names | not in production yet (new in this release) | none |

So the rule can be adopted with no exceptions and no grandfathered entries.

## Edge cases we have thought about

- **Case and look-alikes.** Everything is lowercase ASCII; no Unicode, so no homoglyphs inside the namespace.
- **Hyphen-insensitive comparison** for link names vs usernames (`chess-club` vs `chessclub`) avoids near-collisions
  that would mislead a reader.
- **Reserved words** (`about`, `help`, `api`, `login`, `admin`, …) are already refused as link names; the proposal
  extends the same list to usernames.
- **Renames** are a later paid feature (not built). Planned: the old name redirects for a holding period before it is
  freed; the first-letter rule applies to the new name.
- **Retired codes** are never reused, so an old printed code never points somewhere new.
- **Path prefixes.** `voi.ci/@<username>` redirects to `voi.ci/<username>`, so `@` is never part of a name.

## Questions for reviewers

1. Is "people start with a letter, machines start with a digit" a rule that will age well (bots, organisations,
   imported handles from other services)?
2. Should bot accounts be marked by the first character at all, or by something visible on the page instead?
3. Is a hyphen-insensitive comparison enough, or should we also fold look-alike pairs such as `0`/`o` and `1`/`l`?
4. Any reason to keep links and pages in separate path spaces (`voi.ci/@name` for people) despite the cleaner
   business card?
5. Anything that makes a username guessable or enumerable in a way that matters for privacy (pages are public by
   design; messages are not)?
