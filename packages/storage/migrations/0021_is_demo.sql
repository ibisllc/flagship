-- Demo accounts (task #84).
--
-- A demo account is a REAL claim with real keys — it is not the
-- off-git TEST_ACCOUNTS sandbox (that one is fully mocked, no keys).
-- The only difference: at login the Worker returns a platform-signed
-- directive telling the client to route the *recovery* ceremony
-- through the Mock provider, because Apple/Play review can't drive a
-- real WebAuthn-PRF passkey. Everything else (.com + .services) is
-- live for a demo user.
--
-- The flag lives on the existing username claim row. NOT NULL DEFAULT
-- 0 so every existing row is a normal account and the storage
-- decoder (is_demo === 1) keeps working. Only the operator-gated
-- provisionDemoUser / decommissionDemoUser path ever flips it; the
-- username-claim flow never writes it (see d1.ts put ON CONFLICT).
--
-- Pre-launch: no production rows, so the ALTER is non-destructive.

ALTER TABLE usernames ADD COLUMN is_demo INTEGER NOT NULL DEFAULT 0;
