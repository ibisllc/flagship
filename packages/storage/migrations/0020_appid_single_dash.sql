-- appId encoding change: `<creator>--<slug>` → `<creator>-<slug>`.
--
-- We banned hyphens from usernames (the creator is a username), so
-- the double-dash separator is no longer needed to disambiguate —
-- the FIRST hyphen now reliably splits creator from slug. This
-- migration rewrites the stored composite ids to the single-dash
-- form so existing rows match what the updated handlers emit.
--
-- Pre-launch: there is no production data, so a blunt string rewrite
-- is acceptable. The rewrite replaces only the FIRST occurrence of
-- '--' (the creator/slug boundary). Slugs themselves never contained
-- '--' historically — the daemon's AppPlatform.appId only ever
-- joined with a single '--', and slugs are RFC-1035 labels (single
-- hyphens at most). So a global REPLACE of the first '--' is exact.
--
-- SQLite's REPLACE() rewrites ALL occurrences, but since a
-- well-formed legacy appId contains exactly one '--' (creator and
-- slug are each hyphen-or-single-hyphen labels, never '--'), a
-- global REPLACE is equivalent to "replace the first" here.

UPDATE user_app_aliases
SET app_id = REPLACE(app_id, '--', '-')
WHERE app_id LIKE '%--%';

UPDATE voici_links
SET app_id = REPLACE(app_id, '--', '-')
WHERE app_id LIKE '%--%';
