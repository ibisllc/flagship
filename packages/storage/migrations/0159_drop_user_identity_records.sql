-- Removes the user-identity mandate store (#71, 0012): `POST /api/user-identity` took any signer the request named
-- and keyed rows by a hash anyone can compute from a public name, so anyone could create, overwrite or freeze a row,
-- and store up to 256 KiB per anonymous request (security report F1, 2026-11-23). No client ever read or wrote it; the
-- encrypted account directory does its job. The routes and code are gone; this drops the table and its rows (on
-- production, 5 rows, all a researcher's test writes). Re-runnable.
DROP TABLE IF EXISTS user_identity_records;
